import * as fs from "node:fs"
import { Effect } from "effect"
import { ErrorCode } from "@/private-worker/json-rpc"
import { AppRuntime } from "@/effect/app-runtime"
import { CancelQueuedDispatchService } from "@/kilocode/session/cancel-queued-dispatch"
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
