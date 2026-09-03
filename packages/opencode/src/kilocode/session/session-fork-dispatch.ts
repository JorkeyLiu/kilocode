import fs from "node:fs/promises"
import path from "node:path"
import { isAbsolute } from "path"
import { Cause, Context, Effect, Layer, Option, Schema } from "effect"
import { Global } from "@opencode-ai/core/global"
import { canonicalDirectory } from "@/kilocode/session/canonical-directory"
import { cloneMessageDataForFork, clonePartDataForFork, filterMessagesForFork, getForkedTitle, resolveForkModelAtCheckpoint, sessionPath } from "@/kilocode/session/fork"
import { Database } from "@opencode-ai/core/database/database"
import { EventSequenceTable, EventTable } from "@opencode-ai/core/event/sql"
import { MessageTable, PartTable, SessionTable } from "@opencode-ai/core/session/sql"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionOperation } from "@opencode-ai/core/session/operation"
import { SessionRevision } from "@opencode-ai/core/session/revision"
import { ConfigConvergence } from "@/kilocode/server/config-convergence"
import { GenerationGate } from "@/kilocode/server/generation-gate"
import { SessionID, MessageID, PartID } from "@/session/schema"
import { Session } from "@/session/session"
import { eq, asc } from "drizzle-orm"
import { Slug } from "@opencode-ai/core/util/slug"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Log } from "@opencode-ai/core/util/log"
import { KiloSession } from "@/kilocode/session"
import * as SandboxPolicy from "@/kilocode/sandbox/policy"
import { SandboxStore } from "@/kilocode/sandbox/store"
import { baseKey, carryForkDiff, cumulativeSessionDiff, mergeSessionDiffs, readSessionDiffBase } from "@/kilocode/session-portability/cumulative-diff"
import { InstanceStore } from "@/project/instance-store"
import { InstanceRef } from "@/effect/instance-ref"
import { EventV2 } from "@opencode-ai/core/event"
import { Storage, NotFoundError } from "@/storage/storage"
import { makeRuntime } from "@opencode-ai/core/effect/runtime"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { ProjectV2 } from "@opencode-ai/core/project"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { ForkSeam } from "@/kilocode/session/fork-seam"
import { storageFileForKey, writeExclusiveJson, isClaimedWriteError, ClaimedWriteError } from "@/storage/claimed-file"

export const VERSION = 1 as const
export const OP = "session/fork" as const

export interface SessionForkRequest {
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
    messageId?: string | null
  }
}

export type Revision = { session: number; config: number }

export interface SessionForkSucceeded {
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

export interface SessionForkPrivateSucceeded {
  v: typeof VERSION
  requestId: string
  opId: string
  op: typeof OP
  idempotencyKey: string
  status: "succeeded"
  outcome: { type: "succeeded"; time: number }
  accepted: true
  data: { session: Session.Info }
  revision?: Revision
}

export interface SessionForkFailed {
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

export type SessionForkResult = SessionForkSucceeded | SessionForkFailed
export type SessionForkPrivateResult = SessionForkPrivateSucceeded | SessionForkFailed

function isNonEmptyString(v: unknown): boolean {
  return typeof v === "string" && v.length > 0
}
function isSafeInt(v: unknown): boolean {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && Number.isSafeInteger(v)
}
export { canonicalDirectory } from "@/kilocode/session/canonical-directory"

export function validateRequest(raw: unknown): SessionForkRequest {
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
  if (typeof c.directory !== "string" || !isAbsolute(c.directory as string)) throw new Error("context.directory must be absolute path")
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
  if ("messageId" in p && p.messageId !== null && p.messageId !== undefined) {
    if (typeof p.messageId !== "string" || !Schema.is(MessageID)(p.messageId as string))
      throw new Error("payload.messageId must be MessageID")
  }
  const allowedRoot = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "context", "payload"])
  for (const k of Object.keys(o)) if (!allowedRoot.has(k)) throw new Error(`unexpected field ${k}`)
  const allowedCtx = new Set(["directory", "sessionId", "parentSessionId", "configVersion", "sessionRevision"])
  for (const k of Object.keys(c)) if (!allowedCtx.has(k)) throw new Error(`unexpected context field ${k}`)
  const allowedPayload = new Set(["messageId"])
  for (const k of Object.keys(p)) if (!allowedPayload.has(k)) throw new Error(`unexpected payload field ${k}`)
  try {
    SessionOperation.parseForkOpIdForSession(o.opId as string, c.sessionId as string)
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : String(e))
  }
  // Canonical identity: opId and idempotencyKey must be identical; token colon rejected by bound fork parse
  if (o.idempotencyKey !== o.opId) throw new Error("idempotencyKey must equal opId for fork")
  try {
    SessionOperation.parseForkOpIdForSession(o.idempotencyKey as string, c.sessionId as string)
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : String(e))
  }
  if (c.parentSessionId !== null && c.parentSessionId !== undefined) throw new Error("parentSessionId must be null for fork")
  return o as unknown as SessionForkRequest
}

function buildFailed(
  req: SessionForkRequest,
  code: string,
  message: string,
  retryable: boolean,
  accepted: boolean,
  revision: Revision | undefined,
  detail?: string,
): SessionForkFailed {
  const normalized = SessionOperation.normalizeRecord({
    opId: req.opId,
    opKind: "fork",
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
  } as SessionForkFailed
}

function buildSucceeded(req: SessionForkRequest, data: Session.Info, revision: Revision | undefined): SessionForkSucceeded {
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
  } as SessionForkSucceeded
}

function buildPrivateSucceeded(
  req: SessionForkRequest,
  data: Session.Info,
  revision: Revision | undefined,
): SessionForkPrivateSucceeded {
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
    data: { session: data },
    ...(revision !== undefined ? { revision } : {}),
  } as SessionForkPrivateSucceeded
}

function makeRevision(session: number | undefined, config: number | undefined): Revision | undefined {
  return session !== undefined && config !== undefined ? { session, config } : undefined
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

export interface SessionForkDispatch {
  readonly dispatch: (request: unknown) => Effect.Effect<SessionForkResult, unknown, unknown>
  readonly dispatchPrivate: (request: unknown) => Effect.Effect<SessionForkPrivateResult, unknown, unknown>
}

export class SessionForkDispatchService extends Context.Service<SessionForkDispatchService, SessionForkDispatch>()(
  "SessionForkDispatch",
) {}

const log = Log.create({ service: "sessionFork" })

function isNotFound(err: unknown): boolean {
  return err instanceof NotFoundError || (err as unknown as { _tag?: string })?._tag === "NotFoundError"
}

function isEnoent(err: unknown): boolean {
  const c = (err as unknown as { code?: string })?.code
  if (c === "ENOENT") return true
  const msg = err instanceof Error ? err.message : String(err)
  return msg.includes("ENOENT")
}

function isEexist(err: unknown): boolean {
  const c = (err as unknown as { code?: string })?.code
  if (c === "EEXIST") return true
  const msg = err instanceof Error ? err.message : String(err)
  return msg.includes("EEXIST")
}

function isUniqueViolation(err: unknown): boolean {
  const code = (err as unknown as { code?: string })?.code
  if (code === "SQLITE_CONSTRAINT" || code === "SQLITE_CONSTRAINT_PRIMARYKEY" || code === "SQLITE_CONSTRAINT_UNIQUE") return true
  const msg = err instanceof Error ? err.message : String(err)
  return msg.includes("UNIQUE constraint") || msg.includes("unique constraint") || msg.includes("UNIQUE") || msg.includes("SQLITE_CONSTRAINT")
}

export const layer = Layer.effect(
  SessionForkDispatchService,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const cfg = Option.getOrElse(yield* Effect.serviceOption(ConfigConvergence.Service), () => ConfigConvergence.noop)
    const gate = Option.getOrElse(yield* Effect.serviceOption(GenerationGate.Service), () => GenerationGate.noop)
    const events = yield* EventV2.Service
    const instanceStore = yield* InstanceStore.Service

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

    const dispatch = Effect.fn("SessionForkDispatch.dispatch")(function* (raw: unknown) {
      let req: SessionForkRequest
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
            const ctx = (fallback as Record<string, unknown>)?.context as Record<string, unknown> | undefined
            const sid = ctx?.sessionId
            if (typeof sid === "string" && sid.length > 0) SessionOperation.parseForkOpIdForSession(opId, sid)
            else SessionOperation.parseOpId(opId)
            return opId
          } catch {
            return `fork:ses_unknown`
          }
        })()
        const failure = SessionOperation.normalizeRecord({
          opId: opIdSafe,
          opKind: "fork",
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
        } satisfies SessionForkFailed
      }

      const canonDir = canonicalDirectory(req.context.directory)
      const sessionId = SessionID.make(req.context.sessionId)
      const hash = SessionOperation.hashIdempotencyKey(req.idempotencyKey)
      const messageId = req.payload.messageId ? MessageID.make(req.payload.messageId as string) : undefined

      const inner = Effect.gen(function* () {
        const sourceRow = yield* db
          .select()
          .from(SessionTable)
          .where(eq(SessionTable.id, sessionId))
          .get()
          .pipe(Effect.orDie)
        if (!sourceRow) {
          const cfgEither = yield* readConfigVer(canonDir)
          if (isLeft(cfgEither)) return buildFailed(req, "internal", "config version read failed", false, false, makeRevision(undefined, undefined))
          const cfgVer = rightValue(cfgEither) as number | undefined
          const revision = makeRevision(undefined, cfgVer)
          return buildFailed(req, "session.not_found", `source session not found ${sessionId}`, false, false, revision)
        }

        // Idempotency / opId replay lookup MUST happen before freshness reads
        const existing = yield* SessionOperation.getSessionForkByIdempotencyHash(db, sessionId, hash).pipe(Effect.orDie)
        if (existing) {
          const conflict = SessionOperation.isSessionForkConflict(existing, {
            opId: req.opId,
            directory: canonDir,
            parentSessionId: req.context.parentSessionId ?? null,
            configVersion: req.context.configVersion ?? null,
            sessionRevision: req.context.sessionRevision ?? null,
            messageId: (req.payload.messageId as string) ?? null,
          })
          if (conflict) {
            const curRev = yield* readRevOmit(sessionId)
            const curCfg = yield* readCfgOmit(canonDir)
            const revision = makeRevision(curRev, curCfg)
            return buildFailed(req, "conflict", "idempotencyKey conflict: different operation facts with same key", false, false, revision)
          }
          if (existing.outcome === "succeeded") {
            const hasSnap = Object.hasOwn(existing as object, "resultSnapshot")
            const persisted = hasSnap ? snapshotToInfo((existing as unknown as { resultSnapshot: unknown }).resultSnapshot) : undefined
            if (hasSnap && !persisted) {
              const curRev = yield* readRevOmit(sessionId)
              const curCfg = yield* readCfgOmit(canonDir)
              const revision = makeRevision((existing as unknown as { revision: number }).revision ?? curRev, curCfg)
              return buildFailed(req, "internal", "invalid persisted snapshot", false, false, revision)
            }
            if (persisted) {
              const persistedRev = (existing as unknown as { revision: number }).revision
              const curRev = yield* readRevOmit(sessionId)
              const curCfg = yield* readCfgOmit(canonDir)
              const revision = makeRevision(persistedRev ?? curRev, curCfg)
              return buildSucceeded(req, persisted as unknown as Session.Info, revision)
            }
            return buildFailed(req, "internal", "missing persisted snapshot for replay", false, false, makeRevision(yield* readRevOmit(sessionId), yield* readCfgOmit(canonDir)))
          }
          const curRev = yield* readRevOmit(sessionId)
          const curCfg = yield* readCfgOmit(canonDir)
          const revision = makeRevision(curRev, curCfg)
          return buildFailed(req, existing.code, existing.message, false, false, revision)
        }

        const existingOpId = yield* SessionOperation.get(db, req.opId).pipe(Effect.orDie)
        if (existingOpId) {
          const curRev = yield* readRevOmit(sessionId)
          const curCfg = yield* readCfgOmit(canonDir)
          const revision = makeRevision(curRev, curCfg)
          return buildFailed(req, "conflict", "opId already exists with different idempotencyKey", false, false, revision)
        }

        // Resolve target instance context for canonical project/path and future sandbox inheritance
        const targetCtx = yield* instanceStore.load({ directory: canonDir })
        const targetPath = sessionPath(targetCtx.worktree, canonDir)

        // Config fence must be linearized via single GenerationGate lease
        const needsConfigLease = req.context.configVersion !== undefined
        if (needsConfigLease && gate.isBarrierActive(canonDir)) {
          const curRev = yield* readRevOmit(sessionId)
          const curCfg = yield* readCfgOmit(canonDir)
          const revision = makeRevision(curRev, curCfg)
          return buildFailed(req, "InstanceUnavailableDuringConfigRebuild", "instance unavailable during config rebuild", true, false, revision)
        }
        const leaseRelease: Effect.Effect<void> = needsConfigLease ? yield* gate.acquire(canonDir) : Effect.void

        // Ownership-aware execution: filesystem side effects are outside the DB transaction
        // and are compensated only for artifacts owned by this attempt. Post-crash
        // interruption (process kill between FS write and DB commit) may leave orphaned
        // artifacts; no automatic recovery subsystem claims cross-resource crash atomicity.
        let forkedId: string | undefined
        let ownedBase = false
        let ownedDiff = false
        let ownedSandbox = false
        const storageRuntime = makeRuntime(Storage.Service, Storage.defaultLayer)
        const cleanupOwned = Effect.gen(function* () {
          if (forkedId) {
            if (ownedBase) {
              const okStorage = yield* (ForkSeam.failCleanupStorage
                ? Effect.gen(function* () {
                    ForkSeam.capturedCleanupWarnings.push({ target: forkedId as string, cause: "injected cleanup storage failure" })
                    yield* Effect.logWarning("durable fork cleanup base storage failed", { target: forkedId, cause: "injected cleanup storage failure" })
                  }).pipe(Effect.as(false as const))
                : Effect.promise(() => storageRuntime.runPromise((s) => s.remove(baseKey(forkedId as string)))).pipe(
                    Effect.map(() => true as const),
                    Effect.catch((e) => Effect.logWarning("durable fork cleanup base storage failed", { target: forkedId, cause: String(e) }).pipe(Effect.as(false as const))),
                    Effect.catchDefect((e) => Effect.logWarning("durable fork cleanup base storage defect", { target: forkedId, cause: String(e) }).pipe(Effect.as(false as const))),
                  ))
              const okFs = yield* (ForkSeam.failCleanupFs
                ? Effect.gen(function* () {
                    ForkSeam.capturedCleanupWarnings.push({ target: forkedId as string, cause: "injected cleanup fs failure" })
                    yield* Effect.logWarning("durable fork cleanup base fs failed", { target: forkedId, cause: "injected cleanup fs failure" })
                  }).pipe(Effect.as(false as const))
                : Effect.promise(() => fs.rm(storageFileForKey(baseKey(forkedId as string), Global.Path.data), { force: true })).pipe(
                    Effect.map(() => true as const),
                    Effect.catch((e) => Effect.logWarning("durable fork cleanup base fs failed", { target: forkedId, cause: String(e) }).pipe(Effect.as(false as const))),
                    Effect.catchDefect((e) => Effect.logWarning("durable fork cleanup base fs defect", { target: forkedId, cause: String(e) }).pipe(Effect.as(false as const))),
                  ))
              if (okStorage && okFs) ownedBase = false
            }
            if (ownedDiff) {
              const okStorage = yield* (ForkSeam.failCleanupStorage
                ? Effect.gen(function* () {
                    ForkSeam.capturedCleanupWarnings.push({ target: forkedId as string, cause: "injected cleanup storage failure" })
                    yield* Effect.logWarning("durable fork cleanup diff storage failed", { target: forkedId, cause: "injected cleanup storage failure" })
                  }).pipe(Effect.as(false as const))
                : Effect.promise(() => storageRuntime.runPromise((s) => s.remove(["session_diff", forkedId as string]))).pipe(
                    Effect.map(() => true as const),
                    Effect.catch((e) => Effect.logWarning("durable fork cleanup diff storage failed", { target: forkedId, cause: String(e) }).pipe(Effect.as(false as const))),
                    Effect.catchDefect((e) => Effect.logWarning("durable fork cleanup diff storage defect", { target: forkedId, cause: String(e) }).pipe(Effect.as(false as const))),
                  ))
              const okFs = yield* (ForkSeam.failCleanupFs
                ? Effect.gen(function* () {
                    ForkSeam.capturedCleanupWarnings.push({ target: forkedId as string, cause: "injected cleanup fs failure" })
                    yield* Effect.logWarning("durable fork cleanup diff fs failed", { target: forkedId, cause: "injected cleanup fs failure" })
                  }).pipe(Effect.as(false as const))
                : Effect.promise(() => fs.rm(storageFileForKey(["session_diff", forkedId as string], Global.Path.data), { force: true })).pipe(
                    Effect.map(() => true as const),
                    Effect.catch((e) => Effect.logWarning("durable fork cleanup diff fs failed", { target: forkedId, cause: String(e) }).pipe(Effect.as(false as const))),
                    Effect.catchDefect((e) => Effect.logWarning("durable fork cleanup diff fs defect", { target: forkedId, cause: String(e) }).pipe(Effect.as(false as const))),
                  ))
              if (okStorage && okFs) ownedDiff = false
            }
            if (ownedSandbox) {
              const okRemove = yield* Effect.promise(() => SandboxStore.remove(canonDir, forkedId as unknown as SessionID)).pipe(
                Effect.map(() => true as const),
                Effect.catch((e) => Effect.logWarning("durable fork cleanup sandbox remove failed", { target: forkedId, cause: String(e) }).pipe(Effect.as(false as const))),
                Effect.catchDefect((e) => Effect.logWarning("durable fork cleanup sandbox remove defect", { target: forkedId, cause: String(e) }).pipe(Effect.as(false as const))),
              )
              const okEvict = yield* Effect.sync(() => SandboxPolicy.evict(canonDir, forkedId as unknown as SessionID)).pipe(
                Effect.map(() => true as const),
                Effect.catch((e) => Effect.logWarning("durable fork cleanup sandbox evict failed", { target: forkedId, cause: String(e) }).pipe(Effect.as(false as const))),
                Effect.catchDefect((e) => Effect.logWarning("durable fork cleanup sandbox evict defect", { target: forkedId, cause: String(e) }).pipe(Effect.as(false as const))),
              )
              if (okRemove && okEvict) ownedSandbox = false
            }
            yield* Effect.sync(() => KiloSession.clearPlatformOverride(forkedId as string)).pipe(
              Effect.catch((e) => Effect.logWarning("durable fork cleanup KiloSession clear failed", { target: forkedId, cause: String(e) }).pipe(Effect.asVoid)),
              Effect.catchDefect((e) => Effect.logWarning("durable fork cleanup KiloSession clear defect", { target: forkedId, cause: String(e) }).pipe(Effect.asVoid)),
            )
          }
        })

        const txResult: SessionForkResult = yield* Effect.gen(function* () {
          // Freshness reads only when no committed replay/conflict
          const revEither = yield* readSessionRev(sessionId)
          if (isLeft(revEither)) return buildFailed(req, "internal", "revision read failed", false, false, makeRevision(undefined, undefined)) as unknown as SessionForkResult
          const cfgEither = yield* readConfigVer(canonDir)
          if (isLeft(cfgEither)) return buildFailed(req, "internal", "config version read failed", false, false, makeRevision(rightValue(revEither) as number | undefined, undefined)) as unknown as SessionForkResult
          const actualSessionRev = rightValue(revEither) as number | undefined
          const currentConfigVer = rightValue(cfgEither) as number | undefined
          if (req.context.sessionRevision !== undefined && actualSessionRev !== undefined && req.context.sessionRevision < actualSessionRev) {
            const revision = makeRevision(actualSessionRev, currentConfigVer)
            return buildFailed(req, "stale", "stale sessionRevision", false, false, revision) as unknown as SessionForkResult
          }
          const cfgBeforeEither = yield* readConfigVer(canonDir)
          if (isLeft(cfgBeforeEither)) return buildFailed(req, "internal", "config version read failed", false, false, makeRevision(actualSessionRev, currentConfigVer)) as unknown as SessionForkResult
          const configBeforeTx = rightValue(cfgBeforeEither) as number | undefined
          const effectiveConfigBeforeTx = configBeforeTx ?? currentConfigVer
          if (req.context.configVersion !== undefined && effectiveConfigBeforeTx === undefined) {
            return buildFailed(req, "internal", "config version unavailable", false, false, makeRevision(actualSessionRev, currentConfigVer)) as unknown as SessionForkResult
          }
          if (req.context.configVersion !== undefined && effectiveConfigBeforeTx !== undefined && req.context.configVersion < effectiveConfigBeforeTx) {
            const revision = makeRevision(actualSessionRev, effectiveConfigBeforeTx)
            return buildFailed(req, "stale", "stale configVersion", false, false, revision) as unknown as SessionForkResult
          }

          // Generate target ID before filesystem ownership checks (deterministic seam for tests)
          const newId = ForkSeam.nextId ? ForkSeam.nextId : SessionID.descending()
          if (ForkSeam.nextId) ForkSeam.nextId = undefined
          forkedId = newId

          // Target session identity occupation must be rejected before any FS effects (strict IDs).
          const idOccupied = yield* db
            .select()
            .from(SessionTable)
            .where(eq(SessionTable.id, newId as unknown as SessionID))
            .get()
            .pipe(
              Effect.map((v) => !!v),
              Effect.orDie,
            )
          if (idOccupied) {
            const curRev = yield* readRevOmit(sessionId)
            const curCfg = yield* readCfgOmit(canonDir)
            const revision = makeRevision(curRev, curCfg)
            return buildFailed(req, "conflict", "fork target already exists", false, false, revision) as unknown as SessionForkResult
          }

          // Establish ownership: refuse if target artifacts already exist (fail closed on probe errors)
          // Preflight target aggregate occupancy (SessionTable + EventSequence/EventTable) before any FS effects.
          const eventSeqExists = yield* db
            .select()
            .from(EventSequenceTable)
            .where(eq(EventSequenceTable.aggregate_id, newId as unknown as string))
            .get()
            .pipe(
              Effect.map((v) => !!v),
              Effect.orDie,
            )
          const eventExists = yield* db
            .select()
            .from(EventTable)
            .where(eq(EventTable.aggregate_id, newId as unknown as string))
            .get()
            .pipe(
              Effect.map((v) => !!v),
              Effect.orDie,
            )
          if (eventSeqExists || eventExists) {
            const curRev = yield* readRevOmit(sessionId)
            const curCfg = yield* readCfgOmit(canonDir)
            const revision = makeRevision(curRev, curCfg)
            return buildFailed(req, "conflict", "fork target already exists", false, false, revision) as unknown as SessionForkResult
          }
          const writeStorageExclusive = async (key: string[], content: unknown) => {
            await writeExclusiveJson(storageFileForKey(key, Global.Path.data), content)
          }
          // Probe existing artifacts — any error other than ENOENT fails closed (internal)
          const existingSandbox = yield* Effect.promise(() => SandboxStore.read(canonDir, newId as unknown as SessionID)).pipe(
            Effect.map((v) => v !== undefined),
            Effect.catch((e) => (isEnoent(e) ? Effect.succeed(false) : Effect.fail(e))),
            Effect.catchDefect((e) => Effect.fail(e)),
          )
          const baseExists = yield* Effect.promise(() =>
            fs
              .stat(storageFileForKey(baseKey(newId as string), Global.Path.data))
              .then(() => true)
              .catch((e: unknown) => {
                if (isEnoent(e)) return false
                throw e
              }),
          )
          const diffExists = yield* Effect.promise(() =>
            fs
              .stat(storageFileForKey(["session_diff", String(newId)], Global.Path.data))
              .then(() => true)
              .catch((e: unknown) => {
                if (isEnoent(e)) return false
                throw e
              }),
          )

          if (existingSandbox || baseExists || diffExists) {
            const curRev = yield* readRevOmit(sessionId)
            const curCfg = yield* readCfgOmit(canonDir)
            const revision = makeRevision(curRev, curCfg)
            return buildFailed(req, "conflict", "fork target already exists", false, false, revision) as unknown as SessionForkResult
          }

          // Perform required filesystem side effects with ownership tracking.
          // All failures here fail closed and clean only owned artifacts.
          const srcDir = (sourceRow as unknown as { directory: string }).directory
          // Peek source sandbox (reads isolated store, not cached state)
          const fallback = yield* SandboxPolicy.peek(srcDir, sessionId)
          // Diff carry with exclusive claim and owned flags
          const localForDiff = yield* Effect.promise(() =>
            storageRuntime.runPromise((s) => s.read<any>(["session_diff", String(sessionId)]).pipe(Effect.catchIf(isNotFound, () => Effect.succeed([] as any)))),
          ).pipe(
            Effect.map((v) => v as unknown[]),
            Effect.catch((e) => Effect.fail(e)),
            Effect.catchDefect((e) => Effect.fail(e)),
          )
          const baseForDiff = yield* Effect.promise(() => storageRuntime.runPromise((s) => cumulativeSessionDiff(s, sessionId, localForDiff as any)))
          const hasDiff = baseForDiff.length > 0
          if (hasDiff) {
            const firstKey = baseKey(newId as string)
            const secondKey = ["session_diff", String(newId)] as unknown as string[]
            // First diff write (exclusive) — on post-open ClaimedWriteError, transfer handle to caller and retain ownership until cleanup succeeds
            const firstOutcome = yield* Effect.gen(function* () {
              if (ForkSeam.failFirstDiffWrite) return yield* Effect.fail(new Error("injected first diff write failure"))
              yield* Effect.promise(() => writeStorageExclusive(firstKey, baseForDiff))
              ownedBase = true
            }).pipe(
              Effect.map(() => ({ _tag: "ok" as const })),
              Effect.catch((e) => Effect.succeed({ _tag: "fail" as const, error: e })),
              Effect.catchDefect((e) => Effect.succeed({ _tag: "fail" as const, error: e })),
            )
            if (firstOutcome._tag === "fail") {
              const err = firstOutcome.error
              if (isEexist(err)) {
                const curRev = yield* readRevOmit(sessionId)
                const curCfg = yield* readCfgOmit(canonDir)
                return buildFailed(req, "conflict", "fork target already exists", false, false, makeRevision(curRev, curCfg)) as unknown as SessionForkResult
              }
              if (isClaimedWriteError(err)) {
                // transfer claim: file was created but write failed, caller retains ownership until cleanup succeeds
                ownedBase = true
                const claimed = err as ClaimedWriteError
                const original = (claimed.cause as unknown) ?? claimed
                const msg = original instanceof Error ? original.message : String(original)
                // attempt cleanup via handle, retain ownership on failure and log with target/cause
                const ok = yield* (ForkSeam.failCleanupFs
                  ? Effect.gen(function* () {
                      ForkSeam.capturedCleanupWarnings.push({ target: claimed.target, cause: "injected cleanup fs failure" })
                      yield* Effect.logWarning("durable fork claimed cleanup failed", { target: claimed.target, cause: "injected cleanup fs failure" })
                    }).pipe(Effect.as(false as const))
                  : Effect.promise(() => claimed.handle.cleanup()).pipe(
                      Effect.map((v) => v as boolean),
                      Effect.catch((e) => Effect.logWarning("durable fork claimed cleanup failed", { target: claimed.target, cause: String(e) }).pipe(Effect.as(false as const))),
                      Effect.catchDefect((e) => Effect.logWarning("durable fork claimed cleanup defect", { target: claimed.target, cause: String(e) }).pipe(Effect.as(false as const))),
                    ))
                if (ok) ownedBase = false
                else yield* Effect.logWarning("durable fork claimed file retained (cleanup failed)", { target: claimed.target, cause: msg })
                const curRev = yield* readRevOmit(sessionId)
                const curCfg = yield* readCfgOmit(canonDir)
                return buildFailed(req, "internal", msg, false, false, makeRevision(curRev, curCfg)) as unknown as SessionForkResult
              }
              const msg = err instanceof Error ? err.message : String(err)
              const curRev = yield* readRevOmit(sessionId)
              const curCfg = yield* readCfgOmit(canonDir)
              return buildFailed(req, "internal", msg, false, false, makeRevision(curRev, curCfg)) as unknown as SessionForkResult
            }
            // Second diff write (exclusive) — partial failure must clean only first (owned)
            const secondOutcome = yield* Effect.gen(function* () {
              if (ForkSeam.failSecondDiffWrite) return yield* Effect.fail(new Error("injected second diff write failure"))
              yield* Effect.promise(() => writeStorageExclusive(secondKey, baseForDiff))
              ownedDiff = true
            }).pipe(
              Effect.map(() => ({ _tag: "ok" as const })),
              Effect.catch((e) => Effect.succeed({ _tag: "fail" as const, error: e })),
              Effect.catchDefect((e) => Effect.succeed({ _tag: "fail" as const, error: e })),
            )
            if (secondOutcome._tag === "fail") {
              const err = secondOutcome.error
              // If second write was a claimed failure, the second file exists orphan — transfer handle cleanup before partial first cleanup
              if (isClaimedWriteError(err)) {
                const claimed2 = err as ClaimedWriteError
                ownedDiff = true
                const original2 = (claimed2.cause as unknown) ?? claimed2
                const msg2 = original2 instanceof Error ? original2.message : String(original2)
                const ok2 = yield* (ForkSeam.failCleanupFs
                  ? Effect.gen(function* () {
                      ForkSeam.capturedCleanupWarnings.push({ target: claimed2.target, cause: "injected cleanup fs failure" })
                      yield* Effect.logWarning("durable fork claimed second cleanup failed", { target: claimed2.target, cause: "injected cleanup fs failure" })
                    }).pipe(Effect.as(false as const))
                  : Effect.promise(() => claimed2.handle.cleanup()).pipe(
                      Effect.map((v) => v as boolean),
                      Effect.catch((e) => Effect.logWarning("durable fork claimed second cleanup failed", { target: claimed2.target, cause: String(e) }).pipe(Effect.as(false as const))),
                      Effect.catchDefect((e) => Effect.logWarning("durable fork claimed second cleanup defect", { target: claimed2.target, cause: String(e) }).pipe(Effect.as(false as const))),
                    ))
                if (ok2) ownedDiff = false
                else yield* Effect.logWarning("durable fork claimed second file retained", { target: claimed2.target, cause: msg2 })
                // also clean owned first as before
                const okFirst = yield* (ForkSeam.failCleanupFs
                  ? Effect.gen(function* () {
                      ForkSeam.capturedCleanupWarnings.push({ target: String(firstKey), cause: "injected cleanup fs failure" })
                      yield* Effect.logWarning("durable fork second diff partial cleanup failed", { target: String(firstKey), cause: "injected cleanup fs failure" })
                    }).pipe(Effect.as(false as const))
                  : Effect.promise(() => fs.rm(storageFileForKey(firstKey, Global.Path.data), { force: true })).pipe(
                      Effect.map(() => true as const),
                      Effect.catch((e) => Effect.logWarning("durable fork second diff partial cleanup failed", { target: String(firstKey), cause: String(e) }).pipe(Effect.as(false as const))),
                      Effect.catchDefect((e) => Effect.logWarning("durable fork second diff partial cleanup defect", { target: String(firstKey), cause: String(e) }).pipe(Effect.as(false as const))),
                    ))
                if (okFirst) ownedBase = false
                if (isEexist(original2)) {
                  const curRev = yield* readRevOmit(sessionId)
                  const curCfg = yield* readCfgOmit(canonDir)
                  return buildFailed(req, "conflict", "fork target already exists", false, false, makeRevision(curRev, curCfg)) as unknown as SessionForkResult
                }
                const curRev = yield* readRevOmit(sessionId)
                const curCfg = yield* readCfgOmit(canonDir)
                return buildFailed(req, "internal", msg2, false, false, makeRevision(curRev, curCfg)) as unknown as SessionForkResult
              }
              // Clean only owned first — log failures, retain ownership until success
              const ok = yield* (ForkSeam.failCleanupFs
                ? Effect.gen(function* () {
                    ForkSeam.capturedCleanupWarnings.push({ target: String(firstKey), cause: "injected cleanup fs failure" })
                    yield* Effect.logWarning("durable fork second diff partial cleanup failed", { target: String(firstKey), cause: "injected cleanup fs failure" })
                  }).pipe(Effect.as(false as const))
                : Effect.promise(() => fs.rm(storageFileForKey(firstKey, Global.Path.data), { force: true })).pipe(
                    Effect.map(() => true as const),
                    Effect.catch((e) => Effect.logWarning("durable fork second diff partial cleanup failed", { target: String(firstKey), cause: String(e) }).pipe(Effect.as(false as const))),
                    Effect.catchDefect((e) => Effect.logWarning("durable fork second diff partial cleanup defect", { target: String(firstKey), cause: String(e) }).pipe(Effect.as(false as const))),
                  ))
              if (ok) ownedBase = false
              if (isEexist(err)) {
                const curRev = yield* readRevOmit(sessionId)
                const curCfg = yield* readCfgOmit(canonDir)
                return buildFailed(req, "conflict", "fork target already exists", false, false, makeRevision(curRev, curCfg)) as unknown as SessionForkResult
              }
              const msg = err instanceof Error ? err.message : String(err)
              const curRev = yield* readRevOmit(sessionId)
              const curCfg = yield* readCfgOmit(canonDir)
              return buildFailed(req, "internal", msg, false, false, makeRevision(curRev, curCfg)) as unknown as SessionForkResult
            }
          }
          if (ForkSeam.failSandboxWrite) {
            // clean diff owned artifacts before failing — preserve ownership flags until cleanup succeeds
            yield* cleanupOwned.pipe(Effect.catch(() => Effect.void), Effect.catchDefect(() => Effect.void))
            const curRev = yield* readRevOmit(sessionId)
            const curCfg = yield* readCfgOmit(canonDir)
            return buildFailed(req, "internal", "injected sandbox write failure", false, false, makeRevision(curRev, curCfg)) as unknown as SessionForkResult
          }
          // Sandbox inherit with exclusive claim (may be no-op if source has no sandbox)
          let parentSnap: SandboxStore.Snapshot | undefined
          if (fallback) {
            parentSnap = fallback as unknown as SandboxStore.Snapshot
          } else {
            parentSnap = yield* Effect.promise(() => SandboxStore.read(srcDir, sessionId)).pipe(
              Effect.map((v) => v as SandboxStore.Snapshot | undefined),
              Effect.catch((e) => (isEnoent(e) ? Effect.succeed(undefined) : Effect.fail(e))),
              Effect.catchDefect((e) => Effect.fail(e)),
            )
          }
          if (parentSnap) {
            const nextSnap: SandboxStore.Snapshot = { ...parentSnap, version: 0 }
            const sandboxOutcome = yield* Effect.gen(function* () {
              yield* Effect.promise(() => SandboxStore.writeExclusive(canonDir, newId as unknown as SessionID, nextSnap))
              ownedSandbox = true
            }).pipe(
              Effect.map(() => ({ _tag: "ok" as const })),
              Effect.catch((e) => Effect.succeed({ _tag: "fail" as const, error: e })),
              Effect.catchDefect((e) => Effect.succeed({ _tag: "fail" as const, error: e })),
            )
            if (sandboxOutcome._tag === "fail") {
              const err = sandboxOutcome.error
              if (isClaimedWriteError(err)) {
                const claimedSb = err as ClaimedWriteError
                ownedSandbox = true
                const originalSb = (claimedSb.cause as unknown) ?? claimedSb
                const msgSb = originalSb instanceof Error ? originalSb.message : String(originalSb)
                // clean owned diffs before handling sandbox claimed orphan
                yield* cleanupOwned.pipe(Effect.catch(() => Effect.void), Effect.catchDefect(() => Effect.void))
                const okSb = yield* (ForkSeam.failCleanupFs
                  ? Effect.gen(function* () {
                      ForkSeam.capturedCleanupWarnings.push({ target: claimedSb.target, cause: "injected cleanup fs failure" })
                      yield* Effect.logWarning("durable fork sandbox claimed cleanup failed", { target: claimedSb.target, cause: "injected cleanup fs failure" })
                    }).pipe(Effect.as(false as const))
                  : Effect.promise(() => claimedSb.handle.cleanup()).pipe(
                      Effect.map((v) => v as boolean),
                      Effect.catch((e) => Effect.logWarning("durable fork sandbox claimed cleanup failed", { target: claimedSb.target, cause: String(e) }).pipe(Effect.as(false as const))),
                      Effect.catchDefect((e) => Effect.logWarning("durable fork sandbox claimed cleanup defect", { target: claimedSb.target, cause: String(e) }).pipe(Effect.as(false as const))),
                    ))
                if (okSb) ownedSandbox = false
                else yield* Effect.logWarning("durable fork sandbox claimed file retained", { target: claimedSb.target, cause: msgSb })
                if (isEexist(originalSb)) {
                  const curRev = yield* readRevOmit(sessionId)
                  const curCfg = yield* readCfgOmit(canonDir)
                  return buildFailed(req, "conflict", "fork target already exists", false, false, makeRevision(curRev, curCfg)) as unknown as SessionForkResult
                }
                const curRev = yield* readRevOmit(sessionId)
                const curCfg = yield* readCfgOmit(canonDir)
                return buildFailed(req, "internal", msgSb, false, false, makeRevision(curRev, curCfg)) as unknown as SessionForkResult
              }
              // Clean only owned diff artifacts — flags cleared only after successful removal inside cleanupOwned
              yield* cleanupOwned.pipe(Effect.catch(() => Effect.void), Effect.catchDefect(() => Effect.void))
              // ownedSandbox not set, so no sandbox to clean (failed before ownership)
              if (isEexist(err)) {
                const curRev = yield* readRevOmit(sessionId)
                const curCfg = yield* readCfgOmit(canonDir)
                return buildFailed(req, "conflict", "fork target already exists", false, false, makeRevision(curRev, curCfg)) as unknown as SessionForkResult
              }
              const msg = err instanceof Error ? err.message : String(err)
              const curRev = yield* readRevOmit(sessionId)
              const curCfg = yield* readCfgOmit(canonDir)
              return buildFailed(req, "internal", msg, false, false, makeRevision(curRev, curCfg)) as unknown as SessionForkResult
            }
          }

          // DB transaction (session/ messages/ parts/ event/ operation) - no filesystem inside.
          type TxOut = { result: SessionForkResult; event?: unknown; sideEffect?: { newId: string; parentID: string } }
          const txOut: TxOut = yield* db.transaction(
            (tx) =>
              Effect.gen(function* () {
                if (ForkSeam.failTxAfterFs) return yield* Effect.fail(new Error("injected transaction failure after filesystem writes"))
                const already = yield* SessionOperation.getSessionForkByIdempotencyHashTx(tx as unknown as typeof db, sessionId, hash)
                if (already) {
                  const c = SessionOperation.isSessionForkConflict(already, {
                    opId: req.opId,
                    directory: canonDir,
                    parentSessionId: req.context.parentSessionId ?? null,
                    configVersion: req.context.configVersion ?? null,
                    sessionRevision: req.context.sessionRevision ?? null,
                    messageId: (req.payload.messageId as string) ?? null,
                  })
                  if (c) return { result: buildFailed(req, "conflict", "idempotencyKey conflict: different operation facts with same key", false, false, makeRevision(yield* readRevOmit(sessionId), yield* readCfgOmit(canonDir))) } as unknown as TxOut
                  if (already.outcome === "succeeded") {
                    const hasSnap = Object.hasOwn(already as object, "resultSnapshot")
                    const persisted = hasSnap ? snapshotToInfo((already as unknown as { resultSnapshot: unknown }).resultSnapshot) : undefined
                    if (hasSnap && !persisted) return { result: buildFailed(req, "internal", "invalid persisted snapshot", false, false, makeRevision((already as unknown as { revision: number }).revision, yield* readCfgOmit(canonDir))) } as unknown as TxOut
                    if (persisted) {
                      const persistedRev = (already as unknown as { revision: number }).revision
                      return { result: buildSucceeded(req, persisted as unknown as Session.Info, makeRevision(persistedRev, yield* readCfgOmit(canonDir))) } as unknown as TxOut
                    }
                    return { result: buildFailed(req, "internal", "missing persisted snapshot for replay", false, false, makeRevision(yield* readRevOmit(sessionId), yield* readCfgOmit(canonDir))) } as unknown as TxOut
                  }
                  return { result: buildFailed(req, already.code, already.message, false, false, makeRevision(yield* readRevOmit(sessionId), yield* readCfgOmit(canonDir))) } as unknown as TxOut
                }
                const opExists = yield* SessionOperation.getTx(tx as unknown as typeof db, req.opId)
                if (opExists) return { result: buildFailed(req, "conflict", "opId already exists with different idempotencyKey", false, false, makeRevision(yield* readRevOmit(sessionId), yield* readCfgOmit(canonDir))) } as unknown as TxOut

                // Re-read authoritative revisions inside tx
                const authRevEither = yield* (SessionRevision.getTx(tx as unknown as typeof db, sessionId) as unknown as Effect.Effect<unknown, unknown, unknown>).pipe(
                  Effect.map((v) => ({ _tag: "Right" as const, right: v as number | undefined })),
                  Effect.catch((e: unknown) => Effect.succeed({ _tag: "Left" as const, left: e })),
                  Effect.catchDefect((e: unknown) => Effect.succeed({ _tag: "Left" as const, left: e })),
                ) as unknown as Effect.Effect<{ _tag: "Right"; right: number | undefined } | { _tag: "Left"; left: unknown }>
                if ((authRevEither as unknown as { _tag: string })._tag === "Left") {
                  return { result: buildFailed(req, "internal", "revision read failed inside tx", false, false, makeRevision(undefined, undefined)) } as unknown as TxOut
                }
                const authRev: number | undefined = (authRevEither as unknown as { right: number | undefined }).right
                if (authRev !== undefined && req.context.sessionRevision !== undefined && req.context.sessionRevision < authRev) {
                  const cfgInsideEither = yield* (getConfigVer(canonDir) as unknown as Effect.Effect<unknown, unknown, unknown>).pipe(
                    Effect.map((v) => ({ _tag: "Right" as const, right: v as number | undefined })),
                    Effect.catch((e: unknown) => Effect.succeed({ _tag: "Left" as const, left: e })),
                    Effect.catchDefect((e: unknown) => Effect.succeed({ _tag: "Left" as const, left: e })),
                  ) as unknown as Effect.Effect<{ _tag: "Right"; right: number | undefined } | { _tag: "Left"; left: unknown }>
                  const latestCfg = isLeft(cfgInsideEither) ? undefined : (rightValue(cfgInsideEither) as number | undefined)
                  return { result: buildFailed(req, "stale", "stale sessionRevision", false, false, makeRevision(authRev, latestCfg ?? effectiveConfigBeforeTx)) } as unknown as TxOut
                }
                const cfgInsideEither = yield* (getConfigVer(canonDir) as unknown as Effect.Effect<unknown, unknown, unknown>).pipe(
                  Effect.map((v) => ({ _tag: "Right" as const, right: v as number | undefined })),
                  Effect.catch((e: unknown) => Effect.succeed({ _tag: "Left" as const, left: e })),
                  Effect.catchDefect((e: unknown) => Effect.succeed({ _tag: "Left" as const, left: e })),
                ) as unknown as Effect.Effect<{ _tag: "Right"; right: number | undefined } | { _tag: "Left"; left: unknown }>
                if ((cfgInsideEither as unknown as { _tag: string })._tag === "Left") {
                  return { result: buildFailed(req, "internal", "config version read failed inside tx", false, false, makeRevision(authRev ?? actualSessionRev, undefined)) } as unknown as TxOut
                }
                const cfgInside: number | undefined = (cfgInsideEither as unknown as { right: number | undefined }).right
                const effectiveInside = cfgInside ?? effectiveConfigBeforeTx
                if (req.context.configVersion !== undefined && effectiveInside === undefined) {
                  return { result: buildFailed(req, "internal", "config version unavailable inside tx", false, false, makeRevision(authRev ?? actualSessionRev, undefined)) } as unknown as TxOut
                }
                if (req.context.configVersion !== undefined && effectiveInside !== undefined && req.context.configVersion < effectiveInside) {
                  const revForStale = authRev ?? actualSessionRev ?? 0
                  return { result: buildFailed(req, "stale", "stale configVersion", false, false, makeRevision(revForStale, effectiveInside)) } as unknown as TxOut
                }

                // Re-fetch source inside tx for consistent read
                const src = yield* tx.select().from(SessionTable).where(eq(SessionTable.id, sessionId)).get().pipe(Effect.orDie)
                if (!src) return { result: buildFailed(req, "session.not_found", `source session not found ${sessionId}`, false, false, makeRevision(authRev, effectiveInside)) } as unknown as TxOut

                // Determine model at fork point (same as Session.fork)
                const msgRows = yield* tx
                  .select()
                  .from(MessageTable)
                  .where(eq(MessageTable.session_id, sessionId))
                  .orderBy(asc(MessageTable.time_created), asc(MessageTable.id))
                  .all()
                  .pipe(Effect.orDie)
                const filteredRows = filterMessagesForFork(msgRows as unknown as Array<{ id: string }>, messageId as unknown as string | null) as typeof msgRows
                const model = resolveForkModelAtCheckpoint({
                  sourceModel: (src as unknown as { model: { id: string; providerID: string; variant?: string } | null }).model as unknown as { id: string; providerID: string; variant?: string } | null,
                  checkpointId: messageId as unknown as string | null,
                  orderedMessages: msgRows.map((r) => ({ id: r.id as unknown as string, role: (r.data as Record<string, unknown>).role as string, model: (r.data as Record<string, unknown>).model })),
                }) as unknown

                const newTitle = getForkedTitle((src as unknown as { title: string }).title)
                const now = Date.now()
                const slug = Slug.create()
                const newRow: Record<string, unknown> = {
                  id: newId,
                  project_id: targetCtx.project.id,
                  workspace_id: (src as unknown as { workspace_id: string | null }).workspace_id ?? null,
                  parent_id: sessionId,
                  slug,
                  directory: canonDir,
                  path: targetPath,
                  title: newTitle,
                  version: InstallationVersion,
                  share_url: null,
                  summary_additions: null,
                  summary_deletions: null,
                  summary_files: null,
                  summary_diffs: null,
                  metadata: (src as unknown as { metadata: unknown }).metadata ?? null,
                  cost: 0,
                  tokens_input: 0,
                  tokens_output: 0,
                  tokens_reasoning: 0,
                  tokens_cache_read: 0,
                  tokens_cache_write: 0,
                  revert: null,
                  permission: null,
                  agent: (src as unknown as { agent: string | null }).agent ?? null,
                  model: model ?? null,
                  revision: 0,
                  time_created: now,
                  time_updated: now,
                  time_compacting: null,
                  time_archived: null,
                }
                // Ensure target project row exists (upsert) - Project.fromDirectory already did, but ensure via tx
                yield* tx
                  .insert(ProjectTable)
                  .values({
                    id: targetCtx.project.id as unknown as string,
                    worktree: AbsolutePath.make(targetCtx.worktree),
                    vcs: (targetCtx.project.vcs as string | undefined) ?? null,
                    time_created: targetCtx.project.time.created,
                    time_updated: targetCtx.project.time.updated,
                    sandboxes: targetCtx.project.sandboxes.map((s) => AbsolutePath.make(s)),
                  } as unknown as typeof ProjectTable.$inferInsert)
                  .onConflictDoNothing()
                  .run()
                  .pipe(Effect.orDie)

                yield* tx.insert(SessionTable).values(newRow as unknown as typeof SessionTable.$inferInsert).run().pipe(Effect.orDie)

                // Copy messages and parts with checkpoint — uses shared kernel for transcript mapping
                const idMap = new Map<string, MessageID>()
                for (const row of filteredRows) {
                  const oldId = row.id as unknown as string
                  const newMsgId = MessageID.ascending()
                  idMap.set(oldId, newMsgId)
                  const oldData = row.data as Record<string, unknown>
                  const clonedData = cloneMessageDataForFork(oldData, idMap as unknown as Map<string, string>)
                  const newMsgRow = {
                    id: newMsgId,
                    session_id: newId,
                    time_created: row.time_created,
                    time_updated: now,
                    data: clonedData,
                  }
                  yield* tx.insert(MessageTable).values(newMsgRow as unknown as typeof MessageTable.$inferInsert).run().pipe(Effect.orDie)
                  const partRows = yield* tx
                    .select()
                    .from(PartTable)
                    .where(eq(PartTable.message_id, oldId as unknown as MessageID))
                    .orderBy(asc(PartTable.id))
                    .all()
                    .pipe(Effect.orDie)
                  for (const prow of partRows) {
                    const prepared = KiloSession.prepareForkedPart(prow.data as unknown as Parameters<typeof KiloSession.prepareForkedPart>[0])
                    if (!prepared) continue
                    const mapped = clonePartDataForFork(prepared as unknown as import("@/session/message-v2").MessageV2.Part, idMap as unknown as Map<string, string>)
                    const p: Record<string, unknown> = {
                      ...mapped,
                      id: PartID.ascending(),
                      messageID: newMsgId,
                      sessionID: newId,
                    }
                    const partInsert = {
                      id: p.id as string,
                      message_id: newMsgId,
                      session_id: newId,
                      time_created: (prow as unknown as { time_created: number }).time_created ?? now,
                      time_updated: now,
                      data: (() => {
                        const { id: _id, sessionID: _sid, messageID: _mid, ...rest } = p as Record<string, unknown>
                        return rest
                      })(),
                    }
                    yield* tx.insert(PartTable).values(partInsert as unknown as typeof PartTable.$inferInsert).run().pipe(Effect.orDie)
                  }
                }

                // @ts-ignore drizzle branded SessionID overload mismatch — runtime types are compatible (both SessionID strings)
                const inserted = yield* (tx.select() as unknown as { from: (t: unknown) => { where: (c: unknown) => { get: () => unknown } } }).from(SessionTable).where(eq(SessionTable.id as unknown, newId as unknown)).get().pipe(Effect.orDie) as unknown as typeof SessionTable.$inferSelect | undefined
                if (!inserted) yield* Effect.die(new Error("forked session missing after insert"))
                const insertedNonNull = inserted as typeof inserted & { workspace_id: string | null; directory: string }

                // Event and operation in same tx (filesystem side effects already done outside)
                const info = Session.fromRow(insertedNonNull as unknown as Parameters<typeof Session.fromRow>[0]) as unknown as Session.Info
                const loc = new Location.Info({
                  directory: AbsolutePath.make(canonDir),
                  ...(insertedNonNull.workspace_id ? { workspaceID: insertedNonNull.workspace_id as unknown as WorkspaceV2.ID } : {}),
                  project: { id: ProjectV2.ID.make(targetCtx.project.id), directory: AbsolutePath.make(targetCtx.worktree) },
                })
                const event = yield* (events as unknown as { recordProjectedTx: (tx: unknown, type: unknown, data: unknown, opts: unknown) => Effect.Effect<unknown> }).recordProjectedTx(
                  tx as unknown as never,
                  SessionV1.Event.Created,
                  { sessionID: newId, info },
                  { location: loc as unknown as Location.Info },
                )
                const snapshotJson = JSON.stringify(insertedNonNull)
                const record: SessionOperation.FailureRecord = {
                  opId: req.opId,
                  opKind: "fork",
                  outcome: "succeeded",
                  code: "fork.succeeded",
                  message: "fork succeeded",
                  time: now,
                }
                const meta: SessionOperation.SessionForkMeta = {
                  idempotencyHash: hash,
                  requestId: req.requestId,
                  directory: canonDir,
                  parentSessionId: req.context.parentSessionId ?? null,
                  configVersion: req.context.configVersion ?? null,
                  sessionRevision: req.context.sessionRevision ?? null,
                  messageId: (req.payload.messageId as string) ?? null,
                  forkedSessionId: newId,
                }
                const opRec = yield* SessionOperation.insertSessionForkSucceededTx(tx as unknown as typeof db, sessionId, record, meta, snapshotJson)
                const opInfo = snapshotToInfo((opRec as unknown as { resultSnapshot: unknown }).resultSnapshot)
                if (!opInfo) yield* Effect.die(new Error("invalid snapshot after fork insert"))
                return { result: buildSucceeded(req, opInfo as unknown as Session.Info, makeRevision((opRec as unknown as { revision: number }).revision, effectiveInside)), event, sideEffect: { newId, parentID: sessionId as unknown as string } } as unknown as TxOut
              }),
            { behavior: "immediate" },
          )
          // If transaction returned a failed result (e.g., race-induced conflict/stale), clean owned filesystem artifacts before returning.
          // Flags cleared only after successful removal inside cleanupOwned; retained ownership diagnostics on cleanup failure.
          if ((txOut as unknown as { result: SessionForkResult }).result.status === "failed") {
            yield* cleanupOwned.pipe(Effect.catch(() => Effect.void), Effect.catchDefect(() => Effect.void))
          }
          // Post-commit side effects (commit-safe boundary): register is best-effort; diff and sandbox inherit already committed outside tx
          const side = (txOut as unknown as { sideEffect?: { newId: string; parentID: string } }).sideEffect
          if (side) {
            yield* Effect.sync(() => KiloSession.register({ id: side.newId, parentID: side.parentID })).pipe(
              Effect.catch((e: unknown) => Effect.sync(() => log.warn("fork post-commit register failed", { error: e instanceof Error ? e.message : String(e), newId: side.newId }))),
              Effect.catchDefect((e: unknown) => Effect.sync(() => log.warn("fork post-commit register defect", { error: String(e), newId: side.newId }))),
            )
          }
          // Notify outside transaction
          if ((txOut as unknown as { event?: unknown }).event) {
            const ev = (txOut as unknown as { event: unknown }).event
            yield* (events as unknown as { notifyCommitted: (e: unknown) => Effect.Effect<void> }).notifyCommitted(ev).pipe(
              Effect.catch(() => Effect.void),
              Effect.catchDefect(() => Effect.void),
            )
          }
          return (txOut as unknown as { result: SessionForkResult }).result
        }).pipe(
          Effect.ensuring(leaseRelease),
          Effect.catch((cause: unknown) =>
            Effect.gen(function* () {
              // If cause is already a SessionForkFailed wrapped as success value, it would have been returned,
              // not thrown. So this path is for Effect.fail (transaction or filesystem injection).
              // Clean only owned artifacts.
              yield* cleanupOwned.pipe(Effect.catch(() => Effect.void), Effect.catchDefect(() => Effect.void))
              // If forkedId was set but transaction failed before sideEffect register, ensure no in-memory ghost
              if (forkedId) yield* Effect.sync(() => KiloSession.clearPlatformOverride(forkedId as string)).pipe(Effect.catch(() => Effect.void), Effect.catchDefect(() => Effect.void))
              if (isUniqueViolation(cause)) {
                const curRev = yield* readRevOmit(sessionId)
                const curCfg = yield* readCfgOmit(canonDir)
                return buildFailed(req, "conflict", "fork target already exists", false, false, makeRevision(curRev, curCfg)) as unknown as SessionForkResult
              }
              // Return internal failure (preserve fork failure semantics)
              const msg = cause instanceof Error ? cause.message : String(cause)
              const curRev = yield* readRevOmit(sessionId)
              const curCfg = yield* readCfgOmit(canonDir)
              return buildFailed(req, "internal", msg, false, false, makeRevision(curRev, curCfg)) as unknown as SessionForkResult
            }),
          ),
          Effect.catchDefect((defect: unknown) =>
            Effect.gen(function* () {
              yield* cleanupOwned.pipe(Effect.catch(() => Effect.void), Effect.catchDefect(() => Effect.void))
              if (forkedId) yield* Effect.sync(() => KiloSession.clearPlatformOverride(forkedId as string)).pipe(Effect.catch(() => Effect.void), Effect.catchDefect(() => Effect.void))
              if (isUniqueViolation(defect)) {
                const curRev = yield* readRevOmit(sessionId)
                const curCfg = yield* readCfgOmit(canonDir)
                return buildFailed(req, "conflict", "fork target already exists", false, false, makeRevision(curRev, curCfg)) as unknown as SessionForkResult
              }
              const msg = defect instanceof Error ? defect.message : String(defect)
              const curRev = yield* readRevOmit(sessionId)
              const curCfg = yield* readCfgOmit(canonDir)
              return buildFailed(req, "internal", msg, false, false, makeRevision(curRev, curCfg)) as unknown as SessionForkResult
            }),
          ),
        )
        return txResult
      }).pipe(
        Effect.catchDefect((defect: unknown) =>
          Effect.gen(function* () {
            if (isUniqueViolation(defect)) {
              const curRev = yield* readRevOmit(sessionId)
              const curCfg = yield* readCfgOmit(canonDir)
              const revision = makeRevision(curRev, curCfg)
              return buildFailed(req, "conflict", "fork target already exists", false, false, revision)
            }
            const msg = defect instanceof Error ? defect.message : String(defect)
            const curRev = yield* readRevOmit(sessionId)
            const curCfg = yield* readCfgOmit(canonDir)
            const revision = makeRevision(curRev, curCfg)
            return buildFailed(req, "internal", msg, false, false, revision)
          }).pipe(Effect.catchDefect(() => Effect.succeed(buildFailed(req, "internal", String(defect), false, false, undefined)))),
        ),
        Effect.catch((cause: unknown) =>
          Effect.gen(function* () {
            if (isUniqueViolation(cause)) {
              const curRev = yield* readRevOmit(sessionId)
              const curCfg = yield* readCfgOmit(canonDir)
              const revision = makeRevision(curRev, curCfg)
              return buildFailed(req, "conflict", "fork target already exists", false, false, revision)
            }
            const msg = cause instanceof Error ? cause.message : String(cause)
            const curRev = yield* readRevOmit(sessionId)
            const curCfg = yield* readCfgOmit(canonDir)
            const revision = makeRevision(curRev, curCfg)
            return buildFailed(req, "internal", msg, false, false, revision)
          }).pipe(Effect.catchDefect(() => Effect.succeed(buildFailed(req, "internal", String(cause), false, false, undefined)))),
        ),
      )
      return yield* inner
    })

    const dispatchPrivate = Effect.fn("SessionForkDispatch.dispatchPrivate")(function* (raw: unknown) {
      let req: SessionForkRequest
      try {
        req = validateRequest(raw)
        const rawCtx = (raw as Record<string, unknown>)?.context as Record<string, unknown> | undefined
        if (!rawCtx || typeof rawCtx.directory !== "string" || !isAbsolute(rawCtx.directory as string)) {
          throw new Error("context.directory must be absolute path")
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        const fallback = raw as Record<string, unknown>
        const requestId = typeof fallback?.requestId === "string" ? fallback.requestId : "unknown"
        const opId = typeof fallback?.opId === "string" ? fallback.opId : "unknown"
        const idempotencyKey = typeof fallback?.idempotencyKey === "string" ? fallback.idempotencyKey : "unknown"
        const time = Date.now()
        const opIdSafe = (() => {
          try {
            const ctx = (fallback as Record<string, unknown>)?.context as Record<string, unknown> | undefined
            const sid = ctx?.sessionId
            if (typeof sid === "string" && sid.length > 0) SessionOperation.parseForkOpIdForSession(opId, sid)
            else SessionOperation.parseOpId(opId)
            return opId
          } catch {
            return `fork:ses_unknown`
          }
        })()
        const failure = SessionOperation.normalizeRecord({
          opId: opIdSafe,
          opKind: "fork",
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
        } satisfies SessionForkFailed
      }

      const canonDir = canonicalDirectory(req.context.directory)
      const sessionId = SessionID.make(req.context.sessionId)
      const hash = SessionOperation.hashIdempotencyKey(req.idempotencyKey)

      const inner = Effect.gen(function* () {
        const sourceRow = yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionId)).get().pipe(Effect.orDie)
        if (!sourceRow) {
          const cfgEither = yield* readConfigVer(canonDir)
          if (isLeft(cfgEither)) return buildFailed(req, "internal", "config version read failed", false, false, makeRevision(undefined, undefined))
          const cfgVer = rightValue(cfgEither) as number | undefined
          const revision = makeRevision(undefined, cfgVer)
          return buildFailed(req, "session.not_found", `source session not found ${sessionId}`, false, false, revision)
        }
        const existing = yield* SessionOperation.getSessionForkByIdempotencyHash(db, sessionId, hash).pipe(Effect.orDie)
        const existingOpId = yield* SessionOperation.get(db, req.opId).pipe(Effect.orDie)
        if (existing) {
          const conflict = SessionOperation.isSessionForkConflict(existing, {
            opId: req.opId,
            directory: canonDir,
            parentSessionId: req.context.parentSessionId ?? null,
            configVersion: req.context.configVersion ?? null,
            sessionRevision: req.context.sessionRevision ?? null,
            messageId: (req.payload.messageId as string) ?? null,
          })
          if (conflict) {
            const curRev = yield* readRevOmit(sessionId)
            const curCfg = yield* readCfgOmit(canonDir)
            const revision = makeRevision(curRev, curCfg)
            return buildFailed(req, "conflict", "idempotencyKey conflict: different operation facts with same key", false, false, revision)
          }
          if (existing.outcome === "succeeded") {
            const hasSnap = Object.hasOwn(existing as object, "resultSnapshot")
            const persisted = hasSnap ? snapshotToInfo((existing as unknown as { resultSnapshot: unknown }).resultSnapshot) : undefined
            if (hasSnap && !persisted) {
              const curRev = yield* readRevOmit(sessionId)
              const curCfg = yield* readCfgOmit(canonDir)
              const persistedRev = (existing as unknown as { revision: number }).revision
              const revision = makeRevision(persistedRev ?? curRev, curCfg)
              return buildFailed(req, "internal", "invalid persisted snapshot", false, false, revision)
            }
            if (persisted) {
              const persistedRev = (existing as unknown as { revision: number }).revision
              const curRev = yield* readRevOmit(sessionId)
              const curCfg = yield* readCfgOmit(canonDir)
              const revision = makeRevision(persistedRev ?? curRev, curCfg)
              return buildPrivateSucceeded(req, persisted as unknown as Session.Info, revision)
            }
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
        if (existingOpId) {
          const curRev = yield* readRevOmit(sessionId)
          const curCfg = yield* readCfgOmit(canonDir)
          const revision = makeRevision(curRev, curCfg)
          return buildFailed(req, "conflict", "opId already exists with different idempotencyKey", false, false, revision)
        }
        const curRev = yield* readRevOmit(sessionId)
        const curCfg = yield* readCfgOmit(canonDir)
        const revision = makeRevision(curRev, curCfg)
        return buildFailed(req, "internal", "no committed fork record", false, false, revision)
      }).pipe(
        Effect.catchDefect((defect: unknown) =>
          Effect.gen(function* () {
            const msg = defect instanceof Error ? defect.message : String(defect)
            const curRev = yield* readRevOmit(sessionId)
            const curCfg = yield* readCfgOmit(canonDir)
            const revision = makeRevision(curRev, curCfg)
            return buildFailed(req, "internal", msg, false, false, revision)
          }).pipe(Effect.catchDefect(() => Effect.succeed(buildFailed(req, "internal", String(defect), false, false, undefined)))),
        ),
        Effect.catch((cause: unknown) =>
          Effect.gen(function* () {
            const msg = cause instanceof Error ? cause.message : String(cause)
            const curRev = yield* readRevOmit(sessionId)
            const curCfg = yield* readCfgOmit(canonDir)
            const revision = makeRevision(curRev, curCfg)
            return buildFailed(req, "internal", msg, false, false, revision)
          }).pipe(Effect.catchDefect(() => Effect.succeed(buildFailed(req, "internal", String(cause), false, false, undefined)))),
        ),
      )
      const out = yield* inner
      return out as unknown as SessionForkPrivateResult
    })

    return { dispatch, dispatchPrivate }
  }),
)
