import { isAbsolute } from "path"
import { Cause, Context, Effect, Layer, Option, Schema, Scope } from "effect"
import { canonicalDirectory } from "@/kilocode/session/canonical-directory"
import { Database } from "@opencode-ai/core/database/database"
import { MessageTable } from "@opencode-ai/core/session/sql"
import { SessionOperation } from "@opencode-ai/core/session/operation"
import { ConfigConvergence } from "@/kilocode/server/config-convergence"
import { eq } from "drizzle-orm"
import { SessionID, MessageID } from "@/session/schema"
import { Session } from "@/session/session"
import { MessageV2 } from "@/session/message-v2"
import { SessionPrompt } from "@/session/prompt"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Command } from "@/command"
import { InstanceRef } from "@/effect/instance-ref"
import { EventV2Bridge } from "@/event-v2-bridge"
import { KeyedMutex } from "@opencode-ai/core/effect/keyed-mutex"
import { SessionOperationTable } from "@opencode-ai/core/session/sql"
import { NamedError } from "@opencode-ai/core/util/error"
import { OBSERVATION_NOTIFICATION, OBSERVATION_VERSION } from "@/private-worker/observation"
import { Service as PrivatePeerService } from "@/kilocode/server/private-peer-registry"
import { BlockedError as AgentRequirementError } from "@/kilocode/agent-requirements"
import {
  acquireDrainControl,
  InstanceUnavailableDuringConfigRebuildError,
} from "@/kilocode/server/drain-control-acquire"

export const VERSION = 1 as const
export const OP = "session/command" as const

export interface SessionCommandRequest {
  v: typeof VERSION
  requestId: string
  opId: string
  op: typeof OP
  idempotencyKey: string
  context: {
    directory: string
    sessionId: string
    parentSessionId?: string | null
    configVersion?: number
    sessionRevision?: number
  }
  payload: {
    messageId: string
    command: string
    arguments: string
    model?: string | null
    agent?: string | null
    variant?: string | null
    parts?: unknown[] | null
    snapshotInitialization?: "wait" | null
  }
}

export type Revision = { session: number; config: number }

export interface SessionCommandSucceeded {
  v: typeof VERSION
  requestId: string
  opId: string
  op: typeof OP
  idempotencyKey: string
  status: "succeeded"
  outcome: { type: "succeeded"; time: number }
  accepted: true
  data: { accepted: true; messageId: string; sessionId: string }
  revision?: Revision
}

export interface SessionCommandFailed {
  v: typeof VERSION
  requestId: string
  opId: string
  op: typeof OP
  idempotencyKey: string
  status: "failed"
  outcome: { type: "failed"; time: number; failure: { code: string; message: string; retryable: boolean; detail?: string } }
  accepted: boolean
  failure: { code: string; message: string; retryable: boolean; detail?: string }
  revision?: Revision
}

export type SessionCommandResult = SessionCommandSucceeded | SessionCommandFailed

function isNonEmptyString(v: unknown): boolean {
  return typeof v === "string" && v.length > 0
}
function isSafeInt(v: unknown): boolean {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && Number.isSafeInteger(v)
}
export { canonicalDirectory } from "@/kilocode/session/canonical-directory"

function validateFilePart(p: unknown): void {
  if (p === null || typeof p !== "object" || Array.isArray(p)) throw new Error("payload.parts entry must be object")
  const r = p as Record<string, unknown>
  if (r.type !== "file") throw new Error("payload.parts entry type must be file")
  if (typeof r.mime !== "string" || typeof r.url !== "string") throw new Error("payload.parts file entry requires mime/url")
  for (const k of Object.keys(r)) {
    if (k !== "id" && k !== "type" && k !== "mime" && k !== "filename" && k !== "url" && k !== "source")
      throw new Error(`unexpected payload.parts file field ${k}`)
  }
  if ("id" in r && r.id !== undefined && r.id !== null && typeof r.id !== "string")
    throw new Error("payload.parts file entry id must be string if present")
  if ("filename" in r && r.filename !== undefined && r.filename !== null && typeof r.filename !== "string")
    throw new Error("payload.parts file entry filename must be string if present")
  if ("source" in r && r.source !== undefined && r.source !== null && !Schema.is(SessionV1.FilePartSource)(r.source))
    throw new Error("payload.parts file entry source invalid")
}

function validateModelString(v: unknown): void {
  if (typeof v !== "string" || v.length === 0) throw new Error("payload.model must be provider/model string")
  if (v.includes(":") || v.includes("\0")) throw new Error("payload.model must be provider/model string")
  const segs = v.split("/")
  if (segs.length !== 2 || !segs[0] || !segs[1]) throw new Error("payload.model must be provider/model string")
}

export function validateRequest(raw: unknown): SessionCommandRequest {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("params must be object")
  const o = raw as Record<string, unknown>
  if (o.v !== VERSION) throw new Error(`unsupported session version: ${String(o.v)} — expected numeric ${VERSION}`)
  if (!isNonEmptyString(o.requestId)) throw new Error("requestId must be non-empty string")
  if (!isNonEmptyString(o.opId)) throw new Error("opId must be non-empty string")
  if (o.op !== OP) throw new Error(`op must be ${OP}`)
  if (!isNonEmptyString(o.idempotencyKey)) throw new Error("idempotencyKey must be non-empty string")
  if (o.idempotencyKey !== o.opId) throw new Error("idempotencyKey must equal opId for command")
  const ctx = o.context
  if (ctx === null || typeof ctx !== "object" || Array.isArray(ctx)) throw new Error("context must be object")
  const c = ctx as Record<string, unknown>
  if (typeof c.directory !== "string" || !isAbsolute(c.directory)) throw new Error("context.directory must be absolute path")
  canonicalDirectory(c.directory as string)
  if (typeof c.sessionId !== "string" || !Schema.is(SessionID)(c.sessionId)) throw new Error("context.sessionId must be SessionID")
  if ("parentSessionId" in c && c.parentSessionId !== null && c.parentSessionId !== undefined) {
    if (typeof c.parentSessionId !== "string" || !Schema.is(SessionID)(c.parentSessionId as string))
      throw new Error("context.parentSessionId must be SessionID or null")
  }
  if ("configVersion" in c && c.configVersion !== undefined && !isSafeInt(c.configVersion))
    throw new Error("context.configVersion must be integer >=0")
  if ("sessionRevision" in c && c.sessionRevision !== undefined && !isSafeInt(c.sessionRevision))
    throw new Error("context.sessionRevision must be integer >=0")
  const payload = o.payload
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) throw new Error("payload must be object")
  const p = payload as Record<string, unknown>
  if (typeof p.messageId !== "string" || !Schema.is(MessageID)(p.messageId as string))
    throw new Error("payload.messageId must be MessageID")
  if (typeof p.command !== "string" || p.command.length === 0) throw new Error("payload.command must be non-empty string")
  if (typeof p.arguments !== "string") throw new Error("payload.arguments must be string")
  if ("model" in p && p.model !== null && p.model !== undefined) validateModelString(p.model)
  if ("agent" in p && p.agent !== null && p.agent !== undefined && typeof p.agent !== "string")
    throw new Error("payload.agent must be string or null")
  if ("variant" in p && p.variant !== null && p.variant !== undefined && typeof p.variant !== "string")
    throw new Error("payload.variant must be string or null")
  if ("parts" in p && p.parts !== null && p.parts !== undefined) {
    if (!Array.isArray(p.parts)) throw new Error("payload.parts must be array")
    for (const entry of p.parts as unknown[]) validateFilePart(entry)
  }
  if ("snapshotInitialization" in p && p.snapshotInitialization !== null && p.snapshotInitialization !== undefined) {
    if (p.snapshotInitialization !== "wait") throw new Error("payload.snapshotInitialization must be wait or null")
  }
  const allowedRoot = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "context", "payload"])
  for (const k of Object.keys(o)) if (!allowedRoot.has(k)) throw new Error(`unexpected field ${k}`)
  const allowedCtx = new Set(["directory", "sessionId", "parentSessionId", "configVersion", "sessionRevision"])
  for (const k of Object.keys(c)) if (!allowedCtx.has(k)) throw new Error(`unexpected context field ${k}`)
  const allowedPayload = new Set([
    "messageId",
    "command",
    "arguments",
    "model",
    "agent",
    "variant",
    "parts",
    "snapshotInitialization",
  ])
  for (const k of Object.keys(p)) if (!allowedPayload.has(k)) throw new Error(`unexpected payload field ${k}`)
  const expected = SessionOperation.promptId(p.messageId as string)
  if (o.opId !== expected) throw new Error(`opId must be canonical ${expected}`)
  try {
    SessionOperation.parseOpId(o.opId as string)
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : String(e))
  }
  if (c.parentSessionId !== null && c.parentSessionId !== undefined) throw new Error("parentSessionId must be null for command")
  return o as unknown as SessionCommandRequest
}

function buildFailed(
  req: SessionCommandRequest,
  code: string,
  message: string,
  retryable: boolean,
  accepted: boolean,
  revision: Revision | undefined,
  detail?: string,
): SessionCommandFailed {
  const normalized = SessionOperation.normalizeRecord({
    opId: req.opId,
    opKind: "prompt",
    outcome: "failed",
    code,
    message,
    time: Date.now(),
    detail,
  })
  const time = Date.now()
  const failure = { code, message: normalized.message, retryable, ...(normalized.detail ? { detail: normalized.detail } : {}) }
  return {
    v: VERSION,
    requestId: req.requestId,
    opId: req.opId,
    op: OP,
    idempotencyKey: req.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time, failure },
    accepted,
    failure,
    ...(revision !== undefined ? { revision } : {}),
  } as SessionCommandFailed
}

function buildSucceeded(req: SessionCommandRequest, revision: Revision | undefined): SessionCommandSucceeded {
  return {
    v: VERSION,
    requestId: req.requestId,
    opId: req.opId,
    op: OP,
    idempotencyKey: req.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: Date.now() },
    accepted: true,
    data: { accepted: true as const, messageId: req.payload.messageId, sessionId: req.context.sessionId },
    ...(revision !== undefined ? { revision } : {}),
  } as SessionCommandSucceeded
}

function isAbortedSuccess(value: unknown): boolean {
  const info = (value as { info?: { error?: unknown } })?.info
  if (!info || !info.error) return false
  const err = info.error as { name?: unknown }
  if (typeof err.name === "string" && (err.name === "MessageAbortedError" || err.name === "AbortedError")) return true
  try {
    if (SessionV1.AbortedError.isInstance(err as never)) return true
  } catch {}
  return false
}

export interface SessionCommandDispatch {
  readonly dispatch: (request: unknown) => Effect.Effect<SessionCommandResult, unknown, unknown>
}

export class SessionCommandDispatchService extends Context.Service<SessionCommandDispatchService, SessionCommandDispatch>()(
  "SessionCommandDispatch",
) {}

export const layer = Layer.effect(
  SessionCommandDispatchService,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const session = yield* Session.Service
    const promptSvc = yield* SessionPrompt.Service
    const commands = yield* Command.Service
    const events = yield* EventV2Bridge.Service
    const layerScope = yield* Scope.Scope
    const terminalMutex = KeyedMutex.makeUnsafe<string>()
    const commandInflight = new Map<string, SessionID>()
    const terminalizeCommand = (opId: string, sid: SessionID, outcome: SessionOperation.Outcome, code: string, message: string, detail?: string) =>
      terminalMutex.withLock(opId)(
        Effect.gen(function* () {
          const rec: SessionOperation.FailureRecord = {
            opId,
            opKind: "prompt",
            outcome,
            code,
            message,
            time: Date.now(),
            ...(detail ? { detail } : {}),
          }
          const res = yield* SessionOperation.tryTransitionPromptTerminal(db, sid, rec).pipe(
            Effect.map((v) => v as { applied: boolean; entry?: { seq: number; session_id: string; revision: number; kind: string; time: number }; generationEntry?: { seq: number; session_id: string; revision: number; kind: string; time: number } }),
            Effect.catch(() => Effect.succeed({ applied: false } as { applied: boolean })),
            Effect.catchDefect(() => Effect.succeed({ applied: false } as { applied: boolean })),
          )
          if (res.applied && (res as { entry?: { seq: number; session_id: string; revision: number; kind: string; time: number } }).entry) {
            const entry = (res as { entry: { seq: number; session_id: string; revision: number; kind: string; time: number } }).entry
            yield* Effect.gen(function* () {
              const opt = yield* Effect.serviceOption(PrivatePeerService)
              if (opt._tag === "None") return
              const peer = opt.value
              const payload = {
                v: OBSERVATION_VERSION,
                cursor: entry.seq,
                entries: [{ seq: entry.seq, session_id: entry.session_id, revision: entry.revision, kind: entry.kind, time: entry.time }],
              }
              yield* peer.notify(OBSERVATION_NOTIFICATION, payload).pipe(Effect.catch(() => Effect.void), Effect.catchDefect(() => Effect.void))
            }).pipe(Effect.catch(() => Effect.void), Effect.catchDefect(() => Effect.void))
            const gen = (res as { generationEntry?: { seq: number; session_id: string; revision: number; kind: string; time: number } }).generationEntry
            if (gen) {
              yield* Effect.gen(function* () {
                const opt = yield* Effect.serviceOption(PrivatePeerService)
                if (opt._tag === "None") return
                const peer = opt.value
                const payload = {
                  v: OBSERVATION_VERSION,
                  cursor: gen.seq,
                  entries: [{ seq: gen.seq, session_id: gen.session_id, revision: gen.revision, kind: gen.kind, time: gen.time }],
                }
                yield* peer.notify(OBSERVATION_NOTIFICATION, payload).pipe(Effect.catch(() => Effect.void), Effect.catchDefect(() => Effect.void))
              }).pipe(Effect.catch(() => Effect.void), Effect.catchDefect(() => Effect.void))
            }
          }
          commandInflight.delete(opId)
        }),
      ).pipe(Effect.uninterruptible, Effect.ignore)
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        for (const [opId, sid] of Array.from(commandInflight.entries())) {
          yield* terminalizeCommand(opId, sid, "abandoned", "prompt.abandoned", "prompt abandoned due to scope shutdown")
        }
      }).pipe(Effect.uninterruptible, Effect.ignore),
    )
    const cfg = Option.getOrElse(yield* Effect.serviceOption(ConfigConvergence.Service), () => ConfigConvergence.noop)
    const getConfigVer = (dir: string) => cfg.getBootedVersion(dir) as Effect.Effect<number | undefined>
    const readCfgOmit = (dir: string) =>
      Effect.gen(function* () {
        const v = yield* getConfigVer(dir).pipe(
          Effect.map((x) => ({ _tag: "Right" as const, right: x as number | undefined })),
          Effect.catch(() => Effect.succeed({ _tag: "Left" as const, left: undefined as unknown })),
          Effect.catchDefect(() => Effect.succeed({ _tag: "Left" as const, left: undefined as unknown })),
        )
        return v._tag === "Right" ? v.right : undefined
      })

    const dispatch = Effect.fn("SessionCommandDispatch.dispatch")(function* (raw: unknown) {
      let req: SessionCommandRequest
      try {
        req = validateRequest(raw)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        const fallback = raw as Record<string, unknown>
        const requestId = typeof fallback?.requestId === "string" ? fallback.requestId : "unknown"
        const opId = typeof fallback?.opId === "string" ? fallback.opId : "unknown"
        const idempotencyKey = typeof fallback?.idempotencyKey === "string" ? fallback.idempotencyKey : "unknown"
        const time = Date.now()
        const opIdSafe = (() => {
          try {
            SessionOperation.parseOpId(opId)
            return opId
          } catch {
            return `prompt:msg_unknown`
          }
        })()
        const failure = SessionOperation.normalizeRecord({
          opId: opIdSafe,
          opKind: "prompt",
          outcome: "failed",
          code: "validation.failed",
          message: msg,
          time,
        })
        return {
          v: VERSION,
          requestId,
          opId,
          op: OP,
          idempotencyKey,
          status: "failed",
          outcome: { type: "failed", time, failure: { code: "validation.failed", message: failure.message, retryable: false } },
          accepted: false,
          failure: { code: "validation.failed", message: failure.message, retryable: false },
        } satisfies SessionCommandFailed
      }

      const canonDir = canonicalDirectory(req.context.directory)
      const sid = SessionID.make(req.context.sessionId)
      const mid = MessageID.make(req.payload.messageId)

      const found = yield* session.get(sid).pipe(
        Effect.map((v) => ({ tag: "ok" as const, value: v })),
        Effect.catch((err: unknown) => {
          return Effect.succeed({ tag: "fail" as const, err })
        }),
        Effect.catchDefect((defect: unknown) => Effect.succeed({ tag: "fail" as const, err: defect })),
      )
      if (found.tag !== "ok") {
        const msg = found.err instanceof Error ? found.err.message : String(found.err)
        const isMissing = msg.toLowerCase().includes("not found") || (found.err as { _tag?: string })?._tag === "NotFoundError"
        const curCfg = yield* readCfgOmit(canonDir)
        const revision = curCfg !== undefined ? { session: 0, config: curCfg } : undefined
        if (isMissing) return buildFailed(req, "session.not_found", "session not found", false, false, revision)
        return buildFailed(req, "internal", "internal error", false, false, revision)
      }
      try {
        const stored = canonicalDirectory(found.value.directory)
        if (stored !== canonDir) {
          const curCfg = yield* readCfgOmit(canonDir)
          const revision = curCfg !== undefined ? { session: 0, config: curCfg } : undefined
          return buildFailed(req, "scope_mismatch", "directory mismatch", false, false, revision)
        }
      } catch {
        const curCfg = yield* readCfgOmit(canonDir)
        const revision = curCfg !== undefined ? { session: 0, config: curCfg } : undefined
        return buildFailed(req, "internal", "internal error", false, false, revision)
      }

      const fastRow = yield* db
        .select()
        .from(SessionOperationTable)
        .where(eq(SessionOperationTable.op_id, req.opId))
        .get()
        .pipe(
          Effect.map((v) => v as typeof SessionOperationTable.$inferSelect | undefined),
          Effect.catch(() => Effect.succeed(undefined as typeof SessionOperationTable.$inferSelect | undefined)),
          Effect.catchDefect(() => Effect.succeed(undefined as typeof SessionOperationTable.$inferSelect | undefined)),
        )
      if (fastRow) {
        if ((fastRow.session_id as unknown as string) !== (sid as unknown as string)) {
          const curCfg = yield* readCfgOmit(canonDir)
          const revision = curCfg !== undefined ? { session: 0, config: curCfg } : undefined
          return buildFailed(req, "scope_mismatch", "message belongs to another session", false, false, revision)
        }
        let fastRec: SessionOperation.FailureRecord
        try {
          fastRec = (SessionOperation as unknown as { validatedRowToRecord: (row: unknown) => SessionOperation.FailureRecord }).validatedRowToRecord(fastRow as unknown)
        } catch (e) {
          const curCfg = yield* readCfgOmit(canonDir)
          const revision = curCfg !== undefined ? { session: 0, config: curCfg } : undefined
          const detail = e instanceof Error ? e.message : String(e)
          return buildFailed(req, "internal", "internal error", false, false, revision, detail)
        }
        try {
          if (fastRec.opId !== req.opId) throw new TypeError(`opId mismatch ${fastRec.opId} vs ${req.opId}`)
          if (fastRec.opKind !== "prompt") throw new TypeError(`opKind must be prompt for prompt replay, got ${fastRec.opKind}`)
        } catch (e) {
          const curCfg = yield* readCfgOmit(canonDir)
          const revision = curCfg !== undefined ? { session: 0, config: curCfg } : undefined
          const detail = e instanceof Error ? e.message : String(e)
          return buildFailed(req, "internal", "internal error", false, false, revision, detail)
        }
        if (fastRec.outcome === "in-flight" || fastRec.outcome === "succeeded") {
          const curCfg = yield* readCfgOmit(canonDir)
          const revision = curCfg !== undefined ? { session: 0, config: curCfg } : undefined
          return buildSucceeded(req, revision)
        }
        const curCfg = yield* readCfgOmit(canonDir)
        const revision = curCfg !== undefined ? { session: 0, config: curCfg } : undefined
        const retryable = fastRec.code === "InstanceUnavailableDuringConfigRebuild"
        return buildFailed(req, fastRec.code, fastRec.message, retryable, false, revision)
      }

      const existing = yield* MessageV2.get({ sessionID: sid, messageID: mid }).pipe(
        Effect.map((v) => ({ tag: "found" as const, value: v })),
        Effect.catchTag("NotFoundError", () => Effect.succeed({ tag: "missing" as const })),
        Effect.catch(() => Effect.succeed({ tag: "missing" as const })),
        Effect.catchDefect(() => Effect.succeed({ tag: "missing" as const })),
      )
      if (existing.tag === "found") {
        if (existing.value.info.role !== "user") {
          const curCfg = yield* readCfgOmit(canonDir)
          const revision = curCfg !== undefined ? { session: 0, config: curCfg } : undefined
          return buildFailed(req, "validation.failed", "messageID already in use by non-user message", false, false, revision)
        }
        const curCfg = yield* readCfgOmit(canonDir)
        const revision = curCfg !== undefined ? { session: 0, config: curCfg } : undefined
        return buildSucceeded(req, revision)
      }
      const global = yield* db
        .select({ session: MessageTable.session_id })
        .from(MessageTable)
        .where(eq(MessageTable.id, mid))
        .get()
        .pipe(Effect.orDie)
      if (global && (global.session as unknown as string) !== (sid as unknown as string)) {
        const curCfg = yield* readCfgOmit(canonDir)
        const revision = curCfg !== undefined ? { session: 0, config: curCfg } : undefined
        return buildFailed(req, "scope_mismatch", "message belongs to another session", false, false, revision)
      }

      const acquired = yield* acquireDrainControl(canonDir).pipe(
        Effect.map((v) => ({ tag: "ok" as const, value: v })),
        Effect.catch((err: unknown) => {
          const fence = err instanceof InstanceUnavailableDuringConfigRebuildError
          const code = fence ? "InstanceUnavailableDuringConfigRebuild" : "internal"
          const message = err instanceof Error ? err.message : String(err)
          return Effect.succeed({ tag: "fail" as const, code, message, retryable: fence })
        }),
        Effect.catchDefect((defect: unknown) =>
          Effect.succeed({ tag: "fail" as const, code: "internal", message: String(defect), retryable: false }),
        ),
      )
      if (acquired.tag !== "ok") {
        const curCfg = yield* readCfgOmit(canonDir)
        const revision = curCfg !== undefined ? { session: 0, config: curCfg } : undefined
        return buildFailed(req, acquired.code, acquired.message, acquired.retryable, false, revision)
      }

      const ctx = acquired.value.ctx
      const release = acquired.value.release
      let transferred = false
      const doReleaseIfNeeded = Effect.gen(function* () {
        if (!transferred) yield* release.pipe(Effect.catch(() => Effect.void), Effect.catchDefect(() => Effect.void))
      })

      const result = yield* Effect.gen(function* () {
        // command existence precheck must use correct InstanceRef
        const cmd = yield* commands.get(req.payload.command).pipe(
          Effect.provideService(InstanceRef, ctx),
          Effect.map((v) => ({ tag: "ok" as const, value: v })),
          Effect.catch(() => Effect.succeed({ tag: "fail" as const })),
          Effect.catchDefect(() => Effect.succeed({ tag: "fail" as const })),
        )
        if (cmd.tag === "fail" || !cmd.value) {
          const available = yield* commands.list().pipe(
            Effect.provideService(InstanceRef, ctx),
            Effect.map((list) => list.map((c) => c.name).sort()),
            Effect.catch(() => Effect.succeed([] as string[])),
            Effect.catchDefect(() => Effect.succeed([] as string[])),
          )
          const hint = available.length ? ` Available commands: ${available.join(", ")}` : ""
          const message = `Command not found: "${req.payload.command}".${hint}`
          yield* events
            .publish(Session.Event.Error, {
              sessionID: sid,
              error: new NamedError.Unknown({ message }).toObject(),
            } as never)
            .pipe(Effect.catch(() => Effect.void), Effect.catchDefect(() => Effect.void))
          const curCfg = yield* readCfgOmit(canonDir)
          const revision = curCfg !== undefined ? { session: 0, config: curCfg } : undefined
          return buildFailed(req, "command.not_found", message, false, false, revision) as SessionCommandResult
        }

        const input = {
          sessionID: sid,
          messageID: mid,
          command: req.payload.command,
          arguments: req.payload.arguments,
          ...(req.payload.model ? { model: req.payload.model as string } : {}),
          ...(req.payload.agent ? { agent: req.payload.agent as string } : {}),
          ...(req.payload.variant ? { variant: req.payload.variant as string } : {}),
          ...(req.payload.parts ? { parts: req.payload.parts as never } : {}),
          ...(req.payload.snapshotInitialization ? { snapshotInitialization: req.payload.snapshotInitialization as "wait" } : {}),
        }

        const inceptionExit = yield* SessionOperation.ensurePromptInFlight(db, sid, req.opId).pipe(Effect.exit)
        if (inceptionExit._tag === "Failure") {
          const curCfg = yield* readCfgOmit(canonDir)
          const revision = curCfg !== undefined ? { session: 0, config: curCfg } : undefined
          const detail = Cause.pretty(inceptionExit.cause)
          return buildFailed(req, "internal", "internal error", false, false, revision, detail) as SessionCommandResult
        }
        const inception = inceptionExit.value
        if (!inception.fresh) {
          if (inception.rowSessionId !== (sid as unknown as string)) {
            const curCfg = yield* readCfgOmit(canonDir)
            const revision = curCfg !== undefined ? { session: 0, config: curCfg } : undefined
            return buildFailed(req, "scope_mismatch", "message belongs to another session", false, false, revision) as SessionCommandResult
          }
          if (inception.record.outcome === "in-flight" || inception.record.outcome === "succeeded") {
            const curCfg = yield* readCfgOmit(canonDir)
            const revision = curCfg !== undefined ? { session: 0, config: curCfg } : undefined
            return buildSucceeded(req, revision) as SessionCommandResult
          }
          const curCfg = yield* readCfgOmit(canonDir)
          const revision = curCfg !== undefined ? { session: 0, config: curCfg } : undefined
          const retryable = inception.record.code === "InstanceUnavailableDuringConfigRebuild"
          return buildFailed(req, inception.record.code, inception.record.message, retryable, false, revision) as SessionCommandResult
        }
        commandInflight.set(req.opId, sid)
        if ((inception as { entry?: { seq: number; session_id: string; revision: number; kind: string; time: number } }).entry) {
          const entry = (inception as { entry: { seq: number; session_id: string; revision: number; kind: string; time: number } }).entry
          yield* Effect.gen(function* () {
            const opt = yield* Effect.serviceOption(PrivatePeerService)
            if (opt._tag === "None") return
            const peer = opt.value
            const payload = {
              v: OBSERVATION_VERSION,
              cursor: entry.seq,
              entries: [{ seq: entry.seq, session_id: entry.session_id, revision: entry.revision, kind: entry.kind, time: entry.time }],
            }
            yield* peer.notify(OBSERVATION_NOTIFICATION, payload).pipe(Effect.catch(() => Effect.void), Effect.catchDefect(() => Effect.void))
          }).pipe(Effect.catch(() => Effect.void), Effect.catchDefect(() => Effect.void))
        }
        const run = Effect.gen(function* () {
          const exit = yield* promptSvc.command(input as unknown as Parameters<typeof promptSvc.command>[0]).pipe(Effect.exit)
          if (exit._tag === "Success") {
            if (isAbortedSuccess(exit.value)) {
              yield* terminalizeCommand(req.opId, sid, "abandoned", "prompt.abandoned", "prompt abandoned")
            } else {
              yield* terminalizeCommand(req.opId, sid, "succeeded", "prompt.succeeded", "prompt succeeded")
            }
          } else {
            const cause = exit.cause
            if (Cause.hasInterruptsOnly(cause)) {
              yield* terminalizeCommand(req.opId, sid, "abandoned", "prompt.abandoned", "prompt abandoned")
            } else {
              const err = Cause.squash(cause)
              const raw = err instanceof Error ? err.message : String(err)
              const detail = Cause.pretty(cause)
              yield* terminalizeCommand(req.opId, sid, "failed", "prompt.failed", raw, detail)
              yield* Effect.logError("command_async private failed").pipe(Effect.annotateLogs({ sessionID: sid as unknown as string, cause }))
              yield* events
                .publish("session.error" as never, {
                  sessionID: sid,
                  error: AgentRequirementError.isInstance(err)
                    ? (err as unknown as { toObject: () => unknown }).toObject()
                    : new NamedError.Unknown({ message: Cause.pretty(cause) }).toObject(),
                } as never)
                .pipe(Effect.catch(() => Effect.void), Effect.catchDefect(() => Effect.void))
            }
          }
        }).pipe(Effect.provideService(InstanceRef, ctx), Effect.ensuring(release))
        yield* Effect.forkIn(layerScope)(run).pipe(Effect.asVoid, Effect.ignore)
        transferred = true
        const curCfg = yield* readCfgOmit(canonDir)
        const revision = curCfg !== undefined ? { session: 0, config: curCfg } : undefined
        return buildSucceeded(req, revision) as SessionCommandResult
      }).pipe(Effect.ensuring(doReleaseIfNeeded))

      return result
    })

    return { dispatch }
  }),
)
