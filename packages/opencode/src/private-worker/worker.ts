import { JsonRpcPeer } from "./peer"
import { ErrorCode } from "./json-rpc"
import { ObservationController, type ObservationDeps } from "./observation"

/**
 * Private worker entrypoint (R9).
 * Runs over stdio with Content-Length framing, handles `initialize` exactly
 * once, and echoes `echo` / `ping` commands. R9 observation routing is
 * present (observation/* via injected ObservationController, versioned
 * envelope v=1.0, payload-free entries, gap/eviction/ahead -> explicit
 * rehydrate, notification forwarding via ObservationController.notifyChanged)
 * while R11-R14 remain absent. No lifecycle reconnect, selector/readiness
 * untouched. No production DB lease acquisition. Parity with
 * packages/kilo-vscode/src/private-worker/worker.ts.
 */

export interface WorkerOptions {
  reader?: NodeJS.ReadableStream
  writer?: NodeJS.WritableStream
  version?: string
  observationDeps?: ObservationDeps
  onClosed?: () => void
}

export function startWorker(opts: WorkerOptions = {}): JsonRpcPeer {
  const reader = opts.reader ?? process.stdin
  const writer = opts.writer ?? process.stdout
  const version = opts.version ?? "7.4.11"
  const ctrl = opts.observationDeps ? new ObservationController(opts.observationDeps) : null
  if (typeof (reader as NodeJS.ReadableStream & { resume?: () => void }).resume === "function") {
    ;(reader as unknown as { resume: () => void }).resume()
  }
  const peer = new JsonRpcPeer({
    reader,
    writer,
    onClosed: opts.onClosed,
    onRequest: async (method, params) => {
      if (ctrl && method.startsWith("observation/")) return ctrl.handle(method, params)
      if (method === "initialize") {
        return {
          protocolVersion: "1.0",
          serverInfo: { name: "kilo-private-worker", version },
          capabilities: {},
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
  return peer
}

const isMain =
  typeof process !== "undefined" &&
  typeof process.argv[1] === "string" &&
  process.argv[1].includes("private-worker/worker")
if (isMain) {
  startWorker()
}
