import { isAbsolute, resolve, normalize as normalizePath } from "path"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionOperation } from "@opencode-ai/core/session/operation"
import { SessionRevision } from "@opencode-ai/core/session/revision"
import { ConfigConvergence } from "@/kilocode/server/config-convergence"
import { InstanceRef } from "@/effect/instance-ref"
import { eq } from "drizzle-orm"
import { Session } from "@/session/session"
import { SessionID, MessageID } from "@/session/schema"
import { KiloSessionPromptQueue } from "./prompt-queue"
import { acquireDrainControl, InstanceUnavailableDuringConfigRebuildError } from "@/kilocode/server/drain-control-acquire"
import type { InstanceContext } from "@/project/instance-context"

export const VERSION = 1 as const
export const OP = "session/cancelQueued" as const

export interface CancelQueuedRequest {
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
  }
}

export type Revision = { session: number; config: number }

export interface CancelQueuedSucceeded {
  v: typeof VERSION
  requestId: string
  opId: string
  op: typeof OP
  idempotencyKey: string
  status: "succeeded"
  outcome: { type: "succeeded"; time: number }
  accepted: true
  data: { cancelled: boolean }
  revision?: Revision
}

export interface CancelQueuedFailed {
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

export interface CancelQueuedAmbiguous {
  v: typeof VERSION
  requestId: string
  opId: string
  op: typeof OP
  idempotencyKey: string
  status: "ambiguous"
  outcome: { type: "ambiguous"; time: number }
  accepted: false
  revision?: Revision
}

export type CancelQueuedResult = CancelQueuedSucceeded | CancelQueuedFailed | CancelQueuedAmbiguous

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

export function validateRequest(raw: unknown): CancelQueuedRequest {
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
  if (typeof p.messageId !== "string" || !Schema.is(MessageID)(p.messageId)) throw new Error("payload.messageId must be MessageID")
  const allowedRoot = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "context", "payload"])
  for (const k of Object.keys(o)) if (!allowedRoot.has(k)) throw new Error(`unexpected field ${k}`)
  const allowedCtx = new Set(["directory", "sessionId", "parentSessionId", "configVersion", "sessionRevision"])
  for (const k of Object.keys(c)) if (!allowedCtx.has(k)) throw new Error(`unexpected context field ${k}`)
  const allowedPayload = new Set(["messageId"])
  for (const k of Object.keys(p)) if (!allowedPayload.has(k)) throw new Error(`unexpected payload field ${k}`)
  if (c.parentSessionId !== null && c.parentSessionId !== undefined) throw new Error("parentSessionId must be null for cancelQueued")
  const expected = SessionOperation.cancelQueuedId(c.sessionId as string, p.messageId as string)
  if (o.opId !== expected) throw new Error(`opId must be canonical cancelQueued binding ${expected}`)
  try {
    const parsed = SessionOperation.parseOpId(o.opId as string)
    if (parsed.kind !== "cancelQueued") throw new Error(`opId kind must be cancelQueued: ${o.opId}`)
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : String(e))
  }
  return o as unknown as CancelQueuedRequest
}

function opKindForId(opId: string): SessionOperation.OpKind {
  if (opId.startsWith("cancelQueued:")) return "cancelQueued"
  return "task"
}

function buildFailed(
  req: CancelQueuedRequest,
  code: string,
  message: string,
  retryable: boolean,
  accepted: boolean,
  revision: Revision | undefined,
  detail?: string,
): CancelQueuedFailed {
  const kind = opKindForId(req.opId)
  const normalized = SessionOperation.normalizeRecord({
    opId: req.opId,
    opKind: kind,
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
  } as CancelQueuedFailed
}

function buildSucceeded(
  req: CancelQueuedRequest,
  cancelled: boolean,
  revision: Revision | undefined,
): CancelQueuedSucceeded {
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
    data: { cancelled },
    ...(revision !== undefined ? { revision } : {}),
  } as CancelQueuedSucceeded
}

function buildAmbiguous(
  req: CancelQueuedRequest,
  revision: Revision | undefined,
): CancelQueuedAmbiguous {
  const time = Date.now()
  return {
    v: VERSION,
    requestId: req.requestId,
    opId: req.opId,
    op: OP,
    idempotencyKey: req.idempotencyKey,
    status: "ambiguous",
    outcome: { type: "ambiguous", time },
    accepted: false,
    ...(revision !== undefined ? { revision } : {}),
  } as CancelQueuedAmbiguous
}

function isFenceError(err: unknown): boolean {
  if (err instanceof InstanceUnavailableDuringConfigRebuildError) return true
  const tag = (err as { _tag?: string })?._tag
  return tag === "InstanceUnavailableDuringConfigRebuild"
}

function makeRevision(session: number | undefined, config: number | undefined): Revision | undefined {
  return session !== undefined && config !== undefined ? { session, config } : undefined
}

export interface CancelQueuedDispatch {
  readonly dispatch: (request: unknown) => Effect.Effect<CancelQueuedResult, unknown, unknown>
}

export class CancelQueuedDispatchService extends Context.Service<CancelQueuedDispatchService, CancelQueuedDispatch>()(
  "CancelQueuedDispatch",
) {}

export const layer = Layer.effect(
  CancelQueuedDispatchService,
  Effect.gen(function* () {
  const { db } = yield* Database.Service
  const sessionSvc = yield* Session.Service
  const cfg = Option.getOrElse(yield* Effect.serviceOption(ConfigConvergence.Service), () => ConfigConvergence.noop)

  const getSessionRevSafe = (sid: SessionID) =>
    SessionRevision.get(db, sid).pipe(
      Effect.catch(() => Effect.succeed(undefined as unknown as number)),
      Effect.catchDefect(() => Effect.succeed(undefined as unknown as number)),
    ) as Effect.Effect<number | undefined>

  const getConfigVerSafe = (dir: string) =>
    cfg.getBootedVersion(dir).pipe(
      Effect.catch(() => Effect.succeed(undefined as unknown as number)),
      Effect.catchDefect(() => Effect.succeed(undefined as unknown as number)),
    ) as Effect.Effect<number | undefined>

  const dispatch = Effect.fn("CancelQueuedDispatch.dispatch")(function* (raw: unknown) {
    let req: CancelQueuedRequest
    try {
      req = validateRequest(raw)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const fallback = raw as Record<string, unknown>
      const requestId = typeof fallback?.requestId === "string" ? fallback.requestId : "unknown"
      const opId = typeof fallback?.opId === "string" ? fallback.opId : "unknown"
      const idempotencyKey = typeof fallback?.idempotencyKey === "string" ? fallback.idempotencyKey : "unknown"
      const time = Date.now()
      const kind = opId.includes("cancelQueued:") ? "cancelQueued" as const : "task" as const
      const opIdSafe = (() => {
        try {
          SessionOperation.parseOpId(opId)
          return opId
        } catch {
          return kind === "cancelQueued" ? `cancelQueued:ses_unknown:msg_unknown` : `task:unknown`
        }
      })()
      const failure = SessionOperation.normalizeRecord({
        opId: opIdSafe,
        opKind: kind,
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
      } satisfies CancelQueuedFailed
    }

    const canonDir = canonicalDirectory(req.context.directory)
    const sessionId = SessionID.make(req.context.sessionId)
    const messageId = MessageID.make(req.payload.messageId)
    const hash = SessionOperation.hashIdempotencyKey(req.idempotencyKey)

    const maybeRef = yield* Effect.serviceOption(InstanceRef)
    let acquiredCtx: InstanceContext | undefined
    let acquiredRelease: Effect.Effect<void> = Effect.void
    if (maybeRef._tag === "None") {
      const acquired = yield* acquireDrainControl(canonDir).pipe(
        Effect.map((v) => ({ tag: "ok" as const, value: v })),
        Effect.catch((err: unknown) =>
          Effect.gen(function* () {
            const fence = isFenceError(err)
            const sessionRev = yield* getSessionRevSafe(sessionId)
            const cfgVer = yield* getConfigVerSafe(canonDir)
            const revision = makeRevision(sessionRev, cfgVer)
            const msg = err instanceof Error ? err.message : typeof (err as { message?: string }).message === "string" ? (err as { message: string }).message : String(err)
            if (fence) return { tag: "fence" as const, result: buildFailed(req, "InstanceUnavailableDuringConfigRebuild", msg, true, false, revision) }
            return { tag: "internal" as const, result: buildFailed(req, "internal", msg, false, false, revision) }
          }),
        ),
        Effect.catchDefect((defect: unknown) =>
          Effect.gen(function* () {
            const fence = isFenceError(defect)
            const sessionRev = yield* getSessionRevSafe(sessionId)
            const cfgVer = yield* getConfigVerSafe(canonDir)
            const revision = makeRevision(sessionRev, cfgVer)
            const msg = defect instanceof Error ? defect.message : String(defect)
            if (fence) return { tag: "fence" as const, result: buildFailed(req, "InstanceUnavailableDuringConfigRebuild", msg, true, false, revision) }
            return { tag: "internal" as const, result: buildFailed(req, "internal", msg, false, false, revision) }
          }),
        ),
      )
      if (acquired.tag !== "ok") return acquired.result
      acquiredCtx = acquired.value.ctx
      acquiredRelease = acquired.value.release
    }

    const inner = Effect.gen(function* () {
      const sessionRow = yield* db
        .select({ directory: SessionTable.directory })
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionId))
        .get()
        .pipe(Effect.orDie)
      if (!sessionRow) {
        const cfgVer = yield* getConfigVerSafe(canonDir)
        const revision = makeRevision(undefined, cfgVer)
        return buildFailed(req, "session.not_found", `session not found ${sessionId}`, false, false, revision)
      }
      const canonicalStored = canonicalDirectory(sessionRow.directory)
      if (canonicalStored !== canonDir) {
        const curRev = yield* getSessionRevSafe(sessionId)
        const cfgVer = yield* getConfigVerSafe(canonDir)
        const revision = makeRevision(curRev, cfgVer)
        return buildFailed(req, "scope_mismatch", `directory mismatch for session ${sessionId}`, false, false, revision)
      }

      // LOCK-301: exact idempotency lookup before freshness guards (outside tx)
      const actualSessionRev = yield* getSessionRevSafe(sessionId)
      const currentConfigVer = yield* getConfigVerSafe(canonDir)
      const existing = yield* SessionOperation.getByIdempotencyHash(db, sessionId, hash).pipe(Effect.orDie)
      if (existing) {
        const conflict = SessionOperation.isCancelQueuedConflict(existing, {
          opId: req.opId,
          directory: canonDir,
          parentSessionId: req.context.parentSessionId ?? null,
          configVersion: req.context.configVersion ?? null,
          sessionRevision: req.context.sessionRevision ?? null,
          messageId: req.payload.messageId,
        })
        if (conflict) {
          const revision = makeRevision(actualSessionRev, currentConfigVer)
          return buildFailed(req, "conflict", "idempotencyKey conflict: different operation facts with same key", false, false, revision)
        }
        if (existing.outcome === "in-flight") {
          const revision = makeRevision(actualSessionRev, currentConfigVer)
          return buildAmbiguous(req, revision)
        }
        if (existing.outcome === "succeeded") {
          const cancelled = existing.meta.cancelled ?? false
          const revision = makeRevision(actualSessionRev, currentConfigVer)
          return buildSucceeded(req, !!cancelled, revision)
        }
        const revision = makeRevision(actualSessionRev, currentConfigVer)
        return buildFailed(req, existing.code, existing.message, false, false, revision)
      }

      // Freshness guards apply only to new reservation (when no existing record)
      if (req.context.sessionRevision !== undefined && actualSessionRev !== undefined && req.context.sessionRevision < actualSessionRev) {
        const revision = makeRevision(actualSessionRev, currentConfigVer)
        return buildFailed(req, "stale", "stale sessionRevision", false, false, revision)
      }
      // LOCK-203: Config version re-read immediately before transaction
      const configBeforeTx = yield* getConfigVerSafe(canonDir)
      const effectiveConfigBeforeTx = configBeforeTx ?? currentConfigVer
      if (req.context.configVersion !== undefined && effectiveConfigBeforeTx !== undefined && req.context.configVersion < effectiveConfigBeforeTx) {
        const revision = makeRevision(actualSessionRev, effectiveConfigBeforeTx)
        return buildFailed(req, "stale", "stale configVersion", false, false, revision)
      }

      const now = Date.now()
      const inFlightRecord: SessionOperation.FailureRecord = {
        opId: req.opId,
        opKind: "cancelQueued",
        outcome: "in-flight",
        code: "cancelQueued.inflight",
        message: "cancelQueued in-flight",
        time: now,
      }
      const meta: SessionOperation.CancelQueuedMeta = {
        idempotencyHash: hash,
        requestId: req.requestId,
        directory: canonDir,
        messageId: req.payload.messageId,
        parentSessionId: req.context.parentSessionId ?? null,
        configVersion: req.context.configVersion ?? null,
        sessionRevision: req.context.sessionRevision ?? null,
        cancelled: null,
      }

      type ReserveResult =
        | { status: "stale"; authRev: number }
        | { status: "conflict"; existing: SessionOperation.CancelQueuedRecord }
        | { status: "ambiguous"; existing: SessionOperation.CancelQueuedRecord }
        | { status: "replay"; existing: SessionOperation.CancelQueuedRecord }
        | { status: "reserved"; record: SessionOperation.CancelQueuedRecord; authRev: number | undefined }

      const reserveResult: ReserveResult = yield* db.transaction(
        (tx) =>
          Effect.gen(function* () {
            // LOCK-301: lookup idempotency before stale guard inside BEGIN IMMEDIATE
            const already = yield* SessionOperation.getByIdempotencyHashTx(tx as unknown as typeof db, sessionId, hash)
            if (already) {
              const c = SessionOperation.isCancelQueuedConflict(already, {
                opId: req.opId,
                directory: canonDir,
                parentSessionId: req.context.parentSessionId ?? null,
                configVersion: req.context.configVersion ?? null,
                sessionRevision: req.context.sessionRevision ?? null,
                messageId: req.payload.messageId,
              })
              if (c) return { status: "conflict" as const, existing: already }
              if (already.outcome === "in-flight") return { status: "ambiguous" as const, existing: already }
              return { status: "replay" as const, existing: already }
            }
            // Only absent record undergoes stale validation
            const authRevEffect = SessionRevision.getTx(tx as unknown as typeof db, sessionId)
            const authRev: number | undefined = yield* authRevEffect.pipe(
              Effect.catch(() => Effect.succeed(actualSessionRev as unknown as number)),
              Effect.catchDefect(() => Effect.succeed(actualSessionRev as unknown as number)),
            )
            // If we cannot read authoritative revision, treat as not stale and proceed to insert; failure will surface later
            if (authRev !== undefined && req.context.sessionRevision !== undefined && req.context.sessionRevision < authRev) {
              return { status: "stale" as const, authRev }
            }
            const inserted = yield* SessionOperation.insertCancelQueuedInFlightTx(
              tx as unknown as typeof db,
              sessionId,
              inFlightRecord,
              meta,
            )
            const finalAuthRev = authRev ?? actualSessionRev
            return { status: "reserved" as const, record: inserted, authRev: finalAuthRev }
          }),
        { behavior: "immediate" },
      )

      if (reserveResult.status === "stale") {
        const latestCfg = yield* getConfigVerSafe(canonDir)
        const revision = makeRevision(reserveResult.authRev, latestCfg ?? effectiveConfigBeforeTx)
        return buildFailed(req, "stale", "stale sessionRevision", false, false, revision)
      }
      if (reserveResult.status === "conflict") {
        const latestRev = yield* getSessionRevSafe(sessionId)
        const latestCfg = yield* getConfigVerSafe(canonDir)
        const revision = makeRevision(latestRev ?? actualSessionRev, latestCfg ?? effectiveConfigBeforeTx)
        return buildFailed(req, "conflict", "idempotencyKey conflict: different operation facts with same key", false, false, revision)
      }
      if (reserveResult.status === "ambiguous") {
        const latestRev = yield* getSessionRevSafe(sessionId)
        const latestCfg = yield* getConfigVerSafe(canonDir)
        const revision = makeRevision(latestRev ?? actualSessionRev, latestCfg ?? effectiveConfigBeforeTx)
        return buildAmbiguous(req, revision)
      }
      if (reserveResult.status === "replay") {
        const latestRev = yield* getSessionRevSafe(sessionId)
        const latestCfg = yield* getConfigVerSafe(canonDir)
        const revision = makeRevision(latestRev ?? actualSessionRev, latestCfg ?? effectiveConfigBeforeTx)
        const existingReplay = reserveResult.existing as SessionOperation.CancelQueuedRecord
        if (existingReplay.outcome === "succeeded") {
          const cancelled = existingReplay.meta.cancelled ?? false
          return buildSucceeded(req, !!cancelled, revision)
        }
        return buildFailed(req, existingReplay.code, existingReplay.message, false, false, revision)
      }

      // Reserved in-flight, now check configVersion again before side effect
      const configAfterReserve = yield* getConfigVerSafe(canonDir)
      const effectiveAfter = configAfterReserve ?? effectiveConfigBeforeTx
      if (req.context.configVersion !== undefined && effectiveAfter !== undefined && req.context.configVersion < effectiveAfter) {
        const latestRev = yield* getSessionRevSafe(sessionId)
        const revision = makeRevision(latestRev ?? reserveResult.authRev, effectiveAfter)
        return buildAmbiguous(req, revision)
      }

      // Reserved in-flight, now perform queue mutation
      const cancelled = yield* KiloSessionPromptQueue.cancelOne(sessionId, messageId)
      if (!cancelled) {
        yield* db.transaction(
          (tx) => SessionOperation.updateCancelQueuedTerminalTx(tx as unknown as typeof db, sessionId, req.opId, false, Date.now()),
          { behavior: "immediate" },
        )
        const newRev = yield* getSessionRevSafe(sessionId)
        const cfgVer = yield* getConfigVerSafe(canonDir)
        if (newRev === undefined || cfgVer === undefined) {
          const fallback = makeRevision(newRev, cfgVer)
          return buildFailed(req, "internal", "revision unavailable after side effect", false, false, fallback)
        }
        return buildSucceeded(req, false, { session: newRev, config: cfgVer })
      }
      yield* sessionSvc.removeMessage({ sessionID: sessionId, messageID: messageId }).pipe(Effect.orDie)
      yield* db.transaction(
        (tx) => SessionOperation.updateCancelQueuedTerminalTx(tx as unknown as typeof db, sessionId, req.opId, true, Date.now()),
        { behavior: "immediate" },
      )
      const newRevAfter = yield* getSessionRevSafe(sessionId)
      const cfgVerAfter = yield* getConfigVerSafe(canonDir)
      if (newRevAfter === undefined || cfgVerAfter === undefined) {
        const fallback = makeRevision(newRevAfter, cfgVerAfter)
        return buildFailed(req, "internal", "revision unavailable after side effect", false, false, fallback)
      }
      return buildSucceeded(req, true, { session: newRevAfter, config: cfgVerAfter })
    }).pipe(
      Effect.catchDefect((defect: unknown) =>
        Effect.gen(function* () {
          const msg = defect instanceof Error ? defect.message : String(defect)
          const latestRev: number | undefined = yield* getSessionRevSafe(sessionId)
          const latestCfg: number | undefined = yield* getConfigVerSafe(canonDir)
          const revision = makeRevision(latestRev, latestCfg)
          return buildFailed(req, "internal", msg, false, false, revision)
        }).pipe(Effect.catchDefect(() => Effect.succeed(buildFailed(req, "internal", String(defect), false, false, undefined))))
      ),
      Effect.catch((cause: unknown) =>
        Effect.gen(function* () {
          const msg = cause instanceof Error ? cause.message : String(cause)
          const latestRev: number | undefined = yield* getSessionRevSafe(sessionId)
          const latestCfg: number | undefined = yield* getConfigVerSafe(canonDir)
          const revision = makeRevision(latestRev, latestCfg)
          return buildFailed(req, "internal", msg, false, false, revision)
        }).pipe(Effect.catchDefect(() => Effect.succeed(buildFailed(req, "internal", String(cause), false, false, undefined))))
      ),
    )
    const withCtx = acquiredCtx ? inner.pipe(Effect.provideService(InstanceRef, acquiredCtx)) : inner
    return yield* withCtx.pipe(Effect.ensuring(acquiredRelease))
  })

  return { dispatch }
   }),
)
