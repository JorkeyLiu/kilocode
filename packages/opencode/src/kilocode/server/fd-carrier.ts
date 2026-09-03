import * as fs from "node:fs"
import { Effect, Schema } from "effect"
import { ErrorCode } from "@/private-worker/json-rpc"
import { AppRuntime } from "@/effect/app-runtime"
import { CancelQueuedDispatchService } from "@/kilocode/session/cancel-queued-dispatch"
import { SessionUpdateDispatchService } from "@/kilocode/session/session-update-dispatch"
import { SessionForkDispatchService } from "@/kilocode/session/session-fork-dispatch"
import { SessionCreateDispatchService } from "@/kilocode/session/session-create-dispatch"
import { SessionStatus } from "@/session/status"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { NotFoundError } from "@/storage/storage"
import { canonicalDirectory } from "@/kilocode/session/canonical-directory"
import { acquireDrainControl, InstanceUnavailableDuringConfigRebuildError } from "@/kilocode/server/drain-control-acquire"
import { InstanceRef } from "@/effect/instance-ref"
import { buildInitializeResult, validateProtocolVersion } from "./fd-carrier-protocol"
import { JsonRpcPeer as Peer } from "@/private-worker/peer"

export interface FdCarrierHandle {
  peer: Peer
  reader: NodeJS.ReadableStream
  writer: NodeJS.WritableStream
  dispose: () => void
}

function hasFd(fd: number): boolean {
  try {
    fs.fstatSync(fd)
    return true
  } catch (err) {
    console.warn("[kilo fd-carrier] hasFd check failed for", fd, String(err))
    return false
  }
}

export function canUseFdCarrier(): boolean {
  const envOk = !!process.env.KILO_PARENT_PID || process.env.KILO_CLIENT === "vscode"
  if (!envOk) return false
  // Bun keeps fd 3 open as FIFO even without extra pipes — guard by requiring both 3 and 4
  // and that they are not the internal Bun FIFO without peer fd4.
  // Detection: require fstat 3 and 4 both succeed.
  try {
    fs.fstatSync(3)
    fs.fstatSync(4)
    return true
  } catch (err) {
    console.warn("[kilo fd-carrier] canUse check failed:", String(err))
    return false
  }
}

function bestEffortClose(stream: unknown, label: string): void {
  try {
    const c = stream as { destroy?: () => void; close?: () => void; end?: () => void; destroyed?: boolean }
    if (c.destroyed) return
    if (typeof c.destroy === "function") c.destroy()
    else if (typeof c.close === "function") c.close()
    else if (typeof c.end === "function") (c as { end: () => void }).end()
  } catch (err) {
    console.warn(`[kilo fd-carrier] best-effort ${label} cleanup failed:`, String(err))
  }
}

export const FD_STATUS_VERSION = 1 as const
export const FD_STATUS_OP = "session/status" as const
export const FD_GET_VERSION = 1 as const
export const FD_GET_OP = "session/get" as const

export interface FdGetRequest {
  v: typeof FD_GET_VERSION
  requestId: string
  opId: string
  op: typeof FD_GET_OP
  idempotencyKey: string
  context: {
    directory: string
    sessionId: string
  }
  payload: Record<string, never>
}

export interface FdStatusRequest {
  v: typeof FD_STATUS_VERSION
  requestId: string
  opId: string
  op: typeof FD_STATUS_OP
  idempotencyKey: string
  context: {
    directory: string
  }
  payload: Record<string, never>
}

function isNonEmpty(v: unknown): v is string {
  return typeof v === "string" && v.length > 0
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

function statusFailed(
  req: { requestId: string; opId: string; idempotencyKey: string },
  code: string,
  message: string,
  retryable: boolean,
): Record<string, unknown> {
  const time = Date.now()
  const failure = { code, message, retryable }
  return {
    v: FD_STATUS_VERSION,
    requestId: req.requestId,
    opId: req.opId,
    op: FD_STATUS_OP,
    idempotencyKey: req.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time, failure },
    accepted: false,
    failure,
  }
}

function getFailed(
  req: { requestId: string; opId: string; idempotencyKey: string },
  code: string,
  message: string,
  retryable: boolean,
): Record<string, unknown> {
  const time = Date.now()
  const failure = { code, message, retryable }
  return {
    v: FD_GET_VERSION,
    requestId: req.requestId,
    opId: req.opId,
    op: FD_GET_OP,
    idempotencyKey: req.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time, failure },
    accepted: false,
    failure,
  }
}

const GET_MESSAGE_LIMIT = 200

function boundGetMessage(msg: string): string {
  if (msg.length > GET_MESSAGE_LIMIT) return msg.slice(0, GET_MESSAGE_LIMIT)
  return msg
}

function validateGetRequest(raw: unknown): FdGetRequest {
  if (!isRecord(raw)) throw new Error("params must be object")
  if (raw.v !== FD_GET_VERSION) throw new Error("v must be 1")
  if (!isNonEmpty(raw.requestId)) throw new Error("requestId must be non-empty string")
  if (!isNonEmpty(raw.opId)) throw new Error("opId must be non-empty string")
  if (raw.op !== FD_GET_OP) throw new Error("op must be session/get")
  if (!isNonEmpty(raw.idempotencyKey)) throw new Error("idempotencyKey must be non-empty string")
  if (raw.idempotencyKey !== raw.opId) throw new Error("idempotencyKey must equal opId for get")
  const ctx = raw.context
  if (!isRecord(ctx)) throw new Error("context must be object")
  const allowedCtx = new Set(["directory", "sessionId"])
  for (const k of Object.keys(ctx)) if (!allowedCtx.has(k)) throw new Error(`unexpected context field ${k}`)
  if (typeof ctx.directory !== "string" || ctx.directory.length === 0)
    throw new Error("context.directory must be non-empty string")
  canonicalDirectory(ctx.directory)
  if (typeof ctx.sessionId !== "string" || !Schema.is(SessionID)(ctx.sessionId))
    throw new Error("context.sessionId must be SessionID")
  const payload = raw.payload
  if (!isRecord(payload)) throw new Error("payload must be object")
  if (Object.keys(payload).length !== 0) throw new Error("payload must be empty object for get")
  const allowedRoot = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "context", "payload"])
  for (const k of Object.keys(raw)) if (!allowedRoot.has(k)) throw new Error(`unexpected field ${k}`)
  const opId = raw.opId as string
  const sid = ctx.sessionId as string
  const prefix = `get:${sid}:`
  if (!opId.startsWith(prefix))
    throw new Error("opId must be get:<sessionId>:<token> with nonempty colon-free token")
  const token = opId.slice(prefix.length)
  if (token.length === 0 || token.includes(":"))
    throw new Error("opId must be get:<sessionId>:<token> with nonempty colon-free token")
  return raw as unknown as FdGetRequest
}

function validateStatusRequest(raw: unknown): FdStatusRequest {
  if (!isRecord(raw)) throw new Error("params must be object")
  if (raw.v !== FD_STATUS_VERSION) throw new Error("v must be 1")
  if (!isNonEmpty(raw.requestId)) throw new Error("requestId must be non-empty string")
  if (!isNonEmpty(raw.opId)) throw new Error("opId must be non-empty string")
  if (raw.op !== FD_STATUS_OP) throw new Error("op must be session/status")
  if (!isNonEmpty(raw.idempotencyKey)) throw new Error("idempotencyKey must be non-empty string")
  if (raw.idempotencyKey !== raw.opId) throw new Error("idempotencyKey must equal opId for status")
  const ctx = raw.context
  if (!isRecord(ctx)) throw new Error("context must be object")
  const allowedCtx = new Set(["directory"])
  for (const k of Object.keys(ctx)) if (!allowedCtx.has(k)) throw new Error(`unexpected context field ${k}`)
  if (typeof ctx.directory !== "string" || ctx.directory.length === 0)
    throw new Error("context.directory must be non-empty string")
  canonicalDirectory(ctx.directory)
  const payload = raw.payload
  if (!isRecord(payload)) throw new Error("payload must be object")
  if (Object.keys(payload).length !== 0) throw new Error("payload must be empty object for status")
  const allowedRoot = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "context", "payload"])
  for (const k of Object.keys(raw)) if (!allowedRoot.has(k)) throw new Error(`unexpected field ${k}`)
  return raw as unknown as FdStatusRequest
}

function fallbackIds(raw: unknown): { requestId: string; opId: string; idempotencyKey: string } {
  const o = (isRecord(raw) ? raw : {}) as Record<string, unknown>
  const requestId = isNonEmpty(o.requestId) ? (o.requestId as string) : "unknown"
  const opId = isNonEmpty(o.opId) ? (o.opId as string) : "unknown"
  const idempotencyKey = isNonEmpty(o.idempotencyKey) ? (o.idempotencyKey as string) : "unknown"
  return { requestId, opId, idempotencyKey }
}

export function createFdCarrier(reader: NodeJS.ReadableStream, writer: NodeJS.WritableStream): FdCarrierHandle {
  // Ensure streams are flowing
  try {
    ;(reader as unknown as { resume?: () => void }).resume?.()
  } catch (err) {
    console.warn("[kilo fd-carrier] reader resume failed:", String(err))
  }
  let peer: Peer | null = null
  const dispose = () => {
    try {
      peer?.dispose()
    } catch (err) {
      console.warn("[kilo fd-carrier] peer dispose failed:", String(err))
    }
    bestEffortClose(reader, "reader")
    bestEffortClose(writer, "writer")
  }
  peer = new Peer({
    reader,
    writer,
    onClosed: () => {
      // EOF closes peer and destroys streams idempotently; peer already closed
      bestEffortClose(reader, "reader-onClosed")
      bestEffortClose(writer, "writer-onClosed")
    },
    onRequest: async (method: string, params: unknown) => {
      if (method === "initialize") {
        // validate major fail-closed
        try {
          validateProtocolVersion(params)
        } catch (e) {
          const code = (e as { code?: number })?.code ?? ErrorCode.InvalidParams
          const err = new Error(e instanceof Error ? e.message : String(e)) as Error & { code: number }
          err.code = code
          throw err
        }
        return buildInitializeResult()
      }
      // pre-init guard: all other methods require initialized
      if (!peer!.isInitialized()) {
        const err = new Error("Not initialized") as Error & { code: number }
        err.code = ErrorCode.InvalidRequest
        throw err
      }
      if (method === "session/cancelQueued") {
        // Route directly to B0 dispatch via AppRuntime, preserving typed envelope
        const result = await AppRuntime.runPromise(
          // @ts-ignore - AppRuntime provides CancelQueuedDispatch and all deps via AppLayer
          Effect.gen(function* () {
            const svc = yield* CancelQueuedDispatchService
            return yield* (svc.dispatch as (p: unknown) => Effect.Effect<unknown>)(params)
          }),
        )
        return result
      }
      if (method === "session/update") {
        const result = await AppRuntime.runPromise(
          Effect.gen(function* () {
            const svc = yield* SessionUpdateDispatchService
            // B2 private is structurally replay-only: missing dispatchPrivate fails closed without mutation
            const fn = (svc as unknown as { dispatchPrivate?: (p: unknown) => Effect.Effect<unknown> }).dispatchPrivate
            if (!fn) {
              const err = new Error("session/update private replay unavailable") as Error & { code: number }
              err.code = ErrorCode.MethodNotFound
              throw err
            }
            return yield* (fn as (p: unknown) => Effect.Effect<unknown>)(params)
          }),
        )
        return result
      }
      if (method === "session/fork") {
        const result = await AppRuntime.runPromise(
          Effect.gen(function* () {
            const svc = yield* SessionForkDispatchService
            const fn = (svc as unknown as { dispatchPrivate?: (p: unknown) => Effect.Effect<unknown> }).dispatchPrivate
            if (!fn) {
              const err = new Error("session/fork private replay unavailable") as Error & { code: number }
              err.code = ErrorCode.MethodNotFound
              throw err
            }
            return yield* (fn as (p: unknown) => Effect.Effect<unknown>)(params)
          }),
        )
        return result
      }
      if (method === "session/create") {
        const result = await AppRuntime.runPromise(
          Effect.gen(function* () {
            const svc = yield* SessionCreateDispatchService
            const fn = (svc as unknown as { dispatchPrivate?: (p: unknown) => Effect.Effect<unknown> }).dispatchPrivate
            if (!fn) {
              const err = new Error("session/create private replay unavailable") as Error & { code: number }
              err.code = ErrorCode.MethodNotFound
              throw err
            }
            return yield* (fn as (p: unknown) => Effect.Effect<unknown>)(params)
          }),
        )
        return result
      }
      if (method === "session/status") {
        // B5 parity-only read-only: same-directory StatusMap via drain-control snapshot, never mutates.
        const result = await AppRuntime.runPromise(
          Effect.gen(function* () {
            let req: FdStatusRequest
            try {
              req = validateStatusRequest(params)
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e)
              return statusFailed(fallbackIds(params), "validation.failed", msg, false)
            }
            const dir = canonicalDirectory(req.context.directory)
            const acquired = yield* acquireDrainControl(dir).pipe(
              Effect.map((v) => ({ tag: "ok" as const, value: v })),
              Effect.catch((err: unknown) => {
                const fence = err instanceof InstanceUnavailableDuringConfigRebuildError
                const msg = err instanceof Error ? err.message : String(err)
                const code = fence ? "InstanceUnavailableDuringConfigRebuild" : "internal"
                return Effect.succeed({
                  tag: "fail" as const,
                  result: statusFailed(req, code, msg, fence),
                })
              }),
              Effect.catchDefect((defect: unknown) => {
                const msg = defect instanceof Error ? defect.message : String(defect)
                return Effect.succeed({ tag: "fail" as const, result: statusFailed(req, "internal", msg, false) })
              }),
            )
            if (acquired.tag !== "ok") return acquired.result
            const inner = Effect.gen(function* () {
              const svc = yield* SessionStatus.Service
              const map = yield* svc.list()
              return {
                v: FD_STATUS_VERSION,
                requestId: req.requestId,
                opId: req.opId,
                op: FD_STATUS_OP,
                idempotencyKey: req.idempotencyKey,
                status: "succeeded",
                outcome: { type: "succeeded", time: Date.now() },
                accepted: true,
                data: { statuses: Object.fromEntries(map) },
              }
            }).pipe(
              Effect.provideService(InstanceRef, acquired.value.ctx),
              Effect.ensuring(acquired.value.release),
            )
            return yield* inner.pipe(
              Effect.catch((err: unknown) => {
                const msg = err instanceof Error ? err.message : String(err)
                return Effect.succeed(statusFailed(req, "internal", msg, false))
              }),
              Effect.catchDefect((defect: unknown) => {
                const msg = defect instanceof Error ? defect.message : String(defect)
                return Effect.succeed(statusFailed(req, "internal", msg, false))
              }),
            )
          }),
        )
        return result
      }
      if (method === "session/get") {
        // B6 parity-only read-only: same-directory Session.Info via drain-control snapshot, never mutates.
        const result = await AppRuntime.runPromise(
          Effect.gen(function* () {
            let req: FdGetRequest
            try {
              req = validateGetRequest(params)
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e)
              return getFailed(fallbackIds(params), "validation.failed", boundGetMessage(msg), false)
            }
            const dir = canonicalDirectory(req.context.directory)
            const acquired = yield* acquireDrainControl(dir).pipe(
              Effect.map((v) => ({ tag: "ok" as const, value: v })),
              Effect.catch((err: unknown) => {
                const fence =
                  err instanceof InstanceUnavailableDuringConfigRebuildError ||
                  (err as { _tag?: string })?._tag === "InstanceUnavailableDuringConfigRebuild"
                const code = fence ? "InstanceUnavailableDuringConfigRebuild" : "internal"
                const message = fence
                  ? boundGetMessage(err instanceof Error ? err.message : String(err))
                  : "internal error"
                return Effect.succeed({
                  tag: "fail" as const,
                  result: getFailed(req, code, message, fence),
                })
              }),
              Effect.catchDefect(() => {
                return Effect.succeed({ tag: "fail" as const, result: getFailed(req, "internal", "internal error", false) })
              }),
            )
            if (acquired.tag !== "ok") return acquired.result
            const inner = Effect.gen(function* () {
              const svc = yield* Session.Service
              const sid = SessionID.make(req.context.sessionId)
              const found = yield* svc.get(sid).pipe(
                Effect.map((v) => ({ tag: "ok" as const, value: v })),
                Effect.catch((err: unknown) => {
                  const missing = err instanceof NotFoundError || (err as { _tag?: string })?._tag === "NotFoundError"
                  const code = missing ? "session.not_found" : "internal"
                  const message = missing ? "session not found" : "internal error"
                  return Effect.succeed({ tag: "fail" as const, code, message })
                }),
                Effect.catchDefect(() => {
                  return Effect.succeed({ tag: "fail" as const, code: "internal", message: "internal error" })
                }),
              )
              if (found.tag !== "ok") return getFailed(req, found.code, found.message, false)
              let stored: string
              try {
                stored = canonicalDirectory(found.value.directory)
              } catch {
                return getFailed(req, "internal", "internal error", false)
              }
              if (stored !== dir) return getFailed(req, "scope_mismatch", "directory mismatch", false)
              if (!Schema.is(Session.Info)(found.value))
                return getFailed(req, "internal", "internal error", false)
              return {
                v: FD_GET_VERSION,
                requestId: req.requestId,
                opId: req.opId,
                op: FD_GET_OP,
                idempotencyKey: req.idempotencyKey,
                status: "succeeded",
                outcome: { type: "succeeded", time: Date.now() },
                accepted: true,
                data: { session: found.value },
              }
            }).pipe(
              Effect.provideService(InstanceRef, acquired.value.ctx),
              Effect.ensuring(acquired.value.release),
            )
            return yield* inner.pipe(
              Effect.catch(() => {
                return Effect.succeed(getFailed(req, "internal", "internal error", false))
              }),
              Effect.catchDefect(() => {
                return Effect.succeed(getFailed(req, "internal", "internal error", false))
              }),
            )
          }),
        )
        return result
      }
      const err = new Error(`Method not found: ${method}`) as Error & { code: number }
      err.code = ErrorCode.MethodNotFound
      throw err
    },
  })
  return { peer, reader, writer, dispose }
}

export interface FdCarrierDeps {
  fstatSync: (fd: number) => unknown
  createReadStream: (path: unknown, opts: unknown) => NodeJS.ReadableStream
  createWriteStream: (path: unknown, opts: unknown) => NodeJS.WritableStream
}

export function tryStartFdCarrierWithDeps(deps: FdCarrierDeps): FdCarrierHandle | null {
  if (!canUseFdCarrierWithDeps(deps)) return null
  let reader: NodeJS.ReadableStream | null = null
  try {
    if (!hasFdWithDeps(3, deps) || !hasFdWithDeps(4, deps)) return null
    reader = deps.createReadStream(null as unknown as string, { fd: 3, autoClose: false } as unknown as Record<string, unknown>) as unknown as NodeJS.ReadableStream
    let writer: NodeJS.WritableStream
    try {
      writer = deps.createWriteStream(null as unknown as string, { fd: 4, autoClose: false } as unknown as Record<string, unknown>) as unknown as NodeJS.WritableStream
    } catch (err) {
      console.warn("[kilo fd-carrier] writer creation failed, releasing reader:", String(err))
      if (reader) bestEffortClose(reader, "reader-partial-cleanup")
      return null
    }
    try {
      ;(reader as unknown as { resume: () => void }).resume()
    } catch (err) {
      console.warn("[kilo fd-carrier] reader resume in tryStart failed:", String(err))
    }
    return createFdCarrier(reader, writer)
  } catch (err) {
    console.warn("[kilo fd-carrier] tryStart failed:", String(err))
    if (reader) bestEffortClose(reader, "reader-startup-cleanup")
    return null
  }
}

function hasFdWithDeps(fd: number, deps: FdCarrierDeps): boolean {
  try {
    deps.fstatSync(fd)
    return true
  } catch (err) {
    console.warn("[kilo fd-carrier] hasFd check failed for", fd, String(err))
    return false
  }
}

function canUseFdCarrierWithDeps(deps: FdCarrierDeps): boolean {
  const envOk = !!process.env.KILO_PARENT_PID || process.env.KILO_CLIENT === "vscode"
  if (!envOk) return false
  try {
    deps.fstatSync(3)
    deps.fstatSync(4)
    return true
  } catch (err) {
    console.warn("[kilo fd-carrier] canUse check failed:", String(err))
    return false
  }
}

export function tryStartFdCarrier(): FdCarrierHandle | null {
  return tryStartFdCarrierWithDeps({
    fstatSync: fs.fstatSync.bind(fs),
    createReadStream: (p, o) => fs.createReadStream(p as string, o as never) as unknown as NodeJS.ReadableStream,
    createWriteStream: (p, o) => fs.createWriteStream(p as string, o as never) as unknown as NodeJS.WritableStream,
  })
}
