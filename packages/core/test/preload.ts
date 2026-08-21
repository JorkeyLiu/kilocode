import os from "os"
import path from "path"
import fs from "fs/promises"
import { afterAll } from "bun:test"

// run-owned temp XDG root — must be set BEFORE any core module import
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kilo-core-test-"))
await fs.mkdir(dir, { recursive: true })

process.env.XDG_DATA_HOME = path.join(dir, "share")
process.env.XDG_CACHE_HOME = path.join(dir, "cache")
process.env.XDG_CONFIG_HOME = path.join(dir, "config")
process.env.XDG_STATE_HOME = path.join(dir, "state")

const home = path.join(dir, "home")
await fs.mkdir(home, { recursive: true })
process.env.KILO_TEST_HOME = home

// ensure XDG subdirs exist so Global.ensureRealDir has targets
await Promise.all([
  fs.mkdir(path.join(dir, "share"), { recursive: true }),
  fs.mkdir(path.join(dir, "cache"), { recursive: true }),
  fs.mkdir(path.join(dir, "config"), { recursive: true }),
  fs.mkdir(path.join(dir, "state"), { recursive: true }),
])

function locked(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    ["EBUSY", "EACCES", "EPERM"].includes(String((err as any).code))
  )
}

async function removeOnce(target: string): Promise<void> {
  try {
    await fs.rm(target, { recursive: true, force: true })
  } catch (err) {
    if (locked(err)) {
      if (process.platform === "win32") Bun.gc(true)
      throw err
    }
    throw err
  }
}

async function removeOwned(target: string): Promise<void> {
  const base = path.basename(target)
  if (!base.startsWith("kilo-core-test-")) {
    throw new Error(`refusing to delete outside owned directory: ${target}`)
  }
  let tmpReal: string
  try {
    tmpReal = await fs.realpath(os.tmpdir())
  } catch {
    throw new Error(`refusing to delete: tmpdir realpath unavailable for ${target}`)
  }
  let targetReal: string
  try {
    targetReal = await fs.realpath(target)
  } catch {
    throw new Error(`refusing to delete: target realpath unavailable for ${target}`)
  }
  const tmpLex = os.tmpdir()
  const isRealConfined = targetReal === tmpReal || targetReal.startsWith(tmpReal + path.sep)
  const isLexConfined =
    target === tmpReal ||
    target.startsWith(tmpReal + path.sep) ||
    target === tmpLex ||
    target.startsWith(tmpLex + path.sep)
  if (!isRealConfined || !isLexConfined) {
    throw new Error(`refusing to delete outside tmpdir: ${target} (real: ${targetReal}, tmpReal: ${tmpReal}, tmpLex: ${tmpLex})`)
  }

  const retries = process.platform === "win32" ? 60 : 30
  const delay = process.platform === "win32" ? 500 : 100
  let last: unknown
  for (let attempt = retries; attempt > 0; attempt--) {
    try {
      await removeOnce(target)
    } catch (err) {
      last = err
      if (attempt === 1) break
      if (!locked(err)) break
      await Bun.sleep(delay)
      continue
    }
    // verify removal — detached fibers can recreate files mid-walk
    const exists = await fs.stat(target).then(() => true).catch(() => false)
    if (!exists) return
    if (attempt === 1) {
      last = last ?? new Error(`temp dir still exists after ${retries} attempts: ${target}`)
      break
    }
    await Bun.sleep(delay)
  }
  const exists = await fs.stat(target).then(() => true).catch(() => false)
  if (exists) throw (last as Error) ?? new Error(`failed to remove ${target}`)
}

afterAll(async () => {
  const exists = await fs.stat(dir).then(() => true).catch(() => false)
  if (!exists) return
  try {
    await removeOwned(dir)
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[core preload] cleanup failed for ${dir}`, err)
  }
  // bounded retry until actually gone — report residue but never broaden deletion
  for (let left = 15; left > 0; left--) {
    const still = await fs.stat(dir).then(() => true).catch(() => false)
    if (!still) return
    await Bun.sleep(100)
    try {
      await removeOwned(dir)
    } catch {}
    if (left === 1) {
      // eslint-disable-next-line no-console
      console.error(`[core preload] temp residue remains after cleanup: ${dir}`)
    }
  }
})
