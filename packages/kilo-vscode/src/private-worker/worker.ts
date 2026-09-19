import { JsonRpcPeer } from "./peer"
import { ErrorCode } from "./json-rpc"
import { ObservationController, type ObservationDeps, buildObservationCapabilities } from "./observation"

/**
 * Private worker entrypoint (R9).
 * Runs over stdio with Content-Length framing, handles `initialize` exactly
 * once, and echoes `echo` / `ping` commands. R9 observation routing is
 * present (observation/* via injected ObservationController, versioned
 * envelope v=1.0, payload-free entries, gap/eviction/ahead -> explicit
 * rehydrate, notification forwarding via ObservationController.notifyChanged)
 * while R11-R14 remain absent. No lifecycle reconnect, selector/readiness
 * untouched. No production DB lease acquisition.
 *
 * Usage (Node/Bun):
 *   node --loader ts-node ... worker.ts   // or `bun run src/private-worker/worker.ts`
 *   The process reads JSON-RPC frames from stdin and writes to stdout.
 *   Stderr is used only for diagnostics (bounded via StderrTail on the host).
 *
 * This module exports `startWorker` for in-process test harnesses and also
 * auto-starts when executed as main (import.meta.main or require.main).
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

  // Ensure stdin is flowing
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
          capabilities: ctrl ? buildObservationCapabilities() : {},
        }
      }
      if (method === "ping") return { pong: true }
      if (method === "echo") return params
      if (method === "error") throw new Error("intentional error")
      // Unknown method handled as MethodNotFound inside peer if we throw special?
      // Peer will catch and return InternalError; we want MethodNotFound for unknown.
      // So signal by throwing with code.
      const err = new Error(`Method not found: ${method}`) as Error & { code?: number }
      err.code = ErrorCode.MethodNotFound
      throw err
    },
    onNotification: () => {
      // Notifications are event envelopes; no response required. Scaffold keeps them no-op.
    },
  })

  // Translate MethodNotFound thrown errors into correct code
  // Peer currently maps any thrown error to -32603; we normalize here by inspecting code.
  // Patch peer's behavior by wrapping: if error code is MethodNotFound, respond via makeError path.
  // Instead we handle by returning a sentinel and letting peer do InternalError — simpler:
  // override peer's internal to MethodNotFound by monkey-patching send logic is not needed.
  // Instead we ensure onRequest for unknown returns a rejection that peer turns into -32603,
  // then we adjust here to send -32601 directly via peer's private path: simplest is to
  // have worker's onRequest throw and peer currently produces -32603, but spec tests expect
  // -32601 for MethodNotFound. So we intercept via peer's handling: if method unknown, we
  // return a promise that rejects with MethodNotFound and peer will map to InternalError.
  // To preserve -32601, we make peer check error code and use MethodNotFound.
  // For now, adjust peer to preserve code: update peer to honor err.code.

  return peer
}

// Auto-start when run as process main. This check works for both Node and Bun.
// `process.argv[1]` contains the script path; we start only when file is executed directly
// and not when imported as a module in tests.
const isMain =
  typeof process !== "undefined" &&
  typeof process.argv[1] === "string" &&
  process.argv[1].includes("private-worker/worker")
if (isMain) {
  startWorker()
}
