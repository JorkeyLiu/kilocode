import { describe, it, expect } from "bun:test"
import * as path from "path"
import * as fs from "fs"
import * as os from "os"
import { PrivateWorkerHost } from "../../src/private-worker/host"
import { PrivateObservationService } from "../../src/private-worker/private-observation-service"

function makeHelperScript(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-host-retained-"))
  const file = path.join(tmp, "helper-ignore-sigterm.mjs")
  // Minimal JSON-RPC handler that ignores SIGTERM and responds to initialize/ping
  const code = `
process.on('SIGTERM', () => {});
process.on('SIGINT', () => {});
let buf = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (true) {
    const idx = buf.indexOf('\\r\\n\\r\\n');
    if (idx < 0) break;
    const header = buf.subarray(0, idx).toString('ascii');
    const m = header.match(/Content-Length:\\s*(\\d+)/i);
    if (!m) { buf = buf.subarray(idx+4); continue; }
    const len = parseInt(m[1], 10);
    const total = idx+4+len;
    if (buf.length < total) break;
    const body = buf.subarray(idx+4, total).toString('utf8');
    let msg;
    try { msg = JSON.parse(body); } catch { buf = buf.subarray(total); continue; }
    if (msg.method === 'initialize') {
      const resp = { jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "1.0", serverInfo: { name: "test-helper", version: "1" }, capabilities: {} } };
      const json = JSON.stringify(resp);
      const out = 'Content-Length: ' + Buffer.byteLength(json) + '\\r\\n\\r\\n' + json;
      process.stdout.write(out);
    } else if (msg.method === 'ping') {
      const resp = { jsonrpc: "2.0", id: msg.id, result: { pong: true } };
      const json = JSON.stringify(resp);
      const out = 'Content-Length: ' + Buffer.byteLength(json) + '\\r\\n\\r\\n' + json;
      process.stdout.write(out);
    } else if (msg.id !== undefined && msg.id !== null) {
      const resp = { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found: " + msg.method } };
      const json = JSON.stringify(resp);
      const out = 'Content-Length: ' + Buffer.byteLength(json) + '\\r\\n\\r\\n' + json;
      process.stdout.write(out);
    }
    buf = buf.subarray(total);
  }
});
if (process.stdin.isTTY === false) process.stdin.resume();
`
  fs.writeFileSync(file, code, "utf8")
  return file
}

function makeGracefulHelperScript(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-host-graceful-"))
  const file = path.join(tmp, "helper-graceful.mjs")
  const code = `
process.on('SIGTERM', () => { process.exit(0); });
process.on('SIGINT', () => { process.exit(0); });
let buf = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (true) {
    const idx = buf.indexOf('\\r\\n\\r\\n');
    if (idx < 0) break;
    const header = buf.subarray(0, idx).toString('ascii');
    const m = header.match(/Content-Length:\\s*(\\d+)/i);
    if (!m) { buf = buf.subarray(idx+4); continue; }
    const len = parseInt(m[1], 10);
    const total = idx+4+len;
    if (buf.length < total) break;
    const body = buf.subarray(idx+4, total).toString('utf8');
    let msg;
    try { msg = JSON.parse(body); } catch { buf = buf.subarray(total); continue; }
    if (msg.method === 'initialize') {
      const resp = { jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "1.0", serverInfo: { name: "test-helper", version: "1" }, capabilities: {} } };
      const json = JSON.stringify(resp);
      const out = 'Content-Length: ' + Buffer.byteLength(json) + '\\r\\n\\r\\n' + json;
      process.stdout.write(out);
    } else if (msg.method === 'ping') {
      const resp = { jsonrpc: "2.0", id: msg.id, result: { pong: true } };
      const json = JSON.stringify(resp);
      const out = 'Content-Length: ' + Buffer.byteLength(json) + '\\r\\n\\r\\n' + json;
      process.stdout.write(out);
    } else if (msg.id !== undefined && msg.id !== null) {
      const resp = { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found: " + msg.method } };
      const json = JSON.stringify(resp);
      const out = 'Content-Length: ' + Buffer.byteLength(json) + '\\r\\n\\r\\n' + json;
      process.stdout.write(out);
    }
    buf = buf.subarray(total);
  }
});
if (process.stdin.isTTY === false) process.stdin.resume();
`
  fs.writeFileSync(file, code, "utf8")
  return file
}

function makeInitTimeoutHelperScript(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-host-init-timeout-"))
  const file = path.join(tmp, "helper-init-timeout.mjs")
  const code = `
process.on('SIGTERM', () => {});
process.on('SIGINT', () => {});
process.stdin.on('data', () => {});
if (process.stdin.isTTY === false) process.stdin.resume();
setInterval(() => {}, 1000);
`
  fs.writeFileSync(file, code, "utf8")
  return file
}

async function waitForAlive(host: PrivateWorkerHost, timeoutMs = 2000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (host.isAlive()) return true
    await new Promise((r) => setTimeout(r, 25))
  }
  return host.isAlive()
}

describe("Host retained lastProc disposal after shutdown timeout (real child ignored SIGTERM)", () => {
  it("shutdown returning false after host nulled proc leaves lastProc alive and host disposal kills exact retained child", async () => {
    const helper = makeHelperScript()
    const dir = path.dirname(helper)
    const host = new PrivateWorkerHost({
      command: process.execPath,
      args: [helper],
      initializeTimeoutMs: 5000,
    })
    let retainedPid: number | undefined
    try {
      const init = await host.start()
      expect((init as { protocolVersion: string }).protocolVersion).toBe("1.0")
      retainedPid = host.getPid()
      expect(retainedPid).toBeDefined()
      expect(host.isAlive()).toBe(true)
      expect(host.getState()).toBe("open")
      const ping = (await host.request("ping")) as { pong: boolean }
      expect(ping.pong).toBe(true)

      // shutdown with short timeout should return false because child ignores SIGTERM
      const ok = await host.shutdown(200)
      expect(ok).toBe(false)
      // Host.shutdown calls dispose() and nulls active proc, but lastProc retained
      expect(host.getState()).toBe("closed")
      const retained = host.getProc()
      expect(retained).not.toBeNull()
      expect(retained?.pid).toBe(retainedPid)
      // liveness is via exact proc exitCode/signalCode, not host state
      expect(host.isAlive()).toBe(true)
      expect(retained?.exitCode).toBeNull()
      expect(retained?.signalCode).toBeNull()

      // Second dispose (as service pending disposal would) must kill exact retained child
      host.dispose()
      const exited = await host.waitForExit(3000)
      expect(exited).toBe(true)
      expect(host.hasExited()).toBe(true)
      expect(host.isAlive()).toBe(false)
    } finally {
      try {
        const p = host.getProc()
        if (p && p.exitCode === null && p.signalCode === null) {
          try {
            p.kill("SIGKILL" as unknown as NodeJS.Signals)
          } catch {}
        }
      } catch {}
      try {
        await host.waitForExit(2000)
      } catch {}
      host.dispose()
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {}
    }
  }, 15000)

  it("service disposal kills/awaits retained exact child after shutdown timeout left pending", async () => {
    const helper = makeHelperScript()
    const dir = path.dirname(helper)
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-svc-retained-"))
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
    const svc = new PrivateObservationService({
      enabled: true,
      dbPath,
      env: xdg,
      command: process.execPath,
      args: [helper],
      initializeTimeoutMs: 5000,
    })
    let oldHost: PrivateWorkerHost | null = null
    let oldPid: number | undefined
    try {
      const init = await svc.initialize()
      expect((init as { protocolVersion: string }).protocolVersion).toBe("1.0")
      expect(svc.isStarted()).toBe(true)
      oldHost = svc.getHost()
      expect(oldHost).not.toBeNull()
      oldPid = oldHost!.getPid()
      expect(oldPid).toBeDefined()
      expect(oldHost!.isAlive()).toBe(true)

      // Trigger reconnect which does bounded shutdown (2000ms) of old host.
      // With graceful fallback (1000ms SIGKILL), shutdown may succeed via fallback within 2000ms
      // or time out and retain pending ownership — both prove bounded exact-PID cleanup.
      let err: unknown
      let reconnectResult: unknown = undefined
      try {
        reconnectResult = await svc.reconnect()
      } catch (e) {
        err = e
      }
      if (err !== undefined) {
        expect(String((err as Error).message)).toMatch(/shutdown timed out|reconnect aborted/i)
        expect(svc.getHost()).toBeNull()
        const pending = svc.getPendingShutdownHost()
        expect(pending).not.toBeNull()
        expect(pending).toBe(oldHost)
        const pendingProc = svc.getPendingShutdownProc() ?? pending!.getProc()
        expect(pendingProc?.pid).toBe(oldPid)
        expect(pending!.isAlive()).toBe(true)

        // Service disposal must kill exact pending child via bounded SIGKILL fallback and await its exit
        const pendingRef = pending!
        svc.dispose()
        const exited = await pendingRef.waitForExit(3000)
        expect(exited).toBe(true)
        expect(pendingRef.hasExited()).toBe(true)
        // Pending child must have been terminated via exact-PID SIGKILL after grace
        expect(pendingRef.getProc()?.signalCode).toBe("SIGKILL")
        expect(svc.getPendingShutdownHost()).toBeNull()
        expect(svc.getPendingShutdownProc()).toBeNull()
        expect(svc.getHost()).toBeNull()
        oldHost = null
      } else {
        // Bounded fallback succeeded within shutdown timeout — old child was SIGKILLed and service restarted
        expect((reconnectResult as { protocolVersion: string }).protocolVersion).toBe("1.0")
        expect(svc.getHost()).not.toBeNull()
        expect(svc.getHost()).not.toBe(oldHost)
        expect(svc.getPendingShutdownHost()).toBeNull()
        expect(svc.getPendingShutdownProc()).toBeNull()
        // Old host exact PID must have exited via SIGKILL fallback (bounded graceful + SIGKILL)
        const exitedOld = await oldHost!.waitForExit(500)
        expect(exitedOld).toBe(true)
        expect(oldHost!.hasExited()).toBe(true)
        expect(oldHost!.getProc()?.signalCode).toBe("SIGKILL")
        // New host is alive
        expect(svc.getHost()!.isAlive()).toBe(true)
        oldHost = null
      }
    } finally {
      if (oldHost) {
        try {
          const p = oldHost.getProc()
          if (p && p.exitCode === null && p.signalCode === null) {
            try {
              p.kill("SIGKILL" as unknown as NodeJS.Signals)
            } catch {}
          }
          await oldHost.waitForExit(2000).catch(() => {})
        } catch {}
        try {
          oldHost.dispose()
        } catch {}
      }
      try {
        svc.dispose()
      } catch {}
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {}
      try {
        fs.rmSync(tmp, { recursive: true, force: true })
      } catch {}
      const lease = path.join(path.dirname(path.dirname(dbPath)), `.kilo-${path.basename(path.dirname(dbPath))}.lease.json`)
      try {
        fs.rmSync(lease, { force: true })
      } catch {}
    }
  }, 20000)

  it("normal disposal gives child SIGTERM grace before SIGKILL — graceful exits without escalation, ignored SIGTERM proves bounded SIGKILL", async () => {
    // Graceful path must exit via SIGTERM/exitCode without SIGKILL escalation
    const gracefulHelper = makeGracefulHelperScript()
    const gracefulDir = path.dirname(gracefulHelper)
    const gracefulHost = new PrivateWorkerHost({
      command: process.execPath,
      args: [gracefulHelper],
      initializeTimeoutMs: 5000,
    })
    try {
      const init = await gracefulHost.start()
      expect((init as { protocolVersion: string }).protocolVersion).toBe("1.0")
      expect(gracefulHost.isAlive()).toBe(true)
      const proc = gracefulHost.getProc()
      expect(proc).not.toBeNull()
      const pid = proc!.pid
      expect(pid).toBeDefined()
      const t0 = Date.now()
      gracefulHost.dispose()
      // Wait boundedly for graceful exit — must happen well before 1000ms SIGKILL grace
      const exitedQuick = await gracefulHost.waitForExit(800)
      const elapsed = Date.now() - t0
      expect(exitedQuick).toBe(true)
      expect(elapsed).toBeLessThan(800)
      expect(gracefulHost.hasExited()).toBe(true)
      // Graceful exit must not be via SIGKILL — either exitCode 0 or SIGTERM, never SIGKILL
      const after = gracefulHost.getProc()
      expect(after?.signalCode).not.toBe("SIGKILL")
      // Exact PID still observable after graceful dispose
      expect(after?.pid).toBe(pid)
      // Buffered timer must be cleared/ignored after exit — extra wait does not resurrect or change signal
      await new Promise((r) => setTimeout(r, 1200))
      expect(gracefulHost.hasExited()).toBe(true)
      expect(gracefulHost.getProc()?.signalCode).not.toBe("SIGKILL")
      expect(gracefulHost.isAlive()).toBe(false)
    } finally {
      try {
        const p = gracefulHost.getProc()
        if (p && p.exitCode === null && p.signalCode === null) {
          try {
            p.kill("SIGKILL" as unknown as NodeJS.Signals)
          } catch {}
        }
        await gracefulHost.waitForExit(2000).catch(() => {})
      } catch {}
      try {
        gracefulHost.dispose()
      } catch {}
      try {
        fs.rmSync(gracefulDir, { recursive: true, force: true })
      } catch {}
    }

    // Ignored-SIGTERM path still proves bounded eventual SIGKILL and exact-PID cleanup
    const ignoredHelper = makeHelperScript()
    const ignoredDir = path.dirname(ignoredHelper)
    const ignoredHost = new PrivateWorkerHost({
      command: process.execPath,
      args: [ignoredHelper],
      initializeTimeoutMs: 5000,
    })
    try {
      const init = await ignoredHost.start()
      expect((init as { protocolVersion: string }).protocolVersion).toBe("1.0")
      expect(ignoredHost.isAlive()).toBe(true)
      const t0 = Date.now()
      ignoredHost.dispose()
      // Immediately after SIGTERM, child ignoring SIGTERM must still be alive — proves grace window not bypassed
      await new Promise((r) => setTimeout(r, 200))
      expect(ignoredHost.isAlive()).toBe(true)
      expect(ignoredHost.getProc()?.exitCode).toBeNull()
      expect(ignoredHost.getProc()?.signalCode).toBeNull()
      // After bounded grace (1000ms), SIGKILL must have fired and child exited
      const exited = await ignoredHost.waitForExit(3000)
      const elapsed = Date.now() - t0
      expect(exited).toBe(true)
      expect(elapsed).toBeGreaterThanOrEqual(800)
      expect(elapsed).toBeLessThan(3000)
      expect(ignoredHost.hasExited()).toBe(true)
      expect(ignoredHost.getProc()?.signalCode).toBe("SIGKILL")
      expect(ignoredHost.isAlive()).toBe(false)
    } finally {
      try {
        const p = ignoredHost.getProc()
        if (p && p.exitCode === null && p.signalCode === null) {
          try {
            p.kill("SIGKILL" as unknown as NodeJS.Signals)
          } catch {}
        }
        await ignoredHost.waitForExit(2000).catch(() => {})
      } catch {}
      try {
        ignoredHost.dispose()
      } catch {}
      try {
        fs.rmSync(ignoredDir, { recursive: true, force: true })
      } catch {}
    }
  }, 20000)
})

describe("Failed initialization retains live child until exact exit (no replacement while live)", () => {
  it("failed initialize with ignored SIGTERM retains pending host/proc, blocks retries, and disposal kills exact child", async () => {
    const helper = makeInitTimeoutHelperScript()
    const helperDir = path.dirname(helper)
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-svc-init-retained-"))
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
    const svc = new PrivateObservationService({
      enabled: true,
      dbPath,
      env: xdg,
      command: process.execPath,
      args: [helper],
      initializeTimeoutMs: 400,
    })
    let pendingHost: PrivateWorkerHost | null = null
    let pendingProc: import("child_process").ChildProcess | null = null
    let pendingPid: number | undefined
    try {
      let firstErr: unknown
      try {
        await svc.initialize()
      } catch (e) {
        firstErr = e
      }
      expect(firstErr).toBeDefined()
      expect(String((firstErr as Error).message)).toMatch(/timed out|initialize/i)
      expect(svc.isStarted()).toBe(false)
      expect(svc.getHost()).toBeNull()
      expect(svc.getHostState()).toBe("closed")
      pendingHost = svc.getPendingShutdownHost()
      pendingProc = svc.getPendingShutdownProc()
      expect(pendingHost).not.toBeNull()
      expect(pendingProc).not.toBeNull()
      pendingPid = pendingProc?.pid
      expect(pendingPid).toBeDefined()
      expect(pendingHost!.isAlive()).toBe(true)
      expect(pendingHost!.hasExited()).toBe(false)
      expect(pendingProc!.exitCode).toBeNull()
      expect(pendingProc!.signalCode).toBeNull()
      // Exact PID retained, not host state — host is closed but proc live
      expect(pendingHost!.getState()).toBe("closed")
      expect(pendingHost!.getProc()?.pid).toBe(pendingPid)

      // Immediate retry via initialize must fail closed and not spawn replacement while pending live
      let secondErr: unknown
      try {
        await svc.initialize()
      } catch (e) {
        secondErr = e
      }
      expect(secondErr).toBeDefined()
      expect(String((secondErr as Error).message)).toMatch(/initialize aborted|shutdown timed out/i)
      expect(svc.getHost()).toBeNull()
      expect(svc.getPendingShutdownHost()).toBe(pendingHost)
      expect(svc.getPendingShutdownProc()?.pid).toBe(pendingPid)
      expect(pendingHost!.isAlive()).toBe(true)

      // Immediate reconnect must also fail closed without replacement
      let reconErr: unknown
      try {
        await svc.reconnect()
      } catch (e) {
        reconErr = e
      }
      expect(reconErr).toBeDefined()
      expect(String((reconErr as Error).message)).toMatch(/shutdown timed out|reconnect aborted/i)
      expect(svc.getHost()).toBeNull()
      expect(svc.getPendingShutdownHost()).toBe(pendingHost)
      expect(svc.getPendingShutdownHost()!.isAlive()).toBe(true)

      // Service disposal must eventually terminate the exact child via bounded SIGKILL fallback
      const ref = pendingHost!
      svc.dispose()
      const exited = await ref.waitForExit(3000)
      expect(exited).toBe(true)
      expect(ref.hasExited()).toBe(true)
      expect(ref.isAlive()).toBe(false)
      expect(ref.getProc()?.signalCode).toBe("SIGKILL")
      expect(ref.getProc()?.pid).toBe(pendingPid)
      expect(svc.getPendingShutdownHost()).toBeNull()
      expect(svc.getPendingShutdownProc()).toBeNull()
      expect(svc.getHost()).toBeNull()
      pendingHost = null
      pendingProc = null
    } finally {
      try {
        if (pendingHost) {
          const p = pendingHost.getProc()
          if (p && p.exitCode === null && p.signalCode === null) {
            try {
              p.kill("SIGKILL" as unknown as NodeJS.Signals)
            } catch {}
          }
          await pendingHost.waitForExit(2000).catch(() => {})
          try {
            pendingHost.dispose()
          } catch {}
        }
        if (pendingProc && pendingProc.exitCode === null && pendingProc.signalCode === null) {
          try {
            pendingProc.kill("SIGKILL" as unknown as NodeJS.Signals)
          } catch {}
        }
      } catch {}
      try {
        svc.dispose()
      } catch {}
      try {
        fs.rmSync(helperDir, { recursive: true, force: true })
      } catch {}
      try {
        fs.rmSync(tmp, { recursive: true, force: true })
      } catch {}
      const lease = path.join(path.dirname(path.dirname(dbPath)), `.kilo-${path.basename(path.dirname(dbPath))}.lease.json`)
      try {
        fs.rmSync(lease, { force: true })
      } catch {}
    }
  }, 15000)
})
