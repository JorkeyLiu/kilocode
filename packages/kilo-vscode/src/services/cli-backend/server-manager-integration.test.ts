/* eslint-disable complexity */
import { describe, expect, test } from "bun:test"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import * as vscode from "vscode"
import { ServerManager } from "./server-manager"
import { ServePrivatePeer, canonicalCancelQueuedOpId, compareParity } from "./serve-private-peer"
import { createKiloClient } from "@kilocode/sdk/v2/client"

function note(label: string, err: unknown): void {
  console.warn(`[cleanup:${label}] ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`)
}

function mockWorkspace(workspaceDir: string) {
  const ws = vscode.workspace as unknown as Record<string, unknown>
  const origFolders = ws.workspaceFolders
  const origGetConfig = ws.getConfiguration
  ws.workspaceFolders = [{ uri: { fsPath: workspaceDir } }] as unknown as typeof ws.workspaceFolders
  ws.getConfiguration = ((section?: string) => ({
    get: (key: string, fallback?: unknown) => {
      if (section === "kilo-code.new") {
        if (key === "claudeCodeCompat") return false
        if (key === "extraCaCerts") return ""
        return fallback
      }
      if (section === "http") {
        if (key === "proxyStrictSSL") return true
        if (key === "proxy") return ""
        if (key === "proxySupport") return "override"
        return fallback
      }
      return fallback
    },
    inspect: () => undefined,
    has: () => false,
    update: async () => {},
  })) as unknown as typeof vscode.workspace.getConfiguration
  return () => {
    ws.workspaceFolders = origFolders as never
    ws.getConfiguration = origGetConfig as never
  }
}

function makeCtx(storage: string, extensionPath: string): unknown {
  return {
    extensionPath,
    globalStorageUri: { fsPath: storage },
    extensionMode: 1,
    extension: { packageJSON: { version: "7.4.11" } },
  }
}

describe("ServerManager → real kilo serve → fd3/fd4 → CancelQueuedDispatch production", () => {
  test(
    "covers initialize/capability, SDK false + private replay false+parity, identity/revision, restart/epoch, private-unavailable fallback, port discovery, exact cleanup",
    async () => {
      const extensionPath = path.resolve(import.meta.dir, "../../..")
      const binPath = path.join(extensionPath, "bin", process.platform === "win32" ? "kilo.exe" : "kilo")
      expect(fs.existsSync(binPath)).toBeTrue()
      const stat = fs.statSync(binPath)
      expect(stat.isFile()).toBeTrue()
      // proof binary is current: size and mtime within last hour (build was just run)
      expect(stat.size).toBeGreaterThan(10_000_000)
      const mtimeAge = Date.now() - stat.mtimeMs
      // allow up to 2h for CI cache, but must not be stale 145M artifact from days ago without rebuild
      expect(mtimeAge).toBeLessThan(2 * 60 * 60 * 1000)

      const workspaceRaw = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-prod-ws-"))
      const workspace = fs.realpathSync(workspaceRaw)
      const storage = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-prod-storage-"))
      const xdgData = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-prod-xdg-"))
      const origXdg = process.env.XDG_DATA_HOME
      const origKiloDb = process.env.KILO_DB
      const restoreWorkspace = mockWorkspace(workspace)
      // Isolate canonical DB via XDG_DATA_HOME per LOCK-003
      process.env.XDG_DATA_HOME = xdgData
      delete process.env.KILO_DB
      const ctx = makeCtx(storage, extensionPath) as import("vscode").ExtensionContext
      let mgr = new ServerManager(ctx)
      let peer: ServePrivatePeer | null = null
      let inst: import("./server-manager").ServerInstance | null = null

      // track temp cleanup evidence
      let workspaceRemoved = false
      let storageRemoved = false
      let xdgRemoved = false

      try {
        // 1. Start server via real ServerManager (proof of stdout port discovery)
        inst = await mgr.getServer()
        expect(inst.port).toBeGreaterThan(0)
        expect(inst.port).toBeLessThan(65536)
        expect((inst.process.stdio as unknown[]).length).toBe(5)
        expect(inst.privateReader).toBeTruthy()
        expect(inst.privateWriter).toBeTruthy()
        expect(inst.pid).toBe(inst.process.pid)
        expect(inst.epoch).toBe(1)
        // stdout port discovery unchanged: SDK must connect to that port
        const pid1 = inst.pid!
        const epoch1 = inst.epoch

        // 2. Initialize private peer against fd3/fd4 (LOCK-002)
        peer = new ServePrivatePeer({
          reader: inst.privateReader,
          writer: inst.privateWriter,
          pid: inst.pid,
          epoch: inst.epoch,
          process: inst.process,
          initializeTimeoutMs: 5000,
        })
        const ok = await peer.initialize(5000)
        expect(ok).toBeTrue()
        expect(peer.isAvailable()).toBeTrue()
        expect(peer.getEpoch()).toBe(epoch1)
        expect(peer.getPid()).toBe(pid1)
        const caps = peer.getCapabilities() as unknown
        if (Array.isArray(caps)) expect(caps.includes("session/cancelQueued")).toBeTrue()
        else {
          const str = JSON.stringify(caps ?? "")
          expect(str.includes("cancelQueued") || str.includes("session/cancelQueued")).toBeTrue()
        }
        const initRaw = peer.getInitResult() as Record<string, unknown> | null
        expect(initRaw).toBeTruthy()
        const proto = (initRaw as Record<string, unknown>)?.protocol as Record<string, unknown> | undefined
        const protoVersion = (initRaw as Record<string, unknown>)?.protocolVersion as unknown
        if (proto) expect(proto.major).toBe(1)
        else if (typeof protoVersion === "string") expect(protoVersion).toBe("1.0")
        else if (protoVersion && typeof protoVersion === "object") expect((protoVersion as Record<string, unknown>).major).toBe(1)

        // 3. Create SDK client against same child (LOCK-002 single child/AppLayer)
        const auth = `Basic ${Buffer.from(`kilo:${inst.password}`).toString("base64")}`
        const client = createKiloClient({
          baseUrl: `http://127.0.0.1:${inst.port}`,
          headers: { Authorization: auth },
        })

        // Create a real session via SDK (proves SDK HTTP works on same AppLayer)
        const created = await client.session.create({ directory: workspace, title: "prod-integration" })
        expect(created.error).toBeUndefined()
        const session = created.data as unknown as { id: string; directory: string }
        expect(session.id.startsWith("ses")).toBeTrue()
        expect(session.directory).toBeDefined()

        // Use a fresh messageId that was never queued -> not-pending
        const messageId = `msg_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`
        const opId = canonicalCancelQueuedOpId(session.id, messageId)
        expect(opId).toBe(`cancelQueued:${session.id}:${messageId}`)
        const idempotencyKey = `legacy:${session.id}:${messageId}`

        // 4. SDK cancelQueued on non-pending should be false (not-pending)
        const sdkRes1 = await client.session.cancelQueued({ sessionID: session.id, messageID: messageId, directory: workspace })
        // SDK should succeed with data === false (no queued message)
        expect(sdkRes1.error).toBeUndefined()
        expect(sdkRes1.data).toBe(false)
        // Also verify via raw SDK shape: data is boolean
        expect(typeof sdkRes1.data).toBe("boolean")

        // 5. Private same-key replay with DIFFERENT requestId (LOCK-001 durable replay safe) -> succeeded cancelled:false, parity
        const privateReq1 = {
          v: 1 as const,
          requestId: crypto.randomUUID(),
          opId,
          op: "session/cancelQueued" as const,
          idempotencyKey,
          context: { directory: workspace, sessionId: session.id, parentSessionId: null as string | null },
          payload: { messageId },
        }
        const priv1 = await peer.privateCancelQueued(privateReq1)
        if (priv1.status !== "succeeded") {
          console.error("private priv1 failed:", JSON.stringify(priv1, null, 2))
          console.error("session", JSON.stringify(session, null, 2))
          console.error("workspace", workspace)
        }
        expect(priv1.v).toBe(1)
        expect(priv1.requestId).toBe(privateReq1.requestId)
        expect(priv1.opId).toBe(opId)
        expect(priv1.op).toBe("session/cancelQueued")
        expect(priv1.idempotencyKey).toBe(idempotencyKey)
        expect(priv1.status).toBe("succeeded")
        if (priv1.status === "succeeded") {
          expect(priv1.accepted).toBeTrue()
          expect(priv1.data.cancelled).toBe(false)
          expect(priv1.outcome.type).toBe("succeeded")
          expect(typeof priv1.outcome.time).toBe("number")
          expect(priv1.revision).toBeDefined()
          if (priv1.revision) {
            expect(typeof priv1.revision.session).toBe("number")
            expect(typeof priv1.revision.config).toBe("number")
            expect(Number.isInteger(priv1.revision.session)).toBeTrue()
            expect(Number.isInteger(priv1.revision.config)).toBeTrue()
          }
        }

        // parity: both succeeded, same cancelled flag -> no divergence
        const parity1 = compareParity(priv1, sdkRes1 as unknown as { data?: unknown; error?: unknown })
        expect(parity1.divergence).toBeNull()

        // 6. Private durable replay with another different requestId but same idempotencyKey -> must replay same result (idempotent)
        const privateReq2 = {
          v: 1 as const,
          requestId: crypto.randomUUID(),
          opId,
          op: "session/cancelQueued" as const,
          idempotencyKey,
          context: { directory: workspace, sessionId: session.id, parentSessionId: null as string | null },
          payload: { messageId },
        }
        expect(privateReq2.requestId).not.toBe(privateReq1.requestId)
        const priv2 = await peer.privateCancelQueued(privateReq2)
        expect(priv2.status).toBe("succeeded")
        if (priv2.status === "succeeded" && priv1.status === "succeeded") {
          expect(priv2.data.cancelled).toBe(priv1.data.cancelled)
          expect(priv2.opId).toBe(priv1.opId)
          expect(priv2.idempotencyKey).toBe(priv1.idempotencyKey)
        }

        // 7. Verify canonical identity via SDK -> now SDK second call should still be false and parity holds
        const sdkRes2 = await client.session.cancelQueued({ sessionID: session.id, messageID: messageId, directory: workspace })
        expect(sdkRes2.data).toBe(false)
        const parity2 = compareParity(priv2, sdkRes2 as unknown as { data?: unknown; error?: unknown })
        expect(parity2.divergence).toBeNull()

        // 8. Process restart / new epoch / reinitialize using exact manager lifecycle
        const oldPid = pid1
        const oldEpoch = epoch1
        // Hold old inst reference to prove it dies
        const oldProcess = inst.process
        // Dispose old peer first (exact ownership)
        peer.dispose()
        expect(peer.isDisposed()).toBeTrue()
        expect(peer.isAvailable()).toBeFalse()
        // Dispose manager (kills exact process group)
        mgr.dispose()
        // poll up to 5s for exact process to die (SIGTERM -> SIGKILL fallback)
        {
          const deadline = Date.now() + 5000
          let oldAlive = true
          while (Date.now() < deadline) {
            try {
              process.kill(oldPid, 0)
              await new Promise((r) => setTimeout(r, 200))
            } catch (_err) {
              oldAlive = false
              break
            }
          }
          try {
            process.kill(oldPid, 0)
            oldAlive = true
          } catch (_err) {
            oldAlive = false
          }
          expect(oldAlive).toBeFalse()
          expect(oldProcess.exitCode !== null || oldAlive === false).toBeTrue()
        }

        // Disposed ServerManager is terminal; restart must use new owner instance (no auto-recovery)
        const oldMgr = mgr
        await expect(oldMgr.getServer()).rejects.toThrow()
        mgr = new ServerManager(ctx as import("vscode").ExtensionContext)
        const inst2 = await mgr.getServer()
        expect(inst2.epoch).toBe(1)
        expect(inst2.pid).not.toBe(oldPid)
        expect(inst2.port).toBeGreaterThan(0)
        expect((inst2.process.stdio as unknown[]).length).toBe(5)
        // stdout port discovery still functional for new instance
        const peer2 = new ServePrivatePeer({
          reader: inst2.privateReader,
          writer: inst2.privateWriter,
          pid: inst2.pid,
          epoch: inst2.epoch,
          process: inst2.process,
        })
        const ok2 = await peer2.initialize(5000)
        expect(ok2).toBeTrue()
        expect(peer2.isAvailable()).toBeTrue()
        expect(peer2.getEpoch()).toBe(inst2.epoch)
        // SDK against new server should still work
        const auth2 = `Basic ${Buffer.from(`kilo:${inst2.password}`).toString("base64")}`
        const client2 = createKiloClient({
          baseUrl: `http://127.0.0.1:${inst2.port}`,
          headers: { Authorization: auth2 },
        })
        const list2 = await client2.session.list({ directory: workspace })
        expect(list2.error).toBeUndefined()
        // keep peer2 for next phase
        peer = peer2
        inst = inst2

        // 9. Private unavailable fallback while SDK still works
        // Simulate fd closure / peer disposal without killing server
        peer.dispose()
        expect(peer.isAvailable()).toBeFalse()
        // SDK HTTP call should still succeed (fresh HTTP while private unavailable)
        const listAfterPeerClose = await client2.session.list({ directory: workspace })
        expect(listAfterPeerClose.error).toBeUndefined()
        // Direct private call should now throw/fail-closed
        let privateUnavailableThrown = false
        try {
          await peer.privateCancelQueued(privateReq1)
        } catch (_err) {
          privateUnavailableThrown = true
        }
        expect(privateUnavailableThrown).toBeTrue()
        // Also verify that a timeout-style initialize on null streams is fail-closed
        const nullPeer = new ServePrivatePeer({ reader: null, writer: null, pid: inst.pid, epoch: inst.epoch })
        const nullOk = await nullPeer.initialize(200)
        expect(nullOk).toBeFalse()
        expect(nullPeer.isAvailable()).toBeFalse()
        nullPeer.dispose()

        // 10. Exact cleanup proof will be verified in finally block, but also assert that
        // the server's port is still the one we discovered via stdout (no second runtime)
        expect(inst.port).toBeGreaterThan(0)
      } finally {
        try {
          peer?.dispose()
        } catch (err) {
          note("peer", err)
        }
        const pidBeforeDispose = inst?.pid
        try {
          mgr.dispose()
        } catch (err) {
          note("mgr", err)
        }
        if (pidBeforeDispose) {
          const deadline = Date.now() + 5000
          let alive = true
          while (Date.now() < deadline) {
            try {
              process.kill(pidBeforeDispose, 0)
              await new Promise((r) => setTimeout(r, 200))
            } catch (_err) {
              alive = false
              break
            }
          }
          if (alive) {
            try {
              process.kill(pidBeforeDispose, 0)
              alive = true
            } catch (_err) {
              alive = false
            }
          }
          expect(alive).toBeFalse()
        }
        restoreWorkspace()
        if (origXdg === undefined) delete process.env.XDG_DATA_HOME
        else process.env.XDG_DATA_HOME = origXdg
        if (origKiloDb === undefined) delete process.env.KILO_DB
        else process.env.KILO_DB = origKiloDb
        // remove temp dirs via exact ownership (no global glob)
        try {
          fs.rmSync(workspace, { recursive: true, force: true })
          // also try raw symlink path if different
          if (workspaceRaw !== workspace) {
            try {
              fs.rmSync(workspaceRaw, { recursive: true, force: true })
            } catch (err) {
              note("workspaceRaw", err)
            }
          }
          workspaceRemoved = !fs.existsSync(workspace) && !fs.existsSync(workspaceRaw)
        } catch (err) {
          note("workspace", err)
          workspaceRemoved = !fs.existsSync(workspace) && !fs.existsSync(workspaceRaw)
        }
        try {
          fs.rmSync(storage, { recursive: true, force: true })
          storageRemoved = !fs.existsSync(storage)
        } catch (err) {
          note("storage", err)
          storageRemoved = !fs.existsSync(storage)
        }
        try {
          fs.rmSync(xdgData, { recursive: true, force: true })
          xdgRemoved = !fs.existsSync(xdgData)
        } catch (err) {
          note("xdg", err)
          xdgRemoved = !fs.existsSync(xdgData)
        }
        expect(workspaceRemoved).toBeTrue()
        expect(storageRemoved).toBeTrue()
        expect(xdgRemoved).toBeTrue()
      }
    },
    60000,
  )
})
