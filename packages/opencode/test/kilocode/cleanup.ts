import * as fs from "fs/promises"

function opts() {
  return process.platform === "win32"
    ? { retries: 60, delay: 500 }
    : // 3s settle window: test bodies dispose tmpdirs via `await using` while
      // instance rebuilds/reloads may still rewrite the dir; the removal must
      // out-wait that teardown work.
      { retries: 30, delay: 100 }
}

function locked(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ["EBUSY", "EACCES", "EPERM"].includes(String(error.code))
  )
}

export async function remove(dir: string) {
  const cfg = opts()
  const rm = async (left: number): Promise<void> => {
    let lastError: unknown
    try {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    } catch (error) {
      lastError = error
      if (left <= 1) throw error
      // bun:sqlite connections release their file handles on GC finalization, not on Effect scope
      // closure, so Windows needs a GC pass per retry: a connection that becomes unreachable after
      // a single early pass would otherwise never finalize while this loop only sleeps.
      if (process.platform === "win32" && locked(error)) Bun.gc(true)
    }
    if (left <= 1) {
      // LOCK-003 fixture leak fix: `fs.rm` resolving does not mean the dir is
      // gone — a detached install fiber (the config loader's
      // `Npm.install("@kilocode/plugin")`) can recreate node_modules right
      // after the pass that removed the stub it checks. Every error — not just
      // EBUSY/EACCES/EPERM — can be transient (ENOTEMPTY when a file is
      // recreated mid-walk), so the bounded loop verifies existence and
      // retries until the window is exhausted.
      const gone = await fs.stat(dir).then(() => false).catch(() => true)
      if (!gone) throw lastError ?? new Error(`temp dir still exists after ${cfg.retries} removal attempts: ${dir}`)
      return
    }
    const gone = await fs.stat(dir).then(() => false).catch(() => true)
    if (!gone) {
      await Bun.sleep(cfg.delay)
      return rm(left - 1)
    }
  }
  return rm(cfg.retries)
}
