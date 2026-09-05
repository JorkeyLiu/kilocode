import { afterAll, afterEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { KiloClient } from "@kilocode/sdk/v2/client"
import { setPathParityConnection } from "./kilo-provider/model-state"
import * as ModelState from "./kilo-provider/model-state"
import type { PathParityConnection } from "./kilo-provider/path-parity"

const routingOk = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kilo-ms-path-routing-")))
const stateOk = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kilo-ms-path-state-")))

afterEach(() => {
  setPathParityConnection(null)
})

afterAll(() => {
  setPathParityConnection(null)
  for (const dir of [routingOk, stateOk]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // Owned temp cleanup is best-effort; never mask test results.
    }
  }
})

function cache() {
  const value: Record<string, string> = {}
  return {
    read: () => value,
    write: (next: Record<string, string>) => {
      for (const k of Object.keys(value)) delete value[k]
      Object.assign(value, next)
    },
  }
}

function conn(routing: string | undefined, seen: { calls: number; dir?: unknown }): PathParityConnection {
  return {
    isPrivateAvailable: () => true,
    privatePathOutcomeWithHandle: (req: unknown) => {
      seen.calls += 1
      seen.dir = (req as { context: { directory: unknown } }).context.directory
      const r = req as { requestId: string; opId: string; idempotencyKey: string }
      return {
        id: 7,
        promise: Promise.resolve({
          kind: "valid",
          result: {
            v: 1,
            requestId: r.requestId,
            opId: r.opId,
            op: "path/get",
            idempotencyKey: r.idempotencyKey,
            status: "succeeded",
            outcome: { type: "succeeded", time: 1 },
            accepted: true,
            data: {
              path: {
                home: "/home/u",
                state: "/home/u/.local/state/kilo",
                config: "/home/u/.config/kilo",
                worktree: routing ?? "/tmp",
                directory: routing ?? "/tmp",
              },
            },
          },
        }),
        cancel: () => true,
      }
    },
    getPathRoutingDirectory: () => routing,
  } as unknown as PathParityConnection
}

describe("model-state path/get routing identity and observer wiring", () => {
  test("absent routing directory calls SDK without args and never observes (no process.cwd())", async () => {
    const seen = { calls: 0 }
    setPathParityConnection(conn(undefined, seen))
    let sdkArgs: unknown[] | null = null
    const client = {
      path: {
        get: async (...args: unknown[]) => {
          sdkArgs = args
          return { data: {} }
        },
      },
    } as unknown as KiloClient
    const posted: unknown[] = []
    await ModelState.handleMessage("requestVariants", {}, client, (m) => posted.push(m), cache())
    expect(sdkArgs).toEqual([])
    expect(seen.calls).toBe(0)
    expect(posted[0]).toMatchObject({ type: "variantsLoaded" })
  })

  test("thrown terminal SDK failure still reaches the detached observer fail-closed", async () => {
    const seen = { calls: 0 }
    const routing = `${routingOk}-thrown`
    setPathParityConnection(conn(routing, seen))
    const client = {
      path: {
        get: async () => {
          throw Object.assign(new Error("boom"), { status: 500 })
        },
      },
    } as unknown as KiloClient
    const posted: unknown[] = []
    await ModelState.handleMessage("requestVariants", {}, client, (m) => posted.push(m), cache())
    expect(seen.calls).toBe(1)
    expect(seen.dir).toBe(routing)
    expect(posted[0]).toMatchObject({ type: "variantsLoaded", variants: {} })
  })

  test("SDK and private reads share the authoritative routing directory with SDK authority intact", async () => {
    const seen: { calls: number; dir?: unknown } = { calls: 0 }
    setPathParityConnection(conn(routingOk, seen))
    let sdkArgs: unknown[] | null = null
    const payload = {
      home: "/home/u",
      state: stateOk,
      config: "/home/u/.config/kilo",
      worktree: routingOk,
      directory: routingOk,
    }
    const sdk = { data: { ...payload }, response: { status: 200 } }
    const client = {
      path: {
        get: async (...args: unknown[]) => {
          sdkArgs = args
          return sdk
        },
      },
    } as unknown as KiloClient
    const posted: unknown[] = []
    const before = JSON.stringify(sdk.data)
    await ModelState.handleMessage("requestVariants", {}, client, (m) => posted.push(m), cache())
    // SDK read carries the explicit authoritative directory (never implicit cwd).
    expect(sdkArgs).toEqual([{ directory: routingOk }])
    // Private read routes to the same directory — never the host process.cwd().
    expect(seen.calls).toBe(1)
    expect(seen.dir).toBe(routingOk)
    if (process.cwd() !== routingOk) expect(seen.dir).not.toBe(process.cwd())
    // SDK snapshot untouched by the detached observation.
    expect(JSON.stringify(sdk.data)).toBe(before)
    expect(posted[0]).toMatchObject({ type: "variantsLoaded" })
    await new Promise((r) => setTimeout(r, 25))
    expect(JSON.stringify(sdk.data)).toBe(before)
  })
})
