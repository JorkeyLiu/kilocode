import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const root = join(import.meta.dir, "../src")

function read(rel: string): string {
  return readFileSync(join(root, rel), "utf8")
}

// Runtime observation seam — mock cross-spawn before dynamic imports so
// handwritten wrappers are exercised against a fake proc. This is the
// smallest existing seam: the wrappers import `launch from "cross-spawn"`
// and no architecture change is introduced.
const captured: Array<{ cmd: string; args: string[]; opts: any; proc: any }> = []

mock.module("cross-spawn", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require("node:events") as typeof import("node:events")
  return {
    default: (cmd: string, args: string[], opts: any) => {
      const proc: any = new EventEmitter()
      proc.stdout = new EventEmitter()
      proc.stderr = new EventEmitter()
      proc.pid = 4242
      proc.exitCode = null
      proc.signalCode = null
      let timer: ReturnType<typeof setTimeout> | null = null
      const needsReadiness = args[0] === "serve"
      if (needsReadiness) {
        timer = setTimeout(() => {
          timer = null
          if (proc.exitCode === null && proc.signalCode === null) {
            proc.stdout.emit("data", Buffer.from("kilo server listening on http://127.0.0.1:4096\n"))
          }
        }, 0)
      }
      proc._getTimer = () => timer
      proc._hasTimer = () => timer !== null
      proc.kill = (sig?: string) => {
        if (proc.exitCode !== null || proc.signalCode !== null) return false
        if (timer !== null) {
          clearTimeout(timer)
          timer = null
        }
        proc.signalCode = (sig as string) ?? "SIGTERM"
        proc.emit("exit", null, proc.signalCode)
        return true
      }
      captured.push({ cmd, args: [...args], opts: { ...opts, env: { ...opts?.env } }, proc })
      return proc
    },
  }
})

describe("SDK wrapper KILO_CONFIG_CONTENT forwarding removed (P4.4-T9)", () => {
  test("src/server.ts has no wrapper helper or KILO_CONFIG_CONTENT forwarding", () => {
    const src = read("server.ts")
    expect(src).not.toContain("mergeConfig")
    expect(src).not.toContain("parseExistingConfig")
    expect(src).not.toContain("buildConfigEnv")
    expect(src).not.toContain("KILO_CONFIG_CONTENT")
    // preserves server spawning surface and canonical config passthrough via logLevel arg
    expect(src).toContain("createKiloServer")
    expect(src).toContain("createKiloTui")
    expect(src).toContain("...process.env")
    expect(src).toContain("logLevel")
    expect(src).toContain('from "./gen/types.gen.js"')
  })

  test("src/v2/server.ts has no wrapper helper or KILO_CONFIG_CONTENT forwarding", () => {
    const src = read("v2/server.ts")
    expect(src).not.toContain("mergeConfig")
    expect(src).not.toContain("parseExistingConfig")
    expect(src).not.toContain("buildConfigEnv")
    expect(src).not.toContain("KILO_CONFIG_CONTENT")
    expect(src).toContain("createKiloServer")
    expect(src).toContain("createKiloTui")
    expect(src).toContain("...process.env")
    expect(src).toContain("logLevel")
  })

  test("handwritten wrappers still expose server/tui spawning (no buildConfigEnv export)", async () => {
    const server = await import("../src/server.js")
    expect((server as Record<string, unknown>).buildConfigEnv).toBeUndefined()
    expect(typeof server.createKiloServer).toBe("function")
    expect(typeof server.createKiloTui).toBe("function")
    const v2 = await import("../src/v2/server.js")
    expect((v2 as Record<string, unknown>).buildConfigEnv).toBeUndefined()
    expect(typeof v2.createKiloServer).toBe("function")
    expect(typeof v2.createKiloTui).toBe("function")
  })

  test("generated SDK remains untouched (HTTP/SSE bridge preserved per LOCK-009)", () => {
    const gen = read("gen/sdk.gen.ts")
    expect(gen).toContain("createClient")
    const v2gen = read("v2/gen/sdk.gen.ts")
    expect(v2gen).toContain("createClient")
  })
})

describe("SDK wrapper runtime spawn observation (P4.4-T9)", () => {
  const sentinelKey = "__KILO_SDK_SENTINEL_P44_T9"
  const sentinelVal = "sdk-sentinel-42"
  const contentKey = "KILO_CONFIG_CONTENT"
  let origSentinel: string | undefined
  let origContent: string | undefined

  beforeEach(() => {
    captured.length = 0
    origSentinel = process.env[sentinelKey]
    origContent = process.env[contentKey]
    process.env[sentinelKey] = sentinelVal
    delete process.env[contentKey]
  })

  afterEach(() => {
    if (origSentinel === undefined) delete process.env[sentinelKey]
    else process.env[sentinelKey] = origSentinel
    if (origContent === undefined) delete process.env[contentKey]
    else process.env[contentKey] = origContent
    captured.length = 0
  })

  test("createKiloServer (src/server.ts) spawns serve with logLevel, inherits env, no KILO_CONFIG_CONTENT", async () => {
    const { createKiloServer } = await import("../src/server.js")
    const server = await createKiloServer({
      hostname: "127.0.0.1",
      port: 4123,
      config: { logLevel: "debug" } as any,
    })
    try {
      expect(captured.length).toBe(1)
      const c = captured[0]!
      expect(c.cmd).toBe("kilo")
      expect(c.args[0]).toBe("serve")
      expect(c.args).toContain("--hostname=127.0.0.1")
      expect(c.args).toContain("--port=4123")
      expect(c.args).toContain("--log-level=debug")
      // retained server/TUI distinction — server args contain serve, no TUI flags
      expect(c.args).not.toContain("--project=/tmp/proj")
      // inherited sentinel environment via ...process.env
      expect(c.opts.env[sentinelKey]).toBe(sentinelVal)
      // absence of KILO_CONFIG_CONTENT injection
      expect(c.opts.env.KILO_CONFIG_CONTENT).toBeUndefined()
      expect(c.args.join(" ")).not.toContain("KILO_CONFIG_CONTENT")
    } finally {
      server.close()
    }
  })

  test("createKiloServer (src/server.ts) omits --log-level when not configured", async () => {
    const { createKiloServer } = await import("../src/server.js")
    const server = await createKiloServer({ hostname: "127.0.0.1", port: 4124 })
    try {
      expect(captured.length).toBe(1)
      const c = captured[0]!
      expect(c.args).not.toContain("--log-level=debug")
      expect(c.args.join(" ")).not.toContain("--log-level")
      expect(c.opts.env.KILO_CONFIG_CONTENT).toBeUndefined()
      expect(c.opts.env[sentinelKey]).toBe(sentinelVal)
    } finally {
      server.close()
    }
  })

  test("createKiloTui (src/server.ts) spawns with project/model/session/agent, inherits env, no KILO_CONFIG_CONTENT", async () => {
    const { createKiloTui } = await import("../src/server.js")
    const tui = createKiloTui({
      project: "/tmp/proj",
      model: "m1",
      session: "s1",
      agent: "a1",
    })
    try {
      expect(captured.length).toBe(1)
      const c = captured[0]!
      expect(c.cmd).toBe("kilo")
      // TUI distinction — no serve, positional TUI flags present
      expect(c.args).not.toContain("serve")
      expect(c.args).toContain("--project=/tmp/proj")
      expect(c.args).toContain("--model=m1")
      expect(c.args).toContain("--session=s1")
      expect(c.args).toContain("--agent=a1")
      expect(c.opts.env[sentinelKey]).toBe(sentinelVal)
      expect(c.opts.env.KILO_CONFIG_CONTENT).toBeUndefined()
      expect(c.args.join(" ")).not.toContain("KILO_CONFIG_CONTENT")
      expect(c.opts.stdio).toBe("inherit")
      expect(c.opts.windowsHide).toBe(true)
    } finally {
      tui.close()
    }
  })

  test("createKiloServer (src/v2/server.ts) spawns serve with logLevel, inherits env, no KILO_CONFIG_CONTENT", async () => {
    const { createKiloServer } = await import("../src/v2/server.js")
    const server = await createKiloServer({
      hostname: "127.0.0.1",
      port: 5123,
      config: { logLevel: "info" } as any,
    })
    try {
      expect(captured.length).toBe(1)
      const c = captured[0]!
      expect(c.cmd).toBe("kilo")
      expect(c.args[0]).toBe("serve")
      expect(c.args).toContain("--hostname=127.0.0.1")
      expect(c.args).toContain("--port=5123")
      expect(c.args).toContain("--log-level=info")
      expect(c.opts.env[sentinelKey]).toBe(sentinelVal)
      expect(c.opts.env.KILO_CONFIG_CONTENT).toBeUndefined()
      expect(c.args.join(" ")).not.toContain("KILO_CONFIG_CONTENT")
    } finally {
      server.close()
    }
  })

  test("createKiloTui (src/v2/server.ts) spawns with project/model/session/agent, inherits env, no KILO_CONFIG_CONTENT", async () => {
    const { createKiloTui } = await import("../src/v2/server.js")
    const tui = createKiloTui({
      project: "/tmp/proj2",
      model: "m2",
      session: "s2",
      agent: "a2",
    })
    try {
      expect(captured.length).toBe(1)
      const c = captured[0]!
      expect(c.cmd).toBe("kilo")
      expect(c.args).not.toContain("serve")
      expect(c.args).toContain("--project=/tmp/proj2")
      expect(c.args).toContain("--model=m2")
      expect(c.args).toContain("--session=s2")
      expect(c.args).toContain("--agent=a2")
      expect(c.opts.env[sentinelKey]).toBe(sentinelVal)
      expect(c.opts.env.KILO_CONFIG_CONTENT).toBeUndefined()
      expect(c.args.join(" ")).not.toContain("KILO_CONFIG_CONTENT")
      expect(c.opts.stdio).toBe("inherit")
      expect(c.opts.windowsHide).toBe(true)
    } finally {
      tui.close()
    }
  })
})

describe("SDK wrapper fake lifecycle clean (P4.4-T9 re-audit minimal)", () => {
  test("readiness timer retained/cancelled, scheduled only for server, kill marks termination and close disposes", async () => {
    const { createKiloServer } = await import("../src/server.js")
    const server = await createKiloServer({ hostname: "127.0.0.1", port: 4135 })
    const sproc: any = (captured[0] as any).proc
    // server scheduled readiness; after successful start timer has fired/cleared
    expect(sproc._getTimer()).toBeNull()
    expect(sproc._hasTimer()).toBe(false)
    let sExited = false
    sproc.once("exit", () => {
      sExited = true
    })
    server.close()
    expect(sproc.signalCode).not.toBeNull()
    expect(sproc._getTimer()).toBeNull()
    expect(sExited).toBe(true)
    captured.length = 0
    const { createKiloTui } = await import("../src/server.js")
    const tui = createKiloTui({ project: "/tmp/lc-probe" })
    const tproc: any = (captured[0] as any).proc
    // TUI must not schedule readiness timer
    expect(tproc._hasTimer()).toBe(false)
    expect(tproc._getTimer()).toBeNull()
    let tExited = false
    tproc.once("exit", () => {
      tExited = true
    })
    tui.close()
    expect(tproc.signalCode).not.toBeNull()
    expect(tproc._getTimer()).toBeNull()
    expect(tExited).toBe(true)
    // direct pending-timer cancellation before firing (proves retained timer is cancellable)
    captured.length = 0
    const launch = (await import("cross-spawn")).default as any
    const pending: any = launch("kilo", ["serve", "--hostname=127.0.0.1", "--port=9998"], { env: { ...process.env } })
    expect(pending._hasTimer()).toBe(true)
    let pExited = false
    pending.once("exit", () => {
      pExited = true
    })
    let pData = false
    pending.stdout.once("data", () => {
      pData = true
    })
    pending.kill()
    expect(pending._getTimer()).toBeNull()
    expect(pending.signalCode).not.toBeNull()
    expect(pExited).toBe(true)
    await new Promise((r) => setTimeout(r, 5))
    expect(pData).toBe(false)
    // TUI direct launch still has no timer
    const pendingTui: any = launch("kilo", ["--project=/tmp/lc-direct"], { env: { ...process.env } })
    expect(pendingTui._hasTimer()).toBe(false)
    pendingTui.kill()
  })
})
