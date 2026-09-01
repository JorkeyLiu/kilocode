import { isAbsolute, resolve, normalize as normalizePath } from "path"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionOperation } from "@opencode-ai/core/session/operation"
import { SessionRevision } from "@opencode-ai/core/session/revision"
import { ConfigConvergence } from "@/kilocode/server/config-convergence"
import { GenerationGate } from "@/kilocode/server/generation-gate"
import { eq } from "drizzle-orm"
import { SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Project } from "@opencode-ai/core/project"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { Log } from "@opencode-ai/core/util/log"

export const VERSION = 1 as const
export const OP = "session/update" as const

export interface SessionUpdateRequest {
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
  payload: { title: string }
}

export type Revision = { session: number; config: number }

export interface SessionUpdateSucceeded {
  v: typeof VERSION
  requestId: string
  opId: string
  op: typeof OP
  idempotencyKey: string
  status: "succeeded"
  outcome: { type: "succeeded"; time: number }
  accepted: true
  data: Session.Info
  revision?: Revision
}

export interface SessionUpdateFailed {
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

export type SessionUpdateResult = SessionUpdateSucceeded | SessionUpdateFailed

const SESSION_TITLE_LIMIT = 200
const unsafeTitle = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u

function isNonEmptyString(v: unknown): boolean {
  return typeof v === "string" && v.length > 0
}
function isSafeInt(v: unknown): boolean {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && Number.isSafeInteger(v)
}
export function canonicalDirectory(dir: string): string {
  if (typeof dir !== "string" || !isAbsolute(dir)) throw new Error("context.directory must be absolute path")
  if (dir.includes("\0")) throw new Error("context.directory must not contain null bytes")
  const normalized = normalizePath(resolve(dir))
  if (!isAbsolute(normalized)) throw new Error("context.directory must be absolute path")
  return normalized
}
function validateTitle(raw: unknown): string {
  if (typeof raw !== "string") throw new Error("payload.title must be non-empty string")
  const value = raw.trim()
  if (!value) throw new Error("payload.title must be non-empty string")
  if (value.length > SESSION_TITLE_LIMIT) throw new Error("payload.title too long")
  if (unsafeTitle.test(value)) throw new Error("payload.title contains control characters")
  return value
}

export function validateRequest(raw: unknown): SessionUpdateRequest {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("params must be object")
  const o = raw as Record<string, unknown>
  if (o.v !== VERSION) throw new Error(`unsupported session version: ${String(o.v)} — expected numeric ${VERSION}`)
  if (!isNonEmptyString(o.requestId)) throw new Error("requestId must be non-empty string")
  if (!isNonEmptyString(o.opId)) throw new Error("opId must be non-empty string")
  if (o.op !== OP) throw new Error(`op must be ${OP}`)
  if (!isNonEmptyString(o.idempotencyKey)) throw new Error("idempotencyKey must be non-empty string")
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
  if ("configVersion" in c && c.configVersion !== undefined) {
    if (!isSafeInt(c.configVersion)) throw new Error("context.configVersion must be integer >=0")
  }
  if ("sessionRevision" in c && c.sessionRevision !== undefined) {
    if (!isSafeInt(c.sessionRevision)) throw new Error("context.sessionRevision must be integer >=0")
  }
  const payload = o.payload
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) throw new Error("payload must be object")
  const p = payload as Record<string, unknown>
  if (!isNonEmptyString(p.title)) throw new Error("payload.title must be non-empty string")
  validateTitle(p.title)
  const allowedRoot = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "context", "payload"])
  for (const k of Object.keys(o)) if (!allowedRoot.has(k)) throw new Error(`unexpected field ${k}`)
  const allowedCtx = new Set(["directory", "sessionId", "parentSessionId", "configVersion", "sessionRevision"])
  for (const k of Object.keys(c)) if (!allowedCtx.has(k)) throw new Error(`unexpected context field ${k}`)
  const allowedPayload = new Set(["title"])
  for (const k of Object.keys(p)) if (!allowedPayload.has(k)) throw new Error(`unexpected payload field ${k}`)
  if (c.parentSessionId !== null && c.parentSessionId !== undefined) throw new Error("parentSessionId must be null for sessionUpdate")
  try {
    const parsed = SessionOperation.parseOpId(o.opId as string)
    if (parsed.kind !== "sessionUpdate") throw new Error(`opId kind must be sessionUpdate: ${o.opId}`)
    if (parsed.parts[0] !== c.sessionId) throw new Error(`opId session binding mismatch: ${o.opId} vs ${c.sessionId}`)
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : String(e))
  }
  return o as unknown as SessionUpdateRequest
}

function buildFailed(
  req: SessionUpdateRequest,
  code: string,
  message: string,
  retryable: boolean,
  accepted: boolean,
  revision: Revision | undefined,
  detail?: string,
): SessionUpdateFailed {
  const normalized = SessionOperation.normalizeRecord({
    opId: req.opId,
    opKind: "sessionUpdate",
    outcome: "failed",
    code,
    message,
    time: Date.now(),
    detail,
  })
  const msg = normalized.message
  const det = normalized.detail
  const time = Date.now()
  const failure = { code, message: msg, retryable, ...(det ? { detail: det } : {}) }
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
  } as SessionUpdateFailed
}

function buildSucceeded(
  req: SessionUpdateRequest,
  data: Session.Info,
  revision: Revision | undefined,
): SessionUpdateSucceeded {
  const time = Date.now()
  return {
    v: VERSION,
    requestId: req.requestId,
    opId: req.opId,
    op: OP,
    idempotencyKey: req.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time },
    accepted: true,
    data,
    ...(revision !== undefined ? { revision } : {}),
  } as SessionUpdateSucceeded
}

function makeRevision(session: number | undefined, config: number | undefined): Revision | undefined {
  return session !== undefined && config !== undefined ? { session, config } : undefined
}

function snapshotToInfo(snapshot: unknown): Session.Info | undefined {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return undefined
  try {
    const info = Session.fromRow(snapshot as unknown as Parameters<typeof Session.fromRow>[0]) as unknown as Session.Info
    // Session.Info uses optionalOmitUndefined: explicit undefined must be omitted for decode (JSON semantics)
    const cleaned = JSON.parse(JSON.stringify(info))
    Schema.decodeUnknownSync(Session.Info)(cleaned)
    return info
  } catch {
    return undefined
  }
}

export interface SessionUpdateDispatch {
  readonly dispatch: (request: unknown) => Effect.Effect<SessionUpdateResult, unknown, unknown>
  readonly dispatchPrivate: (request: unknown) => Effect.Effect<SessionUpdateResult, unknown, unknown>
}

export class SessionUpdateDispatchService extends Context.Service<SessionUpdateDispatchService, SessionUpdateDispatch>()(
  "SessionUpdateDispatch",
) {}

const log = Log.create({ service: "sessionUpdate" })

export const layer = Layer.effect(
  SessionUpdateDispatchService,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service
    const cfg = Option.getOrElse(yield* Effect.serviceOption(ConfigConvergence.Service), () => ConfigConvergence.noop)
    const gate = Option.getOrElse(yield* Effect.serviceOption(GenerationGate.Service), () => GenerationGate.noop)

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

     // helper to extract Right value or detect Left (fail-closed)
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

    const dispatch = Effect.fn("SessionUpdateDispatch.dispatch")(function* (raw: unknown) {
      let req: SessionUpdateRequest
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
            return `sessionUpdate:ses_unknown`
          }
        })()
        const failure = SessionOperation.normalizeRecord({
          opId: opIdSafe,
          opKind: "sessionUpdate",
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
        } satisfies SessionUpdateFailed
      }

      const canonDir = canonicalDirectory(req.context.directory)
      const sessionId = SessionID.make(req.context.sessionId)
      const hash = SessionOperation.hashIdempotencyKey(req.idempotencyKey)
      const title = validateTitle(req.payload.title)

      const inner = Effect.gen(function* () {
        const sessionRow = yield* db
          .select({ directory: SessionTable.directory, project_id: SessionTable.project_id, workspace_id: SessionTable.workspace_id })
          .from(SessionTable)
          .where(eq(SessionTable.id, sessionId))
          .get()
          .pipe(Effect.orDie)
        if (!sessionRow) {
          const cfgEither = yield* readConfigVer(canonDir)
          if (isLeft(cfgEither)) return buildFailed(req, "internal", "config version read failed", false, false, makeRevision(undefined, undefined))
          const cfgVer = rightValue(cfgEither) as number | undefined
          const revision = makeRevision(undefined, cfgVer)
          return buildFailed(req, "session.not_found", `session not found ${sessionId}`, false, false, revision)
        }
        const canonicalStored = canonicalDirectory(sessionRow.directory)
        if (canonicalStored !== canonDir) {
          const revEither = yield* readSessionRev(sessionId)
          if (isLeft(revEither)) return buildFailed(req, "internal", "revision read failed", false, false, makeRevision(undefined, undefined))
          const cfgEither = yield* readConfigVer(canonDir)
          if (isLeft(cfgEither)) return buildFailed(req, "internal", "config version read failed", false, false, makeRevision(rightValue(revEither) as number | undefined, undefined))
          const curRev = rightValue(revEither) as number | undefined
          const cfgVer = rightValue(cfgEither) as number | undefined
          const revision = makeRevision(curRev, cfgVer)
          return buildFailed(req, "scope_mismatch", `directory mismatch for session ${sessionId}`, false, false, revision)
        }
        const projectRow = yield* db
          .select({ worktree: ProjectTable.worktree })
          .from(ProjectTable)
          .where(eq(ProjectTable.id, sessionRow.project_id))
          .get()
          .pipe(Effect.orDie)
        if (!projectRow) {
          const curRev = yield* readRevOmit(sessionId)
          const curCfg = yield* readCfgOmit(canonDir)
          const revision = makeRevision(curRev, curCfg)
          return buildFailed(req, "internal", "project not found for session", false, false, revision)
        }
        const projectWorktree = canonicalDirectory(projectRow.worktree)

        // Idempotency/opId replay and conflict lookup MUST happen before any freshness-authority reads.
        // Freshness checks (sessionRevision/configVersion) apply only when no committed replay/conflict exists.
        const existing = yield* SessionOperation.getSessionUpdateByIdempotencyHash(db, sessionId, hash).pipe(Effect.orDie)
        if (existing) {
          const conflict = SessionOperation.isSessionUpdateConflict(existing, {
            opId: req.opId,
            directory: canonDir,
            parentSessionId: req.context.parentSessionId ?? null,
            configVersion: req.context.configVersion ?? null,
            sessionRevision: req.context.sessionRevision ?? null,
            title,
          })
          if (conflict) {
            // Replay path: omit authority facts on read failure, never fabricate partial revision
            const curRevC = yield* readRevOmit(sessionId)
            const curCfgC = yield* readCfgOmit(canonDir)
            const revision = makeRevision(curRevC, curCfgC)
            return buildFailed(req, "conflict", "idempotencyKey conflict: different operation facts with same key", false, false, revision)
          }
          if (existing.outcome === "succeeded") {
            const hasSnapshot = SessionOperation.hasSnapshot(existing as unknown as SessionOperation.SessionUpdateRecord)
            const persisted = hasSnapshot
              ? snapshotToInfo((existing as unknown as { resultSnapshot: unknown }).resultSnapshot)
              : undefined
            if (hasSnapshot && !persisted) {
              const curRevS = yield* readRevOmit(sessionId)
              const curCfgS = yield* readCfgOmit(canonDir)
              const revision = makeRevision((existing as unknown as { revision: number }).revision ?? curRevS, curCfgS)
              return buildFailed(req, "internal", "invalid persisted snapshot", false, false, revision)
            }
            if (persisted) {
              const persistedRev = (existing as unknown as { revision: number }).revision
              const curRevP = yield* readRevOmit(sessionId)
              const curCfgP = yield* readCfgOmit(canonDir)
              const revision = makeRevision(persistedRev ?? curRevP, curCfgP)
              return buildSucceeded(req, persisted as unknown as Session.Info, revision)
            }
            // legacy absent snapshot: fallback to mutable (allowed only if snapshot absent)
            const info = yield* db
              .select()
              .from(SessionTable)
              .where(eq(SessionTable.id, sessionId))
              .get()
              .pipe(Effect.orDie)
              .pipe(Effect.map((row) => (row ? Session.fromRow(row as unknown as Parameters<typeof Session.fromRow>[0]) : undefined)))
            const data = info as unknown as Session.Info
            if (!data) {
              const curRevM = yield* readRevOmit(sessionId)
              const curCfgM = yield* readCfgOmit(canonDir)
              const revision = makeRevision((existing as unknown as { revision: number }).revision ?? curRevM, curCfgM)
              return buildFailed(req, "internal", "session missing for replay", false, false, revision)
            }
            const curRevM2 = yield* readRevOmit(sessionId)
            const curCfgM2 = yield* readCfgOmit(canonDir)
            const revision = makeRevision((existing as unknown as { revision: number }).revision ?? curRevM2, curCfgM2)
            return buildSucceeded(req, data, revision)
          }
          const curRevF = yield* readRevOmit(sessionId)
          const curCfgF = yield* readCfgOmit(canonDir)
          const revision = makeRevision(curRevF, curCfgF)
          return buildFailed(req, existing.code, existing.message, false, false, revision)
        }

        // opId conflict lookup before freshness reads — fail-closed omit, not internal
        const existingOpId = yield* SessionOperation.get(db, req.opId).pipe(Effect.orDie)
        if (existingOpId) {
          const curRevO = yield* readRevOmit(sessionId)
          const curCfgO = yield* readCfgOmit(canonDir)
          const revision = makeRevision(curRevO, curCfgO)
          return buildFailed(req, "conflict", "opId already exists with different idempotencyKey", false, false, revision)
        }

        // Config freshness must be linearized via one continuous coordinator-owned lease.
        // If caller supplied configVersion, hold a single GenerationGate reader lease from freshness
        // decision through the complete immediate transaction; if barrier active, fail closed 409 before acquiring.
        // No release/reacquire gap — fence blocks new readers but allows already-admitted readers, so a gap would let config V advance.
        const needsConfigLease = req.context.configVersion !== undefined
        if (needsConfigLease && gate.isBarrierActive(canonDir)) {
          const curRevB = yield* readRevOmit(sessionId)
          const curCfgB = yield* readCfgOmit(canonDir)
          const revision = makeRevision(curRevB, curCfgB)
          return buildFailed(req, "InstanceUnavailableDuringConfigRebuild", "instance unavailable during config rebuild", true, false, revision)
        }
        const leaseRelease: Effect.Effect<void> = needsConfigLease ? yield* gate.acquire(canonDir) : Effect.void
        const txInnerResult: SessionUpdateResult = yield* Effect.gen(function* () {
          // Freshness reads only when no committed replay/conflict exists — fail-closed internal on read failure
          const revEither = yield* readSessionRev(sessionId)
          if (isLeft(revEither)) return buildFailed(req, "internal", "revision read failed", false, false, makeRevision(undefined, undefined)) as unknown as SessionUpdateResult
          const cfgEither = yield* readConfigVer(canonDir)
          if (isLeft(cfgEither)) return buildFailed(req, "internal", "config version read failed", false, false, makeRevision(rightValue(revEither) as number | undefined, undefined)) as unknown as SessionUpdateResult
          const actualSessionRev = rightValue(revEither) as number | undefined
          const currentConfigVer = rightValue(cfgEither) as number | undefined
          if (req.context.sessionRevision !== undefined && actualSessionRev !== undefined && req.context.sessionRevision < actualSessionRev) {
            const revision = makeRevision(actualSessionRev, currentConfigVer)
            return buildFailed(req, "stale", "stale sessionRevision", false, false, revision) as unknown as SessionUpdateResult
          }
          const cfgBeforeEither = yield* readConfigVer(canonDir)
          if (isLeft(cfgBeforeEither)) return buildFailed(req, "internal", "config version read failed", false, false, makeRevision(actualSessionRev, currentConfigVer)) as unknown as SessionUpdateResult
          const configBeforeTx = rightValue(cfgBeforeEither) as number | undefined
          const effectiveConfigBeforeTx = configBeforeTx ?? currentConfigVer
          if (req.context.configVersion !== undefined && effectiveConfigBeforeTx === undefined) {
            return buildFailed(req, "internal", "config version unavailable", false, false, makeRevision(actualSessionRev, currentConfigVer)) as unknown as SessionUpdateResult
          }
          if (req.context.configVersion !== undefined && effectiveConfigBeforeTx !== undefined && req.context.configVersion < effectiveConfigBeforeTx) {
            const revision = makeRevision(actualSessionRev, effectiveConfigBeforeTx)
            return buildFailed(req, "stale", "stale configVersion", false, false, revision) as unknown as SessionUpdateResult
          }
        const now = Date.now()
        const record: SessionOperation.FailureRecord = {
          opId: req.opId,
          opKind: "sessionUpdate",
          outcome: "succeeded",
          code: "sessionUpdate.succeeded",
          message: "sessionUpdate succeeded",
          time: now,
        }
        const meta: SessionOperation.SessionUpdateMeta = {
          idempotencyHash: hash,
          requestId: req.requestId,
          directory: canonDir,
          parentSessionId: req.context.parentSessionId ?? null,
          configVersion: req.context.configVersion ?? null,
          sessionRevision: req.context.sessionRevision ?? null,
          title,
        }

        type ReserveResult =
          | { status: "stale"; authRev: number }
          | { status: "conflict"; existing: SessionOperation.SessionUpdateRecord }
          | { status: "replay"; existing: SessionOperation.SessionUpdateRecord }
          | { status: "internal"; message: string }
          | { status: "reserved"; record: SessionOperation.SessionUpdateRecord; event: EventV2.Payload }

        const reserveResult: ReserveResult = yield* db.transaction(
          (tx) =>
            Effect.gen(function* () {
              const already = yield* SessionOperation.getSessionUpdateByIdempotencyHashTx(tx as unknown as typeof db, sessionId, hash)
              if (already) {
                const c = SessionOperation.isSessionUpdateConflict(already, {
                  opId: req.opId,
                  directory: canonDir,
                  parentSessionId: req.context.parentSessionId ?? null,
                  configVersion: req.context.configVersion ?? null,
                  sessionRevision: req.context.sessionRevision ?? null,
                  title,
                })
                if (c) return { status: "conflict" as const, existing: already }
                return { status: "replay" as const, existing: already }
              }
              // Check opId collision inside tx before mutation
              const opExists = yield* SessionOperation.getTx(tx as unknown as typeof db, req.opId)
              if (opExists) return { status: "conflict" as const, existing: opExists as unknown as SessionOperation.SessionUpdateRecord }
              const authRevEffect = SessionRevision.getTx(tx as unknown as typeof db, sessionId)
              const authRevEither = yield* (authRevEffect as unknown as Effect.Effect<unknown, unknown, unknown>).pipe(
                Effect.map((v) => ({ _tag: "Right" as const, right: v as number | undefined })),
                Effect.catch((e: unknown) => Effect.succeed({ _tag: "Left" as const, left: e })),
                Effect.catchDefect((e: unknown) => Effect.succeed({ _tag: "Left" as const, left: e })),
              ) as unknown as Effect.Effect<{ _tag: "Right"; right: number | undefined } | { _tag: "Left"; left: unknown }>
              if ((authRevEither as unknown as { _tag: string })._tag === "Left") {
                return { status: "internal" as const, message: "revision read failed inside tx" }
              }
              const authRev: number | undefined = (authRevEither as unknown as { right: number | undefined }).right
              if (authRev !== undefined && req.context.sessionRevision !== undefined && req.context.sessionRevision < authRev) {
                return { status: "stale" as const, authRev }
              }
              const cfgInsideEither = yield* (getConfigVer(canonDir) as unknown as Effect.Effect<unknown, unknown, unknown>).pipe(
                Effect.map((v) => ({ _tag: "Right" as const, right: v as number | undefined })),
                Effect.catch((e: unknown) => Effect.succeed({ _tag: "Left" as const, left: e })),
                Effect.catchDefect((e: unknown) => Effect.succeed({ _tag: "Left" as const, left: e })),
              ) as unknown as Effect.Effect<{ _tag: "Right"; right: number | undefined } | { _tag: "Left"; left: unknown }>
              if ((cfgInsideEither as unknown as { _tag: string })._tag === "Left") {
                return { status: "internal" as const, message: "config version read failed inside tx" }
              }
              const cfgInside: number | undefined = (cfgInsideEither as unknown as { right: number | undefined }).right
              const effectiveInside = cfgInside ?? effectiveConfigBeforeTx
              if (req.context.configVersion !== undefined && effectiveInside === undefined) {
                return { status: "internal" as const, message: "config version unavailable inside tx" }
              }
              if (req.context.configVersion !== undefined && effectiveInside !== undefined && req.context.configVersion < effectiveInside) {
                const revForStale = authRev ?? actualSessionRev ?? 0
                return { status: "stale" as const, authRev: revForStale }
              }
              const inserted = yield* SessionOperation.insertSessionUpdateSucceededTx(tx as unknown as typeof db, sessionId, record, meta)
              const hasSnapshot = SessionOperation.hasSnapshot(inserted)
              const rawSnap = hasSnapshot ? (inserted as unknown as { resultSnapshot: unknown }).resultSnapshot : undefined
              let infoForEvent: Session.Info | undefined
              if (hasSnapshot) {
                const parsed = snapshotToInfo(rawSnap as unknown)
                if (!parsed) {
                  yield* Effect.die(new Error("invalid persisted snapshot"))
                }
                infoForEvent = parsed
              } else {
                const row = yield* tx
                  .select()
                  .from(SessionTable)
                  .where(eq(SessionTable.id, sessionId))
                  .get()
                  .pipe(Effect.orDie)
                if (row) infoForEvent = Session.fromRow(row as unknown as Parameters<typeof Session.fromRow>[0]) as unknown as Session.Info
              }
              if (!infoForEvent) {
                yield* Effect.die(new Error("session missing after update"))
              }
              const loc = new Location.Info({
                directory: AbsolutePath.make(canonDir),
                ...(sessionRow.workspace_id ? { workspaceID: sessionRow.workspace_id as unknown as WorkspaceV2.ID } : {}),
                project: { id: Project.ID.make(sessionRow.project_id), directory: AbsolutePath.make(projectWorktree) },
              })
              const event = yield* events.recordProjectedTx(tx as unknown as typeof db, SessionV1.Event.Updated, { sessionID: sessionId, info: infoForEvent as unknown as Session.Info }, { location: loc as unknown as Location.Ref })
              return { status: "reserved" as const, record: inserted, event }
            }),
          { behavior: "immediate" },
        )

        if (reserveResult.status === "stale") {
          const cfgEither2 = yield* readConfigVer(canonDir)
          const latestCfg = isLeft(cfgEither2) ? undefined : (rightValue(cfgEither2) as number | undefined)
          const revision = makeRevision(reserveResult.authRev, latestCfg ?? effectiveConfigBeforeTx)
          return buildFailed(req, "stale", "stale sessionRevision", false, false, revision)
        }
        if (reserveResult.status === "conflict") {
          const revEither2 = yield* readSessionRev(sessionId)
          const cfgEither2 = yield* readConfigVer(canonDir)
          const latestRev = isLeft(revEither2) ? undefined : (rightValue(revEither2) as number | undefined)
          const latestCfg = isLeft(cfgEither2) ? undefined : (rightValue(cfgEither2) as number | undefined)
          const revision = makeRevision(latestRev ?? actualSessionRev, latestCfg ?? effectiveConfigBeforeTx)
          return buildFailed(req, "conflict", "idempotencyKey conflict: different operation facts with same key", false, false, revision)
        }
        if (reserveResult.status === "replay") {
          const revEither2 = yield* readSessionRev(sessionId)
          const cfgEither2 = yield* readConfigVer(canonDir)
          const latestRev = isLeft(revEither2) ? undefined : (rightValue(revEither2) as number | undefined)
          const latestCfg = isLeft(cfgEither2) ? undefined : (rightValue(cfgEither2) as number | undefined)
          const existingReplay = reserveResult.existing
          if (existingReplay.outcome === "succeeded") {
            const hasSnap = SessionOperation.hasSnapshot(existingReplay)
            const persisted = hasSnap
              ? snapshotToInfo((existingReplay as unknown as { resultSnapshot: unknown }).resultSnapshot)
              : undefined
            if (hasSnap && !persisted) {
              const revision = makeRevision((existingReplay as unknown as { revision: number }).revision ?? latestRev ?? actualSessionRev, latestCfg ?? effectiveConfigBeforeTx)
              return buildFailed(req, "internal", "invalid persisted snapshot", false, false, revision)
            }
            if (persisted) {
              const persistedRev = (existingReplay as unknown as { revision: number }).revision
              const revision = makeRevision(persistedRev ?? latestRev ?? actualSessionRev, latestCfg ?? effectiveConfigBeforeTx)
              return buildSucceeded(req, persisted as unknown as Session.Info, revision)
            }
            const info = yield* db
              .select()
              .from(SessionTable)
              .where(eq(SessionTable.id, sessionId))
              .get()
              .pipe(Effect.orDie)
              .pipe(Effect.map((row) => (row ? Session.fromRow(row as unknown as Parameters<typeof Session.fromRow>[0]) : undefined)))
            const data = info as unknown as Session.Info
            if (!data) {
              const revision = makeRevision((existingReplay as unknown as { revision: number }).revision ?? latestRev ?? actualSessionRev, latestCfg ?? effectiveConfigBeforeTx)
              return buildFailed(req, "internal", "session missing for replay", false, false, revision)
            }
            const persistedRev = (existingReplay as unknown as { revision: number }).revision
            const revision = makeRevision(persistedRev ?? latestRev ?? actualSessionRev, latestCfg ?? effectiveConfigBeforeTx)
            return buildSucceeded(req, data, revision)
          }
          const revision = makeRevision(latestRev ?? actualSessionRev, latestCfg ?? effectiveConfigBeforeTx)
          return buildFailed(req, existingReplay.code, existingReplay.message, false, false, revision)
        }
        if (reserveResult.status === "internal") {
          const revEither2 = yield* readSessionRev(sessionId)
          const cfgEither2 = yield* readConfigVer(canonDir)
          const latestRev = isLeft(revEither2) ? undefined : (rightValue(revEither2) as number | undefined)
          const latestCfg = isLeft(cfgEither2) ? undefined : (rightValue(cfgEither2) as number | undefined)
          const revision = makeRevision(latestRev ?? actualSessionRev, latestCfg ?? effectiveConfigBeforeTx)
          return buildFailed(req, "internal", reserveResult.message, false, false, revision)
        }

        if (reserveResult.status !== "reserved") {
          return buildFailed(req, "internal", "unexpected reserve status", false, false, undefined)
        }
        const updatedInfo = (reserveResult.event.data as { info: Session.Info }).info as unknown as Session.Info
        const persistedRev = (reserveResult.record as unknown as { revision: number }).revision
        const revEither3 = yield* readSessionRev(sessionId)
        const newRev = persistedRev ?? (isLeft(revEither3) ? undefined : (rightValue(revEither3) as number | undefined))
        const cfgEither3 = yield* readConfigVer(canonDir)
        const cfgVerAfter = isLeft(cfgEither3) ? undefined : (rightValue(cfgEither3) as number | undefined)
        const revision = makeRevision(newRev as number | undefined, cfgVerAfter)
        const succeeded = buildSucceeded(req, updatedInfo as unknown as Session.Info, revision)
        yield* events.notifyCommitted(reserveResult.event).pipe(
          Effect.catch((cause: unknown) => Effect.sync(() => log.warn("notifyCommitted failed", { error: cause instanceof Error ? cause.message : String(cause) }))),
          Effect.catchDefect((defect: unknown) => Effect.sync(() => log.warn("notifyCommitted defect", { defect: defect instanceof Error ? defect.message : String(defect) }))),
        )
        return succeeded
        }).pipe(Effect.ensuring(leaseRelease))
        return txInnerResult
      }).pipe(
        Effect.catchDefect((defect: unknown) =>
          Effect.gen(function* () {
            const msg = defect instanceof Error ? defect.message : String(defect)
            const revEither = yield* readSessionRev(sessionId)
            const latestRev = isLeft(revEither) ? undefined : (rightValue(revEither) as number | undefined)
            const cfgEither = yield* readConfigVer(canonDir)
            const latestCfg = isLeft(cfgEither) ? undefined : (rightValue(cfgEither) as number | undefined)
            const revision = makeRevision(latestRev, latestCfg)
            return buildFailed(req, "internal", msg, false, false, revision)
          }).pipe(Effect.catchDefect(() => Effect.succeed(buildFailed(req, "internal", String(defect), false, false, undefined)))),
        ),
        Effect.catch((cause: unknown) =>
          Effect.gen(function* () {
            const msg = cause instanceof Error ? cause.message : String(cause)
            const revEither = yield* readSessionRev(sessionId)
            const latestRev = isLeft(revEither) ? undefined : (rightValue(revEither) as number | undefined)
            const cfgEither = yield* readConfigVer(canonDir)
            const latestCfg = isLeft(cfgEither) ? undefined : (rightValue(cfgEither) as number | undefined)
            const revision = makeRevision(latestRev, latestCfg)
            return buildFailed(req, "internal", msg, false, false, revision)
          }).pipe(Effect.catchDefect(() => Effect.succeed(buildFailed(req, "internal", String(cause), false, false, undefined)))),
        ),
      )
      return yield* inner
    })

    const dispatchPrivate = Effect.fn("SessionUpdateDispatch.dispatchPrivate")(function* (raw: unknown) {
      let req: SessionUpdateRequest
      try {
        req = validateRequest(raw)
        // Private requires explicit parentSessionId === null (must be present and null)
        const rawCtx = (raw as Record<string, unknown>)?.context as Record<string, unknown> | undefined
        if (!rawCtx || !("parentSessionId" in rawCtx) || rawCtx.parentSessionId !== null) {
          throw new Error("context.parentSessionId must be null")
        }
        if (req.context.parentSessionId !== null) throw new Error("context.parentSessionId must be null")
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
            return `sessionUpdate:ses_unknown`
          }
        })()
        const failure = SessionOperation.normalizeRecord({
          opId: opIdSafe,
          opKind: "sessionUpdate",
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
        } satisfies SessionUpdateFailed
      }

      const canonDir = canonicalDirectory(req.context.directory)
      const sessionId = SessionID.make(req.context.sessionId)
      const hash = SessionOperation.hashIdempotencyKey(req.idempotencyKey)
      const title = validateTitle(req.payload.title)

      const inner = Effect.gen(function* () {
        const sessionRow = yield* db
          .select({ directory: SessionTable.directory, project_id: SessionTable.project_id, workspace_id: SessionTable.workspace_id })
          .from(SessionTable)
          .where(eq(SessionTable.id, sessionId))
          .get()
          .pipe(Effect.orDie)
        if (!sessionRow) {
          const cfgEither = yield* readConfigVer(canonDir)
          if (isLeft(cfgEither)) return buildFailed(req, "internal", "config version read failed", false, false, makeRevision(undefined, undefined))
          const cfgVer = rightValue(cfgEither) as number | undefined
          const revision = makeRevision(undefined, cfgVer)
          return buildFailed(req, "session.not_found", `session not found ${sessionId}`, false, false, revision)
        }
        const canonicalStored = canonicalDirectory(sessionRow.directory)
        if (canonicalStored !== canonDir) {
          const revEither = yield* readSessionRev(sessionId)
          if (isLeft(revEither)) return buildFailed(req, "internal", "revision read failed", false, false, makeRevision(undefined, undefined))
          const cfgEither = yield* readConfigVer(canonDir)
          if (isLeft(cfgEither)) return buildFailed(req, "internal", "config version read failed", false, false, makeRevision(rightValue(revEither) as number | undefined, undefined))
          const curRev = rightValue(revEither) as number | undefined
          const cfgVer = rightValue(cfgEither) as number | undefined
          const revision = makeRevision(curRev, cfgVer)
          return buildFailed(req, "scope_mismatch", `directory mismatch for session ${sessionId}`, false, false, revision)
        }

        // Private replay lookup/conflict BEFORE any freshness-authority reads — same-key replay returns exact persisted facts
        // Also check opId collision before any rev/config reads (same as public)
        const existing = yield* SessionOperation.getSessionUpdateByIdempotencyHash(db, sessionId, hash).pipe(Effect.orDie)
        const existingOpId = yield* SessionOperation.get(db, req.opId).pipe(Effect.orDie)
        if (existing) {
          const conflict = SessionOperation.isSessionUpdateConflict(existing, {
            opId: req.opId,
            directory: canonDir,
            parentSessionId: req.context.parentSessionId ?? null,
            configVersion: req.context.configVersion ?? null,
            sessionRevision: req.context.sessionRevision ?? null,
            title,
          })
          if (conflict) {
            const curRev = yield* readRevOmit(sessionId)
            const curCfg = yield* readCfgOmit(canonDir)
            const revision = makeRevision(curRev, curCfg)
            return buildFailed(req, "conflict", "idempotencyKey conflict: different operation facts with same key", false, false, revision)
          }
          // Same-key same-facts replay — return exact persisted terminal facts with omitted authority on read failure
           if (existing.outcome === "succeeded") {
            const hasSnapshot = SessionOperation.hasSnapshot(existing as unknown as SessionOperation.SessionUpdateRecord)
            const persisted = hasSnapshot
              ? snapshotToInfo((existing as unknown as { resultSnapshot: unknown }).resultSnapshot)
              : undefined
            if (hasSnapshot && !persisted) {
              const curRev = yield* readRevOmit(sessionId)
              const curCfg = yield* readCfgOmit(canonDir)
              const persistedRev = (existing as unknown as { revision: number }).revision
              const revision = makeRevision(persistedRev ?? curRev, curCfg)
              return buildFailed(req, "internal", "invalid persisted snapshot", false, false, revision)
            }
            if (persisted) {
              const curRev = yield* readRevOmit(sessionId)
              const curCfg = yield* readCfgOmit(canonDir)
              const persistedRev = (existing as unknown as { revision: number }).revision
              const revision = makeRevision(persistedRev ?? curRev, curCfg)
              return buildSucceeded(req, persisted as unknown as Session.Info, revision)
            }
            // absent snapshot: legacy fallback not allowed for private — fail closed
            const curRev = yield* readRevOmit(sessionId)
            const curCfg = yield* readCfgOmit(canonDir)
            const persistedRev = (existing as unknown as { revision: number }).revision
            const revision = makeRevision(persistedRev ?? curRev, curCfg)
            return buildFailed(req, "internal", "missing persisted snapshot for replay", false, false, revision)
          }
          const curRev = yield* readRevOmit(sessionId)
          const curCfg = yield* readCfgOmit(canonDir)
          const revision = makeRevision(curRev, curCfg)
          return buildFailed(req, existing.code, existing.message, false, false, revision)
        }
        // No existing by hash, but opId already exists with different hash -> conflict (same opId, different idempotencyKey)
        if (existingOpId) {
          const curRev = yield* readRevOmit(sessionId)
          const curCfg = yield* readCfgOmit(canonDir)
          const revision = makeRevision(curRev, curCfg)
          return buildFailed(req, "conflict", "opId already exists with different idempotencyKey", false, false, revision)
        }
        // No committed record at all -> private is replay-only, never inserts
        {
          const curRev = yield* readRevOmit(sessionId)
          const curCfg = yield* readCfgOmit(canonDir)
          const revision = makeRevision(curRev, curCfg)
          return buildFailed(req, "internal", "no committed sessionUpdate record", false, false, revision)
        }
      }).pipe(
        Effect.catchDefect((defect: unknown) =>
          Effect.gen(function* () {
            const msg = defect instanceof Error ? defect.message : String(defect)
            const revEither = yield* readSessionRev(sessionId)
            const latestRev = isLeft(revEither) ? undefined : (rightValue(revEither) as number | undefined)
            const cfgEither = yield* readConfigVer(canonDir)
            const latestCfg = isLeft(cfgEither) ? undefined : (rightValue(cfgEither) as number | undefined)
            const revision = makeRevision(latestRev, latestCfg)
            return buildFailed(req, "internal", msg, false, false, revision)
          }).pipe(Effect.catchDefect(() => Effect.succeed(buildFailed(req, "internal", String(defect), false, false, undefined)))),
        ),
        Effect.catch((cause: unknown) =>
          Effect.gen(function* () {
            const msg = cause instanceof Error ? cause.message : String(cause)
            const revEither = yield* readSessionRev(sessionId)
            const latestRev = isLeft(revEither) ? undefined : (rightValue(revEither) as number | undefined)
            const cfgEither = yield* readConfigVer(canonDir)
            const latestCfg = isLeft(cfgEither) ? undefined : (rightValue(cfgEither) as number | undefined)
            const revision = makeRevision(latestRev, latestCfg)
            return buildFailed(req, "internal", msg, false, false, revision)
          }).pipe(Effect.catchDefect(() => Effect.succeed(buildFailed(req, "internal", String(cause), false, false, undefined)))),
        ),
      )
      return yield* inner
    })

    return { dispatch, dispatchPrivate }
  }),
)
