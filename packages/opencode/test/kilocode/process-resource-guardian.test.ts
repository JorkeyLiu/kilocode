/**
 * Process-resource guardian acceptance (POSIX native, Darwin host).
 *
 * Prelaunch ownership model: the private runtime launches the guardian
 * command INSTEAD of the target; the guardian admits parent liveness +
 * owns cleanup BEFORE the target can run. There is no after-spawn
 * attach and no async poll that a SIGKILL/install race can beat.
 *
 * Proves: install absent/invalid throws with no target side effect;
 * SIGKILLed runtime leaves no env -i orphan and no guardian; raw
 * non-detached Process/LSP wrapping yields the real pgid (guardian pid,
 * never invented); normal exit reaps late grandchildren before guardian
 * exit; cancel kills the tree; extra FDs proxy through; rapid
 * generation turnover attributes ownership correctly; argv decoys +
 * persistent bypass stay alive; real PTY routes and reaps. Windows
 * native job hold is a structural code claim only (stated, not
 * executed on this host; fail-closed, never claimed clean).
 */
import { describe, expect, test } from "bun:test"
import { spawn, execFile } from "child_process"
import * as crypto from "crypto"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { Effect, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { AppProcess } from "@opencode-ai/core/process"

const REPO = path.resolve(import.meta.dirname, "..", "..", "..", "..")
const SERVE_ENTRY = path.join(REPO, "packages", "opencode", "src", "serve-entry.ts")

function token(): string {
  return crypto.randomBytes(32).toString("hex")
}

function guardianCmd(): string {
  return JSON.stringify([process.execPath, SERVE_ENTRY])
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor(cond: () => boolean | Promise<boolean>, ms: number, step = 100): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await cond()) return true
    await new Promise((r) => setTimeout(r, step))
  }
  return await cond()
}

function psGuardianPids(tokenValue: string): Promise<number[]> {
  return new Promise((resolve) => {
    execFile("ps", ["-axo", "pid=,command="], { windowsHide: true }, (_err, stdout) => {
      const out: number[] = []
      for (const line of String(stdout ?? "").split(/\r?\n/)) {
        const m = line.match(/^\s*(\d+)\s+(.*)$/)
        if (!m) continue
        if (m[2]!.includes("__process-guardian") && m[2]!.includes(tokenValue)) out.push(Number(m[1]))
      }
      resolve(out)
    })
  })
}

function childOf(parentPid: number): Promise<number[]> {
  return new Promise((resolve) => {
    execFile("ps", ["-axo", "pid=,ppid="], { windowsHide: true }, (_err, stdout) => {
      const out: number[] = []
      for (const line of String(stdout ?? "").split(/\r?\n/)) {
        const m = line.match(/^\s*(\d+)\s+(\d+)\s*$/)
        if (!m) continue
        if (Number(m[2]) === parentPid) out.push(Number(m[1]))
      }
      resolve(out)
    })
  })
}

function pgidOf(pid: number): Promise<number | undefined> {
  return new Promise((resolve) => {
    execFile("ps", ["-o", "pgid=", "-p", String(pid)], { windowsHide: true }, (_err, stdout) => {
      const n = Number(String(stdout ?? "").trim())
      resolve(Number.isInteger(n) && n > 0 ? n : undefined)
    })
  })
}

function withGuardianEnv(instance: string) {
  const savedToken = process.env.KILO_RUNTIME_TOKEN
  const savedCmd = process.env.KILO_GUARDIAN_CMD
  process.env.KILO_RUNTIME_TOKEN = instance
  process.env.KILO_GUARDIAN_CMD = guardianCmd()
  return () => {
    if (savedToken === undefined) delete process.env.KILO_RUNTIME_TOKEN
    else process.env.KILO_RUNTIME_TOKEN = savedToken
    if (savedCmd === undefined) delete process.env.KILO_GUARDIAN_CMD
    else process.env.KILO_GUARDIAN_CMD = savedCmd
  }
}

describe("process-resource guardian (prelaunch wrapper)", () => {
  test("install absent/invalid throws with no target side effect", async () => {
    if (process.platform !== "darwin" && process.platform !== "linux") return
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-guardian-absent-"))
    const sentinel = path.join(dir, "touched")
    const target = ["/bin/sh", "-c", `touch ${JSON.stringify(sentinel)}`]
    const savedToken = process.env.KILO_RUNTIME_TOKEN
    const savedCmd = process.env.KILO_GUARDIAN_CMD
    try {
      const { Process } = await import("@/util/process")
      // Absent install.
      process.env.KILO_RUNTIME_TOKEN = token()
      delete process.env.KILO_GUARDIAN_CMD
      // KiloPtySelfCommand fallback may resolve a self command from the
      // test argv; force the absent path explicitly.
      process.env.KILO_GUARDIAN_CMD = "not-json"
      await expect(Process.run(target, { nothrow: false })).rejects.toThrow()
      expect(fs.existsSync(sentinel)).toBeFalse()
      // Invalid binary.
      process.env.KILO_GUARDIAN_CMD = JSON.stringify(["/nonexistent/kilo-guardian-bin"])
      await expect(Process.run(target, { nothrow: false })).rejects.toThrow()
      expect(fs.existsSync(sentinel)).toBeFalse()
    } finally {
      if (savedToken === undefined) delete process.env.KILO_RUNTIME_TOKEN
      else process.env.KILO_RUNTIME_TOKEN = savedToken
      if (savedCmd === undefined) delete process.env.KILO_GUARDIAN_CMD
      else process.env.KILO_GUARDIAN_CMD = savedCmd
      await fs.promises.rm(dir, { recursive: true, force: true })
    }
  }, 60000)

  test("SIGKILLED runtime leaves no env -i orphan and no guardian; persistent + decoys live", async () => {
    if (process.platform !== "darwin" && process.platform !== "linux") return
    const instance = token()
    const persistent = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 60000)"], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, KILO_RUNTIME_TOKEN: instance },
    })
    persistent.unref()
    const decoy = spawn(process.execPath, ["-e", `setTimeout(()=>{}, 60000) // KILO_RUNTIME_TOKEN=${instance}`], {
      detached: true,
      stdio: "ignore",
      env: { PATH: process.env.PATH },
    })
    decoy.unref()
    // Helper runtime: wraps an env -i tree (no token in its env, so an
    // env census alone would miss it) then parks. SIGKILL proves the
    // prelaunch owner reaps without any signal handling. The file lives
    // under the package so the `@/` alias resolves under bun.
    const runtimeSrc = `
      const { Process } = await import("@/util/process");
      const proc = Process.spawn(["/usr/bin/env", "-i", "PATH=/usr/bin:/bin", "/bin/sh", "-c", "exec sleep 60"], { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
      console.log("READY guardian=" + proc.pid);
      await new Promise(() => {});
    `
    const runtimeDir = await fs.promises.mkdtemp(path.join(REPO, "packages", "opencode", "test", "kilocode", ".tmp-guardian-rt-"))
    const runtimeFile = path.join(runtimeDir, "runtime.ts")
    await fs.promises.writeFile(runtimeFile, runtimeSrc, "utf8")
    const runtime = spawn(process.execPath, [runtimeFile], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, KILO_RUNTIME_TOKEN: instance, KILO_GUARDIAN_CMD: guardianCmd() },
    })
    let ready = ""
    let readyErr = ""
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("runtime never ready: " + ready + " err: " + readyErr.slice(0, 2000))), 60000)
      runtime.stdout!.on("data", (d: Buffer) => {
        ready += d.toString()
        if (ready.includes("READY")) {
          clearTimeout(timer)
          resolve()
        }
      })
      runtime.stderr!.on("data", (d: Buffer) => {
        readyErr += d.toString()
      })
      runtime.on("error", reject)
    })
    const m = ready.match(/READY guardian=(\d+)/)
    expect(m).not.toBeNull()
    const guardianPid = Number(m![1])
    expect(alive(guardianPid)).toBeTrue()
    // Real group leadership: the guardian IS the group (pgid read live,
    // never invented). The guardian boots the serve entry first, so wait
    // for the admitted target.
    expect(await pgidOf(guardianPid)).toBe(guardianPid)
    expect(await waitFor(async () => (await childOf(guardianPid)).filter(alive).length > 0, 20000)).toBeTrue()
    const inner = (await childOf(guardianPid)).filter((pid) => alive(pid))
    expect(inner.length).toBeGreaterThan(0)
    const innerPid = inner[0]!
    if (process.platform === "linux") {
      const data = await fs.promises.readFile(path.join("/proc", String(innerPid), "environ")).catch(() => undefined)
      if (data) expect(data.toString("utf8").split("\0").includes(`KILO_RUNTIME_TOKEN=${instance}`)).toBeFalse()
    }
    try {
      process.kill(runtime.pid!, "SIGKILL")
    } catch {}
    expect(await waitFor(() => !alive(innerPid), 15000)).toBeTrue()
    expect(await waitFor(() => !alive(guardianPid), 15000)).toBeTrue()
    expect(await waitFor(async () => (await psGuardianPids(instance)).length === 0, 10000)).toBeTrue()
    expect(alive(persistent.pid!)).toBeTrue()
    expect(alive(decoy.pid!)).toBeTrue()
    try {
      process.kill(persistent.pid!, "SIGKILL")
    } catch {}
    try {
      process.kill(decoy.pid!, "SIGKILL")
    } catch {}
    await fs.promises.rm(runtimeDir, { recursive: true, force: true })
  }, 90000)

  test("raw non-detached spawn wraps with the real pgid; output/exit preserved", async () => {
    if (process.platform !== "darwin" && process.platform !== "linux") return
    const restore = withGuardianEnv(token())
    try {
      const { Process } = await import("@/util/process")
      const proc = Process.spawn(["/bin/echo", "hello-guardian"], { stdout: "pipe", stderr: "pipe", stdin: "ignore" })
      const guardianPid = proc.pid!
      expect(guardianPid).toBeGreaterThan(0)
      const out = await Promise.all([proc.exited, import("node:stream/consumers").then((mod) => mod.buffer(proc.stdout!))]).then(
        ([code, stdout]) => ({ code, stdout }),
      )
      expect(out.code).toBe(0)
      expect(out.stdout.toString()).toContain("hello-guardian")
      // Exact admission-to-dispatch leadership is over (guardian exited),
      // so assert leadership on a live wrapper instead.
      const sleeper = Process.spawn(["/bin/sleep", "30"], { stdout: "ignore", stderr: "ignore", stdin: "ignore" })
      try {
        expect(await pgidOf(sleeper.pid!)).toBe(sleeper.pid)
      } finally {
        try {
          sleeper.kill("SIGKILL")
        } catch {}
        await sleeper.exited.catch(() => undefined)
      }
      const failing = await Process.run(["/bin/sh", "-c", "exit 3"], { nothrow: true })
      expect(failing.code).toBe(3)
    } finally {
      restore()
    }
  }, 60000)

  test("normal exit reaps a late grandchild before guardian exit", async () => {
    if (process.platform !== "darwin" && process.platform !== "linux") return
    const instance = token()
    const restore = withGuardianEnv(instance)
    try {
      const { Process } = await import("@/util/process")
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-guardian-grand-"))
      const pidFile = path.join(dir, "grandchild.pid")
      const out = await Process.run(["/bin/sh", "-c", `sleep 60 & echo $! > ${JSON.stringify(pidFile)}; exit 0`], { nothrow: true })
      expect(out.code).toBe(0)
      const grandPid = Number((await fs.promises.readFile(pidFile, "utf8")).trim())
      expect(grandPid).toBeGreaterThan(0)
      expect(alive(grandPid)).toBeFalse()
      expect(await waitFor(async () => (await psGuardianPids(instance)).length === 0, 10000)).toBeTrue()
      await fs.promises.rm(dir, { recursive: true, force: true })
    } finally {
      restore()
    }
  }, 60000)

  test("cancelled command dies and releases its guardian", async () => {
    if (process.platform !== "darwin" && process.platform !== "linux") return
    const instance = token()
    const restore = withGuardianEnv(instance)
    try {
      const { Process } = await import("@/util/process")
      const ctrl = new AbortController()
      const pending = Process.run(["/bin/sleep", "60"], { abort: ctrl.signal, timeout: 2000, nothrow: true })
      await new Promise((r) => setTimeout(r, 800))
      ctrl.abort()
      const out = await pending
      expect(out.code).not.toBe(0)
      expect(await waitFor(async () => (await psGuardianPids(instance)).length === 0, 10000)).toBeTrue()
    } finally {
      restore()
    }
  }, 60000)

  test("Effect spawner proxies exit/output plus an extra FD", async () => {
    if (process.platform !== "darwin" && process.platform !== "linux") return
    const restore = withGuardianEnv(token())
    try {
      const program = Effect.gen(function* () {
        const svc = yield* AppProcess.Service
        return yield* svc.run(ChildProcess.make("/bin/echo", ["effect-guardian-ok"]))
      }).pipe(Effect.provide(AppProcess.defaultLayer))
      const result = await Effect.runPromise(program as Effect.Effect<AppProcess.RunResult>)
      expect(result.exitCode).toBe(0)
      expect(result.stdout.toString()).toContain("effect-guardian-ok")

      // Extra FD: fd3 output streams through the wrapper to the owner.
      const { CrossSpawnSpawner } = await import("@opencode-ai/core/cross-spawn-spawner")
      const { ChildProcessSpawner } = await import("effect/unstable/process/ChildProcessSpawner")
      const fdProgram = Effect.scoped(
        Effect.gen(function* () {
          const spawner = yield* ChildProcessSpawner
          const handle = yield* spawner.spawn(
            ChildProcess.make("/bin/sh", ["-c", "echo extra-fd-ok >&3"], {
              stdin: "ignore",
              additionalFds: { fd3: { type: "output" } },
            }),
          )
          const text = yield* Stream.runCollect(Stream.decodeText(handle.getOutputFd(3))).pipe(
            Effect.map((chunks) => Array.from(chunks).join("")),
          )
          const code = yield* handle.exitCode
          return { text, code }
        }),
      ).pipe(Effect.provide(CrossSpawnSpawner.defaultLayer))
      const fdResult = await Effect.runPromise(fdProgram)
      expect(Number(fdResult.code)).toBe(0)
      expect(fdResult.text).toContain("extra-fd-ok")
    } finally {
      restore()
    }
  }, 90000)

  test("rapid generation turnover attributes ownership correctly", async () => {
    if (process.platform !== "darwin" && process.platform !== "linux") return
    const instance = token()
    const restore = withGuardianEnv(instance)
    try {
      const { Process } = await import("@/util/process")
      const first = Process.spawn(["/bin/sleep", "60"], { stdout: "ignore", stderr: "ignore", stdin: "ignore" })
      const second = Process.spawn(["/bin/sleep", "60"], { stdout: "ignore", stderr: "ignore", stdin: "ignore" })
      expect(await waitFor(async () => (await childOf(first.pid!)).filter(alive).length > 0, 20000)).toBeTrue()
      expect(await waitFor(async () => (await childOf(second.pid!)).filter(alive).length > 0, 20000)).toBeTrue()
      const firstInner = (await childOf(first.pid!)).filter(alive)
      const secondInner = (await childOf(second.pid!)).filter(alive)
      expect(firstInner.length).toBeGreaterThan(0)
      expect(secondInner.length).toBeGreaterThan(0)
      // Reconnect drops the old generation: only its tree dies.
      try {
        process.kill(first.pid!, "SIGTERM")
      } catch {}
      await first.exited.catch(() => undefined)
      expect(await waitFor(() => !alive(firstInner[0]!), 10000)).toBeTrue()
      expect(alive(second.pid!)).toBeTrue()
      expect(alive(secondInner[0]!)).toBeTrue()
      try {
        process.kill(second.pid!, "SIGTERM")
      } catch {}
      await second.exited.catch(() => undefined)
      expect(await waitFor(() => !alive(secondInner[0]!), 10000)).toBeTrue()
      expect(await waitFor(async () => (await psGuardianPids(instance)).length === 0, 10000)).toBeTrue()
    } finally {
      restore()
    }
  }, 90000)

  test("real PTY routes through the wrapper and reaps on abort", async () => {
    if (process.platform !== "darwin" && process.platform !== "linux") return
    const instance = token()
    const restore = withGuardianEnv(instance)
    let term: { pid: number; kill: () => void } | undefined
    try {
      // Same backend core Pty.create uses under bun (bun-pty, not
      // node-pty: node-pty's spawn-helper cannot run the bun guardian on
      // this host). Mirrors guardianPtyCommand routing exactly (including
      // the mandatory --parent-birth identity).
      const mod = await import("bun-pty").catch(() => undefined)
      if (!mod?.spawn) return
      const { birthOf } = await import("@/kilocode/process-resource/guardian")
      const birth = birthOf(process.pid)
      expect(birth).toBeTruthy()
      const raw: string = process.env.KILO_GUARDIAN_CMD!
      const parsed: string[] = JSON.parse(raw)
      const spec = Buffer.from(JSON.stringify({ cmd: "/bin/sh", args: ["-c", "echo pty-guardian-ok; exec sleep 60"], shell: false, extraFds: [] }), "utf8")
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "")
      const oracle = `KILO_RUNTIME_TOKEN=${instance}`
      const seen: string[] = []
      const t = mod.spawn(parsed[0]!, [...parsed.slice(1), "__process-guardian", "--cmd-b64", spec, "--parent-pid", String(process.pid), "--parent-birth", birth!, "--token", oracle], {
        name: "xterm-256color",
        cwd: os.tmpdir(),
        env: { ...process.env } as Record<string, string>,
      })
      t.onData((d: string) => seen.push(d))
      term = {
        pid: t.pid,
        kill: () => {
          try {
            t.kill()
          } catch {}
        },
      }
      expect(alive(t.pid)).toBeTrue()
      // The guardian boots the serve entry before admitting the target.
      const inner = await waitFor(async () => (await childOf(t.pid)).filter(alive).length > 0, 30000)
      expect(inner).toBeTrue()
      expect(await waitFor(() => seen.join("").includes("pty-guardian-ok"), 15000)).toBeTrue()
      try {
        term.kill()
      } catch {}
      try {
        process.kill(t.pid, "SIGKILL")
      } catch {}
      expect(await waitFor(() => !alive(t.pid), 10000)).toBeTrue()
      term = undefined
      expect(await waitFor(async () => (await psGuardianPids(instance)).length === 0, 10000)).toBeTrue()
    } finally {
      try {
        term?.kill()
      } catch {}
      restore()
    }
  }, 90000)

  test("Windows native job path qualification (unexecuted on Darwin)", async () => {
    // The Windows guardian creates the KILL_ON_CLOSE job before dispatch
    // and assigns its own freshly spawned handle with an identity check;
    // failure aborts with no coverage. Nothing here runs on this host:
    // assert fail-closed shape instead of claiming proof.
    if (process.platform === "win32") return
    const { WindowsJob } = await import("@/kilocode/background-process/windows-job")
    expect(WindowsJob.create()).toBeUndefined()
  })
})

describe("process-resource guardian audit corrections (F-A..F-F)", () => {
  const MCP_SERVER_SRC = `
    const fs = require("fs");
    const { spawn } = require("child_process");
    const pidFile = process.argv[2];
    const captureFile = process.argv[3];
    // env -i grandchild: invisible to a token census, owned only via the group.
    const grand = spawn("/bin/sleep", ["60"], { detached: false, stdio: "ignore" });
    fs.writeFileSync(pidFile, String(grand.pid));
    grand.unref();
    process.stderr.write("SERVER-READY\\n");
    let buf = "";
    process.stdin.on("data", (d) => {
      buf += d.toString();
      let idx;
      while ((idx = buf.indexOf("\\n")) >= 0) {
        const line = buf.slice(0, idx).replace(/\\r$/, "");
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg && msg.method === "initialize" && msg.id !== undefined) {
            const out = JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                protocolVersion: (msg.params && msg.params.protocolVersion) || "2025-06-18",
                capabilities: {},
                serverInfo: { name: "audit-fixture", version: "1" },
              },
            }) + "\\n";
            process.stdout.write(out);
            continue;
          }
        } catch {}
        fs.appendFileSync(captureFile, line + "\\n");
      }
    });
    setInterval(() => {}, 1000);
  `

  async function writeMcpServer(): Promise<{ dir: string; serverFile: string; pidFile: string; captureFile: string; rm: () => Promise<void> }> {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "kilo-mcp-guardian-"))
    const serverFile = path.join(dir, "server.cjs")
    const pidFile = path.join(dir, "grandchild.pid")
    const captureFile = path.join(dir, "captured.txt")
    await fs.promises.writeFile(serverFile, MCP_SERVER_SRC, "utf8")
    return { dir, serverFile, pidFile, captureFile, rm: () => fs.promises.rm(dir, { recursive: true, force: true }) }
  }

  function waitStderr(text: () => string, ms: number): Promise<boolean> {
    return waitFor(() => text().includes("SERVER-READY"), ms)
  }

  test("F-A MCP detached transport: group owned, stdio protocol, normal cleanup", async () => {
    if (process.platform !== "darwin" && process.platform !== "linux") return
    const instance = token()
    const restore = withGuardianEnv(instance)
    const fix = await writeMcpServer()
    try {
      const { GuardianStdioTransport } = await import("@/mcp/guardian-transport")
      const { guardianCommandFor } = await import("@/kilocode/process-resource/supervise")
      const wrapped = guardianCommandFor({ cmd: process.execPath, args: [fix.serverFile, fix.pidFile, fix.captureFile] })
      // Birth identity is mandatory on every wrapper path.
      expect(wrapped.args.includes("--parent-birth")).toBeTrue()
      const transport = new GuardianStdioTransport({
        stderr: "pipe",
        command: wrapped.cmd,
        args: wrapped.args,
        cwd: os.tmpdir(),
        env: { ...process.env } as Record<string, string>,
      })
      let errText = ""
      ;(transport.stderr as unknown as NodeJS.EventEmitter)?.on("data", (d: Buffer) => {
        errText += d.toString()
      })
      const { Client } = await import("@modelcontextprotocol/sdk/client/index.js")
      const client = new Client({ name: "audit", version: "1" })
      await client.connect(transport)
      expect(await waitStderr(() => errText, 30000)).toBeTrue()
      const guardianPid = transport.pid!
      expect(guardianPid).toBeGreaterThan(0)
      // True owned group BEFORE the server executed: pgid is the guardian.
      expect(await pgidOf(guardianPid)).toBe(guardianPid)
      expect(await waitFor(async () => (await childOf(guardianPid)).filter(alive).length > 0, 20000)).toBeTrue()
      const grandPid = Number((await fs.promises.readFile(fix.pidFile, "utf8")).trim())
      expect(grandPid).toBeGreaterThan(0)
      expect(alive(grandPid)).toBeTrue()
      // Normal close reaps the env -i grandchild before completion.
      await client.close()
      expect(await waitFor(() => !alive(grandPid), 15000)).toBeTrue()
      expect(await waitFor(() => !alive(guardianPid), 15000)).toBeTrue()
      expect(await waitFor(async () => (await psGuardianPids(instance)).length === 0, 10000)).toBeTrue()
    } finally {
      restore()
      await fix.rm()
    }
  }, 90000)

  test("F-A MCP parent SIGKILL reaps server + env -i grandchild", async () => {
    if (process.platform !== "darwin" && process.platform !== "linux") return
    const instance = token()
    const fix = await writeMcpServer()
    const helperSrc = `
      const { GuardianStdioTransport } = await import("@/mcp/guardian-transport");
      const { guardianCommandFor } = await import("@/kilocode/process-resource/supervise");
      const [serverFile, pidFile, captureFile] = process.argv.slice(2);
      const wrapped = guardianCommandFor({ cmd: process.execPath, args: [serverFile, pidFile, captureFile] });
      const t = new GuardianStdioTransport({ stderr: "pipe", command: wrapped.cmd, args: wrapped.args, cwd: ${JSON.stringify(os.tmpdir())}, env: { ...process.env } });
      let err = "";
      (t.stderr as unknown as { on: (ev: string, fn: (d: Buffer) => void) => void }).on("data", (d) => { err += d.toString(); });
      await t.start();
      console.log("READY guardian=" + t.pid);
      await new Promise(() => {});
    `
    const helperDir = await fs.promises.mkdtemp(path.join(REPO, "packages", "opencode", "test", "kilocode", ".tmp-mcp-rt-"))
    const helperFile = path.join(helperDir, "helper.ts")
    await fs.promises.writeFile(helperFile, helperSrc, "utf8")
    const helper = spawn(process.execPath, [helperFile, fix.serverFile, fix.pidFile, fix.captureFile], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, KILO_RUNTIME_TOKEN: instance, KILO_GUARDIAN_CMD: guardianCmd() },
    })
    let ready = ""
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("mcp helper never ready: " + ready)), 60000)
        helper.stdout!.on("data", (d: Buffer) => {
          ready += d.toString()
          if (ready.includes("READY")) {
            clearTimeout(timer)
            resolve()
          }
        })
        helper.on("error", reject)
      })
      const m = ready.match(/READY guardian=(\d+)/)
      expect(m).not.toBeNull()
      const guardianPid = Number(m![1])
      expect(await pgidOf(guardianPid)).toBe(guardianPid)
      expect(await waitFor(async () => (await childOf(guardianPid)).filter(alive).length > 0, 20000)).toBeTrue()
      const inner = (await childOf(guardianPid)).filter(alive)
      expect(inner.length).toBeGreaterThan(0)
      const grandPid = Number((await fs.promises.readFile(fix.pidFile, "utf8")).trim())
      expect(alive(grandPid)).toBeTrue()
      try {
        process.kill(helper.pid!, "SIGKILL")
      } catch {}
      expect(await waitFor(() => !alive(inner[0]!), 15000)).toBeTrue()
      expect(await waitFor(() => !alive(grandPid), 15000)).toBeTrue()
      expect(await waitFor(() => !alive(guardianPid), 15000)).toBeTrue()
      expect(await waitFor(async () => (await psGuardianPids(instance)).length === 0, 10000)).toBeTrue()
    } finally {
      try {
        process.kill(helper.pid!, "SIGKILL")
      } catch {}
      await fix.rm()
      await fs.promises.rm(helperDir, { recursive: true, force: true })
    }
  }, 90000)

  test("F-A guardian refuses non-leader launch without executing target", async () => {
    if (process.platform !== "darwin" && process.platform !== "linux") return
    const restore = withGuardianEnv(token())
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-guardian-leader-"))
    try {
      const sentinel = path.join(dir, "touched")
      const { guardianCommandFor } = await import("@/kilocode/process-resource/supervise")
      const wrapped = guardianCommandFor({ cmd: "/bin/sh", args: ["-c", `touch ${JSON.stringify(sentinel)}`] })
      // Accidental non-detached launch (external cross-spawn without
      // detached): the leadership gate must refuse before exec.
      const proc = spawn(wrapped.cmd, wrapped.args, { detached: false, stdio: "ignore", env: { ...process.env } })
      const code: number = await new Promise((resolve) => proc.on("exit", (c) => resolve(c ?? -1)))
      expect(code).toBe(2)
      expect(fs.existsSync(sentinel)).toBeFalse()
    } finally {
      restore()
      await fs.promises.rm(dir, { recursive: true, force: true })
    }
  }, 60000)

  test("F-C guardian refuses parent birth mismatch without executing target", async () => {
    if (process.platform !== "darwin" && process.platform !== "linux") return
    const restore = withGuardianEnv(token())
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-guardian-birth-"))
    try {
      const sentinel = path.join(dir, "touched")
      const { guardianCommandFor } = await import("@/kilocode/process-resource/supervise")
      const wrapped = guardianCommandFor({ cmd: "/bin/sh", args: ["-c", `touch ${JSON.stringify(sentinel)}`] })
      const at = wrapped.args.indexOf("--parent-birth")
      expect(at).toBeGreaterThan(-1)
      const forged = [...wrapped.args]
      forged[at + 1] = "forged-birth"
      const proc = spawn(wrapped.cmd, forged, { detached: true, stdio: "ignore", env: { ...process.env } })
      proc.unref()
      const code: number = await new Promise((resolve) => proc.on("exit", (c) => resolve(c ?? -1)))
      expect(code).toBe(2)
      expect(fs.existsSync(sentinel)).toBeFalse()
    } finally {
      restore()
      await fs.promises.rm(dir, { recursive: true, force: true })
    }
  }, 60000)

  test("F-D target SIGTERM/SIGINT observed as signal, not success", async () => {
    if (process.platform !== "darwin" && process.platform !== "linux") return
    const restore = withGuardianEnv(token())
    try {
      const { Process } = await import("@/util/process")
      for (const sig of ["TERM", "INT"] as const) {
        const proc = Process.spawn(["/bin/sh", "-c", `kill -${sig} $$`], { stdout: "ignore", stderr: "ignore", stdin: "ignore" })
        await proc.exited
        expect(proc.signalCode).toBe(`SIG${sig}`)
      }
    } finally {
      restore()
    }
  }, 60000)

  test("F-B cross-spawn missing/corrupt CMD fails closed with no side effect", async () => {
    if (process.platform !== "darwin" && process.platform !== "linux") return
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-guardian-cmdb-"))
    try {
      const sentinel = path.join(dir, "touched")
      const { CrossSpawnSpawner } = await import("@opencode-ai/core/cross-spawn-spawner")
      const { ChildProcessSpawner } = await import("effect/unstable/process/ChildProcessSpawner")
      const { ChildProcess } = await import("effect/unstable/process")
      const run = async (cmd: string | undefined) => {
        const savedToken = process.env.KILO_RUNTIME_TOKEN
        const savedCmd = process.env.KILO_GUARDIAN_CMD
        process.env.KILO_RUNTIME_TOKEN = token()
        if (cmd === undefined) delete process.env.KILO_GUARDIAN_CMD
        else process.env.KILO_GUARDIAN_CMD = cmd
        try {
          const program = Effect.scoped(
            Effect.gen(function* () {
              const spawner = yield* ChildProcessSpawner
              const handle = yield* spawner.spawn(
                ChildProcess.make("/bin/sh", ["-c", `touch ${JSON.stringify(sentinel)}`], { stdin: "ignore" }),
              )
              yield* handle.exitCode
            }),
          ).pipe(Effect.provide(CrossSpawnSpawner.defaultLayer))
          await expect(Effect.runPromise(program)).rejects.toThrow("guardian")
        } finally {
          if (savedToken === undefined) delete process.env.KILO_RUNTIME_TOKEN
          else process.env.KILO_RUNTIME_TOKEN = savedToken
          if (savedCmd === undefined) delete process.env.KILO_GUARDIAN_CMD
          else process.env.KILO_GUARDIAN_CMD = savedCmd
        }
      }
      await run(undefined)
      expect(fs.existsSync(sentinel)).toBeFalse()
      await run("not-json")
      expect(fs.existsSync(sentinel)).toBeFalse()
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true })
    }
  }, 60000)

  test("F-E wrapped cancel signals guardian PID only; unwrapped group kill preserved", async () => {
    if (process.platform !== "darwin" && process.platform !== "linux") return
    const { CrossSpawnSpawner } = await import("@opencode-ai/core/cross-spawn-spawner")
    const { ChildProcessSpawner } = await import("effect/unstable/process/ChildProcessSpawner")
    const { ChildProcess } = await import("effect/unstable/process")
    const origKill = process.kill.bind(process)
    const kills: Array<{ target: number; signal: string | number | undefined }> = []
    ;(process.kill as unknown as typeof process.kill) = ((pid: number, signal?: string | number) => {
      kills.push({ target: pid, signal: signal as string | undefined })
      return origKill(pid, signal as NodeJS.Signals)
    }) as typeof process.kill
    try {
      // Wrapped: exact guardian PID only, descendants dead on completion.
      const restore = withGuardianEnv(token())
      try {
        kills.length = 0
        const program = Effect.scoped(
          Effect.gen(function* () {
            const spawner = yield* ChildProcessSpawner
            const handle = yield* spawner.spawn(ChildProcess.make("/bin/sh", ["-c", "sleep 60 & wait"], { stdin: "ignore" }))
            const gpid = Number(handle.pid)
            yield* Effect.promise(() => waitFor(async () => (await childOf(gpid)).filter(alive).length > 0, 20000)).pipe(
              Effect.flatMap((ready) => (ready ? Effect.void : Effect.fail(new Error("grandchild never admitted")))),
            )
            const inner = yield* Effect.promise(() => childOf(gpid).then((kids) => kids.filter(alive)))
            yield* handle.kill()
            // Bounded cleanup finished on return: the tree is dead.
            yield* Effect.promise(() => waitFor(() => !alive(inner[0]!), 15000)).pipe(
              Effect.flatMap((dead) => (dead ? Effect.void : Effect.fail(new Error("descendant survived cancel")))),
            )
            return gpid
          }),
        ).pipe(Effect.provide(CrossSpawnSpawner.defaultLayer))
        const gpid = await Effect.runPromise(program)
        const signals = kills.filter((k) => k.signal === "SIGTERM" || k.signal === "SIGKILL")
        expect(signals.length).toBeGreaterThan(0)
        expect(signals.every((k) => k.target > 0)).toBeTrue()
        expect(signals.some((k) => k.target === gpid)).toBeTrue()
      } finally {
        restore()
      }
      // Unwrapped: existing negative-pid group kill unchanged.
      {
        const savedToken = process.env.KILO_RUNTIME_TOKEN
        const savedCmd = process.env.KILO_GUARDIAN_CMD
        delete process.env.KILO_RUNTIME_TOKEN
        delete process.env.KILO_GUARDIAN_CMD
        try {
          kills.length = 0
          const program = Effect.scoped(
            Effect.gen(function* () {
              const spawner = yield* ChildProcessSpawner
              const handle = yield* spawner.spawn(ChildProcess.make("/bin/sleep", ["60"], { stdin: "ignore" }))
              const gpid = Number(handle.pid)
              yield* handle.kill()
              return gpid
            }),
          ).pipe(Effect.provide(CrossSpawnSpawner.defaultLayer))
          const gpid = await Effect.runPromise(program)
          expect(kills.some((k) => k.target === -gpid)).toBeTrue()
        } finally {
          if (savedToken === undefined) delete process.env.KILO_RUNTIME_TOKEN
          else process.env.KILO_RUNTIME_TOKEN = savedToken
          if (savedCmd === undefined) delete process.env.KILO_GUARDIAN_CMD
          else process.env.KILO_GUARDIAN_CMD = savedCmd
        }
      }
    } finally {
      process.kill = origKill
    }
  }, 90000)

  test("F-F windows unknown identity never assigns (pure, no native proof)", async () => {
    const { sameBirth, windowsAssignDecision, birthOf } = await import("@/kilocode/process-resource/guardian")
    // Unknown identity (unobtainable birth) must abort, never assign a
    // guessed PID and never signal a foreign PID by number.
    expect(windowsAssignDecision(undefined, "anything")).toBe("abort-unknown")
    expect(windowsAssignDecision("a", undefined)).toBe("abort-unknown")
    expect(windowsAssignDecision(undefined, undefined)).toBe("abort-unknown")
    expect(windowsAssignDecision("a", "b")).toBe("abort-changed")
    // Same-birth verification uses the real local birth when obtainable.
    const own = birthOf(process.pid)
    if (own !== undefined) {
      expect(windowsAssignDecision(own, birthOf(process.pid))).toBe("assign")
      expect(sameBirth(process.pid, "definitely-wrong-birth")).toBeFalse()
    }
    // Windows execution itself is unexecuted on this Darwin host by
    // qualification (structural shape only, asserted above).
  })
})
