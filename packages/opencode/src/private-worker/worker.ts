import { JsonRpcPeer } from "./peer"
import { ErrorCode } from "./json-rpc"

export interface WorkerOptions {
  reader?: NodeJS.ReadableStream
  writer?: NodeJS.WritableStream
  version?: string
}

export function startWorker(opts: WorkerOptions = {}): JsonRpcPeer {
  const reader = opts.reader ?? process.stdin
  const writer = opts.writer ?? process.stdout
  const version = opts.version ?? "7.4.11"
  if (typeof (reader as NodeJS.ReadableStream & { resume?: () => void }).resume === "function") {
    ;(reader as unknown as { resume: () => void }).resume()
  }
  const peer = new JsonRpcPeer({
    reader,
    writer,
    onRequest: async (method, params) => {
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
