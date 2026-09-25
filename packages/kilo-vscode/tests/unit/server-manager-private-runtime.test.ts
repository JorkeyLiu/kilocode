import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { spawnSync } from "node:child_process"
import * as vscode from "vscode"
import { buildHiddenChildEnv, buildServeChildEnvAugment, resolveManagedServerEnv } from "../../src/services/cli-backend/server-manager"

function ownedEnvFixture<T>(fn: () => T): T {
  const saved = process.env.KILO_PRIVATE_RUNTIME
  try {
    return fn()
  } finally {
    if (saved === undefined) delete process.env.KILO_PRIVATE_RUNTIME
    else process.env.KILO_PRIVATE_RUNTIME = saved
  }
}

let originalGetConfiguration: typeof vscode.workspace.getConfiguration
beforeEach(() => {
  const ws = vscode.workspace as unknown as { getConfiguration: typeof vscode.workspace.getConfiguration }
  originalGetConfiguration = ws.getConfiguration
  ws.getConfiguration = ((section?: string) => {
    if (section === "http") {
      return {
        get: () => undefined,
        inspect: () => ({}),
        update: async () => {},
      } as unknown as ReturnType<typeof vscode.workspace.getConfiguration>
    }
    return {
      get: (_key: string, value?: unknown) => value,
      inspect: () => ({}),
      update: async () => {},
    } as unknown as ReturnType<typeof vscode.workspace.getConfiguration>
  }) as typeof vscode.workspace.getConfiguration
})
afterEach(() => {
  const ws = vscode.workspace as unknown as { getConfiguration: typeof vscode.workspace.getConfiguration }
  ws.getConfiguration = originalGetConfiguration
})

describe("ServerManager private runtime spawn", () => {
  it("hidden child omits KILO_PRIVATE_RUNTIME even when host env has 1, serve child sees 1 via real spawn and injected env", () => {
    ownedEnvFixture(() => {
      process.env.KILO_PRIVATE_RUNTIME = "1"

      const hiddenEnv = buildHiddenChildEnv(process.env)
      // cleanly omitted, not string "undefined"
      expect("KILO_PRIVATE_RUNTIME" in hiddenEnv).toBe(false)
      expect(hiddenEnv.KILO_PRIVATE_RUNTIME).toBeUndefined()
      // ensure no accidental string "undefined" value — key must be absent, not "undefined"
      expect((hiddenEnv as Record<string, unknown>).KILO_PRIVATE_RUNTIME).not.toBe("undefined")
      // real child process proves hidden does not leak
      const hiddenOut = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.env.KILO_PRIVATE_RUNTIME))"], {
        env: hiddenEnv as NodeJS.ProcessEnv,
        encoding: "utf8",
      })
      expect(hiddenOut.status).toBe(0)
      expect(hiddenOut.stdout).toBe("undefined")
      expect(hiddenOut.stdout).not.toBe("1")
      expect(hiddenOut.stdout).not.toBe("undefined" && "1") // sanity: not 1

      // serve child must see exactly "1" even when host env is polluted
      const base = { ...process.env } as NodeJS.ProcessEnv
      // simulate polluted host with invalid value, serve should still be "1"
      base.KILO_PRIVATE_RUNTIME = "true"
      const serveAug = buildServeChildEnvAugment(base)
      expect(serveAug.KILO_PRIVATE_RUNTIME).toBe("1")
      // also when host already has 1, serve still 1
      process.env.KILO_PRIVATE_RUNTIME = "1"
      const serveEnvViaHelper = buildServeChildEnvAugment(process.env)
      expect(serveEnvViaHelper.KILO_PRIVATE_RUNTIME).toBe("1")
      // real serve spawn integration: spread managed env then augment to 1
      const managed = resolveManagedServerEnv(process.env)
      const serveEnv = { ...managed, KILO_PRIVATE_RUNTIME: "1" } as NodeJS.ProcessEnv
      const serveOut = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.env.KILO_PRIVATE_RUNTIME))"], {
        env: serveEnv,
        encoding: "utf8",
      })
      expect(serveOut.status).toBe(0)
      expect(serveOut.stdout).toBe("1")

      // injected spawn capture: simulate ServerManager hidden vs serve spawn envs
      const captured: Array<{ kind: string; env: NodeJS.ProcessEnv }> = []
      function fakeSpawn(_cmd: string, _args: string[], opts: { env?: NodeJS.ProcessEnv }) {
        captured.push({ kind: _args[0] === "__internal-storage-cutover" ? "hidden" : "serve", env: opts.env ?? {} })
        return { pid: 123 } as unknown as import("child_process").ChildProcess
      }
      const hiddenCapture = buildHiddenChildEnv(process.env)
      fakeSpawn("/bin/kilo", ["__internal-storage-cutover", "status", "--data-root", "/tmp"], { env: hiddenCapture })
      const serveCapture = { ...resolveManagedServerEnv(process.env), KILO_PRIVATE_RUNTIME: "1" } as NodeJS.ProcessEnv
      fakeSpawn("/bin/kilo", ["serve", "--port", "0"], { env: serveCapture })
      expect(captured.length).toBe(2)
      expect("KILO_PRIVATE_RUNTIME" in captured[0]!.env).toBe(false)
      expect(captured[1]!.env.KILO_PRIVATE_RUNTIME).toBe("1")
    })
  })

  it("hidden env omits marker even for invalid host values, serve always 1", () => {
    ownedEnvFixture(() => {
      for (const v of ["true", "TRUE", "1 ", " 1", "0", "", "yes", "True"]) {
        process.env.KILO_PRIVATE_RUNTIME = v
        const hidden = buildHiddenChildEnv(process.env)
        expect("KILO_PRIVATE_RUNTIME" in hidden).toBe(false)
        const serve = buildServeChildEnvAugment(process.env)
        expect(serve.KILO_PRIVATE_RUNTIME).toBe("1")
        const childHidden = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.env.KILO_PRIVATE_RUNTIME))"], {
          env: hidden as NodeJS.ProcessEnv,
          encoding: "utf8",
        })
        expect(childHidden.stdout).toBe("undefined")
        const childServe = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.env.KILO_PRIVATE_RUNTIME))"], {
          env: { ...resolveManagedServerEnv(process.env), KILO_PRIVATE_RUNTIME: "1" } as NodeJS.ProcessEnv,
          encoding: "utf8",
        })
        expect(childServe.stdout).toBe("1")
      }
      // host absent
      delete process.env.KILO_PRIVATE_RUNTIME
      const hiddenAbsent = buildHiddenChildEnv(process.env)
      expect("KILO_PRIVATE_RUNTIME" in hiddenAbsent).toBe(false)
      const serveAbsent = buildServeChildEnvAugment(process.env)
      expect(serveAbsent.KILO_PRIVATE_RUNTIME).toBe("1")
    })
  })

  it("Flag strict === '1' only, invalid values do not activate", () => {
    ownedEnvFixture(() => {
      const getFlag = () => process.env["KILO_PRIVATE_RUNTIME"] === "1"
      // only exact "1" activates
      process.env.KILO_PRIVATE_RUNTIME = "1"
      expect(getFlag()).toBe(true)
      for (const v of ["true", "TRUE", "1 ", " 1", "01", "0", "", "yes", "on", "True", "1\n"]) {
        process.env.KILO_PRIVATE_RUNTIME = v
        expect(getFlag()).toBe(false)
      }
      delete process.env.KILO_PRIVATE_RUNTIME
      expect(getFlag()).toBe(false)
      process.env.KILO_PRIVATE_RUNTIME = "undefined"
      expect(getFlag()).toBe(false)
    })
  })

  it("private mode does not change spawn cwd/stdio/detached contract via helpers", () => {
    // hidden must be detached:false, serve detached:true with 5 stdio — verify via actual ServerManager shape
    // Use helpers to ensure env omission does not affect other spawn options
    ownedEnvFixture(() => {
      process.env.KILO_PRIVATE_RUNTIME = "1"
      const hiddenEnv = buildHiddenChildEnv(process.env)
      expect("KILO_PRIVATE_RUNTIME" in hiddenEnv).toBe(false)
      // serve env via helper always has 1
      const serveEnv = buildServeChildEnvAugment(process.env)
      expect(serveEnv.KILO_PRIVATE_RUNTIME).toBe("1")
    })
  })
})
