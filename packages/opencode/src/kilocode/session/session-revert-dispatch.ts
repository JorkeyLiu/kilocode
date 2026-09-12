import { isAbsolute } from "path"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { canonicalDirectory } from "@/kilocode/session/canonical-directory"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionOperation } from "@opencode-ai/core/session/operation"
import { SessionRevision } from "@opencode-ai/core/session/revision"
import { ConfigConvergence } from "@/kilocode/server/config-convergence"
import { GenerationGate } from "@/kilocode/server/generation-gate"
import { eq } from "drizzle-orm"
import { SessionID, MessageID, PartID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionRevert } from "@/session/revert"
import { Log } from "@opencode-ai/core/util/log"
import { InstanceRef } from "@/effect/instance-ref"
import { acquireDrainControl } from "@/kilocode/server/drain-control-acquire"

export const VERSION = 1 as const
export const REVERT_OP = "session/revert" as const
export const UNREVERT_OP = "session/unrevert" as const

export interface SessionRevertRequest {
  v: typeof VERSION
  requestId: string
  opId: string
  op: typeof REVERT_OP
  idempotencyKey: string
  context: {
    directory: string
    sessionId: string
    parentSessionId?: string | null
    configVersion?: number
    sessionRevision?: number
  }
  payload: {
    messageId?: string | null
    partId?: string | null
  }
}

export interface SessionUnrevertRequest {
  v: typeof VERSION
  requestId: string
  opId: string
  op: typeof UNREVERT_OP
  idempotencyKey: string
  context: {
    directory: string
    sessionId: string
    parentSessionId?: string | null
    configVersion?: number
    sessionRevision?: number
  }
  payload: Record<string, never>
}

export type Revision = { session: number; config: number }

export interface CheckpointSucceeded {
  v: typeof VERSION
  requestId: string
  opId: string
  op: typeof REVERT_OP | typeof UNREVERT_OP
  idempotencyKey: string
  status: "succeeded"
  outcome: { type: "succeeded"; time: number }
  accepted: true
  data: Session.Info
  revision?: Revision
}

export interface CheckpointPrivateSucceeded {
  v: typeof VERSION
  requestId: string
  opId: string
  op: typeof REVERT_OP | typeof UNREVERT_OP
  idempotencyKey: string
  status: "succeeded"
  outcome: { type: "succeeded"; time: number }
  accepted: true
  data: { session: Session.Info }
  revision?: Revision
}

export interface CheckpointFailed {
  v: typeof VERSION
  requestId: string
  opId: string
  op: typeof REVERT_OP | typeof UNREVERT_OP
  idempotencyKey: string
  status: "failed"
  outcome: { type: "failed"; time: number; failure: { code: string; message: string; retryable: boolean; detail?: string } }
  accepted: boolean
  failure: { code: string; message: string; retryable: boolean; detail?: string }
  revision?: Revision
}

export type CheckpointResult = CheckpointSucceeded | CheckpointFailed
export type CheckpointPrivateResult = CheckpointPrivateSucceeded | CheckpointFailed

function isNonEmptyString(v: unknown): boolean {
  return typeof v === "string" && v.length > 0
}
function isSafeInt(v: unknown): boolean {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && Number.isSafeInteger(v)
}
export { canonicalDirectory } from "@/kilocode/session/canonical-directory"

function checkContext(c: Record<string, unknown>, kind: "revert" | "unrevert") {
  if (typeof c.directory !== "string" || !isAbsolute(c.directory)) throw new Error("context.directory must be absolute path")
  canonicalDirectory(c.directory as string)
  if (typeof c.sessionId !== "string" || !Schema.is(SessionID)(c.sessionId)) throw new Error("context.sessionId must be SessionID")
  if (!("parentSessionId" in c) || (c.parentSessionId !== null && c.parentSessionId !== undefined)) {
    if (c.parentSessionId !== null && c.parentSessionId !== undefined) throw new Error("context.parentSessionId must be null")
  }
  if ("configVersion" in c && c.configVersion !== undefined && !isSafeInt(c.configVersion))
    throw new Error("context.configVersion must be integer >=0")
  if ("sessionRevision" in c && c.sessionRevision !== undefined && !isSafeInt(c.sessionRevision))
    throw new Error("context.sessionRevision must be integer >=0")
  void kind
}

export function validateRevertRequest(raw: unknown): SessionRevertRequest {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("params must be object")
  const o = raw as Record<string, unknown>
  if (o.v !== VERSION) throw new Error(`unsupported session version: ${String(o.v)} — expected numeric ${VERSION}`)
  if (!isNonEmptyString(o.requestId)) throw new Error("requestId must be non-empty string")
  if (!isNonEmptyString(o.opId)) throw new Error("opId must be non-empty string")
  if (o.op !== REVERT_OP) throw new Error(`op must be ${REVERT_OP}`)
  if (!isNonEmptyString(o.idempotencyKey)) throw new Error("idempotencyKey must be non-empty string")
  if (o.idempotencyKey !== o.opId) throw new Error("idempotencyKey must equal opId for revert")
  const ctx = o.context
  if (ctx === null || typeof ctx !== "object" || Array.isArray(ctx)) throw new Error("context must be object")
  const c = ctx as Record<string, unknown>
  checkContext(c, "revert")
  const payload = o.payload
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) throw new Error("payload must be object")
  const p = payload as Record<string, unknown>
  if ("messageId" in p && p.messageId !== null && p.messageId !== undefined) {
    if (typeof p.messageId !== "string" || !Schema.is(MessageID)(p.messageId as string))
      throw new Error("payload.messageId must be MessageID")
  }
  if ("partId" in p && p.partId !== null && p.partId !== undefined) {
    if (typeof p.partId !== "string" || !Schema.is(PartID)(p.partId as string))
      throw new Error("payload.partId must be PartID")
  }
  const allowedRoot = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "context", "payload"])
  for (const k of Object.keys(o)) if (!allowedRoot.has(k)) throw new Error(`unexpected field ${k}`)
  const allowedCtx = new Set(["directory", "sessionId", "parentSessionId", "configVersion", "sessionRevision"])
  for (const k of Object.keys(c)) if (!allowedCtx.has(k)) throw new Error(`unexpected context field ${k}`)
  const allowedPayload = new Set(["messageId", "partId"])
  for (const k of Object.keys(p)) if (!allowedPayload.has(k)) throw new Error(`unexpected payload field ${k}`)
  try {
    SessionOperation.parseRevertOpIdForSession(o.opId as string, c.sessionId as string)
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : String(e))
  }
  try {
    SessionOperation.parseRevertOpIdForSession(o.idempotencyKey as string, c.sessionId as string)
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : String(e))
  }
  return o as unknown as SessionRevertRequest
}

export function validateUnrevertRequest(raw: unknown): SessionUnrevertRequest {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("params must be object")
  const o = raw as Record<string, unknown>
  if (o.v !== VERSION) throw new Error(`unsupported session version: ${String(o.v)} — expected numeric ${VERSION}`)
  if (!isNonEmptyString(o.requestId)) throw new Error("requestId must be non-empty string")
  if (!isNonEmptyString(o.opId)) throw new Error("opId must be non-empty string")
  if (o.op !== UNREVERT_OP) throw new Error(`op must be ${UNREVERT_OP}`)
  if (!isNonEmptyString(o.idempotencyKey)) throw new Error("idempotencyKey must be non-empty string")
  if (o.idempotencyKey !== o.opId) throw new Error("idempotencyKey must equal opId for unrevert")
  const ctx = o.context
  if (ctx === null || typeof ctx !== "object" || Array.isArray(ctx)) throw new Error("context must be object")
  const c = ctx as Record<string, unknown>
  checkContext(c, "unrevert")
  const payload = o.payload
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) throw new Error("payload must be object")
  const p = payload as Record<string, unknown>
  const allowedRoot = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "context", "payload"])
  for (const k of Object.keys(o)) if (!allowedRoot.has(k)) throw new Error(`unexpected field ${k}`)
  const allowedCtx = new Set(["directory", "sessionId", "parentSessionId", "configVersion", "sessionRevision"])
  for (const k of Object.keys(c)) if (!allowedCtx.has(k)) throw new Error(`unexpected context field ${k}`)
  for (const k of Object.keys(p)) throw new Error(`unexpected payload field ${k}`)
  try {
    SessionOperation.parseUnrevertOpIdForSession(o.opId as string, c.sessionId as string)
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : String(e))
  }
  try {
    SessionOperation.parseUnrevertOpIdForSession(o.idempotencyKey as string, c.sessionId as string)
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : String(e))
  }
  return o as unknown as SessionUnrevertRequest
}

function buildFailed(
  req: { requestId: string; opId: string; op: typeof REVERT_OP | typeof UNREVERT_OP; idempotencyKey: string },
  kind: "revert" | "unrevert",
  code: string,
  message: string,
  retryable: boolean,
  accepted: boolean,
  revision: Revision | undefined,
  detail?: string,
): CheckpointFailed {
  const normalized = SessionOperation.normalizeRecord({
    opId: req.opId,
    opKind: kind,
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
    op: req.op,
    idempotencyKey: req.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time, failure },
    accepted,
    failure,
    ...(revision !== undefined ? { revision } : {}),
  } as CheckpointFailed
}

function buildSucceeded(
  req: { requestId: string; opId: string; op: typeof REVERT_OP | typeof UNREVERT_OP; idempotencyKey: string },
  data: Session.Info,
  revision: Revision | undefined,
): CheckpointSucceeded {
  return {
    v: VERSION,
    requestId: req.requestId,
    opId: req.opId,
    op: req.op,
    idempotencyKey: req.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: Date.now() },
    accepted: true,
    data,
    ...(revision !== undefined ? { revision } : {}),
  } as CheckpointSucceeded
}

function buildPrivateSucceeded(
  req: { requestId: string; opId: string; op: typeof REVERT_OP | typeof UNREVERT_OP; idempotencyKey: string },
  data: Session.Info,
  revision: Revision | undefined,
): CheckpointPrivateSucceeded {
  return {
    v: VERSION,
    requestId: req.requestId,
    opId: req.opId,
    op: req.op,
    idempotencyKey: req.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: Date.now() },
    accepted: true,
    data: { session: data },
    ...(revision !== undefined ? { revision } : {}),
  } as CheckpointPrivateSucceeded
}

function makeRevision(session: number | undefined, config: number | undefined): Revision | undefined {
  return session !== undefined && config !== undefined ? { session, config } : undefined
}

function infoFromSnapshot(snapshot: unknown): Session.Info | undefined {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return undefined
  try {
    const cleaned = JSON.parse(JSON.stringify(snapshot))
    return Schema.decodeUnknownSync(Session.Info)(cleaned) as unknown as Session.Info
  } catch {
    return undefined
  }
}

function mapRevertFailure(tag: string, detail?: string): { code: string; retryable: boolean } {
  const hay = `${tag} ${detail ?? ""}`
  if (hay.includes("SessionBusyError")) return { code: "busy", retryable: false }
  if (hay.includes("SnapshotPathError") || hay.includes("SnapshotJournalPathError")) return { code: "validation.failed", retryable: false }
  return { code: "internal", retryable: false }
}

function tagOfCause(cause: unknown): { tag: string; message: string } {
  const c = cause as { error?: { _tag?: string; message?: string }; _tag?: string; message?: string } | undefined
  const err = c?.error as { _tag?: string; message?: string } | undefined
  if (err && typeof err._tag === "string") return { tag: err._tag, message: typeof err.message === "string" ? err.message : String(cause) }
  try {
    const s = JSON.stringify(cause)
    if (s.includes("SessionBusyError")) return { tag: "SessionBusyError", message: s.slice(0, 500) }
    if (s.includes("SnapshotPathError")) return { tag: "SnapshotPathError", message: s.slice(0, 500) }
    if (s.includes("SnapshotJournalPathError")) return { tag: "SnapshotJournalPathError", message: s.slice(0, 500) }
  } catch {}
  const msg = cause instanceof Error ? cause.message : String(cause)
  return { tag: (c as { _tag?: string } | undefined)?._tag ?? "UnknownError", message: msg }
}

export interface RevertDispatch {
  readonly dispatchRevert: (request: unknown) => Effect.Effect<CheckpointResult, unknown, unknown>
  readonly dispatchPrivateRevert: (request: unknown) => Effect.Effect<CheckpointPrivateResult, unknown, unknown>
  readonly dispatchUnrevert: (request: unknown) => Effect.Effect<CheckpointResult, unknown, unknown>
  readonly dispatchPrivateUnrevert: (request: unknown) => Effect.Effect<CheckpointPrivateResult, unknown, unknown>
}

export class SessionRevertDispatchService extends Context.Service<SessionRevertDispatchService, RevertDispatch>()(
  "SessionRevertDispatch",
) {}

const log = Log.create({ service: "sessionRevert" })
void log

export const layer = Layer.effect(
  SessionRevertDispatchService,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const cfg = Option.getOrElse(yield* Effect.serviceOption(ConfigConvergence.Service), () => ConfigConvergence.noop)
    const gate = Option.getOrElse(yield* Effect.serviceOption(GenerationGate.Service), () => GenerationGate.noop)
    const revertSvc = yield* SessionRevert.Service

    const getSessionRev = (sid: SessionID) => SessionRevision.get(db, sid) as Effect.Effect<number | undefined>
    const getConfigVer = (dir: string) => cfg.getBootedVersion(dir) as Effect.Effect<number | undefined>
    const readSessionRev = (sid: SessionID) =>
      getSessionRev(sid).pipe(
        Effect.map((v) => ({ _tag: "Right" as const, right: v as number | undefined })),
        Effect.catch((e: unknown) => Effect.succeed({ _tag: "Left" as const, left: e })),
        Effect.catchDefect((e: unknown) => Effect.succeed({ _tag: "Left" as const, left: e })),
      ) as unknown as Effect.Effect<{ _tag: "Right"; right: number | undefined } | { _tag: "Left"; left: unknown }>
    const readConfigVer = (dir: string) =>
      getConfigVer(dir).pipe(
        Effect.map((v) => ({ _tag: "Right" as const, right: v as number | undefined })),
        Effect.catch((e: unknown) => Effect.succeed({ _tag: "Left" as const, left: e })),
        Effect.catchDefect((e: unknown) => Effect.succeed({ _tag: "Left" as const, left: e })),
      ) as unknown as Effect.Effect<{ _tag: "Right"; right: number | undefined } | { _tag: "Left"; left: unknown }>
    const isLeft = (e: unknown): boolean => (e as { _tag: string })._tag === "Left"
    const rightValue = (e: unknown): unknown => (e as { right: unknown }).right
    const readRevOmit = (sid: SessionID) =>
      Effect.gen(function* () {
        const either = yield* readSessionRev(sid)
        return isLeft(either) ? undefined : (rightValue(either) as number | undefined)
      })
    const readCfgOmit = (dir: string) =>
      Effect.gen(function* () {
        const either = yield* readConfigVer(dir)
        return isLeft(either) ? undefined : (rightValue(either) as number | undefined)
      })

    const withDrain = <A>(
      dir: string,
      kind: "revert" | "unrevert",
      marker: { requestId: string; opId: string; op: typeof REVERT_OP | typeof UNREVERT_OP; idempotencyKey: string },
      run: (release: Effect.Effect<void>) => Effect.Effect<A>,
    ) =>
      Effect.gen(function* () {
        const maybeRef = yield* Effect.serviceOption(InstanceRef)
        if (Option.isSome(maybeRef) && maybeRef.value !== undefined) return yield* run(Effect.void)
        const acquired = yield* acquireDrainControl(dir).pipe(
          Effect.map((v) => ({ tag: "ok" as const, value: v })),
          Effect.catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err)
            const fence = (err as { _tag?: string })?._tag === "InstanceUnavailableDuringConfigRebuild" || msg.includes("Instance is unavailable")
            return Effect.succeed({ tag: "fail" as const, fence, msg })
          }),
          Effect.catchDefect((defect: unknown) => Effect.succeed({ tag: "fail" as const, fence: false, msg: String(defect) })),
        )
        if ((acquired as { tag: string }).tag === "fail") {
          const fail = acquired as { fence: boolean; msg: string }
          return buildFailed(marker, kind, fail.fence ? "InstanceUnavailableDuringConfigRebuild" : "internal", fail.msg, fail.fence, false, undefined) as unknown as A
        }
        const ok = acquired as { tag: "ok"; value: { ctx: unknown; release: Effect.Effect<void> } }
        const out = yield* run(ok.value.release).pipe(Effect.provideService(InstanceRef, ok.value.ctx as never))
        return out
      })

    const checkScope = (sessionId: SessionID, canonDir: string) =>
      Effect.gen(function* () {
        const row = yield* db.select({ directory: SessionTable.directory }).from(SessionTable).where(eq(SessionTable.id, sessionId)).get().pipe(Effect.orDie)
        if (!row) return { ok: false as const, reason: "missing" as const }
        const stored = canonicalDirectory((row as unknown as { directory: string }).directory)
        if (stored !== canonDir) return { ok: false as const, reason: "mismatch" as const }
        return { ok: true as const }
      })

    const checkFresh = (req: SessionRevertRequest | SessionUnrevertRequest, sessionId: SessionID, canonDir: string) =>
      Effect.gen(function* () {
        const revEither = yield* readSessionRev(sessionId)
        if (isLeft(revEither)) return { ok: false as const, code: "internal" as const, message: "revision read failed" }
        const cfgEither = yield* readConfigVer(canonDir)
        if (isLeft(cfgEither)) return { ok: false as const, code: "internal" as const, message: "config version read failed" }
        const actualRev = rightValue(revEither) as number | undefined
        const currentCfg = rightValue(cfgEither) as number | undefined
        if (req.context.sessionRevision !== undefined && actualRev !== undefined && req.context.sessionRevision < actualRev)
          return { ok: false as const, code: "stale" as const, message: "stale sessionRevision" }
        if (req.context.configVersion !== undefined && currentCfg !== undefined && req.context.configVersion < currentCfg)
          return { ok: false as const, code: "stale" as const, message: "stale configVersion" }
        if (req.context.configVersion !== undefined && currentCfg === undefined)
          return { ok: false as const, code: "internal" as const, message: "config version unavailable" }
        return { ok: true as const, rev: actualRev, cfg: currentCfg }
      })

    const persistSucceeded = (
      kind: "revert" | "unrevert",
      sessionId: SessionID,
      req: SessionRevertRequest | SessionUnrevertRequest,
      hash: string,
      info: Session.Info,
      rev: number | undefined,
      cfg: number | undefined,
    ) =>
      Effect.gen(function* () {
        const snapshotJson = JSON.stringify(info)
        const record = { opId: req.opId, opKind: kind, outcome: "succeeded", code: `${kind}.succeeded`, message: `${kind} succeeded`, time: Date.now() } as const
        const meta = {
          idempotencyHash: hash,
          requestId: req.requestId,
          directory: canonicalDirectory(req.context.directory),
          parentSessionId: req.context.parentSessionId ?? null,
          configVersion: req.context.configVersion ?? null,
          sessionRevision: req.context.sessionRevision ?? null,
          messageId: (req as SessionRevertRequest).payload?.messageId ?? null,
          partId: (req as SessionRevertRequest).payload?.partId ?? null,
        }
        const inserted = yield* db.transaction((tx) =>
          Effect.gen(function* () {
            if (kind === "revert") {
              const already = yield* SessionOperation.getSessionRevertByIdempotencyHashTx(tx as never, sessionId, hash)
              if (already) return already
              const opExists = yield* SessionOperation.getTx(tx as never, req.opId)
              if (opExists) yield* Effect.fail(new Error("opId already exists with different idempotencyKey"))
              return yield* SessionOperation.insertSessionRevertSucceededTx(tx as never, sessionId, record as never, meta, snapshotJson)
            }
            const already = yield* SessionOperation.getSessionUnrevertByIdempotencyHashTx(tx as never, sessionId, hash)
            if (already) return already
            const opExists = yield* SessionOperation.getTx(tx as never, req.opId)
            if (opExists) yield* Effect.fail(new Error("opId already exists with different idempotencyKey"))
            return yield* SessionOperation.insertSessionUnrevertSucceededTx(tx as never, sessionId, record as never, meta, snapshotJson)
          }),
        )
        void rev
        void cfg
        return inserted
      })

    const dispatchRevert = Effect.fn("SessionRevertDispatch.dispatchRevert")(function* (raw: unknown) {
      let req: SessionRevertRequest
      try {
        req = validateRevertRequest(raw)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        const fallback = raw as Record<string, unknown>
        return {
          v: VERSION,
          requestId: typeof fallback?.requestId === "string" ? fallback.requestId : "unknown",
          opId: typeof fallback?.opId === "string" ? fallback.opId : "unknown",
          op: REVERT_OP,
          idempotencyKey: typeof fallback?.idempotencyKey === "string" ? fallback.idempotencyKey : "unknown",
          status: "failed",
          outcome: { type: "failed", time: Date.now(), failure: { code: "validation.failed", message: msg, retryable: false } },
          accepted: false,
          failure: { code: "validation.failed", message: msg, retryable: false },
        } satisfies CheckpointFailed
      }
      const canonDir = canonicalDirectory(req.context.directory)
      const sessionId = SessionID.make(req.context.sessionId)
      const hash = SessionOperation.hashIdempotencyKey(req.idempotencyKey)
      const run = (drainRelease: Effect.Effect<void>) =>
        Effect.gen(function* () {
          const existing = yield* SessionOperation.getSessionRevertByIdempotencyHash(db, sessionId, hash).pipe(Effect.orDie)
          if (existing) {
            const conflict = SessionOperation.isSessionCheckpointConflict(existing, {
              opId: req.opId,
              directory: canonDir,
              parentSessionId: req.context.parentSessionId ?? null,
              configVersion: req.context.configVersion ?? null,
              sessionRevision: req.context.sessionRevision ?? null,
              messageId: req.payload.messageId ?? null,
              partId: req.payload.partId ?? null,
            })
            if (conflict) return buildFailed(req, "revert", "conflict", "idempotencyKey conflict: different operation facts with same key", false, false, makeRevision(yield* readRevOmit(sessionId), yield* readCfgOmit(canonDir)))
            if (existing.outcome === "succeeded") {
              const persisted = infoFromSnapshot((existing as unknown as { resultSnapshot: unknown }).resultSnapshot)
              if (!persisted) return buildFailed(req, "revert", "internal", "invalid persisted snapshot", false, false, makeRevision(yield* readRevOmit(sessionId), yield* readCfgOmit(canonDir)))
              return buildSucceeded(req, persisted, makeRevision((existing as unknown as { revision: number }).revision, yield* readCfgOmit(canonDir)))
            }
            return buildFailed(req, "revert", existing.code, existing.message, false, false, makeRevision(yield* readRevOmit(sessionId), yield* readCfgOmit(canonDir)))
          }
          const scope = yield* checkScope(sessionId, canonDir)
          if (!scope.ok) {
            if (scope.reason === "missing") return buildFailed(req, "revert", "session.not_found", `session not found ${sessionId}`, false, false, makeRevision(undefined, yield* readCfgOmit(canonDir)))
            return buildFailed(req, "revert", "scope_mismatch", `directory mismatch for session ${sessionId}`, false, false, makeRevision(yield* readRevOmit(sessionId), yield* readCfgOmit(canonDir)))
          }
          const opExists = yield* SessionOperation.get(db, req.opId).pipe(Effect.orDie)
          if (opExists) return buildFailed(req, "revert", "conflict", "opId already exists with different idempotencyKey", false, false, makeRevision(yield* readRevOmit(sessionId), yield* readCfgOmit(canonDir)))
          if (req.context.configVersion !== undefined && gate.isBarrierActive(canonDir))
            return buildFailed(req, "revert", "InstanceUnavailableDuringConfigRebuild", "instance unavailable during config rebuild", true, false, makeRevision(yield* readRevOmit(sessionId), yield* readCfgOmit(canonDir)))
          const leaseRelease: Effect.Effect<void> = req.context.configVersion !== undefined ? yield* gate.acquire(canonDir) : Effect.void
          const out: CheckpointResult = yield* Effect.gen(function* () {
            const fresh = yield* checkFresh(req, sessionId, canonDir)
            if (!fresh.ok) return buildFailed(req, "revert", fresh.code, fresh.message, false, false, makeRevision(yield* readRevOmit(sessionId), yield* readCfgOmit(canonDir)))
            const exit = yield* revertSvc.revert({ sessionID: sessionId, messageID: req.payload.messageId as never, partID: req.payload.partId as never }).pipe(Effect.exit)
            if (exit._tag === "Failure") {
              const found = tagOfCause(exit.cause)
              const mapped = mapRevertFailure(found.tag, found.message)
              return buildFailed(req, "revert", mapped.code, found.message.slice(0, 500), mapped.retryable, false, makeRevision(yield* readRevOmit(sessionId), yield* readCfgOmit(canonDir)))
            }
            const info = (exit as { value: Session.Info }).value
            const persistExit = yield* Effect.exit(persistSucceeded("revert", sessionId, req, hash, info, fresh.rev, fresh.cfg))
            if (persistExit._tag === "Failure") {
              const found = tagOfCause(persistExit.cause)
              const cause = found.message.slice(0, 500)
              yield* Effect.logWarning("durable checkpoint persist failed", { opId: req.opId, kind: "revert", cause }).pipe(
                Effect.catch(() => Effect.void),
                Effect.catchDefect(() => Effect.void),
              )
              return buildFailed(req, "revert", "internal", `persist failed: ${cause}`.slice(0, 500), false, false, makeRevision(yield* readRevOmit(sessionId), yield* readCfgOmit(canonDir)), cause.slice(0, 1000))
            }
            return buildSucceeded(req, info, makeRevision(yield* readRevOmit(sessionId), yield* readCfgOmit(canonDir)))
          }).pipe(Effect.ensuring(leaseRelease))
          return out
        }).pipe(Effect.ensuring(drainRelease))
      try {
        return yield* withDrain(canonDir, "revert", { requestId: req.requestId, opId: req.opId, op: REVERT_OP, idempotencyKey: req.idempotencyKey }, run)
      } catch (e) {
        if (e && typeof e === "object" && "status" in (e as Record<string, unknown>)) return e as CheckpointFailed
        throw e
      }
    })

    const dispatchPrivateRevert = Effect.fn("SessionRevertDispatch.dispatchPrivateRevert")(function* (raw: unknown) {
      let req: SessionRevertRequest
      try {
        req = validateRevertRequest(raw)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        const fallback = raw as Record<string, unknown>
        return {
          v: VERSION,
          requestId: typeof fallback?.requestId === "string" ? fallback.requestId : "unknown",
          opId: typeof fallback?.opId === "string" ? fallback.opId : "unknown",
          op: REVERT_OP,
          idempotencyKey: typeof fallback?.idempotencyKey === "string" ? fallback.idempotencyKey : "unknown",
          status: "failed",
          outcome: { type: "failed", time: Date.now(), failure: { code: "validation.failed", message: msg, retryable: false } },
          accepted: false,
          failure: { code: "validation.failed", message: msg, retryable: false },
        } satisfies CheckpointFailed
      }
      const canonDir = canonicalDirectory(req.context.directory)
      const sessionId = SessionID.make(req.context.sessionId)
      const hash = SessionOperation.hashIdempotencyKey(req.idempotencyKey)
      const existing = yield* SessionOperation.getSessionRevertByIdempotencyHash(db, sessionId, hash).pipe(Effect.orDie)
      if (!existing) return buildFailed(req, "revert", "internal", "no committed revert record", false, false, makeRevision(yield* readRevOmit(sessionId), yield* readCfgOmit(canonDir)))
      const conflict = SessionOperation.isSessionCheckpointConflict(existing, {
        opId: req.opId,
        directory: canonDir,
        parentSessionId: req.context.parentSessionId ?? null,
        configVersion: req.context.configVersion ?? null,
        sessionRevision: req.context.sessionRevision ?? null,
        messageId: req.payload.messageId ?? null,
        partId: req.payload.partId ?? null,
      })
      if (conflict) return buildFailed(req, "revert", "conflict", "idempotencyKey conflict: different operation facts with same key", false, false, makeRevision(yield* readRevOmit(sessionId), yield* readCfgOmit(canonDir)))
      const persisted = infoFromSnapshot((existing as unknown as { resultSnapshot: unknown }).resultSnapshot)
      if (!persisted) return buildFailed(req, "revert", "internal", "invalid persisted snapshot", false, false, makeRevision(yield* readRevOmit(sessionId), yield* readCfgOmit(canonDir)))
      return buildPrivateSucceeded(req, persisted, makeRevision((existing as unknown as { revision: number }).revision, yield* readCfgOmit(canonDir)))
    })

    const dispatchUnrevert = Effect.fn("SessionRevertDispatch.dispatchUnrevert")(function* (raw: unknown) {
      let req: SessionUnrevertRequest
      try {
        req = validateUnrevertRequest(raw)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        const fallback = raw as Record<string, unknown>
        return {
          v: VERSION,
          requestId: typeof fallback?.requestId === "string" ? fallback.requestId : "unknown",
          opId: typeof fallback?.opId === "string" ? fallback.opId : "unknown",
          op: UNREVERT_OP,
          idempotencyKey: typeof fallback?.idempotencyKey === "string" ? fallback.idempotencyKey : "unknown",
          status: "failed",
          outcome: { type: "failed", time: Date.now(), failure: { code: "validation.failed", message: msg, retryable: false } },
          accepted: false,
          failure: { code: "validation.failed", message: msg, retryable: false },
        } satisfies CheckpointFailed
      }
      const canonDir = canonicalDirectory(req.context.directory)
      const sessionId = SessionID.make(req.context.sessionId)
      const hash = SessionOperation.hashIdempotencyKey(req.idempotencyKey)
      const run = (drainRelease: Effect.Effect<void>) =>
        Effect.gen(function* () {
          const existing = yield* SessionOperation.getSessionUnrevertByIdempotencyHash(db, sessionId, hash).pipe(Effect.orDie)
          if (existing) {
            const conflict = SessionOperation.isSessionCheckpointConflict(existing, {
              opId: req.opId,
              directory: canonDir,
              parentSessionId: req.context.parentSessionId ?? null,
              configVersion: req.context.configVersion ?? null,
              sessionRevision: req.context.sessionRevision ?? null,
            })
            if (conflict) return buildFailed(req, "unrevert", "conflict", "idempotencyKey conflict: different operation facts with same key", false, false, makeRevision(yield* readRevOmit(sessionId), yield* readCfgOmit(canonDir)))
            const persisted = infoFromSnapshot((existing as unknown as { resultSnapshot: unknown }).resultSnapshot)
            if (!persisted) return buildFailed(req, "unrevert", "internal", "invalid persisted snapshot", false, false, makeRevision(yield* readRevOmit(sessionId), yield* readCfgOmit(canonDir)))
            return buildSucceeded(req, persisted, makeRevision((existing as unknown as { revision: number }).revision, yield* readCfgOmit(canonDir)))
          }
          const scope = yield* checkScope(sessionId, canonDir)
          if (!scope.ok) {
            if (scope.reason === "missing") return buildFailed(req, "unrevert", "session.not_found", `session not found ${sessionId}`, false, false, makeRevision(undefined, yield* readCfgOmit(canonDir)))
            return buildFailed(req, "unrevert", "scope_mismatch", `directory mismatch for session ${sessionId}`, false, false, makeRevision(yield* readRevOmit(sessionId), yield* readCfgOmit(canonDir)))
          }
          const opExists = yield* SessionOperation.get(db, req.opId).pipe(Effect.orDie)
          if (opExists) return buildFailed(req, "unrevert", "conflict", "opId already exists with different idempotencyKey", false, false, makeRevision(yield* readRevOmit(sessionId), yield* readCfgOmit(canonDir)))
          if (req.context.configVersion !== undefined && gate.isBarrierActive(canonDir))
            return buildFailed(req, "unrevert", "InstanceUnavailableDuringConfigRebuild", "instance unavailable during config rebuild", true, false, makeRevision(yield* readRevOmit(sessionId), yield* readCfgOmit(canonDir)))
          const leaseRelease: Effect.Effect<void> = req.context.configVersion !== undefined ? yield* gate.acquire(canonDir) : Effect.void
          const out: CheckpointResult = yield* Effect.gen(function* () {
            const fresh = yield* checkFresh(req, sessionId, canonDir)
            if (!fresh.ok) return buildFailed(req, "unrevert", fresh.code, fresh.message, false, false, makeRevision(yield* readRevOmit(sessionId), yield* readCfgOmit(canonDir)))
            const exit = yield* revertSvc.unrevert({ sessionID: sessionId }).pipe(Effect.exit)
            if (exit._tag === "Failure") {
              const found = tagOfCause(exit.cause)
              const mapped = mapRevertFailure(found.tag, found.message)
              return buildFailed(req, "unrevert", mapped.code, found.message.slice(0, 500), mapped.retryable, false, makeRevision(yield* readRevOmit(sessionId), yield* readCfgOmit(canonDir)))
            }
            const info = (exit as { value: Session.Info }).value
            const persistExit = yield* Effect.exit(persistSucceeded("unrevert", sessionId, req, hash, info, fresh.rev, fresh.cfg))
            if (persistExit._tag === "Failure") {
              const found = tagOfCause(persistExit.cause)
              const cause = found.message.slice(0, 500)
              yield* Effect.logWarning("durable checkpoint persist failed", { opId: req.opId, kind: "unrevert", cause }).pipe(
                Effect.catch(() => Effect.void),
                Effect.catchDefect(() => Effect.void),
              )
              return buildFailed(req, "unrevert", "internal", `persist failed: ${cause}`.slice(0, 500), false, false, makeRevision(yield* readRevOmit(sessionId), yield* readCfgOmit(canonDir)), cause.slice(0, 1000))
            }
            return buildSucceeded(req, info, makeRevision(yield* readRevOmit(sessionId), yield* readCfgOmit(canonDir)))
          }).pipe(Effect.ensuring(leaseRelease))
          return out
        }).pipe(Effect.ensuring(drainRelease))
      try {
        return yield* withDrain(canonDir, "unrevert", { requestId: req.requestId, opId: req.opId, op: UNREVERT_OP, idempotencyKey: req.idempotencyKey }, run)
      } catch (e) {
        if (e && typeof e === "object" && "status" in (e as Record<string, unknown>)) return e as CheckpointFailed
        throw e
      }
    })

    const dispatchPrivateUnrevert = Effect.fn("SessionRevertDispatch.dispatchPrivateUnrevert")(function* (raw: unknown) {
      let req: SessionUnrevertRequest
      try {
        req = validateUnrevertRequest(raw)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        const fallback = raw as Record<string, unknown>
        return {
          v: VERSION,
          requestId: typeof fallback?.requestId === "string" ? fallback.requestId : "unknown",
          opId: typeof fallback?.opId === "string" ? fallback.opId : "unknown",
          op: UNREVERT_OP,
          idempotencyKey: typeof fallback?.idempotencyKey === "string" ? fallback.idempotencyKey : "unknown",
          status: "failed",
          outcome: { type: "failed", time: Date.now(), failure: { code: "validation.failed", message: msg, retryable: false } },
          accepted: false,
          failure: { code: "validation.failed", message: msg, retryable: false },
        } satisfies CheckpointFailed
      }
      const canonDir = canonicalDirectory(req.context.directory)
      const sessionId = SessionID.make(req.context.sessionId)
      const hash = SessionOperation.hashIdempotencyKey(req.idempotencyKey)
      const existing = yield* SessionOperation.getSessionUnrevertByIdempotencyHash(db, sessionId, hash).pipe(Effect.orDie)
      if (!existing) return buildFailed(req, "unrevert", "internal", "no committed unrevert record", false, false, makeRevision(yield* readRevOmit(sessionId), yield* readCfgOmit(canonDir)))
      const conflict = SessionOperation.isSessionCheckpointConflict(existing, {
        opId: req.opId,
        directory: canonDir,
        parentSessionId: req.context.parentSessionId ?? null,
        configVersion: req.context.configVersion ?? null,
        sessionRevision: req.context.sessionRevision ?? null,
      })
      if (conflict) return buildFailed(req, "unrevert", "conflict", "idempotencyKey conflict: different operation facts with same key", false, false, makeRevision(yield* readRevOmit(sessionId), yield* readCfgOmit(canonDir)))
      const persisted = infoFromSnapshot((existing as unknown as { resultSnapshot: unknown }).resultSnapshot)
      if (!persisted) return buildFailed(req, "unrevert", "internal", "invalid persisted snapshot", false, false, makeRevision(yield* readRevOmit(sessionId), yield* readCfgOmit(canonDir)))
      return buildPrivateSucceeded(req, persisted, makeRevision((existing as unknown as { revision: number }).revision, yield* readCfgOmit(canonDir)))
    })

    return { dispatchRevert, dispatchPrivateRevert, dispatchUnrevert, dispatchPrivateUnrevert }
  }),
)
