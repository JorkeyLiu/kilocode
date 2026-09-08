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
import { eq } from "drizzle-orm"
import { SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { Log } from "@opencode-ai/core/util/log"
import { InstanceRef } from "@/effect/instance-ref"
import { acquireDrainControl } from "@/kilocode/server/drain-control-acquire"

export const VERSION = 1 as const
export const OP = "session/delete" as const

export interface SessionDeleteRequest {
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
  payload: Record<string, never>
}

export type Revision = { session: number; config: number }

export interface SessionDeleteSucceeded {
  v: typeof VERSION
  requestId: string
  opId: string
  op: typeof OP
  idempotencyKey: string
  status: "succeeded"
  outcome: { type: "succeeded"; time: number }
  accepted: true
  data: Record<string, never>
  revision?: Revision
}

export interface SessionDeleteFailed {
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

export type SessionDeleteResult = SessionDeleteSucceeded | SessionDeleteFailed

function isNonEmptyString(v: unknown): boolean {
  return typeof v === "string" && v.length > 0
}
function isSafeInt(v: unknown): boolean {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && Number.isSafeInteger(v)
}
export { canonicalDirectory } from "@/kilocode/session/canonical-directory"

export function validateRequest(raw: unknown): SessionDeleteRequest {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("params must be object")
  const o = raw as Record<string, unknown>
  if (o.v !== VERSION) throw new Error(`unsupported session version: ${String(o.v)} — expected numeric ${VERSION}`)
  if (!isNonEmptyString(o.requestId)) throw new Error("requestId must be non-empty string")
  if (!isNonEmptyString(o.opId)) throw new Error("opId must be non-empty string")
  if (o.op !== OP) throw new Error(`op must be ${OP}`)
  if (!isNonEmptyString(o.idempotencyKey)) throw new Error("idempotencyKey must be non-empty string")
  if (o.idempotencyKey !== o.opId) throw new Error("idempotencyKey must equal opId for delete")
  const ctx = o.context
  if (ctx === null || typeof ctx !== "object" || Array.isArray(ctx)) throw new Error("context must be object")
  const c = ctx as Record<string, unknown>
  if (typeof c.directory !== "string" || !isAbsolute(c.directory)) throw new Error("context.directory must be absolute path")
  canonicalDirectory(c.directory as string)
  if (typeof c.sessionId !== "string" || !Schema.is(SessionID)(c.sessionId)) throw new Error("context.sessionId must be SessionID")
  if (!("parentSessionId" in c) || c.parentSessionId !== null) throw new Error("context.parentSessionId must be null")
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
  const allowedRoot = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "context", "payload"])
  for (const k of Object.keys(o)) if (!allowedRoot.has(k)) throw new Error(`unexpected field ${k}`)
  const allowedCtx = new Set(["directory", "sessionId", "parentSessionId", "configVersion", "sessionRevision"])
  for (const k of Object.keys(c)) if (!allowedCtx.has(k)) throw new Error(`unexpected context field ${k}`)
  for (const k of Object.keys(p)) throw new Error(`unexpected payload field ${k}`)
  if (c.parentSessionId !== null && c.parentSessionId !== undefined) throw new Error("parentSessionId must be null for delete")
  try {
    SessionOperation.parseDeleteOpIdForSession(o.opId as string, c.sessionId as string)
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : String(e))
  }
  try {
    SessionOperation.parseDeleteOpIdForSession(o.idempotencyKey as string, c.sessionId as string)
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : String(e))
  }
  return o as unknown as SessionDeleteRequest
}

export function validatePrivateRequest(raw: unknown): SessionDeleteRequest {
  const req = validateRequest(raw)
  const rawCtx = (raw as Record<string, unknown>)?.context as Record<string, unknown> | undefined
  if (!rawCtx || !("parentSessionId" in rawCtx) || rawCtx.parentSessionId !== null) {
    throw new Error("context.parentSessionId must be null")
  }
  if (req.context.parentSessionId !== null) throw new Error("context.parentSessionId must be null")
  return req
}

function buildFailed(
  req: SessionDeleteRequest,
  code: string,
  message: string,
  retryable: boolean,
  accepted: boolean,
  revision: Revision | undefined,
  detail?: string,
): SessionDeleteFailed {
  const normalized = SessionOperation.normalizeRecord({
    opId: req.opId,
    opKind: "delete",
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
  } as SessionDeleteFailed
}

function buildSucceeded(req: SessionDeleteRequest, revision: Revision | undefined): SessionDeleteSucceeded {
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
    data: {},
    ...(revision !== undefined ? { revision } : {}),
  } as SessionDeleteSucceeded
}

function makeRevision(session: number | undefined, config: number | undefined): Revision | undefined {
  return session !== undefined && config !== undefined ? { session, config } : undefined
}

export interface SessionDeleteDispatch {
  readonly dispatch: (request: unknown) => Effect.Effect<SessionDeleteResult, unknown, unknown>
  readonly dispatchPrivate: (request: unknown) => Effect.Effect<SessionDeleteResult, unknown, unknown>
}

export class SessionDeleteDispatchService extends Context.Service<SessionDeleteDispatchService, SessionDeleteDispatch>()(
  "SessionDeleteDispatch",
) {}

const log = Log.create({ service: "sessionDelete" })

export const layer = Layer.effect(
  SessionDeleteDispatchService,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
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

    const dispatch = Effect.fn("SessionDeleteDispatch.dispatch")(function* (raw: unknown) {
      let req: SessionDeleteRequest
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
            return `delete:ses_unknown:tok`
          }
        })()
        const failure = SessionOperation.normalizeRecord({
          opId: opIdSafe,
          opKind: "delete",
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
        } satisfies SessionDeleteFailed
      }

      const canonDir = canonicalDirectory(req.context.directory)
      const sessionId = SessionID.make(req.context.sessionId)
      const hash = SessionOperation.hashIdempotencyKey(req.idempotencyKey)

      const maybeRef = yield* Effect.serviceOption(InstanceRef)
      let drainRelease: Effect.Effect<void> = Effect.void
      let drainCtx: unknown | undefined
      if (Option.isNone(maybeRef)) {
        const acquired = yield* acquireDrainControl(canonDir).pipe(
          Effect.map((v) => ({ tag: "ok" as const, value: v })),
          Effect.catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err)
            const isFence = (err as { _tag?: string })?._tag === "InstanceUnavailableDuringConfigRebuild" || msg.includes("Instance is unavailable")
            return Effect.succeed({ tag: "fail" as const, error: buildFailed(req, isFence ? "InstanceUnavailableDuringConfigRebuild" : "internal", msg, isFence, false, undefined) })
          }),
          Effect.catchDefect((defect: unknown) => {
            const msg = defect instanceof Error ? defect.message : String(defect)
            return Effect.succeed({ tag: "fail" as const, error: buildFailed(req, "internal", msg, false, false, undefined) })
          }),
        )
        if ((acquired as { tag: string }).tag === "fail") return (acquired as { error: SessionDeleteFailed }).error
        const ok = acquired as { tag: "ok"; value: { ctx: unknown; release: Effect.Effect<void> } }
        drainCtx = ok.value.ctx
        drainRelease = ok.value.release
      }

      const inner = Effect.gen(function* () {
        const tombstone = yield* SessionOperation.getSessionDeleteByIdempotencyHash(db, sessionId, hash).pipe(Effect.orDie)
        if (tombstone) {
          const conflict = SessionOperation.isSessionDeleteConflict(tombstone, {
            opId: req.opId,
            directory: canonDir,
            parentSessionId: req.context.parentSessionId ?? null,
            configVersion: req.context.configVersion ?? null,
            sessionRevision: req.context.sessionRevision ?? null,
          })
          if (conflict) {
            const curRev = yield* readRevOmit(sessionId)
            const curCfg = yield* readCfgOmit(canonDir)
            const revision = makeRevision(curRev, curCfg)
            return buildFailed(req, "conflict", "idempotencyKey conflict: different operation facts with same key", false, false, revision)
          }
          if (tombstone.outcome === "succeeded") {
            const curRev = yield* readRevOmit(sessionId)
            const curCfg = yield* readCfgOmit(canonDir)
            const revision = makeRevision(curRev, curCfg)
            return buildSucceeded(req, revision)
          }
          const curRev = yield* readRevOmit(sessionId)
          const curCfg = yield* readCfgOmit(canonDir)
          const revision = makeRevision(curRev, curCfg)
          return buildFailed(req, tombstone.code, tombstone.message, false, false, revision)
        }

        const sessionRow = yield* db
          .select({ directory: SessionTable.directory, project_id: SessionTable.project_id })
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

        const existingOpId = yield* SessionOperation.get(db, req.opId).pipe(Effect.orDie)
        if (existingOpId) {
          const curRev = yield* readRevOmit(sessionId)
          const curCfg = yield* readCfgOmit(canonDir)
          const revision = makeRevision(curRev, curCfg)
          return buildFailed(req, "conflict", "opId already exists with different idempotencyKey", false, false, revision)
        }

        const needsConfigLease = req.context.configVersion !== undefined
        if (needsConfigLease && gate.isBarrierActive(canonDir)) {
          const curRev = yield* readRevOmit(sessionId)
          const curCfg = yield* readCfgOmit(canonDir)
          const revision = makeRevision(curRev, curCfg)
          return buildFailed(req, "InstanceUnavailableDuringConfigRebuild", "instance unavailable during config rebuild", true, false, revision)
        }
        const leaseRelease: Effect.Effect<void> = needsConfigLease ? yield* gate.acquire(canonDir) : Effect.void

        const txResult: SessionDeleteResult = yield* Effect.gen(function* () {
          const revEither = yield* readSessionRev(sessionId)
          if (isLeft(revEither)) return buildFailed(req, "internal", "revision read failed", false, false, makeRevision(undefined, undefined)) as unknown as SessionDeleteResult
          const cfgEither = yield* readConfigVer(canonDir)
          if (isLeft(cfgEither)) return buildFailed(req, "internal", "config version read failed", false, false, makeRevision(rightValue(revEither) as number | undefined, undefined)) as unknown as SessionDeleteResult
          const actualSessionRev = rightValue(revEither) as number | undefined
          const currentConfigVer = rightValue(cfgEither) as number | undefined
          if (req.context.sessionRevision !== undefined && actualSessionRev !== undefined && req.context.sessionRevision < actualSessionRev) {
            const revision = makeRevision(actualSessionRev, currentConfigVer)
            return buildFailed(req, "stale", "stale sessionRevision", false, false, revision) as unknown as SessionDeleteResult
          }
          const cfgBeforeEither = yield* readConfigVer(canonDir)
          if (isLeft(cfgBeforeEither)) return buildFailed(req, "internal", "config version read failed", false, false, makeRevision(actualSessionRev, currentConfigVer)) as unknown as SessionDeleteResult
          const configBeforeTx = rightValue(cfgBeforeEither) as number | undefined
          const effectiveConfigBeforeTx = configBeforeTx ?? currentConfigVer
          if (req.context.configVersion !== undefined && effectiveConfigBeforeTx === undefined) {
            return buildFailed(req, "internal", "config version unavailable", false, false, makeRevision(actualSessionRev, currentConfigVer)) as unknown as SessionDeleteResult
          }
          if (req.context.configVersion !== undefined && effectiveConfigBeforeTx !== undefined && req.context.configVersion < effectiveConfigBeforeTx) {
            const revision = makeRevision(actualSessionRev, effectiveConfigBeforeTx)
            return buildFailed(req, "stale", "stale configVersion", false, false, revision) as unknown as SessionDeleteResult
          }

          const tombInside = yield* SessionOperation.getSessionDeleteByIdempotencyHash(db, sessionId, hash).pipe(Effect.orDie)
          if (tombInside) {
            const conflictInside = SessionOperation.isSessionDeleteConflict(tombInside, {
              opId: req.opId,
              directory: canonDir,
              parentSessionId: req.context.parentSessionId ?? null,
              configVersion: req.context.configVersion ?? null,
              sessionRevision: req.context.sessionRevision ?? null,
            })
            if (conflictInside) {
              const curRev = yield* readRevOmit(sessionId)
              const curCfg = yield* readCfgOmit(canonDir)
              return buildFailed(req, "conflict", "idempotencyKey conflict: different operation facts with same key", false, false, makeRevision(curRev, curCfg)) as unknown as SessionDeleteResult
            }
            if (tombInside.outcome === "succeeded") {
              const curRev = yield* readRevOmit(sessionId)
              const curCfg = yield* readCfgOmit(canonDir)
              return buildSucceeded(req, makeRevision(curRev, curCfg)) as unknown as SessionDeleteResult
            }
            const curRev = yield* readRevOmit(sessionId)
            const curCfg = yield* readCfgOmit(canonDir)
            return buildFailed(req, tombInside.code, tombInside.message, false, false, makeRevision(curRev, curCfg)) as unknown as SessionDeleteResult
          }

          const sessionSvc = yield* Session.Service
          const exit = yield* sessionSvc
            .remove(sessionId, {
              tombstone: {
                opId: req.opId,
                hash,
                requestId: req.requestId,
                directory: canonDir,
                parentSessionId: req.context.parentSessionId ?? null,
                configVersion: req.context.configVersion ?? null,
                sessionRevision: req.context.sessionRevision ?? null,
              },
            })
            .pipe(Effect.exit)
          if (exit._tag === "Failure") {
            const cause = exit.cause
            const err = (cause as unknown as { error?: unknown })?.error ?? cause
            const msg = err instanceof Error ? err.message : String(err)
            const causeStr = String(cause)
            const isUnique = msg.includes("UNIQUE") || msg.includes("unique") || causeStr.includes("UNIQUE") || causeStr.includes("unique") || msg.includes("SQLITE_CONSTRAINT")
            if (isUnique) {
              const curRev = yield* readRevOmit(sessionId)
              const curCfg = yield* readCfgOmit(canonDir)
              return buildFailed(req, "conflict", "idempotencyKey conflict: different operation facts with same key", false, false, makeRevision(curRev, curCfg)) as unknown as SessionDeleteResult
            }
            const isNotFound = msg.includes("not found") || causeStr.includes("NotFound")
            if (isNotFound) {
              const cfgEither2 = yield* readConfigVer(canonDir)
              const cfgVer2 = isLeft(cfgEither2) ? undefined : (rightValue(cfgEither2) as number | undefined)
              const revision = makeRevision(undefined, cfgVer2)
              return buildFailed(req, "session.not_found", `session not found ${sessionId}`, false, false, revision) as unknown as SessionDeleteResult
            }
            const curRev = yield* readRevOmit(sessionId)
            const curCfg = yield* readCfgOmit(canonDir)
            return buildFailed(req, "internal", msg, false, false, makeRevision(curRev, curCfg)) as unknown as SessionDeleteResult
          }

          const revAfter = yield* readRevOmit(sessionId)
          const cfgAfter = yield* readCfgOmit(canonDir)
          const revision = makeRevision(revAfter, cfgAfter)
          return buildSucceeded(req, revision)
        }).pipe(Effect.ensuring(leaseRelease))

        return txResult
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
      if (drainCtx !== undefined) return yield* inner.pipe(Effect.provideService(InstanceRef, drainCtx as never), Effect.ensuring(drainRelease))
      return yield* inner.pipe(Effect.ensuring(drainRelease))
    })

    const dispatchPrivate = Effect.fn("SessionDeleteDispatch.dispatchPrivate")(function* (raw: unknown) {
      let req: SessionDeleteRequest
      try {
        req = validatePrivateRequest(raw)
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
            return `delete:ses_unknown:tok`
          }
        })()
        const failure = SessionOperation.normalizeRecord({
          opId: opIdSafe,
          opKind: "delete",
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
        } satisfies SessionDeleteFailed
      }

      const canonDir = canonicalDirectory(req.context.directory)
      const sessionId = SessionID.make(req.context.sessionId)
      const hash = SessionOperation.hashIdempotencyKey(req.idempotencyKey)

      const inner = Effect.gen(function* () {
        const tombstone = yield* SessionOperation.getSessionDeleteByIdempotencyHash(db, sessionId, hash).pipe(Effect.orDie)
        if (!tombstone) {
          const curRev = yield* readRevOmit(sessionId)
          const curCfg = yield* readCfgOmit(canonDir)
          const revision = makeRevision(curRev, curCfg)
          return buildFailed(req, "internal", "no committed delete record", false, false, revision)
        }
        const conflict = SessionOperation.isSessionDeleteConflict(tombstone, {
          opId: req.opId,
          directory: canonDir,
          parentSessionId: req.context.parentSessionId ?? null,
          configVersion: req.context.configVersion ?? null,
          sessionRevision: req.context.sessionRevision ?? null,
        })
        if (conflict) {
          const curRev = yield* readRevOmit(sessionId)
          const curCfg = yield* readCfgOmit(canonDir)
          const revision = makeRevision(curRev, curCfg)
          return buildFailed(req, "conflict", "idempotencyKey conflict: different operation facts with same key", false, false, revision)
        }
        if (tombstone.outcome === "succeeded") {
          const curRev = yield* readRevOmit(sessionId)
          const curCfg = yield* readCfgOmit(canonDir)
          const revision = makeRevision(curRev, curCfg)
          return buildSucceeded(req, revision)
        }
        const curRev = yield* readRevOmit(sessionId)
        const curCfg = yield* readCfgOmit(canonDir)
        const revision = makeRevision(curRev, curCfg)
        return buildFailed(req, tombstone.code, tombstone.message, false, false, revision)
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
