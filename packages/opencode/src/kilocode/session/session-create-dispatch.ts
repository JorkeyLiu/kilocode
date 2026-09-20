import { isAbsolute } from "path"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { canonicalDirectory } from "@/kilocode/session/canonical-directory"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionOperation } from "@opencode-ai/core/session/operation"
import { ConfigConvergence } from "@/kilocode/server/config-convergence"
import { GenerationGate } from "@/kilocode/server/generation-gate"
import { eq } from "drizzle-orm"
import { KeyedMutex } from "@opencode-ai/core/effect/keyed-mutex"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import * as SandboxInheritance from "@/kilocode/sandbox/inheritance" // kilocode_change - B4 token explicit rejection
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { ProjectV2 } from "@opencode-ai/core/project"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { InstanceStore } from "@/project/instance-store"
import { Slug } from "@opencode-ai/core/util/slug"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Log } from "@opencode-ai/core/util/log"
import { KiloSession } from "@/kilocode/session"
import * as SandboxPolicy from "@/kilocode/sandbox/policy"
import { sessionPath } from "@/kilocode/session/fork"
import * as Changefeed from "@opencode-ai/core/retention/changefeed"
import { DispatchAtomicSeam } from "@/kilocode/session/dispatch-atomic-seam"
import { Service as PrivatePeerService } from "@/kilocode/server/private-peer-registry"
import { OBSERVATION_NOTIFICATION, OBSERVATION_VERSION } from "@/private-worker/observation"

export const VERSION = 1 as const
export const OP = "session/create" as const

export interface SessionCreateRequest {
  v: typeof VERSION
  requestId: string
  opId: string
  op: typeof OP
  idempotencyKey: string
  context: {
    directory: string
    parentSessionId?: string | null
    configVersion?: number
  }
  payload: {
    title?: string | null
    parentID?: string | null
    agent?: string | null
    model?: { id: string; providerID: string; variant?: string } | null
    metadata?: Record<string, unknown> | null
    permission?: unknown | null
    platform?: string | null
    workspaceID?: string | null
    sandboxInheritanceToken?: string | null
  }
}

export type Revision = { session: number; config: number }

export interface SessionCreateSucceeded {
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

export interface SessionCreateFailed {
  v: typeof VERSION
  requestId: string
  opId: string
  op: typeof OP
  idempotencyKey: string
  status: "failed"
  outcome: {
    type: "failed"
    time: number
    failure: { code: string; message: string; retryable: boolean; detail?: string }
  }
  accepted: boolean
  failure: { code: string; message: string; retryable: boolean; detail?: string }
  revision?: Revision
}

export interface SessionCreatePrivateSucceeded {
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

export type SessionCreateResult = SessionCreateSucceeded | SessionCreateFailed
export type SessionCreatePrivateResult = SessionCreatePrivateSucceeded | SessionCreateFailed

const SESSION_TITLE_LIMIT = 200
const unsafeTitle = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u

function isNonEmptyString(v: unknown): boolean {
  return typeof v === "string" && v.length > 0
}
function isSafeInt(v: unknown): boolean {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && Number.isSafeInteger(v)
}
export { canonicalDirectory } from "@/kilocode/session/canonical-directory"
function validateTitle(raw: unknown): string | undefined {
  if (raw === null || raw === undefined) return undefined
  if (typeof raw !== "string") throw new Error("payload.title must be string or null")
  const value = raw.trim()
  if (!value) throw new Error("payload.title must be non-empty string")
  if (value.length > SESSION_TITLE_LIMIT) throw new Error("payload.title too long")
  if (unsafeTitle.test(value)) throw new Error("payload.title contains control characters")
  return value
}

export function validateRequest(raw: unknown): SessionCreateRequest {
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
  if (typeof c.directory !== "string" || !isAbsolute(c.directory))
    throw new Error("context.directory must be absolute path")
  canonicalDirectory(c.directory as string)
  if ("parentSessionId" in c && c.parentSessionId !== null && c.parentSessionId !== undefined) {
    if (typeof c.parentSessionId !== "string" || !Schema.is(SessionID)(c.parentSessionId as string))
      throw new Error("context.parentSessionId must be SessionID or null")
  }
  if ("configVersion" in c && c.configVersion !== undefined) {
    if (!isSafeInt(c.configVersion)) throw new Error("context.configVersion must be integer >=0")
  }
  const payload = o.payload
  if (payload === null || typeof payload !== "object" || Array.isArray(payload))
    throw new Error("payload must be object")
  const p = payload as Record<string, unknown>
  if ("title" in p && p.title !== null && p.title !== undefined) {
    if (typeof p.title !== "string") throw new Error("payload.title must be string")
    validateTitle(p.title)
  }
  if ("parentID" in p && p.parentID !== null && p.parentID !== undefined) {
    if (typeof p.parentID !== "string" || !Schema.is(SessionID)(p.parentID as string))
      throw new Error("payload.parentID must be SessionID or null")
  }
  const allowedRoot = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "context", "payload"])
  for (const k of Object.keys(o)) if (!allowedRoot.has(k)) throw new Error(`unexpected field ${k}`)
  const allowedCtx = new Set(["directory", "parentSessionId", "configVersion"])
  for (const k of Object.keys(c)) if (!allowedCtx.has(k)) throw new Error(`unexpected context field ${k}`)
  const allowedPayload = new Set([
    "title",
    "parentID",
    "agent",
    "model",
    "metadata",
    "permission",
    "platform",
    "workspaceID",
    "sandboxInheritanceToken",
  ])
  for (const k of Object.keys(p)) if (!allowedPayload.has(k)) throw new Error(`unexpected payload field ${k}`)
  if ("agent" in p && p.agent !== null && p.agent !== undefined && typeof p.agent !== "string")
    throw new Error("payload.agent must be string or null")
  if ("platform" in p && p.platform !== null && p.platform !== undefined && typeof p.platform !== "string")
    throw new Error("payload.platform must be string or null")
  if ("workspaceID" in p && p.workspaceID !== null && p.workspaceID !== undefined && typeof p.workspaceID !== "string")
    throw new Error("payload.workspaceID must be string or null")
  if ("sandboxInheritanceToken" in p && p.sandboxInheritanceToken !== null && p.sandboxInheritanceToken !== undefined) {
    if (typeof p.sandboxInheritanceToken !== "string")
      throw new Error("payload.sandboxInheritanceToken must be string or null")
    const tok = p.sandboxInheritanceToken as string
    if (tok.length === 0) throw new Error("payload.sandboxInheritanceToken must be non-empty string")
    if (tok.length > 500) throw new Error("payload.sandboxInheritanceToken too long")
    if (!/^si-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tok))
      throw new Error("payload.sandboxInheritanceToken invalid shape")
  }
  if ("model" in p && p.model !== null && p.model !== undefined) {
    if (typeof p.model !== "object" || Array.isArray(p.model)) throw new Error("payload.model must be object or null")
    const m = p.model as Record<string, unknown>
    if (typeof m.id !== "string" || m.id.length === 0) throw new Error("payload.model.id must be non-empty string")
    if (typeof m.providerID !== "string" || m.providerID.length === 0)
      throw new Error("payload.model.providerID must be non-empty string")
  }
  if ("metadata" in p && p.metadata !== null && p.metadata !== undefined) {
    if (typeof p.metadata !== "object" || Array.isArray(p.metadata))
      throw new Error("payload.metadata must be object or null")
  }
  if ("permission" in p && p.permission !== null && p.permission !== undefined) {
    if (!Array.isArray(p.permission)) throw new Error("payload.permission must be array or null")
  }
  try {
    const parsed = SessionOperation.parseOpId(o.opId as string)
    if (parsed.kind !== "create") throw new Error(`opId kind must be create: ${o.opId}`)
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : String(e))
  }
  // Canonical identity: opId and idempotencyKey must be identical operation tuple; colon in token is rejected by parseOpId
  if (o.idempotencyKey !== o.opId) throw new Error("idempotencyKey must equal opId for create")
  try {
    const parsedKey = SessionOperation.parseOpId(o.idempotencyKey as string)
    if (parsedKey.kind !== "create") throw new Error(`idempotencyKey kind must be create: ${o.idempotencyKey}`)
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : String(e))
  }
  if (c.parentSessionId !== null && c.parentSessionId !== undefined)
    throw new Error("parentSessionId must be null for sessionCreate")
  return o as unknown as SessionCreateRequest
}

function buildFailed(
  req: SessionCreateRequest,
  code: string,
  message: string,
  retryable: boolean,
  accepted: boolean,
  revision: Revision | undefined,
  detail?: string,
): SessionCreateFailed {
  const normalized = SessionOperation.normalizeRecord({
    opId: req.opId,
    opKind: "create",
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
  } as SessionCreateFailed
}

function buildSucceeded(
  req: SessionCreateRequest,
  data: Session.Info,
  revision: Revision | undefined,
): SessionCreateSucceeded {
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
  } as SessionCreateSucceeded
}

function buildPrivateSucceeded(
  req: SessionCreateRequest,
  data: Session.Info,
  revision: Revision | undefined,
): SessionCreatePrivateSucceeded {
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
  } as SessionCreatePrivateSucceeded
}

function makeRevision(session: number | undefined, config: number | undefined): Revision | undefined {
  return session !== undefined && config !== undefined ? { session, config } : undefined
}

function snapshotToInfo(snapshot: unknown): Session.Info | undefined {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return undefined
  try {
    const info = Session.fromRow(
      snapshot as unknown as Parameters<typeof Session.fromRow>[0],
    ) as unknown as Session.Info
    const cleaned = JSON.parse(JSON.stringify(info))
    Schema.decodeUnknownSync(Session.Info)(cleaned)
    return info
  } catch {
    return undefined
  }
}

export interface SessionCreateDispatch {
  readonly dispatch: (request: unknown) => Effect.Effect<SessionCreateResult, unknown, unknown>
  readonly dispatchPrivate: (request: unknown) => Effect.Effect<SessionCreatePrivateResult, unknown, unknown>
}

export class SessionCreateDispatchService extends Context.Service<
  SessionCreateDispatchService,
  SessionCreateDispatch
>()("SessionCreateDispatch") {}

const log = Log.create({ service: "sessionCreate" })

export const layer = Layer.effect(
  SessionCreateDispatchService,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service
    const cfg = Option.getOrElse(yield* Effect.serviceOption(ConfigConvergence.Service), () => ConfigConvergence.noop)
    const gate = Option.getOrElse(yield* Effect.serviceOption(GenerationGate.Service), () => GenerationGate.noop)
    const instanceStore = yield* InstanceStore.Service
    const createMutex = KeyedMutex.makeUnsafe<string>()

    const getConfigVer = (dir: string) => cfg.getBootedVersion(dir) as Effect.Effect<number | undefined>
    const readConfigVer = (dir: string) =>
      getConfigVer(dir).pipe(
        Effect.map((v) => ({ _tag: "Right" as const, right: v as number | undefined })),
        Effect.catch((e: unknown) => Effect.succeed({ _tag: "Left" as const, left: e })),
        Effect.catchDefect((e: unknown) => Effect.succeed({ _tag: "Left" as const, left: e })),
      ) as unknown as Effect.Effect<{ _tag: "Right"; right: number | undefined } | { _tag: "Left"; left: unknown }>
    const isLeft = (e: unknown): boolean => (e as { _tag: string })._tag === "Left"
    const rightValue = (e: unknown): unknown => (e as { right: unknown }).right
    const readCfgOmit = (dir: string) =>
      Effect.gen(function* () {
        const either = yield* readConfigVer(dir)
        return isLeft(either) ? undefined : (rightValue(either) as number | undefined)
      })

    const dispatch = Effect.fn("SessionCreateDispatch.dispatch")(function* (raw: unknown) {
      let req: SessionCreateRequest
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
            return `create:unknown`
          }
        })()
        const failure = SessionOperation.normalizeRecord({
          opId: opIdSafe,
          opKind: "create",
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
          outcome: {
            type: "failed",
            time,
            failure: { code: "validation.failed", message: failure.message, retryable: false },
          },
          accepted: false,
          failure: { code: "validation.failed", message: failure.message, retryable: false },
        } satisfies SessionCreateFailed
      }

      const canonDir = canonicalDirectory(req.context.directory)
      const hash = SessionOperation.hashIdempotencyKey(req.idempotencyKey)
      const title = req.payload.title ? validateTitle(req.payload.title) : undefined
      const parentID = req.payload.parentID ? (req.payload.parentID as string) : undefined
      const tokenPlain = (req.payload.sandboxInheritanceToken as string | null) ?? null
      const tokenHash = tokenPlain ? SandboxInheritance.hashToken(tokenPlain) : null

      const result = yield* createMutex.withLock(req.opId)(
        Effect.gen(function* () {
          const existing = yield* SessionOperation.getSessionCreateByIdempotencyHash(db, hash, canonDir).pipe(Effect.orDie)
          if (existing) {
            const existingHash = existing.meta.sandboxTokenHash ?? null
            if (existingHash !== tokenHash) {
              const curCfg = yield* readCfgOmit(canonDir)
              const revision = makeRevision(undefined, curCfg)
              return buildFailed(req, "conflict", "idempotencyKey conflict: different operation facts with same key", false, false, revision)
            }
            const coreMismatch = existing.opId !== req.opId || existing.meta.directory !== canonDir || (existing.meta.parentSessionId ?? null) !== (req.context.parentSessionId ?? null) || (existing.meta.configVersion ?? null) !== (req.context.configVersion ?? null) || (existing.meta.title ?? null) !== (title ?? null) || (existing.meta.parentID ?? null) !== (parentID ?? null)
            if (coreMismatch) {
              const curCfg = yield* readCfgOmit(canonDir)
              const revision = makeRevision(undefined, curCfg)
              return buildFailed(req, "conflict", "idempotencyKey conflict: different operation facts with same key", false, false, revision)
            }
            if (existing.outcome === "succeeded") {
              const hasSnap = Object.hasOwn(existing as object, "resultSnapshot")
              const persisted = hasSnap ? snapshotToInfo((existing as unknown as { resultSnapshot: unknown }).resultSnapshot) : undefined
              if (hasSnap && !persisted) {
                const curCfg = yield* readCfgOmit(canonDir)
                const revision = makeRevision((existing as unknown as { revision: number }).revision, curCfg)
                return buildFailed(req, "internal", "invalid persisted snapshot", false, false, revision)
              }
              if (persisted) {
                const persistedRev = (existing as unknown as { revision: number }).revision
                const curCfg = yield* readCfgOmit(canonDir)
                const revision = makeRevision(persistedRev, curCfg)
                return buildSucceeded(req, persisted as unknown as Session.Info, revision)
              }
              {
                const curCfg = yield* readCfgOmit(canonDir)
                const revision = makeRevision(undefined, curCfg)
                return buildFailed(req, "internal", "missing persisted snapshot for replay", false, false, revision)
              }
            }
            const curCfg = yield* readCfgOmit(canonDir)
            const revision = makeRevision(undefined, curCfg)
            return buildFailed(req, existing.code, existing.message, false, false, revision)
          }
          const existingOpId = yield* SessionOperation.get(db, req.opId).pipe(Effect.orDie)
          if (existingOpId) {
            const curCfg = yield* readCfgOmit(canonDir)
            const revision = makeRevision(undefined, curCfg)
            return buildFailed(req, "conflict", "opId already exists with different idempotencyKey", false, false, revision)
          }
          let tokenSourceID: string | null = null
          let tokenSourceDir: string | null = null
          let hasReservation = false
          const ensureRelease = () => { if (hasReservation) { try { SandboxInheritance.release(req.opId) } catch {} hasReservation = false } }
          const doCommit = () => { if (hasReservation) { try { SandboxInheritance.commit(req.opId) } catch {} hasReservation = false } }
          if (tokenPlain !== null) {
            const peek = SandboxInheritance.peekGrant(tokenPlain)
            if (!peek) {
              const curCfg = yield* readCfgOmit(canonDir)
              const revision = makeRevision(undefined, curCfg)
              return buildFailed(req, "validation.failed", "Invalid sandbox inheritance token", false, false, revision)
            }
            tokenSourceID = peek.sessionID as string
            tokenSourceDir = peek.directory
            try {
              SandboxInheritance.reserve(req.opId, tokenPlain)
              hasReservation = true
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e)
              if (msg.includes("conflict")) {
                const curCfg = yield* readCfgOmit(canonDir)
                const revision = makeRevision(undefined, curCfg)
                return buildFailed(req, "conflict", "idempotencyKey conflict: different sandbox token with same opId", false, false, revision)
              }
              const curCfg = yield* readCfgOmit(canonDir)
              const revision = makeRevision(undefined, curCfg)
              return buildFailed(req, "validation.failed", "Invalid sandbox inheritance token", false, false, revision)
            }
          }
          const needsConfigLease = req.context.configVersion !== undefined
          if (needsConfigLease && gate.isBarrierActive(canonDir)) {
            ensureRelease()
            const curCfg = yield* readCfgOmit(canonDir)
            const revision = makeRevision(undefined, curCfg)
            return buildFailed(req, "InstanceUnavailableDuringConfigRebuild", "instance unavailable during config rebuild", true, false, revision)
          }
          const leaseRelease: Effect.Effect<void> = needsConfigLease ? yield* gate.acquire(canonDir) : Effect.void
          const txResult: SessionCreateResult = yield* Effect.gen(function* () {
            const cfgEither = yield* readConfigVer(canonDir)
            if (isLeft(cfgEither)) {
              ensureRelease()
              return buildFailed(req, "internal", "config version read failed", false, false, makeRevision(undefined, undefined)) as unknown as SessionCreateResult
            }
            const currentConfigVer = rightValue(cfgEither) as number | undefined
            const cfgBeforeEither = yield* readConfigVer(canonDir)
            if (isLeft(cfgBeforeEither)) {
              ensureRelease()
              return buildFailed(req, "internal", "config version read failed", false, false, makeRevision(undefined, currentConfigVer)) as unknown as SessionCreateResult
            }
            const configBeforeTx = rightValue(cfgBeforeEither) as number | undefined
            const effectiveConfigBeforeTx = configBeforeTx ?? currentConfigVer
            if (req.context.configVersion !== undefined && effectiveConfigBeforeTx === undefined) {
              ensureRelease()
              return buildFailed(req, "internal", "config version unavailable", false, false, makeRevision(undefined, currentConfigVer)) as unknown as SessionCreateResult
            }
            if (req.context.configVersion !== undefined && effectiveConfigBeforeTx !== undefined && req.context.configVersion < effectiveConfigBeforeTx) {
              ensureRelease()
              const revision = makeRevision(undefined, effectiveConfigBeforeTx)
              return buildFailed(req, "stale", "stale configVersion", false, false, revision) as unknown as SessionCreateResult
            }
            const targetCtx = yield* instanceStore.load({ directory: canonDir })
            type TxOut = {
              result: SessionCreateResult
              event?: unknown
              sideEffect?: { newId: string; parentID?: string; parentDir?: string; platform?: string | null; targetCtx: unknown; sandboxSourceID?: string | null; sandboxSourceDir?: string | null }
              changefeedEntry?: { seq: number; session_id: string; revision: number; kind: "changed" | "deleted"; time: number }
            }
            const txOut: TxOut = yield* db.transaction(
              (tx) =>
                Effect.gen(function* () {
                  const already = yield* SessionOperation.getSessionCreateByIdempotencyHashTx(tx as unknown as typeof db, hash, canonDir)
                  if (already) {
                    const alreadyHash = already.meta.sandboxTokenHash ?? null
                    if (alreadyHash !== tokenHash) {
                      const curCfg = yield* readCfgOmit(canonDir)
                      return { result: buildFailed(req, "conflict", "idempotencyKey conflict: different operation facts with same key", false, false, makeRevision(undefined, curCfg)) } as unknown as TxOut
                    }
                    const coreMismatch = already.opId !== req.opId || already.meta.directory !== canonDir || (already.meta.parentSessionId ?? null) !== (req.context.parentSessionId ?? null) || (already.meta.configVersion ?? null) !== (req.context.configVersion ?? null) || (already.meta.title ?? null) !== (title ?? null) || (already.meta.parentID ?? null) !== (parentID ?? null)
                    if (coreMismatch) {
                      const curCfg = yield* readCfgOmit(canonDir)
                      return { result: buildFailed(req, "conflict", "idempotencyKey conflict: different operation facts with same key", false, false, makeRevision(undefined, curCfg)) } as unknown as TxOut
                    }
                    if (already.outcome === "succeeded") {
                      const hasSnap = Object.hasOwn(already as object, "resultSnapshot")
                      const persisted = hasSnap ? snapshotToInfo((already as unknown as { resultSnapshot: unknown }).resultSnapshot) : undefined
                      if (hasSnap && !persisted) {
                        const curCfg = yield* readCfgOmit(canonDir)
                        return { result: buildFailed(req, "internal", "invalid persisted snapshot", false, false, makeRevision((already as unknown as { revision: number }).revision, curCfg)) } as unknown as TxOut
                      }
                      if (persisted) {
                        const persistedRev = (already as unknown as { revision: number }).revision
                        const curCfg = yield* readCfgOmit(canonDir)
                        return { result: buildSucceeded(req, persisted as unknown as Session.Info, makeRevision(persistedRev, curCfg)) } as unknown as TxOut
                      }
                      {
                        const curCfg = yield* readCfgOmit(canonDir)
                        return { result: buildFailed(req, "internal", "missing persisted snapshot for replay", false, false, makeRevision(undefined, curCfg)) } as unknown as TxOut
                      }
                    }
                    {
                      const curCfg = yield* readCfgOmit(canonDir)
                      return { result: buildFailed(req, already.code, already.message, false, false, makeRevision(undefined, curCfg)) } as unknown as TxOut
                    }
                  }
                  const opExists = yield* SessionOperation.getTx(tx as unknown as typeof db, req.opId)
                  if (opExists) {
                    const curCfg = yield* readCfgOmit(canonDir)
                    return { result: buildFailed(req, "conflict", "opId already exists with different idempotencyKey", false, false, makeRevision(undefined, curCfg)) } as unknown as TxOut
                  }
                  const cfgInsideEither = yield* (getConfigVer(canonDir) as unknown as Effect.Effect<unknown, unknown, unknown>).pipe(
                    Effect.map((v) => ({ _tag: "Right" as const, right: v as number | undefined })),
                    Effect.catch((e: unknown) => Effect.succeed({ _tag: "Left" as const, left: e })),
                    Effect.catchDefect((e: unknown) => Effect.succeed({ _tag: "Left" as const, left: e })),
                  ) as unknown as Effect.Effect<{ _tag: "Right"; right: number | undefined } | { _tag: "Left"; left: unknown }>
                  if ((cfgInsideEither as unknown as { _tag: string })._tag === "Left") {
                    return { result: buildFailed(req, "internal", "config version read failed inside tx", false, false, makeRevision(undefined, undefined)) } as unknown as TxOut
                  }
                  const cfgInside: number | undefined = (cfgInsideEither as unknown as { right: number | undefined }).right
                  const effectiveInside = cfgInside ?? effectiveConfigBeforeTx
                  if (req.context.configVersion !== undefined && effectiveInside === undefined) {
                    return { result: buildFailed(req, "internal", "config version unavailable inside tx", false, false, makeRevision(undefined, undefined)) } as unknown as TxOut
                  }
                  if (req.context.configVersion !== undefined && effectiveInside !== undefined && req.context.configVersion < effectiveInside) {
                    return { result: buildFailed(req, "stale", "stale configVersion", false, false, makeRevision(undefined, effectiveInside)) } as unknown as TxOut
                  }
                  const newId = SessionID.descending()
                  const now = Date.now()
                  const slug = Slug.create()
                  const targetPath = sessionPath(targetCtx.worktree, canonDir)
                  let parentRow: unknown = null
                  if (parentID) {
                    const prow = yield* tx.select().from(SessionTable).where(eq(SessionTable.id, parentID as unknown as SessionID)).get().pipe(Effect.orDie)
                    if (!prow) return { result: buildFailed(req, "validation.failed", `parent session not found ${parentID}`, false, false, makeRevision(undefined, effectiveInside)) } as unknown as TxOut
                    parentRow = prow
                  }
                  const agent = (req.payload.agent as string | null) ?? null
                  const model = (req.payload.model as { id: string; providerID: string; variant?: string } | null) ?? null
                  const metadataRaw = (req.payload.metadata as Record<string, unknown> | null) ?? null
                  const permissionRaw = (req.payload.permission as unknown | null) ?? null
                  const platform = (req.payload.platform as string | null) ?? null
                  const workspaceID = (req.payload.workspaceID as string | null) ?? null
                  const newRow: Record<string, unknown> = {
                    id: newId,
                    project_id: targetCtx.project.id,
                    workspace_id: workspaceID ?? (parentRow as unknown as { workspace_id: string | null })?.workspace_id ?? null,
                    parent_id: parentID ?? null,
                    slug,
                    directory: canonDir,
                    path: targetPath,
                    title: title ?? `New session - ${new Date().toISOString()}`,
                    version: InstallationVersion,
                    share_url: null,
                    summary_additions: null,
                    summary_deletions: null,
                    summary_files: null,
                    summary_diffs: null,
                    metadata: metadataRaw,
                    cost: 0,
                    tokens_input: 0,
                    tokens_output: 0,
                    tokens_reasoning: 0,
                    tokens_cache_read: 0,
                    tokens_cache_write: 0,
                    revert: null,
                    permission: permissionRaw,
                    agent: agent,
                    model: model,
                    revision: 0,
                    time_created: now,
                    time_updated: now,
                    time_compacting: null,
                    time_archived: null,
                  }
                  yield* tx.insert(ProjectTable).values({ id: targetCtx.project.id as unknown as string, worktree: AbsolutePath.make(targetCtx.worktree), vcs: (targetCtx.project.vcs as string | undefined) ?? null, time_created: targetCtx.project.time.created, time_updated: targetCtx.project.time.updated, sandboxes: targetCtx.project.sandboxes.map((s) => AbsolutePath.make(s)) } as unknown as typeof ProjectTable.$inferInsert).onConflictDoNothing().run().pipe(Effect.orDie)
                  yield* tx.insert(SessionTable).values(newRow as unknown as typeof SessionTable.$inferInsert).run().pipe(Effect.orDie)
                  const changefeedEntry = yield* Changefeed.appendTx(tx as unknown as typeof db, { session_id: newId, revision: 0, kind: "changed", time: now })
                  const inserted = yield* tx.select().from(SessionTable).where(eq(SessionTable.id, newId)).get().pipe(Effect.orDie)
                  if (!inserted) yield* Effect.die(new Error("created session missing after insert"))
                  const insertedNonNull = inserted as typeof inserted & { workspace_id: string | null; directory: string }
                  const info = Session.fromRow(insertedNonNull as unknown as Parameters<typeof Session.fromRow>[0]) as unknown as Session.Info
                  const loc = new Location.Info({ directory: AbsolutePath.make(canonDir), ...(insertedNonNull.workspace_id ? { workspaceID: insertedNonNull.workspace_id as unknown as WorkspaceV2.ID } : {}), project: { id: ProjectV2.ID.make(targetCtx.project.id), directory: AbsolutePath.make(targetCtx.worktree) } })
                  const event = yield* (events as unknown as { recordProjectedTx: (tx: unknown, type: unknown, data: unknown, opts: unknown) => Effect.Effect<unknown> }).recordProjectedTx(tx as unknown as never, SessionV1.Event.Created, { sessionID: newId, info }, { location: loc as unknown as Location.Info })
                  const snapshotJson = JSON.stringify(insertedNonNull)
                  const record: SessionOperation.FailureRecord = { opId: req.opId, opKind: "create", outcome: "succeeded", code: "create.succeeded", message: "create succeeded", time: now }
                  const meta: SessionOperation.SessionCreateMeta = { idempotencyHash: hash, requestId: req.requestId, directory: canonDir, parentSessionId: req.context.parentSessionId ?? null, configVersion: req.context.configVersion ?? null, title: title ?? null, parentID: parentID ?? null, createdSessionId: newId, sandboxTokenHash: tokenHash, sandboxSourceSessionId: tokenSourceID, sandboxSourceDirectory: tokenSourceDir }
                  const opRec = yield* SessionOperation.insertSessionCreateSucceededTx(tx as unknown as typeof db, newId as unknown as SessionID, record, meta, snapshotJson)
                  const opInfo = snapshotToInfo((opRec as unknown as { resultSnapshot: unknown }).resultSnapshot)
                  if (!opInfo) yield* Effect.die(new Error("invalid snapshot after create insert"))
                  if (DispatchAtomicSeam.failCreateInsideTx) yield* Effect.die(new Error("injected create tx failure"))
                  return { result: buildSucceeded(req, opInfo as unknown as Session.Info, makeRevision((opRec as unknown as { revision: number }).revision, effectiveInside)), event, sideEffect: { newId, parentID, parentDir: parentRow ? (parentRow as unknown as { directory: string }).directory : undefined, platform, targetCtx, sandboxSourceID: tokenSourceID, sandboxSourceDir: tokenSourceDir }, changefeedEntry: { seq: changefeedEntry.seq, session_id: changefeedEntry.session_id, revision: changefeedEntry.revision, kind: changefeedEntry.kind, time: changefeedEntry.time } } as unknown as TxOut
                }),
              { behavior: "immediate" },
            )
            const isFresh = !!(txOut as unknown as { changefeedEntry?: unknown }).changefeedEntry
            const side = (txOut as unknown as { sideEffect?: { newId: string; parentID?: string; parentDir?: string; platform?: string | null; targetCtx: unknown; sandboxSourceID?: string | null; sandboxSourceDir?: string | null } }).sideEffect
            if (isFresh && (txOut as unknown as { result: SessionCreateResult }).result?.status === "succeeded") {
              doCommit()
            } else {
              ensureRelease()
            }
            if (side && isFresh) {
              yield* Effect.sync(() => {
                try { KiloSession.register({ id: side.newId as unknown as SessionID, parentID: side.parentID as unknown as SessionID | undefined, platform: side.platform ?? undefined }) } catch (e) { log.warn("sessionCreate post-commit register failed", { error: e instanceof Error ? e.message : String(e), newId: side.newId }) }
              })
              const inheritSources: Array<{ id: string; dir: string }> = []
              if (side.parentID && side.parentDir) inheritSources.push({ id: side.parentID, dir: side.parentDir })
              if (side.sandboxSourceID && side.sandboxSourceDir) {
                const dup = inheritSources.some((s) => s.id === side.sandboxSourceID && (() => { try { return canonicalDirectory(s.dir) === canonicalDirectory(side.sandboxSourceDir!) } catch { return s.dir === side.sandboxSourceDir } })())
                if (!dup) inheritSources.push({ id: side.sandboxSourceID, dir: side.sandboxSourceDir })
              }
              for (const src of inheritSources) {
                const fallback = yield* SandboxPolicy.peek(src.dir, src.id as unknown as SessionID).pipe(Effect.catch(() => Effect.succeed(undefined as unknown as SandboxPolicy.Snapshot | undefined)), Effect.catchDefect(() => Effect.succeed(undefined as unknown as SandboxPolicy.Snapshot | undefined)))
                const inheritResult = yield* instanceStore.provide({ directory: canonDir }, SandboxPolicy.inherit(src.id as unknown as SessionID, side.newId as unknown as SessionID, fallback as unknown as Omit<SandboxPolicy.Snapshot, "version"> | undefined, src.dir)).pipe(Effect.exit)
                if (inheritResult._tag === "Failure") { const cause = inheritResult.cause; log.warn("sessionCreate post-commit inherit failed (best-effort, session retained)", { cause: String(cause), newId: side.newId }) }
              }
            }
            if ((txOut as unknown as { event?: unknown }).event) {
              const ev = (txOut as unknown as { event: unknown }).event
              yield* (events as unknown as { notifyCommitted: (e: unknown) => Effect.Effect<void> }).notifyCommitted(ev).pipe(Effect.catch(() => Effect.void), Effect.catchDefect(() => Effect.void))
            }
            const entry = (txOut as unknown as { changefeedEntry?: { seq: number; session_id: string; revision: number; kind: string; time: number } }).changefeedEntry
            const resultForNotify = (txOut as unknown as { result: SessionCreateResult }).result
            if (entry && resultForNotify.status === "succeeded" && isFresh) {
              yield* Effect.gen(function* () {
                const opt = yield* Effect.serviceOption(PrivatePeerService)
                if (opt._tag === "None") return
                const peer = opt.value
                const payload = { v: OBSERVATION_VERSION, cursor: entry.seq, entries: [{ seq: entry.seq, session_id: entry.session_id, revision: entry.revision, kind: entry.kind, time: entry.time }] }
                yield* peer.notify(OBSERVATION_NOTIFICATION, payload).pipe(Effect.catch(() => Effect.void), Effect.catchDefect(() => Effect.void))
              }).pipe(Effect.catch(() => Effect.void), Effect.catchDefect(() => Effect.void))
            }
            return (txOut as unknown as { result: SessionCreateResult }).result
          }).pipe(Effect.ensuring(leaseRelease), Effect.catchDefect((defect: unknown) => Effect.gen(function* () { ensureRelease(); const msg = defect instanceof Error ? defect.message : String(defect); const curCfg = yield* readCfgOmit(canonDir); const revision = makeRevision(undefined, curCfg); return buildFailed(req, "internal", msg, false, false, revision) }).pipe(Effect.catchDefect(() => Effect.succeed(buildFailed(req, "internal", String(defect), false, false, undefined))))), Effect.catch((cause: unknown) => Effect.gen(function* () { ensureRelease(); const msg = cause instanceof Error ? cause.message : String(cause); const curCfg = yield* readCfgOmit(canonDir); const revision = makeRevision(undefined, curCfg); return buildFailed(req, "internal", msg, false, false, revision) }).pipe(Effect.catchDefect(() => Effect.succeed(buildFailed(req, "internal", String(cause), false, false, undefined))))))
            return txResult
        }),
      )
      return result
    })
    const dispatchPrivate = Effect.fn("SessionCreateDispatch.dispatchPrivate")(function* (raw: unknown) {
      let req: SessionCreateRequest
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
            return `create:unknown`
          }
        })()
        const failure = SessionOperation.normalizeRecord({
          opId: opIdSafe,
          opKind: "create",
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
          outcome: {
            type: "failed",
            time,
            failure: { code: "validation.failed", message: failure.message, retryable: false },
          },
          accepted: false,
          failure: { code: "validation.failed", message: failure.message, retryable: false },
        } satisfies SessionCreateFailed
      }

      const canonDir = canonicalDirectory(req.context.directory)
      const hash = SessionOperation.hashIdempotencyKey(req.idempotencyKey)
      const title = req.payload.title ? validateTitle(req.payload.title) : undefined
      const parentID = req.payload.parentID ? (req.payload.parentID as string) : undefined
      const tokenPlainPriv = (req.payload.sandboxInheritanceToken as string | null) ?? null
      const tokenHashPriv = tokenPlainPriv ? SandboxInheritance.hashToken(tokenPlainPriv) : null
      const inner = Effect.gen(function* () {
        return yield* createMutex.withLock(req.opId)(
          Effect.gen(function* () {
            const existing = yield* SessionOperation.getSessionCreateByIdempotencyHash(db, hash, canonDir).pipe(Effect.orDie)
            const existingOpId = yield* SessionOperation.get(db, req.opId).pipe(Effect.orDie)
            if (existing) {
              const existingHash = existing.meta.sandboxTokenHash ?? null
              if (existingHash !== tokenHashPriv) {
                const curCfg = yield* readCfgOmit(canonDir)
                const revision = makeRevision(undefined, curCfg)
                return buildFailed(req, "conflict", "idempotencyKey conflict: different operation facts with same key", false, false, revision)
              }
              const coreMismatch = existing.opId !== req.opId || existing.meta.directory !== canonDir || (existing.meta.parentSessionId ?? null) !== (req.context.parentSessionId ?? null) || (existing.meta.configVersion ?? null) !== (req.context.configVersion ?? null) || (existing.meta.title ?? null) !== (title ?? null) || (existing.meta.parentID ?? null) !== (parentID ?? null)
              if (coreMismatch) {
                const curCfg = yield* readCfgOmit(canonDir)
                const revision = makeRevision(undefined, curCfg)
                return buildFailed(req, "conflict", "idempotencyKey conflict: different operation facts with same key", false, false, revision)
              }
              if (existing.outcome === "succeeded") {
                const hasSnap = Object.hasOwn(existing as object, "resultSnapshot")
                const persisted = hasSnap ? snapshotToInfo((existing as unknown as { resultSnapshot: unknown }).resultSnapshot) : undefined
                if (hasSnap && !persisted) {
                  const curCfg = yield* readCfgOmit(canonDir)
                  const persistedRev = (existing as unknown as { revision: number }).revision
                  const revision = makeRevision(persistedRev ?? undefined, curCfg)
                  return buildFailed(req, "internal", "invalid persisted snapshot", false, false, revision)
                }
                if (persisted) {
                  const persistedRev = (existing as unknown as { revision: number }).revision
                  const curCfg = yield* readCfgOmit(canonDir)
                  const revision = makeRevision(persistedRev, curCfg)
                  return buildPrivateSucceeded(req, persisted as unknown as Session.Info, revision)
                }
                const curCfg = yield* readCfgOmit(canonDir)
                const persistedRev = (existing as unknown as { revision: number }).revision
                const revision = makeRevision(persistedRev, curCfg)
                return buildFailed(req, "internal", "missing persisted snapshot for replay", false, false, revision)
              }
              const curCfg = yield* readCfgOmit(canonDir)
              const revision = makeRevision(undefined, curCfg)
              return buildFailed(req, existing.code, existing.message, false, false, revision)
            }
            if (existingOpId) {
              const curCfg = yield* readCfgOmit(canonDir)
              const revision = makeRevision(undefined, curCfg)
              return buildFailed(req, "conflict", "opId already exists with different idempotencyKey", false, false, revision)
            }
            const curCfg = yield* readCfgOmit(canonDir)
            const revision = makeRevision(undefined, curCfg)
            return buildFailed(req, "internal", "no committed create record", false, false, revision)
          }),
        )
      }).pipe(
        Effect.catchDefect((defect: unknown) =>
          Effect.gen(function* () {
            const msg = defect instanceof Error ? defect.message : String(defect)
            const curCfg = yield* readCfgOmit(canonDir)
            const revision = makeRevision(undefined, curCfg)
            return buildFailed(req, "internal", msg, false, false, revision)
          }).pipe(
            Effect.catchDefect(() =>
              Effect.succeed(buildFailed(req, "internal", String(defect), false, false, undefined)),
            ),
          ),
        ),
        Effect.catch((cause: unknown) =>
          Effect.gen(function* () {
            const msg = cause instanceof Error ? cause.message : String(cause)
            const curCfg = yield* readCfgOmit(canonDir)
            const revision = makeRevision(undefined, curCfg)
            return buildFailed(req, "internal", msg, false, false, revision)
          }).pipe(
            Effect.catchDefect(() =>
              Effect.succeed(buildFailed(req, "internal", String(cause), false, false, undefined)),
            ),
          ),
        ),
      )
      const out = yield* inner
      return out
    })

    return { dispatch, dispatchPrivate } as unknown as SessionCreateDispatch
  }),
)
