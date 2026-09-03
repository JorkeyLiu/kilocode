/* eslint-disable complexity */
import { describe, expect, test } from "bun:test"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import * as vscode from "vscode"
import { ServerManager } from "./server-manager"
import { ServePrivatePeer, canonicalCreateOpId, compareCreateParity, validateCreateResult } from "./serve-private-peer"
import { createKiloClient } from "@kilocode/sdk/v2/client"

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

describe("ServerManager → real kilo serve → fd3/fd4 → SessionCreate durable production", () => {
  test.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
    "covers SDK durable create + private replay same revision/no duplicate, restart epoch/capability, private-unavailable/fail-closed authoritative",
    async () => {
      const extensionPath = path.resolve(import.meta.dir, "../../..")
      const binPath = path.join(extensionPath, "bin", process.platform === "win32" ? "kilo.exe" : "kilo")
      expect(fs.existsSync(binPath)).toBeTrue()
      const stat = fs.statSync(binPath)
      expect(stat.isFile()).toBeTrue()
      expect(stat.size).toBeGreaterThan(10_000_000)
      const mtimeAge = Date.now() - stat.mtimeMs
      expect(mtimeAge).toBeLessThan(2 * 60 * 60 * 1000)

      let workspaceRaw: string | undefined
      let workspace: string | undefined
      let storage: string | undefined
      let xdgData: string | undefined
      let origXdg: string | undefined
      let hadOrigXdg = false
      let origKiloDb: string | undefined
      let hadOrigKiloDb = false
      let restoreWorkspace: (() => void) | undefined
      let ctx: unknown
      let mgr: ServerManager | undefined
      let peer: ServePrivatePeer | null = null
      let inst: import("./server-manager").ServerInstance | null = null

      let workspaceRemoved = false
      let storageRemoved = false
      let xdgRemoved = false
      const cleanupErrors: unknown[] = []

      try {
        workspaceRaw = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-prod-b4-ws-"))
        workspace = fs.realpathSync(workspaceRaw)
        storage = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-prod-b4-storage-"))
        xdgData = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-prod-b4-xdg-"))
        hadOrigXdg = Object.prototype.hasOwnProperty.call(process.env, "XDG_DATA_HOME")
        origXdg = process.env.XDG_DATA_HOME
        hadOrigKiloDb = Object.prototype.hasOwnProperty.call(process.env, "KILO_DB")
        origKiloDb = process.env.KILO_DB
        restoreWorkspace = mockWorkspace(workspace)
        process.env.XDG_DATA_HOME = xdgData
        delete process.env.KILO_DB
        ctx = makeCtx(storage, extensionPath) as import("vscode").ExtensionContext
        mgr = new ServerManager(ctx as import("vscode").ExtensionContext)

        // 1. Start server via real ServerManager
        inst = await mgr.getServer()
        expect(inst.port).toBeGreaterThan(0)
        expect(inst.port).toBeLessThan(65536)
        expect((inst.process.stdio as unknown[]).length).toBe(5)
        expect(inst.privateReader).toBeTruthy()
        expect(inst.privateWriter).toBeTruthy()
        expect(inst.pid).toBe(inst.process.pid)
        expect(inst.epoch).toBe(1)
        const pid1 = inst.pid!
        const epoch1 = inst.epoch

        // 2. Initialize private peer against fd3/fd4
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
        if (Array.isArray(caps)) expect(caps.includes("session/create")).toBeTrue()
        else {
          const str = JSON.stringify(caps ?? "")
          expect(str.includes("session/create") || str.includes("create")).toBeTrue()
        }
        expect(peer.hasCapability("session/create")).toBeTrue()
        const initRaw = peer.getInitResult() as Record<string, unknown> | null
        expect(initRaw).toBeTruthy()
        const proto = (initRaw as Record<string, unknown>)?.protocol as Record<string, unknown> | undefined
        const protoVersion = (initRaw as Record<string, unknown>)?.protocolVersion as unknown
        if (proto) expect(proto.major).toBe(1)
        else if (typeof protoVersion === "string") expect(protoVersion).toBe("1.0")
        else if (protoVersion && typeof protoVersion === "object") expect((protoVersion as Record<string, unknown>).major).toBe(1)

        // 3. Create SDK client against same child
        const auth = `Basic ${Buffer.from(`kilo:${inst.password}`).toString("base64")}`
        const client = createKiloClient({
          baseUrl: `http://127.0.0.1:${inst.port}`,
          headers: { Authorization: auth },
        })

        // 4. SDK durable create authoritative
        const token = crypto.randomUUID().replace(/-/g, "").slice(0, 8)
        const opId = canonicalCreateOpId(token)
        const idempotencyKey = `create:${token}`
        const requestId1 = crypto.randomUUID()
        const title1 = `prod-b4-${token}`
        const sdkRes1 = await client.session.create({
          directory: workspace,
          title: title1,
          idempotencyKey,
          requestId: requestId1,
          opId,
          context: { directory: workspace, parentSessionId: null },
        } as unknown as never)
        if ((sdkRes1 as unknown as { error?: unknown }).error) {
          console.error("sdkRes1 error", JSON.stringify((sdkRes1 as unknown as { error: unknown }).error, null, 2))
        }
        expect((sdkRes1 as unknown as { error?: unknown }).error).toBeUndefined()
        const sdkData1 = (sdkRes1 as unknown as { data: { id: string; directory: string; title: string } }).data
        expect(sdkData1.id.startsWith("ses")).toBeTrue()
        expect(sdkData1.directory).toBeDefined()
        expect(sdkData1.title).toBe(title1)

        // list should have exactly one session
        const list1 = await client.session.list({ directory: workspace } as unknown as never)
        expect((list1 as unknown as { error?: unknown }).error).toBeUndefined()
        expect(((list1 as unknown as { data: unknown[] }).data as unknown[]).length).toBe(1)

        // 5. Private same-key replay with different requestId -> same snapshot, same revision, no duplicate
        const privateReq1 = {
          v: 1 as const,
          requestId: crypto.randomUUID(),
          opId,
          op: "session/create" as const,
          idempotencyKey,
          context: { directory: workspace, parentSessionId: null as string | null },
          payload: { title: title1 },
        }
        expect(privateReq1.requestId).not.toBe(requestId1)
        const priv1 = await (peer as unknown as { privateCreate: (r: unknown) => Promise<import("./serve-private-peer").ServePrivateCreateResult> }).privateCreate(privateReq1 as unknown as never)
        if (priv1.status !== "succeeded") {
          console.error("priv1 failed", JSON.stringify(priv1, null, 2))
        }
        expect(priv1.v).toBe(1)
        expect(priv1.requestId).toBe(privateReq1.requestId)
        expect(priv1.opId).toBe(opId)
        expect(priv1.op).toBe("session/create")
        expect(priv1.idempotencyKey).toBe(idempotencyKey)
        expect(priv1.status).toBe("succeeded")
        if (priv1.status === "succeeded") {
          expect(priv1.accepted).toBeTrue()
          const pdata = priv1.data as Record<string, unknown>
          const psess = pdata.session as Record<string, unknown>
          expect(psess).toBeTruthy()
          expect((psess as Record<string, unknown>).id).toBe(sdkData1.id)
          expect((psess as Record<string, unknown>).directory).toBe(workspace)
          expect(priv1.outcome.type).toBe("succeeded")
          expect(typeof priv1.outcome.time).toBe("number")
          expect(priv1.revision).toBeDefined()
          if (priv1.revision) {
            expect(typeof priv1.revision.session).toBe("number")
            expect(typeof priv1.revision.config).toBe("number")
          }
          expect(() => validateCreateResult(priv1 as unknown, privateReq1 as unknown as never)).not.toThrow()
        }
        const parity1 = compareCreateParity(priv1, sdkRes1 as unknown as { data?: unknown; error?: unknown })
        expect(parity1.divergence).toBeNull()

        // 6. Second private replay same keys different requestId -> same id and revision
        const privateReq2 = {
          v: 1 as const,
          requestId: crypto.randomUUID(),
          opId,
          op: "session/create" as const,
          idempotencyKey,
          context: { directory: workspace, parentSessionId: null as string | null },
          payload: { title: title1 },
        }
        const priv2 = await (peer as unknown as { privateCreate: (r: unknown) => Promise<import("./serve-private-peer").ServePrivateCreateResult> }).privateCreate(privateReq2 as unknown as never)
        expect(priv2.status).toBe("succeeded")
        if (priv2.status === "succeeded" && priv1.status === "succeeded") {
          const pdata2 = (priv2.data as Record<string, unknown>).session as Record<string, unknown>
          const pdata1 = (priv1.data as Record<string, unknown>).session as Record<string, unknown>
          const id2 = (pdata2 as Record<string, unknown>).id as string
          const id1 = (pdata1 as Record<string, unknown>).id as string
          expect(id2).toBe(id1)
          expect(priv2.opId).toBe(priv1.opId)
          expect(priv2.idempotencyKey).toBe(priv1.idempotencyKey)
          expect(priv2.revision!.session).toBe(priv1.revision!.session)
        }

        // 7. SDK second call same durable keys should be idempotent
        const sdkRes2 = await client.session.create({
          directory: workspace,
          title: title1,
          idempotencyKey,
          requestId: crypto.randomUUID(),
          opId,
          context: { directory: workspace, parentSessionId: null },
        } as unknown as never)
        expect((sdkRes2 as unknown as { error?: unknown }).error).toBeUndefined()
        const sdkData2 = (sdkRes2 as unknown as { data: { id: string } }).data
        expect(sdkData2.id).toBe(sdkData1.id)
        const parity2 = compareCreateParity(priv2, sdkRes2 as unknown as { data?: unknown; error?: unknown })
        expect(parity2.divergence).toBeNull()
        const listAfterReplay = await client.session.list({ directory: workspace } as unknown as never)
        expect(((listAfterReplay as unknown as { data: unknown[] }).data as unknown[]).length).toBe(1)

        // 8. Restart / new epoch
        const oldPid = pid1
        const oldEpoch = epoch1
        const oldProcess = inst.process
        const oldMgr = mgr
        peer.dispose()
        expect(peer.isDisposed()).toBeTrue()
        expect(peer.isAvailable()).toBeFalse()
        mgr.dispose()
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
        // disposed ServerManager is terminal per LOCK-002; restart must use new owner instance (no auto-recovery)
        await expect(oldMgr.getServer()).rejects.toThrow()
        mgr = new ServerManager(ctx as import("vscode").ExtensionContext)
        const inst2 = await mgr.getServer()
        expect(inst2.epoch).toBe(1)
        expect(inst2.pid).not.toBe(oldPid)
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
        expect(peer2.hasCapability("session/create")).toBeTrue()
        const auth2 = `Basic ${Buffer.from(`kilo:${inst2.password}`).toString("base64")}`
        const client2 = createKiloClient({
          baseUrl: `http://127.0.0.1:${inst2.port}`,
          headers: { Authorization: auth2 },
        })
        const list2 = await client2.session.list({ directory: workspace } as unknown as never)
        expect((list2 as unknown as { error?: unknown }).error).toBeUndefined()
        const fetchedAfterRestart = await client2.session.get({ sessionID: sdkData1.id, directory: workspace } as unknown as never)
        expect((fetchedAfterRestart as unknown as { error?: unknown }).error).toBeUndefined()
        peer = peer2
        inst = inst2

        // 9. Private unavailable fallback while SDK still works
        peer.dispose()
        expect(peer.isAvailable()).toBeFalse()
        const listAfterPeerClose = await client2.session.list({ directory: workspace } as unknown as never)
        expect((listAfterPeerClose as unknown as { error?: unknown }).error).toBeUndefined()
        let privateUnavailableThrown = false
        try {
          await (peer as unknown as { privateCreate: (r: unknown) => Promise<unknown> }).privateCreate(privateReq1 as unknown as never)
        } catch (_err) {
          privateUnavailableThrown = true
        }
        expect(privateUnavailableThrown).toBeTrue()
        const nullPeer = new ServePrivatePeer({ reader: null, writer: null, pid: inst.pid, epoch: inst.epoch })
        const nullOk = await nullPeer.initialize(200)
        expect(nullOk).toBeFalse()
        expect(nullPeer.isAvailable()).toBeFalse()
        nullPeer.dispose()
        const listAfterUnavailable = await client2.session.list({ directory: workspace } as unknown as never)
        expect(((listAfterUnavailable as unknown as { data: unknown[] }).data as unknown[]).length).toBe(1)

        // 10. New durable create while private unavailable still authoritative
        const token2 = crypto.randomUUID().replace(/-/g, "").slice(0, 8)
        const opId2 = canonicalCreateOpId(token2)
        const idempotencyKey2 = opId2
        const title2 = `prod-b4-${token2}`
        const sdkRes3 = await client2.session.create({
          directory: workspace,
          title: title2,
          idempotencyKey: idempotencyKey2,
          requestId: crypto.randomUUID(),
          opId: opId2,
          context: { directory: workspace, parentSessionId: null },
        } as unknown as never)
        expect((sdkRes3 as unknown as { error?: unknown }).error).toBeUndefined()
        const sdkData3 = (sdkRes3 as unknown as { data: { id: string } }).data
        expect(sdkData3.id).not.toBe(sdkData1.id)
        const listAfterSecond = await client2.session.list({ directory: workspace } as unknown as never)
        expect(((listAfterSecond as unknown as { data: unknown[] }).data as unknown[]).length).toBe(2)
        const peer3 = new ServePrivatePeer({
          reader: inst.privateReader,
          writer: inst.privateWriter,
          pid: inst.pid,
          epoch: inst.epoch,
          process: inst.process,
        })
        const ok3 = await peer3.initialize(5000)
        expect(ok3).toBeFalse()
        expect(peer3.isAvailable()).toBeFalse()
        peer3.dispose()
        peer = null

        expect(inst.port).toBeGreaterThan(0)
      } finally {
        try {
          peer?.dispose()
        } catch (err) {
          cleanupErrors.push(err)
        }
        const pidBeforeDispose = inst?.pid
        try {
          mgr?.dispose()
        } catch (err) {
          cleanupErrors.push(err)
        }
        if (pidBeforeDispose) {
          const deadline = Date.now() + 5000
          let alive = true
          while (Date.now() < deadline) {
            try {
              process.kill(pidBeforeDispose, 0)
              await new Promise((r) => setTimeout(r, 200))
            } catch (err) {
              const code = (err as NodeJS.ErrnoException)?.code
              if (code === "ESRCH") {
                alive = false
                break
              }
              cleanupErrors.push(
                new Error(`cleanup probe unknown for pid ${pidBeforeDispose}: ${code ?? (err instanceof Error ? err.message : String(err))}`),
              )
              break
            }
          }
          if (alive) {
            try {
              process.kill(pidBeforeDispose, 0)
              alive = true
            } catch (err) {
              const code = (err as NodeJS.ErrnoException)?.code
              if (code === "ESRCH") alive = false
              else
                cleanupErrors.push(
                  new Error(`cleanup probe unknown for pid ${pidBeforeDispose}: ${code ?? (err instanceof Error ? err.message : String(err))}`),
                )
            }
          }
          if (alive) cleanupErrors.push(new Error(`pid ${pidBeforeDispose} still alive after dispose`))
        }
        if (restoreWorkspace) {
          try {
            restoreWorkspace()
          } catch (err) {
            cleanupErrors.push(err)
          }
        }
        try {
          if (hadOrigXdg) process.env.XDG_DATA_HOME = origXdg!
          else delete process.env.XDG_DATA_HOME
        } catch (err) {
          cleanupErrors.push(err)
        }
        try {
          if (hadOrigKiloDb) process.env.KILO_DB = origKiloDb!
          else delete process.env.KILO_DB
        } catch (err) {
          cleanupErrors.push(err)
        }
        if (workspace) {
          try {
            fs.rmSync(workspace, { recursive: true, force: true })
          } catch (err) {
            cleanupErrors.push(err)
          }
          if (workspaceRaw && workspaceRaw !== workspace) {
            try {
              fs.rmSync(workspaceRaw, { recursive: true, force: true })
            } catch (err) {
              cleanupErrors.push(err)
            }
          }
          const stillWs = fs.existsSync(workspace)
          const stillRaw = workspaceRaw ? fs.existsSync(workspaceRaw) : false
          workspaceRemoved = !stillWs && !stillRaw
          if (!workspaceRemoved) cleanupErrors.push(new Error(`workspace not removed: ${workspace}`))
        } else if (workspaceRaw) {
          try {
            fs.rmSync(workspaceRaw, { recursive: true, force: true })
          } catch (err) {
            cleanupErrors.push(err)
          }
          workspaceRemoved = !fs.existsSync(workspaceRaw)
          if (!workspaceRemoved) cleanupErrors.push(new Error(`workspaceRaw not removed: ${workspaceRaw}`))
        }
        if (storage) {
          try {
            fs.rmSync(storage, { recursive: true, force: true })
          } catch (err) {
            cleanupErrors.push(err)
          }
          const still = fs.existsSync(storage)
          storageRemoved = !still
          if (!storageRemoved) cleanupErrors.push(new Error(`storage not removed: ${storage}`))
        }
        if (xdgData) {
          try {
            fs.rmSync(xdgData, { recursive: true, force: true })
          } catch (err) {
            cleanupErrors.push(err)
          }
          const still = fs.existsSync(xdgData)
          xdgRemoved = !still
          if (!xdgRemoved) cleanupErrors.push(new Error(`xdgData not removed: ${xdgData}`))
        }
        expect(workspaceRemoved).toBeTrue()
        expect(storageRemoved).toBeTrue()
        expect(xdgRemoved).toBeTrue()
        if (cleanupErrors.length) {
          throw new Error(`cleanup failed: ${cleanupErrors.map((e) => (e instanceof Error ? e.message : String(e))).join("; ")}`)
        }
      }
    },
    60000,
  )
})
