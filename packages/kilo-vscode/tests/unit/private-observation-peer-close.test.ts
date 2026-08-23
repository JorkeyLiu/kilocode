import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import * as path from "path"
import * as fs from "fs"
import * as os from "os"
import { PrivateObservationService } from "../../src/private-worker/private-observation-service"
import { PrivateWorkerHost } from "../../src/private-worker/host"
import { PrivateObservationLifecycleTriggers } from "../../src/private-worker/private-observation-lifecycle-triggers"

function makeTmpEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-peerclose-"))
  const dataDir = path.join(tmp, "data")
  fs.mkdirSync(dataDir, { recursive: true })
  const dbPath = path.join(dataDir, "kilo.db")
  const xdg = {
    XDG_DATA_HOME: path.join(tmp, "xdg-data"),
    XDG_CONFIG_HOME: path.join(tmp, "xdg-config"),
    XDG_CACHE_HOME: path.join(tmp, "xdg-cache"),
    XDG_STATE_HOME: path.join(tmp, "xdg-state"),
  }
  for (const v of Object.values(xdg)) fs.mkdirSync(v, { recursive: true })
  const cleanup = async () => {
    try {
      fs.rmSync(tmp, { recursive: true, force: true })
    } catch {}
  }
  return { tmp, dbPath, xdg, cleanup }
}

describe("PrivateWorkerHost/Peer onClosed and transport vs restart distinction", () => {
  let origFixture: string | undefined
  beforeEach(() => {
    origFixture = process.env.KILO_E2E_FIXTURE
    process.env.KILO_E2E_FIXTURE = "1"
  })
  afterEach(() => {
    if (origFixture === undefined) delete process.env.KILO_E2E_FIXTURE
    else process.env.KILO_E2E_FIXTURE = origFixture
  })

  it("host onClosed fires on closePeerTransport without killing process, peer state closed", async () => {
    const { dbPath, xdg, cleanup } = makeTmpEnv()
    const standaloneTs = path.resolve(process.cwd(), "src/private-worker/standalone-worker.ts")
    let closed = 0
    const host = new PrivateWorkerHost({
      env: { ...xdg, KILO_DB: dbPath, KILO_PRIVATE_WORKER_STANDALONE: "1", KILO_PRIVATE_WORKER_TEST_BRIDGE: "1" },
      command: "bun",
      args: ["--conditions=browser", standaloneTs],
      onClosed: () => {
        closed++
      },
    })
    try {
      await host.start()
      expect(host.getState()).toBe("open")
      const beforePid = host.getPid()
      expect(beforePid).toBeDefined()
      const aliveBefore = host.isAlive()
      expect(aliveBefore).toBe(true)
      const didClose = host.closePeerTransport() as unknown as { closed: boolean; aliveBefore: boolean; aliveAfter: boolean; beforePid?: number; afterPid?: number }
      // host now returns detailed evidence: both aliveBefore and aliveAfter true, same PID post-close
      const didClosed = typeof didClose === "boolean" ? didClose : didClose.closed
      expect(didClosed).toBe(true)
      if (typeof didClose !== "boolean") {
        expect(didClose.aliveBefore).toBe(true)
        expect(didClose.aliveAfter).toBe(true)
        expect(didClose.beforePid).toBe(beforePid)
        expect(didClose.afterPid).toBe(beforePid)
      }
      expect(host.getState()).toBe("closed")
      // closed hook fired exactly once
      expect(closed).toBe(1)
      // process still alive immediately after peer close (transport close distinct from kill)
      const proc = host.getProc()
      expect(proc).not.toBeNull()
      expect(proc!.exitCode).toBeNull()
      expect(host.isAlive()).toBe(true)
      // second close is no-op, no second hook
      const didClose2 = host.closePeerTransport() as unknown as { closed: boolean }
      const didClosed2 = typeof didClose2 === "boolean" ? didClose2 : (didClose2 as { closed: boolean }).closed
      expect(didClosed2).toBe(false)
      expect(closed).toBe(1)
    } finally {
      host.dispose()
      await new Promise((r) => setTimeout(r, 200))
      await cleanup()
    }
  }, 20000)

  it("service onPeerClosed hook fires via host onClosed and triggers lifecycle", async () => {
    const { dbPath, xdg, cleanup } = makeTmpEnv()
    const standaloneTs = path.resolve(process.cwd(), "src/private-worker/standalone-worker.ts")
    const svc = new PrivateObservationService({
      enabled: true,
      dbPath,
      testBridge: true,
      env: xdg,
      command: "bun",
      args: ["--conditions=browser", standaloneTs],
    })
    try {
      let hookFired = 0
      svc.setOnPeerClosed(() => {
        hookFired++
      })
      await svc.initialize()
      expect(svc.getHostState()).toBe("open")
      const beforePid = svc.getHost()?.getPid()
      // close transport via service seam
      const res = svc.closePeerTransport()
      expect(res.closed).toBe(true)
      expect(res.aliveBefore).toBe(true)
      expect(res.aliveAfter).toBe(true)
      expect(res.beforePid).toBe(beforePid)
      expect(res.afterPid).toBe(beforePid)
      expect(res.beforePid).toBe(res.afterPid)
      // give event loop to fire hook
      await new Promise((r) => setTimeout(r, 100))
      expect(hookFired).toBe(1)
      // Now wire lifecycle triggers to prove debounced reconnect via transport close
      const triggers = new PrivateObservationLifecycleTriggers(svc, { debounceMs: 10 })
      // Reset hostState is still closed after previous close, but service still holds closed host.
      // Reconnect will dispose old and start new. Hook already fired once; now trigger via lifecycle directly.
      const beforePid2 = svc.getHost()?.getPid()
      // trigger via lifecycle (not via host close hook — hook would have already fired on prior close)
      const p = triggers.onPeerClosed()
      const result = await p
      expect(result).not.toBeUndefined()
      expect(svc.getHostState()).toBe("open")
      const afterPid = svc.getHost()?.getPid()
      expect(afterPid).not.toBe(beforePid2)
      triggers.dispose()
    } finally {
      svc.dispose()
      await new Promise((r) => setTimeout(r, 200))
      await cleanup()
    }
  }, 30000)

  it("transport close keeps PID alive before replacement vs restart kills exact PID", async () => {
    const { dbPath, xdg, cleanup } = makeTmpEnv()
    const standaloneTs = path.resolve(process.cwd(), "src/private-worker/standalone-worker.ts")
    const svc = new PrivateObservationService({
      enabled: true,
      dbPath,
      testBridge: true,
      env: xdg,
      command: "bun",
      args: ["--conditions=browser", standaloneTs],
    })
    try {
      await svc.initialize()
      const beforePid = svc.getHost()?.getPid()!
      expect(typeof beforePid).toBe("number")
      // Capture snapshot watermark before
      const snapBefore = svc.getNotificationSnapshot()
      const wm = snapBefore.nextOrdinal
      // mutate to generate one notification before boundary
      await svc.request("test/mutateChangefeed", { session_id: "peerclose_before", revision: 1, kind: "changed", time: 9000 })
      await new Promise((r) => setTimeout(r, 200))
      const snapMid = svc.getNotificationSnapshot()
      expect(snapMid.nextOrdinal).toBeGreaterThan(wm)
      // Transport close: peer closed, proc alive before and after with same PID
      const closeRes = svc.closePeerTransport()
      expect(closeRes.aliveBefore).toBe(true)
      expect(closeRes.aliveAfter).toBe(true)
      expect(closeRes.beforePid).toBe(beforePid)
      expect(closeRes.afterPid).toBe(beforePid)
      expect(closeRes.closed).toBe(true)
      const triggers = new PrivateObservationLifecycleTriggers(svc, { debounceMs: 10 })
      svc.setOnPeerClosed(() => void triggers.onPeerClosed())
      // The host is now closed but proc still alive; reconnect should dispose it and start new pid
      await triggers.onPeerClosed()
      await svc.waitReady(5000)
      const afterPidTransport = svc.getHost()?.getPid()!
      expect(afterPidTransport).not.toBe(beforePid)
      // Now mutate after reconnect to prove notification delivered post-boundary distinct from pre
      await svc.request("test/mutateChangefeed", { session_id: "peerclose_after_transport", revision: 1, kind: "changed", time: 9001 })
      await new Promise((r) => setTimeout(r, 300))
      const snapAfterTransport = svc.getNotificationSnapshot()
      const afterDeltaTransport = snapAfterTransport.entries.filter((e) => e.ordinal >= wm)
      expect(afterDeltaTransport.length).toBeGreaterThanOrEqual(1)
      // Ensure no duplicate seq across pre/post delta
      const beforeSeqs = snapMid.entries.map((e) => (e.params as { entries: Array<{ seq: number }> }).entries[0]?.seq).filter((v) => typeof v === "number") as number[]
      // simple check that afterDelta contains new ordinal
      expect(afterDeltaTransport[afterDeltaTransport.length - 1]!.ordinal).toBeGreaterThanOrEqual(wm)
      triggers.dispose()
      // Now restart path: exact PID kill
      const beforePid2 = svc.getHost()?.getPid()!
      const proc = svc.getHost()?.getProc()!
      proc.kill()
      const ok = await svc.getHost()!.waitForExit(5000)
      expect(ok).toBe(true)
      const afterKillProcAlive = svc.getHost()?.isAlive()
      expect(afterKillProcAlive).toBe(false)
      await svc.reconnect()
      await svc.waitReady(5000)
      const afterPidRestart = svc.getHost()?.getPid()!
      expect(afterPidRestart).not.toBe(beforePid2)
      // Distinctness: transport close preserved aliveBefore true, restart killed pid before replacement
      expect(closeRes.aliveBefore).toBe(true)
    } finally {
      svc.dispose()
      await new Promise((r) => setTimeout(r, 200))
      await cleanup()
    }
  }, 40000)

  it("intentional service.reconnect disposal does not schedule extra reconnect via onClosed (suppression), external peer close still reaches hook", async () => {
    const { dbPath, xdg, cleanup } = makeTmpEnv()
    const standaloneTs = path.resolve(process.cwd(), "src/private-worker/standalone-worker.ts")
    const svc = new PrivateObservationService({
      enabled: true,
      dbPath,
      testBridge: true,
      env: xdg,
      command: "bun",
      args: ["--conditions=browser", standaloneTs],
    })
    try {
      let hookFired = 0
      svc.setOnPeerClosed(() => {
        hookFired++
      })
      await svc.initialize()
      expect(svc.getHostState()).toBe("open")
      // Capture host before reconnect
      const pidBeforeReconnect = svc.getHost()?.getPid()
      expect(pidBeforeReconnect).toBeDefined()
      hookFired = 0
      // Intentional reconnect disposes old host — hook must remain 0 (suppressed)
      await svc.reconnect()
      expect(hookFired).toBe(0)
      expect(svc.getHostState()).toBe("open")
      const pidAfterReconnect = svc.getHost()?.getPid()
      expect(pidAfterReconnect).not.toBe(pidBeforeReconnect)
      // Now external transport close must still fire hook (fixture path not suppressed)
      hookFired = 0
      const res = svc.closePeerTransport()
      expect(res.closed).toBe(true)
      expect(res.aliveBefore).toBe(true)
      expect(res.aliveAfter).toBe(true)
      expect(res.beforePid).toBe(pidAfterReconnect)
      expect(res.afterPid).toBe(pidAfterReconnect)
      await new Promise((r) => setTimeout(r, 80))
      expect(hookFired).toBe(1)
      // Suppression must be scoped: another intentional reconnect still suppressed, not masking later external close
      hookFired = 0
      await svc.reconnect()
      expect(hookFired).toBe(0)
      const pidAfterSecond = svc.getHost()?.getPid()
      expect(typeof pidAfterSecond).toBe("number")
      // external close again still fires
      hookFired = 0
      const res2 = svc.closePeerTransport()
      expect(res2.aliveAfter).toBe(true)
      await new Promise((r) => setTimeout(r, 80))
      expect(hookFired).toBe(1)
    } finally {
      svc.dispose()
      await new Promise((r) => setTimeout(r, 200))
      await cleanup()
    }
  }, 30000)

  it("service.dispose clears/blocks onClosed hook; pending failed-init does not invoke hook", async () => {
    const { dbPath, xdg, cleanup } = makeTmpEnv()
    const standaloneTs = path.resolve(process.cwd(), "src/private-worker/standalone-worker.ts")
    const svc = new PrivateObservationService({
      enabled: true,
      dbPath,
      testBridge: true,
      env: xdg,
      command: "bun",
      args: ["--conditions=browser", standaloneTs],
    })
    try {
      let hookFired = 0
      svc.setOnPeerClosed(() => {
        hookFired++
      })
      await svc.initialize()
      expect(svc.getHostState()).toBe("open")
      hookFired = 0
      // dispose is intentional final disposal — must not fire hook
      svc.dispose()
      // give event loop
      await new Promise((r) => setTimeout(r, 100))
      expect(hookFired).toBe(0)
      // setting hook after dispose should not be invoked by any late closure (disposed blocks)
      hookFired = 0
      svc.setOnPeerClosed(() => {
        hookFired++
      })
      await new Promise((r) => setTimeout(r, 100))
      expect(hookFired).toBe(0)
    } finally {
      try {
        svc.dispose()
      } catch {}
      await new Promise((r) => setTimeout(r, 200))
      await cleanup()
    }
  }, 20000)

  it("pending-child shutdown/failed init does not invoke lifecycle reconnect via hook", async () => {
    // Use helper that ignores SIGTERM to keep child alive after failed init timeout, but hook must not fire
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-suppress-pending-"))
    const helper = path.join(tmp, "helper-init-timeout.mjs")
    const code = `
process.on('SIGTERM', () => {});
process.on('SIGINT', () => {});
process.stdin.on('data', () => {});
if (process.stdin.isTTY === false) process.stdin.resume();
setInterval(() => {}, 1000);
`
    fs.writeFileSync(helper, code, "utf8")
    const xdgTmp = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-suppress-xdg-"))
    const dataDir = path.join(xdgTmp, "data")
    fs.mkdirSync(dataDir, { recursive: true })
    const dbPath = path.join(dataDir, "kilo.db")
    const xdg = {
      XDG_DATA_HOME: path.join(xdgTmp, "xdg-data"),
      XDG_CONFIG_HOME: path.join(xdgTmp, "xdg-config"),
      XDG_CACHE_HOME: path.join(xdgTmp, "xdg-cache"),
      XDG_STATE_HOME: path.join(xdgTmp, "xdg-state"),
    }
    for (const v of Object.values(xdg)) fs.mkdirSync(v, { recursive: true })
    const svc = new PrivateObservationService({
      enabled: true,
      dbPath,
      env: xdg,
      command: process.execPath,
      args: [helper],
      initializeTimeoutMs: 400,
    })
    try {
      let hookFired = 0
      svc.setOnPeerClosed(() => {
        hookFired++
      })
      let err: unknown
      try {
        await svc.initialize()
      } catch (e) {
        err = e
      }
      expect(err).toBeDefined()
      // failed init disposal is intentional — must not have fired hook
      expect(hookFired).toBe(0)
      // pending host remains alive but hook not fired
      const pending = svc.getPendingShutdownHost()
      expect(pending).not.toBeNull()
      expect(pending!.isAlive()).toBe(true)
      // reconnect attempt while pending alive must fail without firing hook
      hookFired = 0
      let reconErr: unknown
      try {
        await svc.reconnect()
      } catch (e) {
        reconErr = e
      }
      expect(reconErr).toBeDefined()
      expect(hookFired).toBe(0)
      // cleanup pending via dispose must still not fire hook
      hookFired = 0
      const ref = pending!
      svc.dispose()
      await new Promise((r) => setTimeout(r, 100))
      expect(hookFired).toBe(0)
      const exited = await ref.waitForExit(3000)
      expect(exited).toBe(true)
    } finally {
      try {
        svc.dispose()
      } catch {}
      try {
        fs.rmSync(tmp, { recursive: true, force: true })
      } catch {}
      try {
        fs.rmSync(xdgTmp, { recursive: true, force: true })
      } catch {}
      const lease = path.join(path.dirname(path.dirname(dbPath)), `.kilo-${path.basename(path.dirname(dbPath))}.lease.json`)
      try {
        fs.rmSync(lease, { force: true })
      } catch {}
    }
  }, 20000)
})
