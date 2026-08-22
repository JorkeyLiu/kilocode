import { Effect, ManagedRuntime } from "effect"
import { isAbsolute } from "path"
import { Database } from "@opencode-ai/core/database/database"
import { createChangefeedDeps } from "./changefeed-adapter"
import { startWorker } from "./worker"
import type { ObservationDeps } from "./observation"

/**
 * Standalone private worker entry (R9) for VS Code packaging.
 * Gate: KILO_PRIVATE_WORKER_STANDALONE=1 + absolute KILO_DB.
 * Bundled as ESM artifact dist/private-worker/standalone-worker.mjs.
 * Uses leased Database.layerFromPath + createChangefeedDeps.
 * Default worker remains lightweight CJS without this graph.
 */

export function isStandaloneEnabled(): boolean {
  return process.env.KILO_PRIVATE_WORKER_STANDALONE === "1" && typeof process.env.KILO_DB === "string" && isAbsolute(process.env.KILO_DB)
}

export async function createStandaloneDeps(): Promise<{ deps: ObservationDeps; dispose: () => Promise<void> }> {
  const file = process.env.KILO_DB!
  if (!isAbsolute(file)) throw new Error(`KILO_DB must be absolute for standalone worker: ${file}`)
  const layer = Database.layerFromPath(file)
  const runtime = ManagedRuntime.make(layer)
  const svc = await runtime.runPromise(
    Effect.gen(function* () {
      return yield* Database.Service
    }),
  )
  const deps = createChangefeedDeps(svc.db)
  const dispose = async () => {
    try {
      await runtime.dispose()
    } catch {}
  }
  return { deps, dispose }
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

function clearPolling(iv: ReturnType<typeof setInterval> | undefined): void {
  if (iv) safe(() => clearInterval(iv))
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
    const r = process.stdin as unknown as { off?: (e: string, h: () => void) => void; removeListener?: (e: string, h: () => void) => void }
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

const isMain =
  typeof process !== "undefined" &&
  typeof process.argv[1] === "string" &&
  process.argv[1].includes("private-worker/standalone-worker")
if (isMain) {
  if (isStandaloneEnabled()) {
    void (async () => {
      try {
        const { deps, dispose } = await createStandaloneDeps()
        const peer = startWorker({ observationDeps: deps })
        const origDispose = peer.dispose.bind(peer)
        let cleaned = false
        let iv: ReturnType<typeof setInterval> | undefined
        const onEnd = () => {
          void doCleanup()
        }
        const sigIntHandler = () => {
          void doCleanup().finally(() => process.exit(0))
        }
        const sigTermHandler = () => {
          void doCleanup().finally(() => process.exit(0))
        }
        const doCleanup = async () => {
          if (cleaned) return
          cleaned = true
          clearPolling(iv)
          safe(() => origDispose())
          await safeAsync(() => dispose())
          detachProcessSignals(sigIntHandler, sigTermHandler)
          detachStdin(onEnd)
        }
        ;(peer as unknown as { dispose: () => void }).dispose = () => {
          void doCleanup()
        }
        attachProcessSignals(sigIntHandler, sigTermHandler)
        attachStdin(onEnd)
        iv = setInterval(() => {
          if (peer.getState() === "closed") {
            clearPolling(iv)
            void doCleanup()
          }
        }, 50)
        if (iv.unref) iv.unref()
      } catch (e) {
        console.error("[private-worker] standalone bootstrap failed:", e)
        process.exit(1)
      }
    })()
  } else {
    startWorker()
  }
}
