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
import { NamedError } from "@opencode-ai/core/util/error"
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
  // Canonical tuple reuses the durable prompt identity: the same user message
  // is the authority for prompt and command, so no new operation kind/table.
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
    // Layer-owned scope for the accept-only background run. forkIn keeps
    // dispatch immediate-return while the fiber is interrupted when the layer
    // scope closes; inner generation still converges via SessionPrompt owners.
    const layerScope = yield* Scope.Scope
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

      // Sync command-exists precheck before accept: preserves the current
      // synchronous command observable error semantics as terminal non-retryable.
      const cmd = yield* commands.get(req.payload.command).pipe(
        Effect.map((v) => ({ tag: "ok" as const, value: v })),
        Effect.catch(() => Effect.succeed({ tag: "fail" as const })),
        Effect.catchDefect(() => Effect.succeed({ tag: "fail" as const })),
      )
      if (cmd.tag === "fail" || !cmd.value) {
        const available = yield* commands.list().pipe(
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
        return buildFailed(req, "command.not_found", message, false, false, revision)
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
      const ctx = acquired.value.ctx
      const release = acquired.value.release
      const run = promptSvc
        .command(input as unknown as Parameters<typeof promptSvc.command>[0])
        .pipe(
          Effect.catchCause((cause) => {
            if (Cause.hasInterruptsOnly(cause)) return Effect.void
            return Effect.gen(function* () {
              yield* Effect.logError("command_async private failed").pipe(Effect.annotateLogs({ sessionID: sid as unknown as string, cause }))
              const error = Cause.squash(cause)
              yield* events
                .publish("session.error" as never, {
                  sessionID: sid,
                  error: AgentRequirementError.isInstance(error)
                    ? (error as unknown as { toObject: () => unknown }).toObject()
                    : new NamedError.Unknown({ message: Cause.pretty(cause) }).toObject(),
                } as never)
                .pipe(Effect.catch(() => Effect.void), Effect.catchDefect(() => Effect.void))
            })
          }),
          Effect.provideService(InstanceRef, ctx),
          Effect.ensuring(release),
        )
      yield* Effect.forkIn(layerScope)(run).pipe(Effect.asVoid, Effect.ignore)
      const curCfg = yield* readCfgOmit(canonDir)
      const revision = curCfg !== undefined ? { session: 0, config: curCfg } : undefined
      return buildSucceeded(req, revision)
    })

    return { dispatch }
  }),
)
