import * as fs from "node:fs"
import * as path from "node:path"
import { spawnSync } from "node:child_process"

// kilocode_change - shared parent start-identity for prelaunch guardian
// wrappers. Byte-identical semantics to the guardian's own birthOf (linux
// /proc starttime, darwin/freebsd ps lstart, win32 CIM CreationDate) so
// owner-published --parent-birth matches the guardian's verification.
// Core never imports opencode; both cross-spawn and pty wrappers use this.
// F-E: owned-group verification (pgid === pid + same birth + alive) so a
// forced SIGKILL may tear down the whole owned tree atomically without
// ever guessing a shared/dead group.
export function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    globalThis.process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function pgidOf(pid: number): number | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined
  if (globalThis.process.platform === "win32") return undefined
  if (globalThis.process.platform === "linux") {
    try {
      const text = fs.readFileSync(path.join("/proc", String(pid), "stat"), "utf8")
      const end = text.lastIndexOf(")")
      if (end < 0) return undefined
      const fields = text
        .slice(end + 2)
        .trim()
        .split(/\s+/)
      const pg = Number(fields[2])
      return Number.isInteger(pg) && pg > 0 ? pg : undefined
    } catch {
      return undefined
    }
  }
  try {
    const out = spawnSync("ps", ["-o", "pgid=", "-p", String(pid)], { windowsHide: true, encoding: "utf8" })
    const text = typeof out.stdout === "string" ? out.stdout.trim() : ""
    const n = Number(text)
    return Number.isInteger(n) && n > 0 ? n : undefined
  } catch {
    return undefined
  }
}

export function groupMembers(pgid: number): number[] {
  if (globalThis.process.platform === "win32" || !Number.isInteger(pgid) || pgid <= 0) return []
  const self = globalThis.process.pid
  if (globalThis.process.platform === "linux") {
    const names: string[] = (() => {
      try {
        return fs.readdirSync("/proc")
      } catch {
        return []
      }
    })()
    const out: number[] = []
    for (const name of names) {
      if (!/^\d+$/.test(name)) continue
      const id = Number(name)
      if (!Number.isInteger(id) || id <= 0 || id === self) continue
      const pg = pgidOf(id)
      if (pg === pgid) out.push(id)
    }
    return out.sort((a, b) => a - b)
  }
  try {
    const out = spawnSync("ps", ["-axo", "pid=,pgid="], { windowsHide: true, encoding: "utf8", timeout: 5000 })
    const text = typeof out.stdout === "string" ? out.stdout : ""
    const found: number[] = []
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s*$/)
      if (!m) continue
      const id = Number(m[1])
      if (!Number.isInteger(id) || id <= 0 || id === self) continue
      if (Number(m[2]) === pgid) found.push(id)
    }
    return found.sort((a, b) => a - b)
  } catch {
    return []
  }
}

export type Owned = { ok: true; pgid: number } | { ok: false; reason: string }

export function owned(pid: number, birth: string | undefined): Owned {
  if (!Number.isInteger(pid) || pid <= 0) return { ok: false, reason: "no-pid" }
  if (globalThis.process.platform === "win32") return { ok: false, reason: "win32-no-posix-group" }
  if (birth === undefined) return { ok: false, reason: "unknown-birth" }
  try {
    globalThis.process.kill(pid, 0)
  } catch {
    return { ok: false, reason: "guardian-gone" }
  }
  const now = birthOf(pid)
  if (now === undefined) return { ok: false, reason: "birth-unavailable" }
  if (now !== birth) return { ok: false, reason: "birth-changed" }
  const pg = pgidOf(pid)
  if (pg === undefined) return { ok: false, reason: "pgid-unavailable" }
  if (pg !== pid) return { ok: false, reason: "not-leader" }
  return { ok: true, pgid: pg }
}

export function birthOf(pid: number): string | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined
  if (process.platform === "linux") {
    try {
      const text = fs.readFileSync(path.join("/proc", String(pid), "stat"), "utf8")
      const end = text.lastIndexOf(")")
      if (end < 0) return undefined
      const fields = text
        .slice(end + 2)
        .trim()
        .split(/\s+/)
      const starttime = fields[19]
      return starttime !== undefined && starttime !== "" ? `${starttime}` : undefined
    } catch {
      return undefined
    }
  }
  if (process.platform === "darwin" || process.platform === "freebsd") {
    try {
      const out = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { windowsHide: true, encoding: "utf8" })
      const text = typeof out.stdout === "string" ? out.stdout.trim() : ""
      return text ? text : undefined
    } catch {
      return undefined
    }
  }
  if (process.platform === "win32") {
    try {
      const out = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `$p=Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; if ($p) { [Console]::Out.Write($p.CreationDate) }`,
        ],
        { windowsHide: true, encoding: "utf8" },
      )
      const text = typeof out.stdout === "string" ? out.stdout.trim() : ""
      return text ? text : undefined
    } catch {
      return undefined
    }
  }
  return undefined
}
