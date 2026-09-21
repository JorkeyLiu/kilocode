import { Effect, ManagedRuntime } from "effect"
import { isAbsolute } from "path"
import { Database } from "@opencode-ai/core/database/database"
import * as Changefeed from "@opencode-ai/core/retention/changefeed"
import { createChangefeedDeps } from "./changefeed-adapter"
import { createSessionListDeps } from "./session-list-adapter"
import { createSessionGetDeps } from "./session-get-adapter"
import { createSessionMessagesDeps } from "./session-messages-adapter"
import { createSessionOperationsDeps } from "./session-operations-adapter"
import { startWorker } from "./worker"
import type { ObservationDeps } from "./observation"
import { JsonRpcPeer } from "./peer"
import { ObservationController, buildObservationCapabilities } from "./observation"
import { ErrorCode } from "./json-rpc"
import { OBSERVATION_VERSION } from "./observation"

/**
 * Standalone private worker entry for VS Code packaging.
 * Gate: KILO_PRIVATE_WORKER_STANDALONE=1 + absolute KILO_DB (canonical DB path).
 * Bundled as ESM artifact dist/private-worker/standalone-worker.mjs.
 * No-lease observer: uses Database.layerNoLease + createChangefeedDeps.
 * Legacy kilo serve owns the exclusive data-root lease; this worker never creates it.
 * Default worker remains lightweight CJS without this graph.
 */

export function isStandaloneEnabled(): boolean {
  return (
    process.env.KILO_PRIVATE_WORKER_STANDALONE === "1" &&
    typeof process.env.KILO_DB === "string" &&
    isAbsolute(process.env.KILO_DB)
  )
}

export function isTestBridgeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.KILO_PRIVATE_WORKER_TEST_BRIDGE === "1"
}

export async function createStandaloneDeps(): Promise<{
  deps: ObservationDeps
  dispose: () => Promise<void>
  db: Database.Interface["db"]
}> {
  const file = process.env.KILO_DB!
  if (!isAbsolute(file)) throw new Error(`KILO_DB must be absolute for standalone worker: ${file}`)
  const layer = Database.layerNoLease(file)
  const runtime = ManagedRuntime.make(layer)
  const svc = await runtime.runPromise(
    Effect.gen(function* () {
      return yield* Database.Service
    }),
  )
  const base = createChangefeedDeps(svc.db)
  const list = createSessionListDeps(svc.db)
  const get = createSessionGetDeps(svc.db)
  const messages = createSessionMessagesDeps(svc.db)
  const ops = createSessionOperationsDeps(svc.db)
  const deps: ObservationDeps = { ...base, list: list.list, get: get.get, messages: messages.messages, operations: ops.operations }
  const dispose = async () => {
    try {
      await runtime.dispose()
    } catch {}
  }
  return { deps, dispose, db: svc.db }
}

function safe(fn: () => void): void {
  try {
    fn()
  } catch {}
}

async function safeAsync(fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
  } catch {}
}

function safeOff(target: unknown, event: string, handler: () => void): void {
  const t = target as { off?: (e: string, h: () => void) => void; removeListener?: (e: string, h: () => void) => void }
  safe(() => t.off?.(event, handler as unknown as () => void))
  safe(() => t.removeListener?.(event, handler as unknown as () => void))
}

function detachProcessSignals(sigInt: () => void, sigTerm: () => void): void {
  safe(() => {
    if (sigInt) safeOff(process, "SIGINT", sigInt)
    if (sigTerm) safeOff(process, "SIGTERM", sigTerm)
  })
}

function detachStdin(onEnd: () => void): void {
  safe(() => {
    const r = process.stdin as unknown as {
      off?: (e: string, h: () => void) => void
      removeListener?: (e: string, h: () => void) => void
    }
    safeOff(r, "end", onEnd)
    safeOff(r, "close", onEnd)
    safeOff(r, "error", onEnd)
  })
}

function attachProcessSignals(sigInt: () => void, sigTerm: () => void): void {
  safe(() => process.on("SIGINT", sigInt as unknown as () => void))
  safe(() => process.on("SIGTERM", sigTerm as unknown as () => void))
}

function attachStdin(onEnd: () => void): void {
  safe(() => {
    const reader = process.stdin as unknown as { on?: (e: string, h: () => void) => void }
    reader.on?.("end", onEnd)
    reader.on?.("close", onEnd)
    reader.on?.("error", onEnd as unknown as () => void)
  })
}

export function createSharedCleanup(cleanup: () => Promise<void>): () => Promise<void> {
  let promise: Promise<void> | undefined
  return () => {
    if (promise) return promise
    promise = cleanup()
    return promise
  }
}

export function createSignalExitHandler(doCleanup: () => Promise<void>, exit: (code: number) => void): () => void {
  return () => {
    void doCleanup().finally(() => exit(0))
  }
}

const isMain =
  typeof process !== "undefined" &&
  typeof process.argv[1] === "string" &&
  process.argv[1].includes("private-worker/standalone-worker")
if (isMain) {
  if (isStandaloneEnabled()) {
    void (async () => {
      try {
        const { deps, dispose, db } = await createStandaloneDeps()
        const useBridge = isTestBridgeEnabled()
        // Event-driven cleanup: peer onClosed + stdin end + signals, no polling.
        // Shared promise ensures concurrent signal handlers await the same in-progress cleanup before exit.
        let peer: JsonRpcPeer
        let origDispose: (() => void) | undefined
        let cleanupPromise: Promise<void> | undefined
        const doCleanup = (): Promise<void> => {
          if (cleanupPromise) return cleanupPromise
          cleanupPromise = (async () => {
            if (origDispose) safe(() => origDispose!())
            else if (peer) safe(() => peer.dispose())
            await safeAsync(() => dispose())
            detachProcessSignals(sigIntHandler, sigTermHandler)
            detachStdin(onEnd)
          })()
          return cleanupPromise
        }
        const onEnd = () => {
          void doCleanup()
        }
        const sigIntHandler = createSignalExitHandler(doCleanup, (c) => process.exit(c))
        const sigTermHandler = createSignalExitHandler(doCleanup, (c) => process.exit(c))
        const onPeerClosed = () => {
          void doCleanup()
        }
        if (useBridge) {
          const ctrl = new ObservationController(deps)
          if (typeof (process.stdin as unknown as { resume?: () => void }).resume === "function") {
            ;(process.stdin as unknown as { resume: () => void }).resume()
          }
          let peerRef: JsonRpcPeer | undefined
          peer = new JsonRpcPeer({
            reader: process.stdin,
            writer: process.stdout,
            onClosed: onPeerClosed,
            // eslint-disable-next-line complexity
            onRequest: async (method, params) => {
              if (method === "test/mutateChangefeed") {
                const p = (params ?? {}) as Record<string, unknown>
                const session_id =
                  typeof p.session_id === "string"
                    ? p.session_id
                    : `ses_${Date.now()}_${Math.floor(Math.random() * 1000)}`
                const revision =
                  typeof p.revision === "number" && Number.isInteger(p.revision) && p.revision >= 0 ? p.revision : 1
                const kindRaw = typeof p.kind === "string" ? p.kind : "changed"
                const kind = kindRaw === "deleted" || kindRaw === "changed" ? kindRaw : "changed"
                const time = typeof p.time === "number" && Number.isInteger(p.time) ? p.time : Date.now()
                const capsRaw = p.caps as unknown
                let entry: Changefeed.Entry
                if (
                  capsRaw &&
                  typeof capsRaw === "object" &&
                  !Array.isArray(capsRaw) &&
                  ("maxRows" in (capsRaw as Record<string, unknown>) ||
                    "maxBytes" in (capsRaw as Record<string, unknown>))
                ) {
                  const caps = capsRaw as { maxRows?: number; maxBytes?: number }
                  const maxRows =
                    typeof caps.maxRows === "number" && Number.isInteger(caps.maxRows) && caps.maxRows > 0
                      ? caps.maxRows
                      : Changefeed.MAX_ROWS
                  const maxBytes =
                    typeof caps.maxBytes === "number" && Number.isInteger(caps.maxBytes) && caps.maxBytes > 0
                      ? caps.maxBytes
                      : Changefeed.MAX_BYTES
                  entry = await Effect.runPromise(
                    Changefeed.appendWithCaps(
                      db,
                      { session_id, revision, kind: kind as Changefeed.Kind, time },
                      { maxRows, maxBytes },
                    ),
                  )
                } else {
                  entry = await Effect.runPromise(
                    Changefeed.append(db, { session_id, revision, kind: kind as Changefeed.Kind, time }),
                  )
                }
                const obs = {
                  seq: entry.seq,
                  session_id: entry.session_id,
                  revision: entry.revision,
                  kind: entry.kind,
                  time: entry.time,
                }
                if (peerRef) {
                  try {
                    ctrl.notifyChanged(peerRef, [obs as unknown as import("./observation").ObservationEntry], entry.seq)
                  } catch {}
                }
                return { v: OBSERVATION_VERSION, cursor: entry.seq, entry: obs }
              }
              if (method.startsWith("observation/")) return ctrl.handle(method, params)
              if (method === "initialize") {
                return {
                  protocolVersion: "1.0",
                  serverInfo: { name: "kilo-private-worker", version: "7.4.11" },
                  capabilities: buildObservationCapabilities(),
                }
              }
              if (method === "ping") return { pong: true }
              if (method === "echo") return params
              if (method === "error") throw new Error("intentional error")
              const err = new Error(`Method not found: ${method}`) as Error & { code?: number }
              err.code = ErrorCode.MethodNotFound
              throw err
            },
            onNotification: () => {},
          })
          peerRef = peer
        } else {
          peer = startWorker({ observationDeps: deps, onClosed: onPeerClosed })
        }
        origDispose = peer.dispose.bind(peer)
        ;(peer as unknown as { dispose: () => void }).dispose = () => {
          void doCleanup()
        }
        attachProcessSignals(sigIntHandler, sigTermHandler)
        attachStdin(onEnd)
      } catch (e) {
        console.error("[private-worker] standalone bootstrap failed:", e)
        process.exit(1)
      }
    })()
  } else {
    startWorker()
  }
}
