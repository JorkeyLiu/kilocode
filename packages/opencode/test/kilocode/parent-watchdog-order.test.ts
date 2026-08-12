import { afterEach, describe, expect, test } from "bun:test"
import { spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// The orphan log write is best-effort: with a broken stderr pipe it fails, and
// the orphan callback must run regardless — and it must run BEFORE that log
// write. Coverage runs the real module in exact-owned subprocesses:
//   1. Ordering: a broken stderr pipe + an intercepted stderr write proves the
//      callback fires before the orphan log write (marker content discriminates
//      the reorder even in source mode, where the EPIPE itself is async).
//   2. Reparenting: a child whose parent exits (ppid -> 1) is detected via the
//      reparenting branch and the callback fires.

const watchdogSrc = path.resolve(import.meta.dir, "../../src/kilocode/parent-watchdog.ts")

function spawnManaged(cmd: string, args: string[], env: Record<string, string>): { child: ChildProcess; exited: Promise<number | null> } {
  const child = spawn(cmd, args, {
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, ...env },
  })
  child.stderr?.resume()
  const exited = new Promise<number | null>((resolve) => {
    child.on("exit", resolve)
    child.on("error", () => resolve(null))
  })
  return { child, exited }
}

async function reap(child: ChildProcess): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
  await new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve()
    child.once("exit", () => resolve())
    child.once("error", () => resolve())
  })
}

async function reapPid(pid: number): Promise<void> {
  try {
    process.kill(pid, 0)
    process.kill(pid, "SIGKILL")
  } catch {
    return // already gone
  }
  for (let i = 0; i < 40; i++) {
    await Bun.sleep(50)
    try {
      process.kill(pid, 0)
    } catch {
      return
    }
  }
}

// Produce a PID that is provably dead at the moment it is returned: spawn a
// real process, SIGKILL it, reap it (we are its parent, so the exit event
// fires only after reaping), and verify `kill(pid, 0)` reports ESRCH. A magic
// constant like 99999 is not portable — some host may have a live process at
// that PID, and then the watchdog would never orphan.
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "await Bun.sleep(30000)"], { stdio: "ignore" })
  const pid = child.pid
  await reap(child)
  if (pid !== undefined) {
    try {
      process.kill(pid, 0)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ESRCH") return pid
    }
  }
  throw new Error("could not produce a provably dead parent PID")
}

describe("startParentWatchdog orphan ordering", () => {
  afterEach(() => {
    delete process.env["KILO_PARENT_PID"]
  })

  test("broken stderr pipe: orphan callback fires BEFORE the failing log write", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-watchdog-order-"))
    const marker = path.join(dir, "marker.txt")
    const childSrc = path.join(dir, "child.ts")
    fs.writeFileSync(
      childSrc,
      `
import { writeFileSync } from "node:fs"
import { startParentWatchdog } from ${JSON.stringify(watchdogSrc)}

const marker = process.env["MARKER"]!
const writes: string[] = []

// Intercept stderr writes so the orphan log write is observable even though
// the real write against the broken pipe only fails asynchronously.
const orig = process.stderr.write.bind(process.stderr)
process.stderr.write = ((chunk: any, ...rest: any[]) => {
  const s = String(chunk)
  if (s.includes("parent process gone")) writes.push("log-write")
  return orig(chunk, ...rest)
}) as typeof process.stderr.write

// Record every EPIPE that surfaces from the broken pipe.
process.on("uncaughtException", (e) => {
  const code = (e as { code?: string }).code
  writeFileSync(marker, "ue:" + (code ?? "other") + "\\n", { flag: "a" })
})

startParentWatchdog(() => {
  // Marker content discriminates the ordering: with the fix the orphan log
  // write has not happened yet (empty), without it the write came first.
  writeFileSync(marker, "orphan-called:" + writes.join(",") + "\\n", { flag: "a" })
  setTimeout(() => process.exit(0), 400)
}, 50)

// The watchdog timer is unref'd — hold the event loop open so ticks fire.
setInterval(() => {}, 1000)
`,
    )
    // A provably dead parent PID (spawn-kill-reap, verified ESRCH) — not a
    // magic constant that a busy host could accidentally have alive.
    const parent = await deadPid()
    const { child, exited } = spawnManaged(process.execPath, [childSrc], {
      KILO_PARENT_PID: String(parent),
      MARKER: marker,
    })
    // Break the child's stderr pipe from spawn: every log write fails with EPIPE.
    child.stderr?.destroy()
    try {
      const code = await Promise.race([exited, Bun.sleep(10000).then(() => null)])
      expect(code, "child did not exit within 10s").not.toBeNull()
      const contents = fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : ""
      // The callback ran, and it ran before the orphan log write (empty writes
      // at callback time). The old ordering wrote the log line first.
      expect(contents).toContain("orphan-called:")
      expect(contents).not.toContain("orphan-called:log-write")
      // The broken pipe really failed: EPIPE surfaced as an uncaughtException.
      expect(contents).toContain("ue:EPIPE")
    } finally {
      await reap(child)
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("re-parented child (parent exits, ppid -> 1) is detected and the callback fires", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-watchdog-reparent-"))
    const marker = path.join(dir, "marker.txt")
    const pidfile = path.join(dir, "child.pid")
    const childSrc = path.join(dir, "child.ts")
    const grandparentSrc = path.join(dir, "grandparent.ts")
    fs.writeFileSync(
      childSrc,
      `
import { writeFileSync } from "node:fs"
import { startParentWatchdog } from ${JSON.stringify(watchdogSrc)}

const marker = process.env["MARKER"]!
startParentWatchdog(() => {
  writeFileSync(marker, "orphan-called\\n")
  setTimeout(() => process.exit(0), 100)
}, 50)

// The watchdog timer is unref'd — hold the event loop open so ticks fire.
setInterval(() => {}, 1000)
`,
    )
    fs.writeFileSync(
      grandparentSrc,
      `
import { writeFileSync } from "node:fs"
import { spawn } from "node:child_process"

const child = spawn(process.execPath, [${JSON.stringify(childSrc)}], {
  stdio: "ignore",
  env: { ...process.env, KILO_PARENT_PID: String(process.pid), MARKER: ${JSON.stringify(marker)} },
})
child.on("error", () => {})
writeFileSync(${JSON.stringify(pidfile)}, String(child.pid ?? "") + "\\n")
// Let the child boot and capture its initial ppid, then exit — the child is
// re-parented (ppid -> 1) and the watchdog must detect it.
setTimeout(() => process.exit(0), 1500)
`,
    )
    const { child: grandparent, exited: grandparentExited } = spawnManaged(process.execPath, [grandparentSrc], {})
    let childPid = NaN
    try {
      const start = Date.now()
      while (!fs.existsSync(marker)) {
        if (Date.now() - start > 10000) break
        await Bun.sleep(50)
      }
      expect(fs.readFileSync(marker, "utf8")).toContain("orphan-called")
      childPid = fs.existsSync(pidfile) ? Number(fs.readFileSync(pidfile, "utf8").trim()) : NaN
      await grandparentExited
    } finally {
      await reap(grandparent)
      if (Number.isInteger(childPid) && childPid > 1) await reapPid(childPid)
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
