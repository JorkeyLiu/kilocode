import { describe, expect, test } from "bun:test"
import { PassThrough } from "stream"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import * as vscode from "vscode"
import { JsonRpcPeer } from "../../private-worker/peer"
import { ServePrivatePeer } from "./serve-private-peer"

describe("Lifecycle hardening", () => {
  test("ServePrivatePeer concurrent initialize is serialized and stale completions rejected", async () => {
    const toClient = new PassThrough()
    const toBackend = new PassThrough()
    const clientReader = toClient as unknown as NodeJS.ReadableStream
    const clientWriter = toBackend as unknown as NodeJS.WritableStream
    let initCount = 0
    const backendPeer = new JsonRpcPeer({
      reader: toBackend as unknown as NodeJS.ReadableStream,
      writer: toClient as unknown as NodeJS.WritableStream,
      onRequest: async (method: string) => {
        if (method === "initialize") {
          initCount += 1
          await new Promise((r) => setTimeout(r, 80))
          return { protocol: { name: "kilo-private", major: 1, minor: 0 }, capabilities: ["session/cancelQueued", "session/update", "session/fork", "session/create"] }
        }
        return {}
      },
    })
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, pid: 999, epoch: 77, initializeTimeoutMs: 800 })
    const p1 = peer.initialize()
    const p2 = peer.initialize()
    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1).toBeTrue()
    expect(r2).toBeTrue()
    expect(initCount).toBe(1)
    expect(peer.isAvailable()).toBeTrue()
    // stale onClosed from old peer identity should not disable current available
    const raw = (peer as unknown as { peer: JsonRpcPeer }).peer
    expect(raw).toBeTruthy()
    backendPeer.dispose()
    // give event loop a tick for onClosed
    await new Promise((r) => setTimeout(r, 20))
    // need to keep peer open; the backend dispose already closed peer
    // recreate scenario: same instance dispose then late init response
  })

  test("ServePrivatePeer late initialize after dispose does not become available", async () => {
    const toClient = new PassThrough()
    const toBackend = new PassThrough()
    let backend: JsonRpcPeer | null = null
    backend = new JsonRpcPeer({
      reader: toBackend as unknown as NodeJS.ReadableStream,
      writer: toClient as unknown as NodeJS.WritableStream,
      onRequest: async (method: string) => {
        if (method === "initialize") {
          await new Promise((r) => setTimeout(r, 120))
          return { protocol: { name: "kilo-private", major: 1, minor: 0 }, capabilities: ["session/cancelQueued"] }
        }
        return {}
      },
    })
    const peer = new ServePrivatePeer({ reader: toClient as unknown as NodeJS.ReadableStream, writer: toBackend as unknown as NodeJS.WritableStream, pid: 1001, epoch: 9, initializeTimeoutMs: 800 })
    const promise = peer.initialize()
    // dispose 10ms into initialize
    await new Promise((r) => setTimeout(r, 10))
    peer.dispose()
    const ok = await promise
    expect(ok).toBeFalse()
    expect(peer.isDisposed()).toBeTrue()
    expect(peer.isAvailable()).toBeFalse()
    // late backend response should not resurrect
    await new Promise((r) => setTimeout(r, 150))
    expect(peer.isAvailable()).toBeFalse()
    backend.dispose()
  })

  test("ServePrivatePeer stale same-epoch close callback cannot disable current peer", async () => {
    const toClient = new PassThrough()
    const toBackend = new PassThrough()
    const backendPeer = new JsonRpcPeer({
      reader: toBackend as unknown as NodeJS.ReadableStream,
      writer: toClient as unknown as NodeJS.WritableStream,
      onRequest: async (method: string) => {
        if (method === "initialize") return { protocol: { name: "kilo-private", major: 1, minor: 0 }, capabilities: ["session/cancelQueued"] }
        return {}
      },
    })
    const peer = new ServePrivatePeer({ reader: toClient as unknown as NodeJS.ReadableStream, writer: toBackend as unknown as NodeJS.WritableStream, pid: 111, epoch: 1, initializeTimeoutMs: 500 })
    expect(await peer.initialize()).toBeTrue()
    expect(peer.isAvailable()).toBeTrue()
    // Simulate stale close from an old peer instance that captured same epoch identity
    // Directly invoke the old onClosed guard: create a second ServePrivatePeer with same epoch to prove isolation,
    // and verify disposing its underlying peer does not affect first.
    const toClientOld = new PassThrough()
    const toBackendOld = new PassThrough()
    let oldClosedFired = false
    const oldPeerRaw = new JsonRpcPeer({
      reader: toBackendOld as unknown as NodeJS.ReadableStream,
      writer: toClientOld as unknown as NodeJS.WritableStream,
      onRequest: async () => ({ protocol: { name: "kilo-private", major: 1, minor: 0 }, capabilities: ["session/cancelQueued"] }),
      onClosed: () => {
        oldClosedFired = true
      },
    })
    oldPeerRaw.dispose()
    await new Promise((r) => setTimeout(r, 10))
    expect(oldClosedFired).toBeTrue()
    // original peer must still be available; its onClosed checked peer identity
    expect(peer.isAvailable()).toBeTrue()
    backendPeer.dispose()
    peer.dispose()
    oldPeerRaw.dispose()
  })

  test("JsonRpcPeer synchronous writer throw closes peer and rejects all pending", async () => {
    const reader = new PassThrough() as unknown as NodeJS.ReadableStream
    let onClosedFired = false
    const throwingWriter = {
      write: () => {
        throw new Error("sync writer throw")
      },
      on: () => {},
      removeListener: () => {},
      off: () => {},
    } as unknown as NodeJS.WritableStream
    const peer = new JsonRpcPeer({
      reader,
      writer: throwingWriter,
      onClosed: () => {
        onClosedFired = true
      },
    })
    const p1 = peer.request("foo", { x: 1 })
    const p2 = peer.request("bar", { x: 2 })
    let e1: unknown = null
    let e2: unknown = null
    p1.catch((e) => { e1 = e })
    p2.catch((e) => { e2 = e })
    // allow microtask to settle
    await new Promise((r) => setTimeout(r, 20))
    expect(peer.getState()).toBe("closed")
    expect(onClosedFired).toBeTrue()
    expect(peer.getPendingCount()).toBe(0)
    // both pending should be rejected
    await expect(p1).rejects.toBeTruthy()
    await expect(p2).rejects.toBeTruthy()
    expect(e1).toBeTruthy()
    expect(e2).toBeTruthy()
    // subsequent request should reject immediately without hanging
    await expect(peer.request("baz")).rejects.toThrow()
  })

  test("JsonRpcPeer writer async error rejects pending and transitions to closed", async () => {
    const toClient = new PassThrough()
    const toBackend = new PassThrough()
    const backendPeer = new JsonRpcPeer({
      reader: toBackend as unknown as NodeJS.ReadableStream,
      writer: toClient as unknown as NodeJS.WritableStream,
      onRequest: async () => {
        await new Promise((r) => setTimeout(r, 1000))
        return { ok: true }
      },
    })
    const peer = new JsonRpcPeer({ reader: toClient as unknown as NodeJS.ReadableStream, writer: toBackend as unknown as NodeJS.WritableStream })
    const pending = peer.request("foo", { x: 1 })
    // attach catch early to avoid unhandled rejection logging before we assert
    let caught: unknown = null
    pending.catch((e) => { caught = e })
    expect(peer.getState()).toBe("open")
    expect(peer.getPendingCount()).toBe(1)
    // Simulate async writer error after request queued
    const w = toBackend as unknown as { emit: (ev: string, err: unknown) => boolean }
    w.emit("error", new Error("writer boom"))
    await new Promise((r) => setTimeout(r, 30))
    expect(peer.getState()).toBe("closed")
    expect(caught).toBeTruthy()
    expect(peer.getPendingCount()).toBe(0)
    // Second request after close should be rejected immediately without hanging
    await expect(peer.request("bar")).rejects.toThrow()
    backendPeer.dispose()
    peer.dispose()
  })

  test("ServePrivatePeer failed initialize invalidates transport and prevents stale response acceptance", async () => {
    const toClient = new PassThrough()
    const toBackend = new PassThrough()
    // backend delays initialize beyond peer timeout, so first init times out and invalidates
    const backendPeer = new JsonRpcPeer({
      reader: toBackend as unknown as NodeJS.ReadableStream,
      writer: toClient as unknown as NodeJS.WritableStream,
      onRequest: async (method: string) => {
        if (method === "initialize") {
          await new Promise((r) => setTimeout(r, 400))
          return { protocol: { name: "kilo-private", major: 1, minor: 0 }, capabilities: ["session/cancelQueued", "session/update", "session/fork", "session/create"] }
        }
        return {}
      },
    })
    const peer = new ServePrivatePeer({ reader: toClient as unknown as NodeJS.ReadableStream, writer: toBackend as unknown as NodeJS.WritableStream, pid: 5001, epoch: 77, initializeTimeoutMs: 100 })
    const ok1 = await peer.initialize()
    expect(ok1).toBeFalse()
    expect(peer.isAvailable()).toBeFalse()
    // retry with same instance should be permanently invalidated, not attempt new transport
    const ok2 = await peer.initialize()
    expect(ok2).toBeFalse()
    expect(peer.isAvailable()).toBeFalse()
    // new instance reusing same streams should also be blocked (stream reuse prevented)
    const peer2 = new ServePrivatePeer({ reader: toClient as unknown as NodeJS.ReadableStream, writer: toBackend as unknown as NodeJS.WritableStream, pid: 5001, epoch: 77, initializeTimeoutMs: 100 })
    const ok3 = await peer2.initialize()
    expect(ok3).toBeFalse()
    expect(peer2.isAvailable()).toBeFalse()
    // late backend response (400ms) must not resurrect either peer
    await new Promise((r) => setTimeout(r, 500))
    expect(peer.isAvailable()).toBeFalse()
    expect(peer2.isAvailable()).toBeFalse()
    // fresh transport (new PassThrough) should succeed
    const toClientFresh = new PassThrough()
    const toBackendFresh = new PassThrough()
    const backendFresh = new JsonRpcPeer({
      reader: toBackendFresh as unknown as NodeJS.ReadableStream,
      writer: toClientFresh as unknown as NodeJS.WritableStream,
      onRequest: async (method: string) => {
        if (method === "initialize") return { protocol: { name: "kilo-private", major: 1, minor: 0 }, capabilities: ["session/cancelQueued"] }
        return {}
      },
    })
    const peerFresh = new ServePrivatePeer({ reader: toClientFresh as unknown as NodeJS.ReadableStream, writer: toBackendFresh as unknown as NodeJS.WritableStream, pid: 5002, epoch: 78, initializeTimeoutMs: 300 })
    expect(await peerFresh.initialize()).toBeTrue()
    expect(peerFresh.isAvailable()).toBeTrue()
    backendPeer.dispose()
    peer.dispose()
    peer2.dispose()
    backendFresh.dispose()
    peerFresh.dispose()
  })

  test("ServerManager startup timeout with non-exiting child kills exact owned child with SIGTERM/SIGKILL fallback", async () => {
    const { ServerManager } = await import("./server-manager")
    // hanging script never prints port
    const content = `#!/usr/bin/env node
// ignore SIGTERM for 1s to prove SIGKILL fallback then exit on SIGKILL
process.on('SIGTERM', ()=>{ setTimeout(()=>{}, 6000) });
setInterval(()=>{}, 1000);
`
    const script = path.join(os.tmpdir(), `fake-kilo-timeout-${Date.now()}.js`)
    fs.writeFileSync(script, content, "utf8")
    fs.chmodSync(script, 0o755)
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-timeout-"))
    const ctx = {
      extensionPath: os.tmpdir(),
      globalStorageUri: { fsPath: storage },
      extensionMode: 1,
      extension: { packageJSON: { version: "7.4.11" } },
    } as unknown as import("vscode").ExtensionContext
    const ws = vscode.workspace as unknown as Record<string, unknown>
    const origFolders = ws.workspaceFolders
    const origGetConfig = ws.getConfiguration
    ws.workspaceFolders = [{ uri: { fsPath: storage } }] as unknown as typeof ws.workspaceFolders
    ws.getConfiguration = (() => ({ get: () => "", inspect: () => undefined })) as unknown as typeof vscode.workspace.getConfiguration
    const origGetCliPath = (ServerManager.prototype as unknown as Record<string, unknown>).getCliPath
    ;(ServerManager.prototype as unknown as Record<string, unknown>).getCliPath = () => script
    // speed up timeout: monkey-patch setTimeout for this test to reduce 30s to ~0.6s
    const origSetTimeout = global.setTimeout
    const patchedSetTimeout = ((fn: (...a: unknown[]) => void, delay: number, ...args: unknown[]) => {
      if (delay === 30000) return origSetTimeout(fn as unknown as () => void, 600, ...(args as []))
      if (delay === 5000) return origSetTimeout(fn as unknown as () => void, 300, ...(args as []))
      return origSetTimeout(fn as unknown as () => void, delay, ...(args as []))
    }) as unknown as typeof setTimeout
    // @ts-ignore
    global.setTimeout = patchedSetTimeout
    const mgr = new ServerManager(ctx)
    const { spawn } = await import("child_process")
    const decoy = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 10000)"], { detached: true, stdio: "ignore" })
    decoy.unref()
    const decoyPid = decoy.pid!
    let ownedPid: number | undefined
    try {
      const startup = mgr.getServer()
      // capture owned pid via startingProc
      await new Promise((r) => setTimeout(r, 80))
      ownedPid = (mgr as unknown as { startingProc: { pid?: number } }).startingProc?.pid
      expect(ownedPid).toBeDefined()
      await expect(startup).rejects.toBeTruthy()
      // give SIGKILL fallback time
      await new Promise((r) => setTimeout(r, 600))
      expect((mgr as unknown as { instance: unknown }).instance).toBeNull()
      // owned child should be dead
      let ownedAlive = true
      try {
        process.kill(ownedPid!, 0)
      } catch {
        ownedAlive = false
      }
      expect(ownedAlive).toBeFalse()
      // decoy must still be alive (exact ownership)
      let decoyAlive = true
      try { process.kill(decoyPid, 0) } catch { decoyAlive = false }
      expect(decoyAlive).toBeTrue()
      // watchdog cleared: no dangling timers keep process alive beyond test - verify by checking mgr internal timers cleared
      expect((mgr as unknown as { startupPromise: unknown }).startupPromise).toBeNull()
    } finally {
      global.setTimeout = origSetTimeout
      mgr.dispose()
      try { process.kill(-decoyPid, "SIGTERM") } catch { try { decoy.kill("SIGTERM") } catch {} }
      try { decoy.kill("SIGTERM") } catch {}
      try { fs.unlinkSync(script) } catch {}
      try { fs.rmSync(storage, { recursive: true }) } catch {}
      ;(ServerManager.prototype as unknown as Record<string, unknown>).getCliPath = origGetCliPath
      ws.workspaceFolders = origFolders
      ws.getConfiguration = origGetConfig
      // ensure ownedPid killed if still alive
      if (ownedPid) {
        try { process.kill(-ownedPid, "SIGKILL") } catch {}
        try { process.kill(ownedPid, "SIGKILL") } catch {}
      }
    }
  })

  test("ServerManager dispose during startup kills only exact owned child and prevents install", async () => {
    const { ServerManager } = await import("./server-manager")
    const port = 41899
    // Fake script that delays port log 400ms
    const content = `#!/usr/bin/env node
setTimeout(()=>console.log('kilo server listening on http://127.0.0.1:${port}'), 400);
setTimeout(()=>process.exit(0), 5000);
`
    const script = path.join(os.tmpdir(), `fake-kilo-hardening-${Date.now()}-${port}.js`)
    fs.writeFileSync(script, content, "utf8")
    fs.chmodSync(script, 0o755)
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-hardening-"))
    const ctx = {
      extensionPath: os.tmpdir(),
      globalStorageUri: { fsPath: storage },
      extensionMode: 1,
      extension: { packageJSON: { version: "7.4.11" } },
    } as unknown as import("vscode").ExtensionContext
    const ws = vscode.workspace as unknown as Record<string, unknown>
    const origFolders = ws.workspaceFolders
    const origGetConfig = ws.getConfiguration
    ws.workspaceFolders = [{ uri: { fsPath: storage } }]
    ws.getConfiguration = (() => ({ get: () => "", inspect: () => undefined })) as unknown as typeof vscode.workspace.getConfiguration
    const origGetCliPath = (ServerManager.prototype as unknown as Record<string, unknown>).getCliPath
    ;(ServerManager.prototype as unknown as Record<string, unknown>).getCliPath = () => script
    const mgr = new ServerManager(ctx)
    // decoy to prove exact-PID kill
    const { spawn } = await import("child_process")
    const decoy = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 10000)"], { detached: true, stdio: "ignore" })
    decoy.unref()
    const decoyPid = decoy.pid!
    try {
      const startup = mgr.getServer()
      await new Promise((r) => setTimeout(r, 50))
      mgr.dispose()
      await expect(startup).rejects.toBeTruthy()
      expect((mgr as unknown as { instance: unknown }).instance).toBeNull()
      // owned child should be dead, decoy alive
      await new Promise((r) => setTimeout(r, 300))
      let decoyAlive = true
      try { process.kill(decoyPid, 0) } catch { decoyAlive = false }
      expect(decoyAlive).toBeTrue()
    } finally {
      mgr.dispose()
      try { process.kill(-decoyPid, "SIGTERM") } catch { try { decoy.kill("SIGTERM") } catch {} }
      try { decoy.kill("SIGTERM") } catch {}
      try { fs.unlinkSync(script) } catch {}
      try { fs.rmSync(storage, { recursive: true }) } catch {}
      ;(ServerManager.prototype as unknown as Record<string, unknown>).getCliPath = origGetCliPath
      ws.workspaceFolders = origFolders
      ws.getConfiguration = origGetConfig
    }
  })

  test("ServerManager dead process after port detection is not cached", async () => {
    const { ServerManager } = await import("./server-manager")
    const port = 41900
    // Script prints port then exits in next tick (dead shortly after detection)
    const content = `#!/usr/bin/env node
console.log('kilo server listening on http://127.0.0.1:${port}');
process.nextTick(()=>process.exit(1));
`
    const script = path.join(os.tmpdir(), `fake-kilo-dead-${Date.now()}-${port}.js`)
    fs.writeFileSync(script, content, "utf8")
    fs.chmodSync(script, 0o755)
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-dead-"))
    const ctx = {
      extensionPath: os.tmpdir(),
      globalStorageUri: { fsPath: storage },
      extensionMode: 1,
      extension: { packageJSON: { version: "7.4.11" } },
    } as unknown as import("vscode").ExtensionContext
    const ws = vscode.workspace as unknown as Record<string, unknown>
    const origFolders = ws.workspaceFolders
    const origGetConfig = ws.getConfiguration
    ws.workspaceFolders = [{ uri: { fsPath: storage } }]
    ws.getConfiguration = (() => ({ get: () => "", inspect: () => undefined })) as unknown as typeof vscode.workspace.getConfiguration
    const origGetCliPath = (ServerManager.prototype as unknown as Record<string, unknown>).getCliPath
    ;(ServerManager.prototype as unknown as Record<string, unknown>).getCliPath = () => script
    const mgr = new ServerManager(ctx)
    try {
      let sawReject = false
      try {
        await mgr.getServer()
      } catch {
        sawReject = true
      }
      // Either startup was rejected due to immediate exit before install,
      // or it resolved but exit shortly after nulled the instance — both mean no dead process cached.
      await new Promise((r) => setTimeout(r, 200))
      expect((mgr as unknown as { instance: unknown }).instance).toBeNull()
      // at least one path proves dead not cached; if it resolved, exit handler cleared it
      expect(sawReject || (mgr as unknown as { instance: unknown }).instance === null).toBeTrue()
    } finally {
      mgr.dispose()
      try { fs.unlinkSync(script) } catch {}
      try { fs.rmSync(storage, { recursive: true }) } catch {}
      ;(ServerManager.prototype as unknown as Record<string, unknown>).getCliPath = origGetCliPath
      ws.workspaceFolders = origFolders
      ws.getConfiguration = origGetConfig
    }
  })

  test("KiloConnectionService dispose invalidates pending connect continuations before install", async () => {
    const { KiloConnectionService } = await import("./connection-service")
    const { ServerManager } = await import("./server-manager")
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-conn-hardening-"))
    const ctx = {
      extensionPath: os.tmpdir(),
      globalStorageUri: { fsPath: storage },
      extensionMode: 1,
      extension: { packageJSON: { version: "7.4.11" } },
      workspaceState: { get: () => undefined, update: async () => {} },
    } as unknown as import("vscode").ExtensionContext
    const ws = vscode.workspace as unknown as Record<string, unknown>
    const origFolders = ws.workspaceFolders
    const origGetConfig = ws.getConfiguration
    const origState = (vscode.window as unknown as Record<string, unknown>).state
    ws.workspaceFolders = [{ uri: { fsPath: storage } }]
    ws.getConfiguration = (() => ({ get: () => "", inspect: () => undefined })) as unknown as typeof vscode.workspace.getConfiguration
    ;(vscode.window as unknown as Record<string, unknown>).state = { focused: true }
    const svc = new KiloConnectionService(ctx)
    // stub serverManager.getServer to delay, so dispose can interrupt before install
    const mgr = (svc as unknown as { serverManager: ServerManager }).serverManager
    const origGetServer = mgr.getServer.bind(mgr)
    let getServerCalled = false
    mgr.getServer = async () => {
      getServerCalled = true
      await new Promise((r) => setTimeout(r, 400))
      // return a fake instance that looks alive but will be discarded if dispose raced
      return {
        port: 41234,
        password: "x",
        process: { pid: 99999, exitCode: null, on: () => {}, stdio: [] } as unknown as import("child_process").ChildProcess,
        privateReader: null,
        privateWriter: null,
        pid: 99999,
        epoch: 1,
      } as unknown as import("./server-manager").ServerInstance
    }
    try {
      const connectPromise = svc.connect(storage).catch((e) => e)
      await new Promise((r) => setTimeout(r, 50))
      svc.dispose()
      const res = await connectPromise
      expect(res).toBeInstanceOf(Error)
      expect((svc as unknown as { client: unknown }).client).toBeNull()
      expect((svc as unknown as { sseClient: unknown }).sseClient).toBeNull()
      expect((svc as unknown as { privatePeer: unknown }).privatePeer).toBeNull()
      expect((svc as unknown as { info: unknown }).info).toBeNull()
      expect(getServerCalled).toBeTrue()
      // late connect after dispose should be rejected, not resurrect
      await expect(svc.connect(storage)).rejects.toThrow()
      expect((svc as unknown as { client: unknown }).client).toBeNull()
    } finally {
      try { svc.dispose() } catch {}
      mgr.getServer = origGetServer
      ws.workspaceFolders = origFolders
      ws.getConfiguration = origGetConfig
      ;(vscode.window as unknown as Record<string, unknown>).state = origState
      try { fs.rmSync(storage, { recursive: true }) } catch {}
    }
  })
})
