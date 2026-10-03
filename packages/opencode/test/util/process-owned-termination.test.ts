/**
 * kilocode_change - owned termination (F-E same bound) for util/process.
 *
 * Proves: aborted wrapped Process.spawn with an env -i grandchild that is
 * SIGSTOP-stuck reaps the whole owned tree before `exited` resolves;
 * decoy survives; normal TERM is positive-PID only until the verified
 * group SIGKILL. Run-owned token/cmd, exact-PID cleanup only.
 */
import { describe, expect, test } from "bun:test"
import { execFile, spawn as nodeSpawn } from "node:child_process"
import * as crypto from "node:crypto"
import * as path from "node:path"

const REPO = path.resolve(import.meta.dirname, "..", "..", "..", "..")
const SERVE_ENTRY = path.join(REPO, "packages", "opencode", "src", "serve-entry.ts")

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function childOf(pid: number): Promise<number[]> {
  return new Promise((resolve) => {
    execFile("ps", ["-axo", "pid=,ppid="], { windowsHide: true }, (_err, out) => {
      const found: number[] = []
      for (const line of String(out ?? "").split(/\r?\n/)) {
        const m = line.match(/^\s*(\d+)\s+(\d+)\s*$/)
        if (!m) continue
        if (Number(m[2]) === pid) found.push(Number(m[1]))
      }
      resolve(found)
    })
  })
}

async function waitFor(cond: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await cond()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return await cond()
}

describe("util.process owned force escalation", () => {
  test("aborted stuck guardian reaps env -i tree before exited, decoy lives", async () => {
    if (process.platform !== "darwin" && process.platform !== "linux") return
    const token = crypto.randomBytes(32).toString("hex")
    const savedToken = process.env.KILO_RUNTIME_TOKEN
    const savedCmd = process.env.KILO_GUARDIAN_CMD
    process.env.KILO_RUNTIME_TOKEN = token
    process.env.KILO_GUARDIAN_CMD = JSON.stringify([process.execPath, SERVE_ENTRY])
    const decoy = nodeSpawn("/bin/sleep", ["60"], { detached: true, stdio: "ignore" })
    decoy.unref()
    const decoyPid = decoy.pid
    if (typeof decoyPid !== "number") throw new Error("decoy produced no pid")
    expect(alive(decoyPid)).toBe(true)
    type Kill = { target: number; signal: string | number | undefined }
    const kills: Kill[] = []
    const origKill = process.kill.bind(process)
    const patched = ((pid: number, sig?: string | number) => {
      kills.push({ target: pid, signal: sig })
      return origKill(pid, sig as NodeJS.Signals)
    }) as typeof process.kill
    process.kill = patched
    try {
      const { Process } = await import("@/util/process")
      const abort = new AbortController()
      const proc = Process.spawn(["/usr/bin/env", "-i", "PATH=/usr/bin:/bin", "/bin/sh", "-c", "sleep 60 & wait"], {
        abort: abort.signal,
        timeout: 200,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      })
      const gpid = proc.pid
      if (typeof gpid !== "number") throw new Error("guardian produced no pid")
      const ready = await waitFor(async () => (await childOf(gpid)).filter(alive).length > 0, 20000)
      if (!ready) throw new Error("guardian never admitted target")
      const inner = (await childOf(gpid)).filter(alive)
      const innerPid = inner[0]
      if (typeof innerPid !== "number") throw new Error("inner never admitted")
      const grandReady = await waitFor(async () => (await childOf(innerPid)).filter(alive).length > 0, 20000)
      if (!grandReady) throw new Error("grandchild never admitted")
      const grand = (await childOf(innerPid)).filter(alive)
      const grandPid = grand[0]
      if (typeof grandPid !== "number") throw new Error("grandchild pid missing")
      origKill(gpid, "SIGSTOP")
      abort.abort()
      const code = await proc.exited
      expect(typeof code).toBe("number")
      expect(alive(gpid)).toBe(false)
      expect(alive(innerPid)).toBe(false)
      expect(alive(grandPid)).toBe(false)
      expect(alive(decoyPid)).toBe(true)
      const terms = kills.filter((k) => k.signal === "SIGTERM")
      expect(terms.length).toBeGreaterThan(0)
      expect(terms.every((k) => k.target > 0)).toBe(true)
      expect(kills.some((k) => k.target === -gpid && k.signal === "SIGKILL")).toBe(true)
    } finally {
      process.kill = origKill
      if (savedToken === undefined) delete process.env.KILO_RUNTIME_TOKEN
      else process.env.KILO_RUNTIME_TOKEN = savedToken
      if (savedCmd === undefined) delete process.env.KILO_GUARDIAN_CMD
      else process.env.KILO_GUARDIAN_CMD = savedCmd
      try {
        origKill(decoyPid, "SIGKILL")
      } catch (err) {
        if (err instanceof Error && err.message.includes("ESRCH")) return
      }
    }
  }, 60000)
})
