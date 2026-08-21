import fsp from "fs/promises"
import path from "path"
import { randomUUID } from "crypto"
import { fsyncDir } from "./util"

export type LeaseHandle = {
  release: () => Promise<void>
  token: string
  pid: number
}

const inProcessLocks = new Map<string, { count: number; token: string; pid: number }>()

const pendingChains = new Map<string, Promise<void>>()

async function withPerPathQueue<T>(lp: string, fn: () => Promise<T>): Promise<T> {
  const prev = pendingChains.get(lp) ?? Promise.resolve()
  let release!: () => void
  const cur = new Promise<void>((res) => {
    release = res
  })
  const chain = prev.then(() => cur)
  pendingChains.set(lp, chain)
  await prev
  try {
    return await fn()
  } finally {
    release()
    if (pendingChains.get(lp) === chain) pendingChains.delete(lp)
  }
}

function leasePathForDataRoot(dataRoot: string): string {
  const abs = path.resolve(dataRoot)
  const parent = path.dirname(abs)
  const base = path.basename(abs)
  // sibling beside data root, deterministic, shared between DB runtime and cutover
  return path.join(parent, `.kilo-${base}.lease.json`)
}

function leasePathForDbFile(file: string): string {
  if (file === ":memory:" || file === "" || file.includes(":memory:")) return ""
  const abs = path.resolve(file)
  const dir = path.dirname(abs)
  // dir is dataRoot (where kilo.db lives). Use same deterministic sibling.
  const parent = path.dirname(dir)
  const base = path.basename(dir)
  // Special case: if file is directly under parent like /tmp/kilo.db (no dataRoot dir), dir is parent. We still compute parent of dir.
  // To handle both, we consider dataRoot = dir, lease path = parent/.kilo-base.lease.json
  // If base is empty or ".", fall back to filename-based
  if (!base || base === "." || base === "/") {
    return `${abs}.lease.json`
  }
  // If dir is exactly Global.Path.data, this matches cutover dataRoot logic
  return path.join(parent, `.kilo-${base}.lease.json`)
}

export function leasePathFor(dataRootOrFile: string): string {
  // Heuristic: if path ends with .db, treat as file, otherwise dataRoot
  if (dataRootOrFile.endsWith(".db") || dataRootOrFile.includes(".db.")) return leasePathForDbFile(dataRootOrFile)
  return leasePathForDataRoot(dataRootOrFile)
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e: any) {
    if (e.code === "ESRCH") return false
    if (e.code === "EPERM") return true
    return true
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p)
    return true
  } catch {
    return false
  }
}

async function acquireLeaseInner(dataRoot: string, lp: string): Promise<LeaseHandle> {
  // same-process reentrant: if we already hold the lease in this process, refcount instead of refusing
  const existing = inProcessLocks.get(lp)
  if (existing) {
    let raw: string | undefined
    try {
      raw = await fsp.readFile(lp, "utf8")
      const data = JSON.parse(raw)
      if (data.token !== existing.token || data.pid !== existing.pid) {
        throw new Error(`lease reentrant token mismatch for ${lp} - fail closed`)
      }
    } catch (e: any) {
      if (e.code === "ENOENT") {
        // file disappeared but map still thinks we hold it — stale map entry, clear and proceed to fresh acquire
        inProcessLocks.delete(lp)
      } else if (e.message?.includes("reentrant token mismatch") || e.message?.includes("fail closed")) {
        throw e
      } else {
        throw new Error(`lease reentrant read failed ${lp}: ${e.message}`)
      }
    }
    if (inProcessLocks.has(lp)) {
      const cur = inProcessLocks.get(lp)!
      cur.count += 1
      inProcessLocks.set(lp, cur)
      const token = cur.token
      const pid = cur.pid
      return {
        token,
        pid,
        release: async () => {
          const cur2 = inProcessLocks.get(lp)
          if (!cur2 || cur2.token !== token) throw new Error(`lease release by non-owner for ${lp}`)
          cur2.count -= 1
          if (cur2.count > 0) {
            inProcessLocks.set(lp, cur2)
            return
          }
          inProcessLocks.delete(lp)
          await releaseFile(lp, token)
        },
      }
    }
    // fell through after ENOENT clear — continue to fresh acquisition
  }
  // check existing file (cross-process live vs stale)
  if (await fileExists(lp)) {
    let raw: string
    try {
      raw = await fsp.readFile(lp, "utf8")
    } catch {
      throw new Error(`lease read failed ${lp}`)
    }
    let data: any
    try {
      data = JSON.parse(raw)
    } catch {
      throw new Error(`lease corrupt ${lp} - fail closed, manual recovery required`)
    }
    if (!data || typeof data.pid !== "number" || typeof data.token !== "string") {
      throw new Error(`lease corrupt ${lp} - fail closed`)
    }
    if (isPidAlive(data.pid)) {
      throw new Error(`lease held by live PID ${data.pid} at ${lp} - exclusivity cannot be proven`)
    }
    // stale, prove pid dead -> remove
    try {
      await fsp.rm(lp, { force: true })
      await fsyncDir(path.dirname(lp))
    } catch (e: any) {
      throw new Error(`stale lease recovery failed ${lp}: ${e.message}`)
    }
  }
  const token = randomUUID()
  const pid = process.pid
  const payload = JSON.stringify({ pid, token, createdAt: Date.now() }, null, 2)
  // exclusive create
  try {
    const fd = await fsp.open(lp, "wx", 0o600)
    try {
      await fd.writeFile(payload, "utf8")
      await fd.sync()
    } finally {
      await fd.close()
    }
    await fsyncDir(path.dirname(lp))
  } catch (e: any) {
    if (e.code === "EEXIST") throw new Error(`lease held at ${lp} - concurrent acquisition`)
    throw e
  }
  inProcessLocks.set(lp, { count: 1, token, pid })
  return {
    token,
    pid,
    release: async () => {
      const cur = inProcessLocks.get(lp)
      // prevent release by non-owner
      if (!cur || cur.token !== token) throw new Error(`lease release by non-owner for ${lp}`)
      cur.count -= 1
      if (cur.count > 0) {
        inProcessLocks.set(lp, cur)
        return
      }
      inProcessLocks.delete(lp)
      await releaseFile(lp, token)
    },
  }
}

async function releaseFile(lp: string, expectedToken: string): Promise<void> {
  let raw: string | undefined
  try {
    raw = await fsp.readFile(lp, "utf8")
  } catch (e: any) {
    if (e.code === "ENOENT") return
    throw new Error(`lease release read failed ${lp}: ${e.message}`)
  }
  let data: any
  try {
    data = JSON.parse(raw)
  } catch {
    throw new Error(`lease release corrupt ${lp} - fail closed`)
  }
  if (data.token !== expectedToken) throw new Error(`lease release token mismatch for ${lp} - not owner`)
  try {
    await fsp.rm(lp, { force: true })
  } catch (e: any) {
    throw new Error(`lease release rm failed ${lp}: ${e.message}`)
  }
  try {
    await fsyncDir(path.dirname(lp))
  } catch (e: any) {
    throw new Error(`lease release fsync failed ${lp}: ${e.message}`)
  }
}

export async function acquireLease(dataRoot: string): Promise<LeaseHandle> {
  const lp = leasePathForDataRoot(dataRoot)
  return withPerPathQueue(lp, () => acquireLeaseInner(dataRoot, lp))
}

export async function acquireLeaseForDbFile(file: string): Promise<LeaseHandle | undefined> {
  if (file === ":memory:") return undefined
  // derive dataRoot from file path: dirname
  const dir = path.dirname(path.resolve(file))
  // If file is :memory: bypass
  return acquireLease(dir)
}

export function isLeaseHeld(dataRoot: string): boolean {
  const lp = leasePathForDataRoot(dataRoot)
  return inProcessLocks.has(lp)
}

// For testing: clear in-process map (not for production)
export function _clearForTests(): void {
  inProcessLocks.clear()
  pendingChains.clear()
}
