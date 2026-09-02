import { isAbsolute, resolve, normalize as normalizePath, relative as relativePath } from "path"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { Database } from "@opencode-ai/core/database/database"
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
import { carryForkDiff } from "@/kilocode/session-portability/cumulative-diff"
import { InstanceStore } from "@/project/instance-store"
import { InstanceRef } from "@/effect/instance-ref"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { ProjectV2 } from "@opencode-ai/core/project"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"

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
export function canonicalDirectory(dir: string): string {
  if (typeof dir !== "string" || !isAbsolute(dir)) throw new Error("context.directory must be absolute path")
  if (dir.includes("\0")) throw new Error("context.directory must not contain null bytes")
  const normalized = normalizePath(resolve(dir))
  if (!isAbsolute(normalized)) throw new Error("context.directory must be absolute path")
  return normalized
}
function getForkedTitle(title: string): string {
  const match = title.match(/^(.+) \(fork #(\d+)\)$/)
  if (match) {
    const base = match[1]
    const num = parseInt(match[2]!, 10)
    return `${base} (fork #${num + 1})`
  }
  return `${title} (fork #1)`
}
function sessionPath(worktree: string, cwd: string): string {
  return relativePath(resolve(worktree), resolve(cwd)).replaceAll("\\", "/")
}

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
    const parsed = SessionOperation.parseOpId(o.opId as string)
    if (parsed.kind !== "fork") throw new Error(`opId kind must be fork: ${o.opId}`)
    if (parsed.parts[0] !== c.sessionId) throw new Error(`opId session binding mismatch: ${o.opId} vs ${c.sessionId}`)
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
            SessionOperation.parseOpId(opId)
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

          // Transaction with recheck - includes target identity and lifecycle
          type TxOut = { result: SessionForkResult; event?: unknown }
          const txOut: TxOut = yield* db.transaction(
            (tx) =>
              Effect.gen(function* () {
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
                const filteredRows = messageId ? msgRows.filter((r) => (r.id as string) < (messageId as unknown as string)) : msgRows
                let model: unknown = undefined
                if (messageId) {
                  let found: typeof msgRows[0] | undefined
                  for (let i = filteredRows.length - 1; i >= 0; i--) {
                    const row = filteredRows[i]!
                    const data = row.data as Record<string, unknown>
                    if (data.role === "user") {
                      found = row
                      break
                    }
                  }
                  if (found) {
                    const d = found.data as Record<string, unknown>
                    const m = d.model as Record<string, unknown> | undefined
                    if (m && typeof m.modelID === "string" && typeof m.providerID === "string") {
                      model = { id: m.modelID, providerID: m.providerID, variant: (m as { variant?: string }).variant }
                    } else {
                      model = undefined
                    }
                  } else {
                    model = undefined
                  }
                } else {
                  model = (src as unknown as { model: unknown }).model ?? null
                  if (model === null) model = undefined
                }

                const newId = SessionID.descending()
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

                // Copy messages and parts with checkpoint
                const idMap = new Map<string, MessageID>()
                for (const row of filteredRows) {
                  const oldId = row.id as unknown as string
                  const newMsgId = MessageID.ascending()
                  idMap.set(oldId, newMsgId)
                  const oldData = row.data as Record<string, unknown>
                  const parentIdRaw = oldData.parentID as string | undefined
                  const mappedParent = parentIdRaw ? idMap.get(parentIdRaw) : undefined
                  const clonedData: Record<string, unknown> = {
                    ...oldData,
                    parentID: mappedParent ?? oldData.parentID,
                    ...(oldData.role === "assistant" ? { cost: 0 } : {}),
                  }
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
                    const p: Record<string, unknown> = {
                      ...prepared,
                      id: PartID.ascending(),
                      messageID: newMsgId,
                      sessionID: newId,
                      ...(prepared.type === "step-finish" ? { cost: 0 } : {}),
                    }
                    if ((p as { type: string }).type === "compaction" && (p as { tail_start_id?: string }).tail_start_id) {
                      const mapped = idMap.get((p as { tail_start_id: string }).tail_start_id)
                      if (mapped) (p as Record<string, unknown>).tail_start_id = mapped
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

                const inserted = yield* tx.select().from(SessionTable).where(eq(SessionTable.id, newId)).get().pipe(Effect.orDie)
                if (!inserted) yield* Effect.die(new Error("forked session missing after insert"))
                const insertedNonNull = inserted as typeof inserted & { workspace_id: string | null; directory: string }

                // Lifecycle: register, sandbox inherit, cumulative diff - must not be swallowed; failure rolls back
                yield* Effect.sync(() => KiloSession.register({ id: newId, parentID: sessionId }))
                const srcDir = (src as unknown as { directory: string }).directory
                const fallback = yield* SandboxPolicy.peek(srcDir, sessionId).pipe(
                  Effect.catch(() => Effect.succeed(undefined as unknown as SandboxPolicy.Snapshot | undefined)),
                  Effect.catchDefect(() => Effect.succeed(undefined as unknown as SandboxPolicy.Snapshot | undefined)),
                )
                yield* SandboxPolicy.inherit(sessionId as unknown as SessionID, newId as unknown as SessionID, fallback as unknown as Omit<SandboxPolicy.Snapshot, "version"> | undefined, srcDir).pipe(
                  Effect.provideService(InstanceRef, targetCtx),
                )
                yield* carryForkDiff(sessionId as unknown as SessionID, newId as unknown as SessionID)

                // Event and operation in same tx
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
                return { result: buildSucceeded(req, opInfo as unknown as Session.Info, makeRevision((opRec as unknown as { revision: number }).revision, effectiveInside)), event } as unknown as TxOut
              }),
            { behavior: "immediate" },
          )
          // Notify outside transaction
          if ((txOut as unknown as { event?: unknown }).event) {
            const ev = (txOut as unknown as { event: unknown }).event
            yield* (events as unknown as { notifyCommitted: (e: unknown) => Effect.Effect<void> }).notifyCommitted(ev).pipe(
              Effect.catch(() => Effect.void),
              Effect.catchDefect(() => Effect.void),
            )
          }
          return (txOut as unknown as { result: SessionForkResult }).result
        }).pipe(Effect.ensuring(leaseRelease))
        return txResult
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
            SessionOperation.parseOpId(opId)
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
