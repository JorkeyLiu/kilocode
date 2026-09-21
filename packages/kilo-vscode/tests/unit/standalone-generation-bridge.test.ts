import { describe, it, expect } from "bun:test"
import * as path from "path"
import * as fs from "fs"
import * as os from "os"
import { PrivateWorkerHost } from "../../src/private-worker/host"
import { OBSERVATION_METHODS, OBSERVATION_VERSION, OBSERVATION_NOTIFICATION } from "../../src/private-worker/observation"

function leasePathForDbFile(file: string): string {
  const abs = path.resolve(file)
  const dir = path.dirname(abs)
  const parent = path.dirname(dir)
  const base = path.basename(dir)
  if (!base || base === "." || base === "/") return `${abs}.lease.json`
  return path.join(parent, `.kilo-${base}.lease.json`)
}

async function waitForHostClosed(host: PrivateWorkerHost, timeoutMs = 3000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (host.getState() === "closed") return true
    await new Promise((r) => setTimeout(r, 25))
  }
  return host.getState() === "closed"
}

async function waitForNotificationCount(arr: unknown[], expected: number, timeoutMs = 3000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (arr.length >= expected) return true
    await new Promise((r) => setTimeout(r, 25))
  }
  return arr.length >= expected
}

function makeTmpEnv(): { tmp: string; dbPath: string; env: NodeJS.ProcessEnv; cleanup: () => Promise<void> } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-vscode-gen-bridge-"))
  const dataDir = path.join(tmp, "data")
  fs.mkdirSync(dataDir, { recursive: true })
  const dbPath = path.join(dataDir, "kilo.db")
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    KILO_PRIVATE_WORKER_STANDALONE: "1",
    KILO_PRIVATE_WORKER_TEST_BRIDGE: "1",
    KILO_DB: dbPath,
    XDG_DATA_HOME: path.join(tmp, "xdg-data"),
    XDG_CONFIG_HOME: path.join(tmp, "xdg-config"),
    XDG_CACHE_HOME: path.join(tmp, "xdg-cache"),
    XDG_STATE_HOME: path.join(tmp, "xdg-state"),
  }
  for (const k of ["XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"]) {
    const v = env[k]!
    fs.mkdirSync(v, { recursive: true })
  }
  const cleanup = async () => {
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
    const lease = leasePathForDbFile(dbPath)
    try { fs.rmSync(lease, { force: true }) } catch {}
  }
  return { tmp, dbPath, env, cleanup }
}

describe("vscode standalone test/mutateChangefeed generation preservation (bounded)", () => {
  it("preserves generation kind through bridge and reaches normal validation; unknown falls back to changed", async () => {
    const { dbPath, env, cleanup } = makeTmpEnv()
    const lease = leasePathForDbFile(dbPath)
    const standaloneTs = path.resolve(process.cwd(), "src/private-worker/standalone-worker.ts")
    const notifs: Array<{ method: string; params: unknown }> = []
    const host = new PrivateWorkerHost({
      command: "bun",
      args: ["--conditions=browser", standaloneTs],
      env,
      initializeTimeoutMs: 8000,
      onNotification: (m, p) => notifs.push({ method: m, params: p }),
    })
    try {
      expect(fs.existsSync(lease)).toBe(false)
      const init = await host.start()
      expect((init as { protocolVersion: string }).protocolVersion).toBe("1.0")
      expect(fs.existsSync(lease)).toBe(false)

      const snap0 = (await host.request(OBSERVATION_METHODS.SNAPSHOT, {})) as { v: string; cursor: number }
      expect(snap0.v).toBe(OBSERVATION_VERSION)
      const before = snap0.cursor

      const gen = (await host.request("test/mutateChangefeed", { session_id: "ses_gen_bridge_a", revision: 1, kind: "generation", time: 9000 })) as { v: string; cursor: number; entry: { seq: number; session_id: string; revision: number; kind: string; time: number } }
      expect(gen.v).toBe(OBSERVATION_VERSION)
      expect(gen.entry.kind).toBe("generation")
      expect(gen.cursor).toBe(gen.entry.seq)
      expect(await waitForNotificationCount(notifs, 1, 3000)).toBe(true)
      const n1 = notifs[0]!.params as { v: string; cursor: number; entries: Array<{ kind: string; seq: number }> }
      expect(n1.v).toBe(OBSERVATION_VERSION)
      expect(n1.entries[0]!.kind).toBe("generation")

      const read = (await host.request(OBSERVATION_METHODS.READ, { cursor: before })) as { rehydrate: boolean; cursor: number; entries: Array<{ kind: string }> }
      expect(read.rehydrate).toBe(false)
      expect(read.entries[0]!.kind).toBe("generation")

      const bogus = (await host.request("test/mutateChangefeed", { session_id: "ses_gen_bridge_b", revision: 1, kind: "bogus_unknown", time: 9001 })) as { cursor: number; entry: { kind: string } }
      expect(bogus.entry.kind).toBe("changed")
      expect(await waitForNotificationCount(notifs, 2, 3000)).toBe(true)
      const n2 = notifs[1]!.params as { entries: Array<{ kind: string }> }
      expect(n2.entries[0]!.kind).toBe("changed")

      const snap1 = (await host.request(OBSERVATION_METHODS.SNAPSHOT, {})) as { cursor: number }
      expect(snap1.cursor).toBe(bogus.cursor)
    } finally {
      host.dispose()
      await waitForHostClosed(host, 2000)
      expect(fs.existsSync(lease)).toBe(false)
      await cleanup()
    }
  }, 30000)

  it("standalone source still coerces only unknown kinds and keeps bundle markers", async () => {
    const base = path.resolve(process.cwd(), "src/private-worker")
    const standalone = fs.readFileSync(path.join(base, "standalone-worker.ts"), "utf8")
    expect(standalone).toContain(`kindRaw === "generation"`)
    expect(standalone).toContain(`KILO_PRIVATE_WORKER_TEST_BRIDGE`)
    expect(standalone).toContain("notifyChanged")
  })
})
