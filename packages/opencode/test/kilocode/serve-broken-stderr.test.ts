import { afterEach, describe, expect, test } from "bun:test"
import { spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// Regression: `kilo serve --print-logs` with a broken stderr pipe and a dead
// Extension Host parent must not spin at ~100% CPU / grow RSS unboundedly —
// it must exit within a bounded window. Reproduces the diagnosed mechanism
// exactly: the first log write against the closed pipe surfaces as an EPIPE
// uncaughtException, and the fixed fatal handlers terminate without recursing
// into another write.
//
// The CLI is spawned as an exact-owned subprocess via node:child_process so
// `child.stderr.destroy()` breaks the pipe at the OS level (verified: the
// child then receives an uncaughtException with code "EPIPE"). Every PID this
// test creates — the CLI child and the dummy parent — is killed and reaped.

const opencodeRoot = path.resolve(import.meta.dir, "../..")
const cliEntry = path.join(opencodeRoot, "src/index.ts")
const compiledBin = process.env["KILO_TEST_BIN"]

interface Spawned {
  readonly child: ChildProcess
  readonly exited: Promise<number | null>
  readonly stdoutTail: () => string
}

function cliArgs(): { cmd: string; args: string[] } {
  if (compiledBin) {
    return { cmd: compiledBin, args: ["serve", "--print-logs", "--port", "0"] }
  }
  return { cmd: "bun", args: ["run", "--conditions=browser", cliEntry, "serve", "--print-logs", "--port", "0"] }
}

function isolatedEnv(home: string, parent: number): Record<string, string> {
  return {
    KILO_PARENT_PID: String(parent),
    KILO_TEST_HOME: home,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local/share"),
    XDG_STATE_HOME: path.join(home, ".local/state"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    KILO_PURE: "1",
    KILO_DISABLE_AUTOUPDATE: "1",
    KILO_DISABLE_AUTOCOMPACT: "1",
    KILO_DISABLE_MODELS_FETCH: "1",
    KILO_SERVER_PASSWORD: "testpass",
  }
}

function spawnCli(home: string, parent: number): Spawned {
  const { cmd, args } = cliArgs()
  const child = spawn(cmd, args, {
    cwd: home,
    env: { ...process.env, ...isolatedEnv(home, parent) },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let stdout = ""
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString()
  })
  child.stderr?.resume()
  const exited = new Promise<number | null>((resolve) => {
    child.on("exit", resolve)
    child.on("error", () => resolve(null))
  })
  return {
    child,
    exited,
    stdoutTail: () => stdout.slice(-2000),
  }
}

// Sample RSS (KB) and %CPU of a live PID via `ps`; ["?"] when gone.
function sample(pid: number): string[] {
  try {
    const out = Bun.spawnSync(["ps", "-o", "rss=,pcpu=", "-p", String(pid)], { stdout: "pipe" })
    return out.stdout.toString().trim().split(/\s+/)
  } catch {
    return ["?"]
  }
}

async function waitForListening(spawned: Spawned, ms = 25000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < ms) {
    if (spawned.stdoutTail().includes("listening on")) return
    const code = await Promise.race([spawned.exited, Bun.sleep(100).then(() => null)])
    if (code !== null) {
      throw new Error(`serve exited (code ${code}) before listening\nstdout: ${spawned.stdoutTail()}`)
    }
  }
  throw new Error(`serve did not become ready within ${ms}ms\nstdout: ${spawned.stdoutTail()}`)
}

async function reap(child: ChildProcess): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL")
  }
  await new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve()
      return
    }
    const done = () => resolve()
    child.once("exit", done)
    child.once("error", done)
  })
}

async function reapBun(child: Bun.Subprocess): Promise<void> {
  try {
    child.kill()
  } catch {
    // already dead
  }
  try {
    await Promise.race([child.exited, Bun.sleep(2000)])
  } catch {
    // exited promise already settled
  }
}

async function expectBoundedExit(
  spawned: Spawned,
  windowMs: number,
  label: string,
  options: { sampleRss?: boolean } = {},
): Promise<{ exitCode: number | null; elapsedMs: number; maxRssKb: number }> {
  const start = Date.now()
  let maxRssKb = 0
  let exitCode: number | null = null
  // Sample CPU/RSS while alive to catch unbounded growth even before the
  // window elapses; every 250ms is enough to observe the old ~100-200MB/s ramp.
  while (Date.now() - start < windowMs) {
    exitCode = await Promise.race([
      spawned.exited,
      Bun.sleep(250).then(() => null),
    ])
    if (exitCode !== null) break
    if (options.sampleRss) {
      const s = sample(spawned.child.pid ?? -1)
      const rss = Number(s[0])
      if (Number.isFinite(rss) && rss > maxRssKb) maxRssKb = rss
    }
  }
  const elapsedMs = Date.now() - start
  expect(exitCode, `${label}: must exit within ${windowMs}ms (got ${elapsedMs}ms) — process was still running`).not.toBeNull()
  if (options.sampleRss) {
    // The broken build ramped past 1.4GB within ~8s; a healthy bounded process
    // stays far below 1GB. Ceiling is a sanity bound, not a latency SLA.
    expect(maxRssKb, `${label}: RSS grew to ${maxRssKb}KB — unbounded growth`).toBeLessThan(1_000_000)
  }
  return { exitCode, elapsedMs, maxRssKb }
}

describe("kilo serve --print-logs broken-stderr EPIPE regression", () => {
  let dir: string | undefined
  const spawned: Spawned[] = []
  const parents: Bun.Subprocess[] = []

  afterEach(async () => {
    for (const s of spawned) await reap(s.child)
    spawned.length = 0
    for (const p of parents) await reapBun(p)
    parents.length = 0
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true })
      dir = undefined
    }
  })

  test("dead parent + broken stderr from spawn: exits bounded, no spin, no unbounded RSS", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-epipe-a-"))
    const dummy = Bun.spawn([process.execPath, "-e", "await Bun.sleep(30000)"], { stdout: "ignore", stderr: "ignore" })
    parents.push(dummy)
    const pid = dummy.pid
    dummy.kill("SIGKILL")
    await dummy.exited

    const s = spawnCli(dir, pid)
    spawned.push(s)
    // Break stderr immediately — every log write now EPIPEs.
    s.child.stderr?.destroy()

    const { exitCode, elapsedMs, maxRssKb } = await expectBoundedExit(s, 15000, "variant A", { sampleRss: true })
    // The broken stderr cannot surface a boot banner: the first log write in
    // the CLI logging middleware EPIPEs before the serve handler runs, so the
    // process never reaches "listening on". The discriminator is the exit
    // signature instead — the EPIPE fatal path terminates with code 1 (the
    // fatal-handler contract), never "any numeric code". An arbitrary early
    // exit (e.g. exit 0 from a clean early return, or a non-EPIPE code) must
    // fail. Measured: source and compiled both exit 1 in ~3s with no spin and
    // RSS far under the ceiling (broken baseline never exits and ramps past
    // 1.4GB).
    expect(exitCode).toBe(1)
    expect(elapsedMs).toBeLessThan(15000)
    expect(maxRssKb).toBeLessThan(1_000_000)
  }, { timeout: 120_000 })

  test("healthy boot, then parent death + broken stderr: orphan shutdown cannot be starved", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-epipe-b-"))
    const dummy = Bun.spawn([process.execPath, "-e", "await Bun.sleep(30000)"], { stdout: "ignore", stderr: "ignore" })
    parents.push(dummy)

    const s = spawnCli(dir, dummy.pid)
    spawned.push(s)
    await waitForListening(s)

    // Parent dies, then the pipe breaks — the watchdog tick and the EPIPE
    // handler race; either path must terminate within the bound.
    dummy.kill("SIGKILL")
    await dummy.exited
    s.child.stderr?.destroy()

    const { exitCode, elapsedMs, maxRssKb } = await expectBoundedExit(s, 15000, "variant B", { sampleRss: true })
    expect(exitCode).toBeGreaterThanOrEqual(0)
    expect(elapsedMs).toBeLessThan(15000)
    expect(maxRssKb).toBeLessThan(1_000_000)
  }, { timeout: 120_000 })

  test("healthy boot, parent death alone (healthy stderr): graceful shutdown still exits", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-epipe-c-"))
    const dummy = Bun.spawn([process.execPath, "-e", "await Bun.sleep(30000)"], { stdout: "ignore", stderr: "ignore" })
    parents.push(dummy)

    const s = spawnCli(dir, dummy.pid)
    spawned.push(s)
    await waitForListening(s)

    dummy.kill("SIGKILL")
    await dummy.exited

    const { exitCode, elapsedMs } = await expectBoundedExit(s, 15000, "variant C (healthy stderr)")
    expect(exitCode).toBeGreaterThanOrEqual(0)
    expect(elapsedMs).toBeLessThan(15000)
  }, { timeout: 120_000 })
})
