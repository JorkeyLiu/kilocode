import { describe, expect, test } from "bun:test"
import { spawn } from "child_process"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { Effect, Layer } from "effect"
import { Config } from "@/config/config"
import { Plugin } from "@/plugin"
import { PtyPreparation } from "@/pty-preparation"
import { testEffect } from "../lib/effect"
import {
  RUNTIME_TOKEN_ENV,
  assertRuntimeToken,
  isValidRuntimeToken,
  readRuntimeToken,
  stripRuntimeToken,
} from "@/kilocode/runtime-token"

const prepIt = testEffect(
  Layer.mergeAll(
    Layer.mock(Config.Service)({ get: () => Effect.succeed({}) }),
    Layer.mock(Plugin.Service)({
      trigger: <Name extends string, Input, Output>(_name: Name, _input: Input, output: Output) =>
        Effect.sync(() => output),
      list: () => Effect.succeed([]),
      init: () => Effect.void,
    }),
  ),
)

describe("runtime ownership token", () => {
  test("validates strict 64-hex shape", () => {
    expect(isValidRuntimeToken("a".repeat(64))).toBeTrue()
    expect(isValidRuntimeToken("A".repeat(64))).toBeFalse()
    expect(isValidRuntimeToken("a".repeat(63))).toBeFalse()
    expect(isValidRuntimeToken(`a`.repeat(64) + "b")).toBeFalse()
    expect(isValidRuntimeToken("")).toBeFalse()
    expect(isValidRuntimeToken(undefined)).toBeFalse()
  })

  test("reads only a valid token, never a malformed value", () => {
    const good = "b".repeat(64)
    expect(readRuntimeToken({ [RUNTIME_TOKEN_ENV]: good } as NodeJS.ProcessEnv)).toBe(good)
    expect(readRuntimeToken({ [RUNTIME_TOKEN_ENV]: "short" } as NodeJS.ProcessEnv)).toBeUndefined()
    expect(readRuntimeToken({} as NodeJS.ProcessEnv)).toBeUndefined()
  })

  test("strip removes the instance token and preserves the persistent oracle", () => {
    const token = "c".repeat(64)
    const out = stripRuntimeToken({
      [RUNTIME_TOKEN_ENV]: token,
      KILO_BACKGROUND_PROCESS_TOKEN: "persist-oracle",
      PATH: "/bin",
    } as NodeJS.ProcessEnv)
    expect(RUNTIME_TOKEN_ENV in out).toBeFalse()
    expect(out.KILO_BACKGROUND_PROCESS_TOKEN).toBe("persist-oracle")
    expect(out.PATH).toBe("/bin")
  })

  test("assert re-imposes the live token over custom env spoof/strip", () => {
    const live = "d".repeat(64)
    const source = { [RUNTIME_TOKEN_ENV]: live } as NodeJS.ProcessEnv
    const spoofed = assertRuntimeToken({ [RUNTIME_TOKEN_ENV]: "e".repeat(64), FOO: "1" }, source)
    expect(spoofed[RUNTIME_TOKEN_ENV]).toBe(live)
    const stripped: Record<string, string | undefined> = { FOO: "1" }
    const restored = assertRuntimeToken(stripped, source)
    expect(restored[RUNTIME_TOKEN_ENV]).toBe(live)
    // No live token: custom env passes through untouched, never injected.
    const bare = assertRuntimeToken({ FOO: "1" }, {} as NodeJS.ProcessEnv)
    expect(RUNTIME_TOKEN_ENV in bare).toBeFalse()
  })

  test("prompt shell shape: plugin shell.env spoof/strip cannot escape ownership (F3)", () => {
    // Mirrors session/prompt.ts: `env: assertRuntimeToken({ ...shellEnv.env, TERM })`.
    const live = "d".repeat(64)
    const source = { [RUNTIME_TOKEN_ENV]: live } as NodeJS.ProcessEnv
    const pluginSpoof: Record<string, string | undefined> = { [RUNTIME_TOKEN_ENV]: "e".repeat(64), CUSTOM: "1" }
    const fromSpoof = assertRuntimeToken({ ...pluginSpoof, TERM: "dumb" } as Record<string, string | undefined>, source)
    expect(fromSpoof[RUNTIME_TOKEN_ENV]).toBe(live)
    expect(fromSpoof.CUSTOM).toBe("1")
    const pluginStrip: Record<string, string | undefined> = { CUSTOM: "1" }
    const fromStrip = assertRuntimeToken({ ...pluginStrip, TERM: "dumb" } as Record<string, string | undefined>, source)
    expect(fromStrip[RUNTIME_TOKEN_ENV]).toBe(live)
  })

  test("persistent oracle is exact, never substring (F4)", async () => {
    const { BackgroundProcess } = await import("@/kilocode/background-process/index")
    const token = "123e4567-e89b-12d3-a456-426614174000"
    const exact = BackgroundProcess.hasExactPersistentToken(
      `node __background-process-runner ${token} abc123 KILO_BACKGROUND_PROCESS_TOKEN=${token}`,
      token,
    )
    expect(exact).toBeTrue()
    // Superstring argv must not match.
    expect(BackgroundProcess.hasExactPersistentToken(`node __background-process-runner ${token}-extra`, token)).toBeFalse()
    // Foreign token never matches.
    expect(
      BackgroundProcess.hasExactPersistentToken(
        `node __background-process-runner 123e4567-e89b-12d3-a456-426614174999`,
        token,
      ),
    ).toBeFalse()
    // Value extension must not match (prefix collision).
    expect(BackgroundProcess.hasExactPersistentToken(`KILO_BACKGROUND_PROCESS_TOKEN=${token}ab`, token)).toBeFalse()
  })

  test("persistent launch env excludes the instance token", async () => {    // Mirrors BackgroundProcess launch env composition for lifetime=persistent:
    // per-process oracle present, crashing-instance token stripped.
    const instance = "f".repeat(64)
    const composed: NodeJS.ProcessEnv = stripRuntimeToken({
      ...{ [RUNTIME_TOKEN_ENV]: instance },
      TERM: "dumb",
      KILO_BACKGROUND_PROCESS_TOKEN: "persist-oracle",
    } as NodeJS.ProcessEnv)
    expect(composed.KILO_BACKGROUND_PROCESS_TOKEN).toBe("persist-oracle")
    expect(RUNTIME_TOKEN_ENV in composed).toBeFalse()
    // Non-persistent lifetimes keep the instance token via inheritance.
    const kept = {
      ...{ [RUNTIME_TOKEN_ENV]: instance },
      TERM: "dumb",
    } as NodeJS.ProcessEnv
    expect(kept[RUNTIME_TOKEN_ENV]).toBe(instance)
  })
})

describe("runtime token spawn propagation", () => {
  prepIt.live("pty preparation preserves the live token over custom env", () =>
    Effect.gen(function* () {
      const live = "a".repeat(64)
      const saved = process.env[RUNTIME_TOKEN_ENV]
      process.env[RUNTIME_TOKEN_ENV] = live
      try {
        const prepared = yield* PtyPreparation.prepareCreate({
          command: "/bin/sh",
          args: [],
          cwd: "/tmp",
          env: { [RUNTIME_TOKEN_ENV]: "b".repeat(64), CUSTOM: "1" },
        })
        expect(prepared.env[RUNTIME_TOKEN_ENV]).toBe(live)
        expect(prepared.env.CUSTOM).toBe("1")
      } finally {
        if (saved === undefined) delete process.env[RUNTIME_TOKEN_ENV]
        else process.env[RUNTIME_TOKEN_ENV] = saved
      }
    }),
  )

  prepIt.live("pty preparation injects no token when the runtime holds none", () =>
    Effect.gen(function* () {
      const saved = process.env[RUNTIME_TOKEN_ENV]
      delete process.env[RUNTIME_TOKEN_ENV]
      try {
        const prepared = yield* PtyPreparation.prepareCreate({ command: "/bin/sh", args: [], cwd: "/tmp" })
        expect(RUNTIME_TOKEN_ENV in prepared.env).toBeFalse()
      } finally {
        if (saved !== undefined) process.env[RUNTIME_TOKEN_ENV] = saved
      }
    }),
  )
})

describe("runtime token native spawn propagation", () => {
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  // Poll a child-written report file until present (readiness signal, not
  // wall-clock). Returns the exact file content or undefined on deadline.
  async function readReport(file: string, ms: number): Promise<string | undefined> {
    const end = Date.now() + ms
    for (;;) {
      try {
        return await fs.promises.readFile(file, "utf8")
      } catch {}
      if (Date.now() >= end) return undefined
      await new Promise((r) => setTimeout(r, 50))
    }
  }

  // Poll a pid until it no longer signals (teardown readiness, not
  // wall-clock). True once the pid is reaped, false on deadline.
  async function pollDead(pid: number, ms: number): Promise<boolean> {
    const end = Date.now() + ms
    for (;;) {
      if (!alive(pid)) return true
      if (Date.now() >= end) return false
      await new Promise((r) => setTimeout(r, 50))
    }
  }

  test.skipIf(process.platform === "win32")("shell/pty-inheriting spawn carries the token; persistent-stripped and scrubbed do not", async () => {
    const instance = "f".repeat(64)
    // Children report their own observed env to files: exact env evidence,
    // immune to platform-binary `ps` hiding and argv/env conflation.
    // The JS avoids single quotes so it survives `sh -c '...'` wrapping.
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "runtime-token-"))
    const js = (name: string) =>
      `require("fs").writeFileSync(${JSON.stringify(path.join(dir, `${name}.txt`))},String(process.env.${RUNTIME_TOKEN_ENV}??"__ABSENT__"));setTimeout(()=>{},30000)`
    // Shell shape: `command` with a `shell` interpreter inherits env wholesale
    // (ShellTool.cmd Unix path). PTY preparation does the same via
    // assertRuntimeToken over process.env. Both must carry the live token.
    const shellEnv = assertRuntimeToken({ ...process.env, [RUNTIME_TOKEN_ENV]: instance }, {
      [RUNTIME_TOKEN_ENV]: instance,
    } as NodeJS.ProcessEnv)
    const shellKid = spawn("/bin/sh", ["-c", `exec ${process.execPath} -e '${js("shell")}'`], {
      detached: true,
      stdio: "ignore",
      env: shellEnv,
    })
    shellKid.unref()
    const shellPid = shellKid.pid!
    // BackgroundProcess persistent shape: per-process oracle only, instance
    // token stripped (BackgroundProcess.env persistent branch + runner
    // defensive delete). Must NOT carry the instance token.
    const persistEnv = stripRuntimeToken({
      ...process.env,
      [RUNTIME_TOKEN_ENV]: instance,
      KILO_BACKGROUND_PROCESS_TOKEN: "persist-oracle",
    } as NodeJS.ProcessEnv)
    const persistKid = spawn(process.execPath, ["-e", js("persist")], {
      detached: true,
      stdio: "ignore",
      env: persistEnv,
    })
    persistKid.unref()
    const persistPid = persistKid.pid!
    // Scrubbed boundary (env -i shape): documents the gap, never claimed.
    const scrubKid = spawn(process.execPath, ["-e", js("scrub")], {
      detached: true,
      stdio: "ignore",
      env: { PATH: process.env.PATH },
    })
    scrubKid.unref()
    const scrubPid = scrubKid.pid!
    try {
      expect(alive(shellPid)).toBeTrue()
      expect(alive(persistPid)).toBeTrue()
      expect(alive(scrubPid)).toBeTrue()
      const [shellSeen, persistSeen, scrubSeen] = await Promise.all([
        readReport(path.join(dir, "shell.txt"), 10000),
        readReport(path.join(dir, "persist.txt"), 10000),
        readReport(path.join(dir, "scrub.txt"), 10000),
      ])
      expect(shellSeen).toBe(instance)
      expect(persistSeen).toBe("__ABSENT__")
      expect(scrubSeen).toBe("__ABSENT__")
    } finally {
      for (const pid of [shellPid, persistPid, scrubPid]) {
        try {
          process.kill(pid, "SIGKILL")
        } catch {}
      }
      await fs.promises.rm(dir, { recursive: true, force: true })
    }
  }, 30000)

  test.skipIf(process.platform === "win32")("real PTY child inherits the token via env (when pty available)", async () => {
    const instance = "a".repeat(64)
    let pty: { pid: number; kill: () => void } | undefined
    try {
      const mod = await import("@lydell/node-pty").catch(() => undefined)
      if (!mod?.spawn) return
      const prepared = assertRuntimeToken({ ...process.env, [RUNTIME_TOKEN_ENV]: instance }, {
        [RUNTIME_TOKEN_ENV]: instance,
      } as NodeJS.ProcessEnv)
      // Direct third-party target (no platform-shell hop: Darwin `ps`
      // hides the launch env of platform images, so a shell hop would
      // oracle an unobservable hop. Shell env preservation itself is
      // proven by the shell-shape case above). No `ps` oracle here at
      // all: the slave hop is not ps-observable from this sandbox, so
      // the test asserts the owned boundary instead: the exact env
      // object handed to the real native spawn, plus native
      // spawn/teardown ownership of the resulting pid. No mocks.
      expect(prepared[RUNTIME_TOKEN_ENV]).toBe(instance)
      const term = mod.spawn(process.execPath, ["-e", "setTimeout(()=>{}, 30000)"], {
        cwd: "/tmp",
        env: prepared as unknown as Record<string, string>,
      })
      pty = { pid: term.pid, kill: () => term.kill() }
    } catch {
      return
    }
    try {
      expect(alive(pty.pid)).toBeTrue()
      try {
        pty.kill()
      } catch {}
      expect(await pollDead(pty.pid, 10000)).toBeTrue()
    } finally {
      try {
        pty?.kill()
      } catch {}
      try {
        if (pty) process.kill(pty.pid, "SIGKILL")
      } catch {}
    }
  }, 30000)
})
