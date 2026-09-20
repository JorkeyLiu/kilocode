import { isAbsolute } from "path"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { canonicalDirectory } from "@/kilocode/session/canonical-directory"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionOperation } from "@opencode-ai/core/session/operation"
import { SessionRevision } from "@opencode-ai/core/session/revision"
import { ConfigConvergence } from "@/kilocode/server/config-convergence"
import { GenerationGate } from "@/kilocode/server/generation-gate"
import { and, eq, sql } from "drizzle-orm"
import { SessionID, MessageID, PartID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionRevert } from "@/session/revert"
import { Log } from "@opencode-ai/core/util/log"
import { InstanceRef } from "@/effect/instance-ref"
import { acquireDrainControl } from "@/kilocode/server/drain-control-acquire"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { ProjectV2 } from "@opencode-ai/core/project"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { SessionChangefeedTable } from "@opencode-ai/core/retention/sql"
import { SessionOperationTable } from "@opencode-ai/core/session/sql"
import { DispatchAtomicSeam } from "@/kilocode/session/dispatch-atomic-seam"
import * as Changefeed from "@opencode-ai/core/retention/changefeed"
import { Service as PrivatePeerService } from "@/kilocode/server/private-peer-registry"
import { OBSERVATION_NOTIFICATION, OBSERVATION_VERSION } from "@/private-worker/observation"

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

function snapshotToInfo(snapshot: unknown): Session.Info | undefined {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return undefined
  try {
    const info = Session.fromRow(snapshot as unknown as Parameters<typeof Session.fromRow>[0]) as unknown as Session.Info
    const cleaned = JSON.parse(JSON.stringify(info))
    Schema.decodeUnknownSync(Session.Info)(cleaned)
    return info
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
    const events = Option.getOrElse(yield* Effect.serviceOption(EventV2.Service), () => ({
      recordProjectedTx: () =>
        Effect.succeed({ id: "evt_mock", type: "session.updated", seq: 0, data: { sessionID: "mock", info: {} } } as unknown as EventV2.Payload),
      notifyCommitted: () => Effect.void,
    } as unknown as EventV2.Interface))
    const cfg = Option.getOrElse(yield* Effect.serviceOption(ConfigConvergence.Service), () => ConfigConvergence.noop)
    const gate = Option.getOrElse(yield* Effect.serviceOption(GenerationGate.Service), () => GenerationGate.noop)
    const revertSvc = yield* SessionRevert.Service

    // Explicit typed helpers for narrowly necessary Effect/Drizzle boundaries
    const toSessionRow = (row: unknown) => row as unknown as Parameters<typeof Session.fromRow>[0]
    const toSessionInfo = (row: unknown) => Session.fromRow(toSessionRow(row)) as unknown as Session.Info
    const asTx = (tx: unknown) => tx as never
    const asOpInsert = (v: unknown) => v as unknown as typeof SessionOperationTable.$inferInsert

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
            const sessionRowPre = yield* db
              .select({ directory: SessionTable.directory, project_id: SessionTable.project_id, workspace_id: SessionTable.workspace_id })
              .from(SessionTable)
              .where(eq(SessionTable.id, sessionId))
              .get()
              .pipe(Effect.orDie)
            if (!sessionRowPre) return buildFailed(req, "revert", "session.not_found", `session not found ${sessionId}`, false, false, makeRevision(undefined, yield* readCfgOmit(canonDir)))
            const projectRow = yield* db
              .select({ worktree: ProjectTable.worktree })
              .from(ProjectTable)
              .where(eq(ProjectTable.id, sessionRowPre.project_id))
              .get()
              .pipe(Effect.orDie)
            const projectWorktree = projectRow ? canonicalDirectory(projectRow.worktree) : canonDir
            const fresh = yield* checkFresh(req, sessionId, canonDir)
            if (!fresh.ok) return buildFailed(req, "revert", fresh.code, fresh.message, false, false, makeRevision(yield* readRevOmit(sessionId), yield* readCfgOmit(canonDir)))
            // Filesystem operation before DB commit (DB cannot roll back FS)
            const prepareEffect = revertSvc.prepareRevert({
              sessionID: sessionId,
              messageID: req.payload.messageId as unknown as MessageID,
              partID: req.payload.partId as unknown as PartID | undefined,
            })
            const prepExit = yield* Effect.exit(prepareEffect)
            if (prepExit._tag === "Failure") {
              const found = tagOfCause(prepExit.cause)
              const mapped = mapRevertFailure(found.tag, found.message)
              return buildFailed(req, "revert", mapped.code, found.message.slice(0, 500), mapped.retryable, false, makeRevision(yield* readRevOmit(sessionId), yield* readCfgOmit(canonDir)))
            }
            const prep = prepExit.value as { revert: NonNullable<Session.Info["revert"]>; summary: NonNullable<Session.Info["summary"]> } | undefined
            if (!prep) {
              // No revert boundary: treat as succeeded with current session snapshot, no revision bump
              const currentInfo = yield* db
                .select()
                .from(SessionTable)
                .where(eq(SessionTable.id, sessionId))
                .get()
                .pipe(Effect.orDie)
                .pipe(Effect.map((row) => (row ? toSessionInfo(row) : undefined)))
              const data = currentInfo as Session.Info | undefined
              if (!data) return buildFailed(req, "revert", "internal", "session missing for no-op revert", false, false, makeRevision(yield* readRevOmit(sessionId), yield* readCfgOmit(canonDir)))
              const now = Date.now()
              const record: SessionOperation.FailureRecord = {
                opId: req.opId,
                opKind: "revert",
                outcome: "succeeded",
                code: "revert.succeeded",
                message: "revert succeeded",
                time: now,
              }
              const meta = {
                idempotencyHash: hash,
                requestId: req.requestId,
                directory: canonDir,
                parentSessionId: req.context.parentSessionId ?? null,
                configVersion: req.context.configVersion ?? null,
                sessionRevision: req.context.sessionRevision ?? null,
                messageId: req.payload.messageId ?? null,
                partId: req.payload.partId ?? null,
              }
              type ReserveNoop =
                | { status: "conflict" }
                | { status: "replay"; existing: unknown }
                | { status: "reserved"; info: Session.Info; revision: number }
              const reserveNoop: ReserveNoop = yield* db.transaction(
                (tx) =>
                  Effect.gen(function* () {
                    const already = yield* SessionOperation.getSessionRevertByIdempotencyHashTx(asTx(tx), sessionId, hash)
                    if (already) {
                      const c = SessionOperation.isSessionCheckpointConflict(already, {
                        opId: req.opId,
                        directory: canonDir,
                        parentSessionId: req.context.parentSessionId ?? null,
                        configVersion: req.context.configVersion ?? null,
                        sessionRevision: req.context.sessionRevision ?? null,
                        messageId: req.payload.messageId ?? null,
                        partId: req.payload.partId ?? null,
                      })
                      if (c) return { status: "conflict" as const }
                      return { status: "replay" as const, existing: already }
                    }
                    const opExistsInside = yield* SessionOperation.getTx(asTx(tx), req.opId)
                    if (opExistsInside) return { status: "conflict" as const }
                    const cur = yield* tx.select({ rev: SessionTable.revision }).from(SessionTable).where(eq(SessionTable.id, sessionId)).get().pipe(Effect.orDie)
                    const curRev = cur ? (cur as unknown as { rev: number }).rev : 0
                    const snapshotJson = JSON.stringify(currentInfo)
                    yield* tx
                      .insert(SessionOperationTable)
                      .values(
                        asOpInsert({
                          op_id: record.opId,
                          session_id: sessionId,
                          op_kind: record.opKind,
                          outcome: record.outcome,
                          code: record.code,
                          message: record.message,
                          time: record.time,
                          cancel: null,
                          detail: null,
                          stack: null,
                          revision: curRev,
                          idempotency_hash: meta.idempotencyHash,
                          request_id: meta.requestId,
                          directory: meta.directory,
                          parent_session_id: meta.parentSessionId,
                          config_version: meta.configVersion,
                          session_revision: meta.sessionRevision,
                          message_id: meta.messageId,
                          title: meta.partId,
                          result_snapshot: snapshotJson,
                        }),
                      )
                      .run()
                      .pipe(Effect.orDie)
                    return { status: "reserved" as const, info: data, revision: curRev }
                  }),
                { behavior: "immediate" },
              )
              if (reserveNoop.status === "conflict") return buildFailed(req, "revert", "conflict", "idempotencyKey conflict: different operation facts with same key", false, false, makeRevision(yield* readRevOmit(sessionId), yield* readCfgOmit(canonDir)))
              if (reserveNoop.status === "replay") {
                const existingReplay = reserveNoop.existing as { resultSnapshot: unknown; revision: number }
                const persisted = infoFromSnapshot(existingReplay.resultSnapshot)
                if (!persisted) return buildFailed(req, "revert", "internal", "invalid persisted snapshot", false, false, makeRevision(yield* readRevOmit(sessionId), yield* readCfgOmit(canonDir)))
                return buildSucceeded(req, persisted, makeRevision(existingReplay.revision, yield* readCfgOmit(canonDir)))
              }
              return buildSucceeded(req, reserveNoop.info, makeRevision(reserveNoop.revision, yield* readCfgOmit(canonDir)))
            }
            const now = Date.now()
            const record: SessionOperation.FailureRecord = {
              opId: req.opId,
              opKind: "revert",
              outcome: "succeeded",
              code: "revert.succeeded",
              message: "revert succeeded",
              time: now,
            }
            const meta = {
              idempotencyHash: hash,
              requestId: req.requestId,
              directory: canonDir,
              parentSessionId: req.context.parentSessionId ?? null,
              configVersion: req.context.configVersion ?? null,
              sessionRevision: req.context.sessionRevision ?? null,
              messageId: req.payload.messageId ?? null,
              partId: req.payload.partId ?? null,
            }
            type ReserveResult =
              | { status: "stale"; authRev: number }
              | { status: "conflict" }
              | { status: "replay"; existing: unknown }
              | { status: "internal"; message: string }
              | {
                  status: "reserved"
                  info: Session.Info
                  revision: number
                  event: EventV2.Payload
                  changefeedEntry: { seq: number; session_id: string; revision: number; kind: string; time: number }
                }
            const reserveResult: ReserveResult = yield* db.transaction(
              (tx) =>
                Effect.gen(function* () {
                  const already = yield* SessionOperation.getSessionRevertByIdempotencyHashTx(tx as never, sessionId, hash)
                  if (already) {
                    const c = SessionOperation.isSessionCheckpointConflict(already, {
                      opId: req.opId,
                      directory: canonDir,
                      parentSessionId: req.context.parentSessionId ?? null,
                      configVersion: req.context.configVersion ?? null,
                      sessionRevision: req.context.sessionRevision ?? null,
                      messageId: req.payload.messageId ?? null,
                      partId: req.payload.partId ?? null,
                    })
                    if (c) return { status: "conflict" as const }
                    return { status: "replay" as const, existing: already }
                  }
                  const opExistsInside = yield* SessionOperation.getTx(tx as never, req.opId)
                  if (opExistsInside) return { status: "conflict" as const }
                  const authRevEffect = SessionRevision.getTx(tx as never, sessionId)
                  const authRevEither = yield* (authRevEffect as unknown as Effect.Effect<unknown, unknown, unknown>).pipe(
                    Effect.map((v) => ({ _tag: "Right" as const, right: v as number | undefined })),
                    Effect.catch((e: unknown) => Effect.succeed({ _tag: "Left" as const, left: e })),
                    Effect.catchDefect((e: unknown) => Effect.succeed({ _tag: "Left" as const, left: e })),
                  ) as unknown as Effect.Effect<{ _tag: "Right"; right: number | undefined } | { _tag: "Left"; left: unknown }>
                  if ((authRevEither as unknown as { _tag: string })._tag === "Left") return { status: "internal" as const, message: "revision read failed inside tx" }
                  const authRev: number | undefined = (authRevEither as unknown as { right: number | undefined }).right
                  if (authRev !== undefined && req.context.sessionRevision !== undefined && req.context.sessionRevision < authRev) return { status: "stale" as const, authRev }
                  const cfgInsideEither = yield* (getConfigVer(canonDir) as unknown as Effect.Effect<unknown, unknown, unknown>).pipe(
                    Effect.map((v) => ({ _tag: "Right" as const, right: v as number | undefined })),
                    Effect.catch((e: unknown) => Effect.succeed({ _tag: "Left" as const, left: e })),
                    Effect.catchDefect((e: unknown) => Effect.succeed({ _tag: "Left" as const, left: e })),
                  ) as unknown as Effect.Effect<{ _tag: "Right"; right: number | undefined } | { _tag: "Left"; left: unknown }>
                  if ((cfgInsideEither as unknown as { _tag: string })._tag === "Left") return { status: "internal" as const, message: "config version read failed inside tx" }
                  const cfgInside: number | undefined = (cfgInsideEither as unknown as { right: number | undefined }).right
                  const effectiveInside = cfgInside ?? fresh.cfg
                  if (req.context.configVersion !== undefined && effectiveInside === undefined) return { status: "internal" as const, message: "config version unavailable inside tx" }
                  if (req.context.configVersion !== undefined && effectiveInside !== undefined && req.context.configVersion < effectiveInside) {
                    const revForStale = authRev ?? fresh.rev ?? 0
                    return { status: "stale" as const, authRev: revForStale }
                  }
                  // Atomic session update + revision + changefeed + operation + event
                  const updated = yield* tx
                    .update(SessionTable)
                    .set({
                      revert: prep.revert as unknown as typeof SessionTable.$inferInsert.revert,
                      summary_additions: prep.summary.additions,
                      summary_deletions: prep.summary.deletions,
                      summary_files: prep.summary.files,
                      summary_diffs: prep.summary.diffs as unknown as typeof SessionTable.$inferInsert.summary_diffs,
                      time_updated: now,
                      revision: sql`${SessionTable.revision} + 1`,
                    })
                    .where(eq(SessionTable.id, sessionId))
                    .returning({ rev: SessionTable.revision })
                    .all()
                    .pipe(Effect.orDie)
                  if (updated.length !== 1) yield* Effect.die(new Error(`session revert update failed for ${sessionId}`))
                  const nextRev = (updated[0] as { rev: number }).rev
                  yield* Changefeed.appendTx(asTx(tx), { session_id: sessionId as unknown as string, revision: nextRev, kind: "changed", time: now })
                  const updatedRow = yield* tx.select().from(SessionTable).where(eq(SessionTable.id, sessionId)).get().pipe(Effect.orDie)
                  if (!updatedRow) yield* Effect.die(new Error("session missing after revert update"))
                  const infoForEvent = toSessionInfo(updatedRow)
                  const snapshotJson = JSON.stringify(infoForEvent)
                  const loc = new Location.Info({
                    directory: AbsolutePath.make(canonDir),
                    ...(sessionRowPre.workspace_id ? { workspaceID: sessionRowPre.workspace_id as unknown as WorkspaceV2.ID } : {}),
                    project: { id: ProjectV2.ID.make(sessionRowPre.project_id), directory: AbsolutePath.make(projectWorktree) },
                  })
                  const event = yield* (events as unknown as { recordProjectedTx: (tx: unknown, def: unknown, data: unknown, opts: unknown) => Effect.Effect<unknown> }).recordProjectedTx(
                    asTx(tx),
                    SessionV1.Event.Updated,
                    { sessionID: sessionId, info: infoForEvent },
                    { location: loc as unknown as Location.Info },
                  ) as Effect.Effect<EventV2.Payload>
                  yield* tx
                    .insert(SessionOperationTable)
                    .values(
                      asOpInsert({
                        op_id: record.opId,
                        session_id: sessionId,
                        op_kind: record.opKind,
                        outcome: record.outcome,
                        code: record.code,
                        message: record.message,
                        time: record.time,
                        cancel: null,
                        detail: null,
                        stack: null,
                        revision: nextRev,
                        idempotency_hash: meta.idempotencyHash,
                        request_id: meta.requestId,
                      directory: meta.directory,
                      parent_session_id: meta.parentSessionId,
                      config_version: meta.configVersion,
                      session_revision: meta.sessionRevision,
                      message_id: meta.messageId,
                      title: meta.partId,
                      result_snapshot: snapshotJson,
                    }),
                    )
                    .run()
                    .pipe(Effect.orDie)
                  if (DispatchAtomicSeam.failRevertInsideTx) yield* Effect.die(new Error("injected revert tx failure"))
                  const cfEntry = yield* tx
                    .select()
                    .from(SessionChangefeedTable)
                    .where(and(eq(SessionChangefeedTable.session_id, sessionId as unknown as string), eq(SessionChangefeedTable.revision, nextRev)))
                    .get()
                    .pipe(Effect.orDie)
                  if (!cfEntry) yield* Effect.die(new Error("changefeed entry missing after revert"))
                  const changefeedEntry = {
                    seq: (cfEntry as unknown as { seq: number }).seq,
                    session_id: (cfEntry as unknown as { session_id: string }).session_id,
                    revision: (cfEntry as unknown as { revision: number }).revision,
                    kind: (cfEntry as unknown as { kind: string }).kind,
                    time: (cfEntry as unknown as { time: number }).time,
                  }
                  return {
                    status: "reserved" as const,
                    info: infoForEvent as unknown as Session.Info,
                    revision: nextRev,
                    event,
                    changefeedEntry,
                  }
                }),
              { behavior: "immediate" },
            )
            if (reserveResult.status === "stale") {
              const latestCfg = yield* readCfgOmit(canonDir)
              const revision = makeRevision(reserveResult.authRev, latestCfg ?? fresh.cfg)
              return buildFailed(req, "revert", "stale", "stale sessionRevision", false, false, revision)
            }
            if (reserveResult.status === "conflict") {
              const latestRev = yield* readRevOmit(sessionId)
              const latestCfg = yield* readCfgOmit(canonDir)
              const revision = makeRevision(latestRev ?? fresh.rev, latestCfg ?? fresh.cfg)
              return buildFailed(req, "revert", "conflict", "idempotencyKey conflict: different operation facts with same key", false, false, revision)
            }
            if (reserveResult.status === "replay") {
              const existingReplay = reserveResult.existing as { resultSnapshot: unknown; revision: number }
              const persisted = snapshotToInfo(existingReplay.resultSnapshot) ?? infoFromSnapshot(existingReplay.resultSnapshot)
              if (!persisted) return buildFailed(req, "revert", "internal", "invalid persisted snapshot", false, false, makeRevision(yield* readRevOmit(sessionId), yield* readCfgOmit(canonDir)))
              return buildSucceeded(req, persisted, makeRevision(existingReplay.revision, yield* readCfgOmit(canonDir)))
            }
            if (reserveResult.status === "internal") {
              const latestRev = yield* readRevOmit(sessionId)
              const latestCfg = yield* readCfgOmit(canonDir)
              const revision = makeRevision(latestRev ?? fresh.rev, latestCfg ?? fresh.cfg)
              return buildFailed(req, "revert", "internal", reserveResult.message, false, false, revision)
            }
            if (reserveResult.status !== "reserved") return buildFailed(req, "revert", "internal", "unexpected reserve status", false, false, undefined)
            const updatedInfo = reserveResult.info
            const revision = makeRevision(reserveResult.revision, yield* readCfgOmit(canonDir))
            const succeeded = buildSucceeded(req, updatedInfo, revision)
            yield* (events as unknown as { notifyCommitted: (e: unknown) => Effect.Effect<void> }).notifyCommitted(reserveResult.event).pipe(Effect.catch(() => Effect.void), Effect.catchDefect(() => Effect.void))
            const entry = (reserveResult as unknown as { changefeedEntry: { seq: number; session_id: string; revision: number; kind: string; time: number } }).changefeedEntry
            if (entry && succeeded.status === "succeeded") {
              yield* Effect.gen(function* () {
                const opt = yield* Effect.serviceOption(PrivatePeerService)
                if (opt._tag === "None") return
                const peer = opt.value
                const payload = {
                  v: OBSERVATION_VERSION,
                  cursor: entry.seq,
                  entries: [
                    {
                      seq: entry.seq,
                      session_id: entry.session_id,
                      revision: entry.revision,
                      kind: entry.kind,
                      time: entry.time,
                    },
                  ],
                }
                yield* peer.notify(OBSERVATION_NOTIFICATION, payload).pipe(Effect.catch(() => Effect.void), Effect.catchDefect(() => Effect.void))
              }).pipe(Effect.catch(() => Effect.void), Effect.catchDefect(() => Effect.void))
            }
            return succeeded
          }).pipe(Effect.ensuring(leaseRelease)).pipe(
            Effect.catchDefect((defect: unknown) =>
              Effect.gen(function* () {
                const msg = defect instanceof Error ? defect.message : String(defect)
                const latestRev = yield* readRevOmit(sessionId)
                const latestCfg = yield* readCfgOmit(canonDir)
                const revision = makeRevision(latestRev, latestCfg)
                return buildFailed(req, "revert", "internal", msg, false, false, revision)
              }).pipe(Effect.catchDefect(() => Effect.succeed(buildFailed(req, "revert", "internal", String(defect), false, false, undefined)))),
            ),
            Effect.catch((cause: unknown) =>
              Effect.gen(function* () {
                const msg = cause instanceof Error ? cause.message : String(cause)
                const latestRev = yield* readRevOmit(sessionId)
                const latestCfg = yield* readCfgOmit(canonDir)
                const revision = makeRevision(latestRev, latestCfg)
                return buildFailed(req, "revert", "internal", msg, false, false, revision)
              }).pipe(Effect.catchDefect(() => Effect.succeed(buildFailed(req, "revert", "internal", String(cause), false, false, undefined)))),
            ),
          )
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
      const persisted = infoFromSnapshot((existing as unknown as { resultSnapshot: unknown }).resultSnapshot) ?? snapshotToInfo((existing as unknown as { resultSnapshot: unknown }).resultSnapshot)
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
            const persisted = infoFromSnapshot((existing as unknown as { resultSnapshot: unknown }).resultSnapshot) ?? snapshotToInfo((existing as unknown as { resultSnapshot: unknown }).resultSnapshot)
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
            const sessionRowPre = yield* db
              .select({ directory: SessionTable.directory, project_id: SessionTable.project_id, workspace_id: SessionTable.workspace_id })
              .from(SessionTable)
              .where(eq(SessionTable.id, sessionId))
              .get()
              .pipe(Effect.orDie)
            if (!sessionRowPre) return buildFailed(req, "unrevert", "session.not_found", `session not found ${sessionId}`, false, false, makeRevision(undefined, yield* readCfgOmit(canonDir)))
            const projectRow = yield* db
              .select({ worktree: ProjectTable.worktree })
              .from(ProjectTable)
              .where(eq(ProjectTable.id, sessionRowPre.project_id))
              .get()
              .pipe(Effect.orDie)
            const projectWorktree = projectRow ? canonicalDirectory(projectRow.worktree) : canonDir
            const fresh = yield* checkFresh(req, sessionId, canonDir)
            if (!fresh.ok) return buildFailed(req, "unrevert", fresh.code, fresh.message, false, false, makeRevision(yield* readRevOmit(sessionId), yield* readCfgOmit(canonDir)))
            const prepareEffect = revertSvc.prepareUnrevert({ sessionID: sessionId })
            const prepExit = yield* Effect.exit(prepareEffect)
            if (prepExit._tag === "Failure") {
              const found = tagOfCause(prepExit.cause)
              const mapped = mapRevertFailure(found.tag, found.message)
              return buildFailed(req, "unrevert", mapped.code, found.message.slice(0, 500), mapped.retryable, false, makeRevision(yield* readRevOmit(sessionId), yield* readCfgOmit(canonDir)))
            }
            const hadRevert = prepExit.value as boolean
            if (!hadRevert) {
              const currentInfo = yield* db
                .select()
                .from(SessionTable)
                .where(eq(SessionTable.id, sessionId))
                .get()
                .pipe(Effect.orDie)
                .pipe(Effect.map((row) => (row ? toSessionInfo(row) : undefined)))
              const data = currentInfo as Session.Info | undefined
              if (!data) return buildFailed(req, "unrevert", "internal", "session missing for no-op unrevert", false, false, makeRevision(yield* readRevOmit(sessionId), yield* readCfgOmit(canonDir)))
              const now = Date.now()
              const record: SessionOperation.FailureRecord = { opId: req.opId, opKind: "unrevert", outcome: "succeeded", code: "unrevert.succeeded", message: "unrevert succeeded", time: now }
              const meta = { idempotencyHash: hash, requestId: req.requestId, directory: canonDir, parentSessionId: req.context.parentSessionId ?? null, configVersion: req.context.configVersion ?? null, sessionRevision: req.context.sessionRevision ?? null, messageId: null as string | null, partId: null as string | null }
              type ReserveNoop = { status: "conflict" } | { status: "replay"; existing: unknown } | { status: "reserved"; info: Session.Info; revision: number }
              const reserveNoop: ReserveNoop = yield* db.transaction(
                (tx) =>
                  Effect.gen(function* () {
                    const already = yield* SessionOperation.getSessionUnrevertByIdempotencyHashTx(tx as never, sessionId, hash)
                    if (already) {
                      const c = SessionOperation.isSessionCheckpointConflict(already, { opId: req.opId, directory: canonDir, parentSessionId: req.context.parentSessionId ?? null, configVersion: req.context.configVersion ?? null, sessionRevision: req.context.sessionRevision ?? null })
                      if (c) return { status: "conflict" as const }
                      return { status: "replay" as const, existing: already }
                    }
                    const opExistsInside = yield* SessionOperation.getTx(tx as never, req.opId)
                    if (opExistsInside) return { status: "conflict" as const }
                    const cur = yield* tx.select({ rev: SessionTable.revision }).from(SessionTable).where(eq(SessionTable.id, sessionId)).get().pipe(Effect.orDie)
                    const curRev = cur ? (cur as unknown as { rev: number }).rev : 0
                    const snapshotJson = JSON.stringify(currentInfo)
                    yield* tx
                      .insert(SessionOperationTable)
                      .values({
                        op_id: record.opId,
                        session_id: sessionId,
                        op_kind: record.opKind,
                        outcome: record.outcome,
                        code: record.code,
                        message: record.message,
                        time: record.time,
                        cancel: null,
                        detail: null,
                        stack: null,
                        revision: curRev,
                        idempotency_hash: meta.idempotencyHash,
                        request_id: meta.requestId,
                        directory: meta.directory,
                        parent_session_id: meta.parentSessionId,
                        config_version: meta.configVersion,
                        session_revision: meta.sessionRevision,
                        message_id: meta.messageId,
                        title: meta.partId,
                        result_snapshot: snapshotJson,
                      } as unknown as typeof SessionOperationTable.$inferInsert)
                      .run()
                      .pipe(Effect.orDie)
                    return { status: "reserved" as const, info: data, revision: curRev }
                  }),
                { behavior: "immediate" },
              )
              if (reserveNoop.status === "conflict") return buildFailed(req, "unrevert", "conflict", "idempotencyKey conflict: different operation facts with same key", false, false, makeRevision(yield* readRevOmit(sessionId), yield* readCfgOmit(canonDir)))
              if (reserveNoop.status === "replay") {
                const existingReplay = reserveNoop.existing as { resultSnapshot: unknown; revision: number }
                const persisted = infoFromSnapshot(existingReplay.resultSnapshot) ?? snapshotToInfo(existingReplay.resultSnapshot)
                if (!persisted) return buildFailed(req, "unrevert", "internal", "invalid persisted snapshot", false, false, makeRevision(yield* readRevOmit(sessionId), yield* readCfgOmit(canonDir)))
                return buildSucceeded(req, persisted, makeRevision(existingReplay.revision, yield* readCfgOmit(canonDir)))
              }
              return buildSucceeded(req, reserveNoop.info, makeRevision(reserveNoop.revision, yield* readCfgOmit(canonDir)))
            }
            const now = Date.now()
            const record: SessionOperation.FailureRecord = { opId: req.opId, opKind: "unrevert", outcome: "succeeded", code: "unrevert.succeeded", message: "unrevert succeeded", time: now }
            const meta = { idempotencyHash: hash, requestId: req.requestId, directory: canonDir, parentSessionId: req.context.parentSessionId ?? null, configVersion: req.context.configVersion ?? null, sessionRevision: req.context.sessionRevision ?? null, messageId: null as string | null, partId: null as string | null }
            type ReserveResult =
              | { status: "stale"; authRev: number }
              | { status: "conflict" }
              | { status: "replay"; existing: unknown }
              | { status: "internal"; message: string }
              | {
                  status: "reserved"
                  info: Session.Info
                  revision: number
                  event: EventV2.Payload
                  changefeedEntry: { seq: number; session_id: string; revision: number; kind: string; time: number }
                }
            const reserveResult: ReserveResult = yield* db.transaction(
              (tx) =>
                Effect.gen(function* () {
                  const already = yield* SessionOperation.getSessionUnrevertByIdempotencyHashTx(tx as never, sessionId, hash)
                  if (already) {
                    const c = SessionOperation.isSessionCheckpointConflict(already, { opId: req.opId, directory: canonDir, parentSessionId: req.context.parentSessionId ?? null, configVersion: req.context.configVersion ?? null, sessionRevision: req.context.sessionRevision ?? null })
                    if (c) return { status: "conflict" as const }
                    return { status: "replay" as const, existing: already }
                  }
                  const opExistsInside = yield* SessionOperation.getTx(tx as never, req.opId)
                  if (opExistsInside) return { status: "conflict" as const }
                  const authRevEffect = SessionRevision.getTx(tx as never, sessionId)
                  const authRevEither = yield* (authRevEffect as unknown as Effect.Effect<unknown, unknown, unknown>).pipe(
                    Effect.map((v) => ({ _tag: "Right" as const, right: v as number | undefined })),
                    Effect.catch((e: unknown) => Effect.succeed({ _tag: "Left" as const, left: e })),
                    Effect.catchDefect((e: unknown) => Effect.succeed({ _tag: "Left" as const, left: e })),
                  ) as unknown as Effect.Effect<{ _tag: "Right"; right: number | undefined } | { _tag: "Left"; left: unknown }>
                  if ((authRevEither as unknown as { _tag: string })._tag === "Left") return { status: "internal" as const, message: "revision read failed inside tx" }
                  const authRev: number | undefined = (authRevEither as unknown as { right: number | undefined }).right
                  if (authRev !== undefined && req.context.sessionRevision !== undefined && req.context.sessionRevision < authRev) return { status: "stale" as const, authRev }
                  const cfgInsideEither = yield* (getConfigVer(canonDir) as unknown as Effect.Effect<unknown, unknown, unknown>).pipe(
                    Effect.map((v) => ({ _tag: "Right" as const, right: v as number | undefined })),
                    Effect.catch((e: unknown) => Effect.succeed({ _tag: "Left" as const, left: e })),
                    Effect.catchDefect((e: unknown) => Effect.succeed({ _tag: "Left" as const, left: e })),
                  ) as unknown as Effect.Effect<{ _tag: "Right"; right: number | undefined } | { _tag: "Left"; left: unknown }>
                  if ((cfgInsideEither as unknown as { _tag: string })._tag === "Left") return { status: "internal" as const, message: "config version read failed inside tx" }
                  const cfgInside: number | undefined = (cfgInsideEither as unknown as { right: number | undefined }).right
                  const effectiveInside = cfgInside ?? fresh.cfg
                  if (req.context.configVersion !== undefined && effectiveInside === undefined) return { status: "internal" as const, message: "config version unavailable inside tx" }
                  if (req.context.configVersion !== undefined && effectiveInside !== undefined && req.context.configVersion < effectiveInside) {
                    const revForStale = authRev ?? fresh.rev ?? 0
                    return { status: "stale" as const, authRev: revForStale }
                  }
                  const updated = yield* tx
                    .update(SessionTable)
                    .set({ revert: null, time_updated: now, revision: sql`${SessionTable.revision} + 1` })
                    .where(eq(SessionTable.id, sessionId))
                    .returning({ rev: SessionTable.revision })
                    .all()
                    .pipe(Effect.orDie)
                  if (updated.length !== 1) yield* Effect.die(new Error(`session unrevert update failed for ${sessionId}`))
                  const nextRev = (updated[0] as { rev: number }).rev
                  yield* Changefeed.appendTx(asTx(tx), { session_id: sessionId as unknown as string, revision: nextRev, kind: "changed", time: now })
                  const updatedRow = yield* tx.select().from(SessionTable).where(eq(SessionTable.id, sessionId)).get().pipe(Effect.orDie)
                  if (!updatedRow) yield* Effect.die(new Error("session missing after unrevert update"))
                  const infoForEvent = toSessionInfo(updatedRow)
                  const snapshotJson = JSON.stringify(infoForEvent)
                  const loc = new Location.Info({
                    directory: AbsolutePath.make(canonDir),
                    ...(sessionRowPre.workspace_id ? { workspaceID: sessionRowPre.workspace_id as unknown as WorkspaceV2.ID } : {}),
                    project: { id: ProjectV2.ID.make(sessionRowPre.project_id), directory: AbsolutePath.make(projectWorktree) },
                  })
                  const event = yield* (events as unknown as { recordProjectedTx: (tx: unknown, def: unknown, data: unknown, opts: unknown) => Effect.Effect<unknown> }).recordProjectedTx(
                    asTx(tx),
                    SessionV1.Event.Updated,
                    { sessionID: sessionId, info: infoForEvent },
                    { location: loc as unknown as Location.Info },
                  ) as Effect.Effect<EventV2.Payload>
                  yield* tx
                    .insert(SessionOperationTable)
                    .values({
                      op_id: record.opId,
                      session_id: sessionId,
                      op_kind: record.opKind,
                      outcome: record.outcome,
                      code: record.code,
                      message: record.message,
                      time: record.time,
                      cancel: null,
                      detail: null,
                      stack: null,
                      revision: nextRev,
                      idempotency_hash: meta.idempotencyHash,
                      request_id: meta.requestId,
                      directory: meta.directory,
                      parent_session_id: meta.parentSessionId,
                      config_version: meta.configVersion,
                      session_revision: meta.sessionRevision,
                      message_id: meta.messageId,
                      title: meta.partId,
                      result_snapshot: snapshotJson,
                    } as unknown as typeof SessionOperationTable.$inferInsert)
                    .run()
                    .pipe(Effect.orDie)
                  if (DispatchAtomicSeam.failUnrevertInsideTx) yield* Effect.die(new Error("injected unrevert tx failure"))
                  const cfEntry = yield* tx
                    .select()
                    .from(SessionChangefeedTable)
                    .where(and(eq(SessionChangefeedTable.session_id, sessionId as unknown as string), eq(SessionChangefeedTable.revision, nextRev)))
                    .get()
                    .pipe(Effect.orDie)
                  if (!cfEntry) yield* Effect.die(new Error("changefeed entry missing after unrevert"))
                  const changefeedEntry = {
                    seq: (cfEntry as unknown as { seq: number }).seq,
                    session_id: (cfEntry as unknown as { session_id: string }).session_id,
                    revision: (cfEntry as unknown as { revision: number }).revision,
                    kind: (cfEntry as unknown as { kind: string }).kind,
                    time: (cfEntry as unknown as { time: number }).time,
                  }
                  return {
                    status: "reserved" as const,
                    info: infoForEvent as unknown as Session.Info,
                    revision: nextRev,
                    event,
                    changefeedEntry,
                  }
                }),
              { behavior: "immediate" },
            )
            if (reserveResult.status === "stale") {
              const latestCfg = yield* readCfgOmit(canonDir)
              const revision = makeRevision(reserveResult.authRev, latestCfg ?? fresh.cfg)
              return buildFailed(req, "unrevert", "stale", "stale sessionRevision", false, false, revision)
            }
            if (reserveResult.status === "conflict") {
              const latestRev = yield* readRevOmit(sessionId)
              const latestCfg = yield* readCfgOmit(canonDir)
              const revision = makeRevision(latestRev ?? fresh.rev, latestCfg ?? fresh.cfg)
              return buildFailed(req, "unrevert", "conflict", "idempotencyKey conflict: different operation facts with same key", false, false, revision)
            }
            if (reserveResult.status === "replay") {
              const existingReplay = reserveResult.existing as { resultSnapshot: unknown; revision: number }
              const persisted = infoFromSnapshot(existingReplay.resultSnapshot) ?? snapshotToInfo(existingReplay.resultSnapshot)
              if (!persisted) return buildFailed(req, "unrevert", "internal", "invalid persisted snapshot", false, false, makeRevision(yield* readRevOmit(sessionId), yield* readCfgOmit(canonDir)))
              return buildSucceeded(req, persisted, makeRevision(existingReplay.revision, yield* readCfgOmit(canonDir)))
            }
            if (reserveResult.status === "internal") {
              const latestRev = yield* readRevOmit(sessionId)
              const latestCfg = yield* readCfgOmit(canonDir)
              const revision = makeRevision(latestRev ?? fresh.rev, latestCfg ?? fresh.cfg)
              return buildFailed(req, "unrevert", "internal", reserveResult.message, false, false, revision)
            }
            if (reserveResult.status !== "reserved") return buildFailed(req, "unrevert", "internal", "unexpected reserve status", false, false, undefined)
            const revision = makeRevision(reserveResult.revision, yield* readCfgOmit(canonDir))
            const succeeded = buildSucceeded(req, reserveResult.info, revision)
            yield* (events as unknown as { notifyCommitted: (e: unknown) => Effect.Effect<void> }).notifyCommitted(reserveResult.event).pipe(Effect.catch(() => Effect.void), Effect.catchDefect(() => Effect.void))
            const entry = (reserveResult as unknown as { changefeedEntry: { seq: number; session_id: string; revision: number; kind: string; time: number } }).changefeedEntry
            if (entry && succeeded.status === "succeeded") {
              yield* Effect.gen(function* () {
                const opt = yield* Effect.serviceOption(PrivatePeerService)
                if (opt._tag === "None") return
                const peer = opt.value
                const payload = {
                  v: OBSERVATION_VERSION,
                  cursor: entry.seq,
                  entries: [
                    {
                      seq: entry.seq,
                      session_id: entry.session_id,
                      revision: entry.revision,
                      kind: entry.kind,
                      time: entry.time,
                    },
                  ],
                }
                yield* peer.notify(OBSERVATION_NOTIFICATION, payload).pipe(Effect.catch(() => Effect.void), Effect.catchDefect(() => Effect.void))
              }).pipe(Effect.catch(() => Effect.void), Effect.catchDefect(() => Effect.void))
            }
            return succeeded
          }).pipe(Effect.ensuring(leaseRelease)).pipe(
            Effect.catchDefect((defect: unknown) =>
              Effect.gen(function* () {
                const msg = defect instanceof Error ? defect.message : String(defect)
                const latestRev = yield* readRevOmit(sessionId)
                const latestCfg = yield* readCfgOmit(canonDir)
                const revision = makeRevision(latestRev, latestCfg)
                return buildFailed(req, "unrevert", "internal", msg, false, false, revision)
              }).pipe(Effect.catchDefect(() => Effect.succeed(buildFailed(req, "unrevert", "internal", String(defect), false, false, undefined)))),
            ),
            Effect.catch((cause: unknown) =>
              Effect.gen(function* () {
                const msg = cause instanceof Error ? cause.message : String(cause)
                const latestRev = yield* readRevOmit(sessionId)
                const latestCfg = yield* readCfgOmit(canonDir)
                const revision = makeRevision(latestRev, latestCfg)
                return buildFailed(req, "unrevert", "internal", msg, false, false, revision)
              }).pipe(Effect.catchDefect(() => Effect.succeed(buildFailed(req, "unrevert", "internal", String(cause), false, false, undefined)))),
            ),
          )
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
      const persisted = infoFromSnapshot((existing as unknown as { resultSnapshot: unknown }).resultSnapshot) ?? snapshotToInfo((existing as unknown as { resultSnapshot: unknown }).resultSnapshot)
      if (!persisted) return buildFailed(req, "unrevert", "internal", "invalid persisted snapshot", false, false, makeRevision(yield* readRevOmit(sessionId), yield* readCfgOmit(canonDir)))
      return buildPrivateSucceeded(req, persisted, makeRevision((existing as unknown as { revision: number }).revision, yield* readCfgOmit(canonDir)))
    })

    return { dispatchRevert, dispatchPrivateRevert, dispatchUnrevert, dispatchPrivateUnrevert }
  }),
)
