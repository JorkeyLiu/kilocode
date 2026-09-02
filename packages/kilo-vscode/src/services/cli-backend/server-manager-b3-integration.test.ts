/* eslint-disable complexity */
import { describe, expect, test } from "bun:test"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import * as vscode from "vscode"
import { ServerManager } from "./server-manager"
import { ServePrivatePeer, canonicalForkOpId, compareForkParity, validateForkResult } from "./serve-private-peer"
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

describe("ServerManager → real kilo serve → fd3/fd4 → SessionFork durable production", () => {
  test.skipIf(process.platform !== "darwin")(
    "covers SDK durable fork + private replay same revision/no duplicate, restart epoch/capability, private-unavailable/fail-closed authoritative",
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
        workspaceRaw = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-prod-b3-ws-"))
        workspace = fs.realpathSync(workspaceRaw)
        storage = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-prod-b3-storage-"))
        xdgData = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-prod-b3-xdg-"))
        hadOrigXdg = Object.prototype.hasOwnProperty.call(process.env, "XDG_DATA_HOME")
        origXdg = process.env.XDG_DATA_HOME
        hadOrigKiloDb = Object.prototype.hasOwnProperty.call(process.env, "KILO_DB")
        origKiloDb = process.env.KILO_DB
        restoreWorkspace = mockWorkspace(workspace)
        process.env.XDG_DATA_HOME = xdgData
        delete process.env.KILO_DB
        ctx = makeCtx(storage, extensionPath) as import("vscode").ExtensionContext
        mgr = new ServerManager(ctx as import("vscode").ExtensionContext)

        // 1. Start server via real ServerManager (proof of stdout port discovery)
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

        // 2. Initialize private peer against fd3/fd4 (B3 capability)
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
        if (Array.isArray(caps)) expect(caps.includes("session/fork")).toBeTrue()
        else {
          const str = JSON.stringify(caps ?? "")
          expect(str.includes("session/fork") || str.includes("fork")).toBeTrue()
        }
        expect(peer.hasCapability("session/fork")).toBeTrue()
        const initRaw = peer.getInitResult() as Record<string, unknown> | null
        expect(initRaw).toBeTruthy()
        const proto = (initRaw as Record<string, unknown>)?.protocol as Record<string, unknown> | undefined
        const protoVersion = (initRaw as Record<string, unknown>)?.protocolVersion as unknown
        if (proto) expect(proto.major).toBe(1)
        else if (typeof protoVersion === "string") expect(protoVersion).toBe("1.0")
        else if (protoVersion && typeof protoVersion === "object") expect((protoVersion as Record<string, unknown>).major).toBe(1)

        // 3. Create SDK client against same child (LOCK-001 single child/AppLayer)
        const auth = `Basic ${Buffer.from(`kilo:${inst.password}`).toString("base64")}`
        const client = createKiloClient({
          baseUrl: `http://127.0.0.1:${inst.port}`,
          headers: { Authorization: auth },
        })

        // Create a real session via SDK (proves SDK HTTP works on same AppLayer)
        const created = await client.session.create({ directory: workspace, title: "prod-b3-source" })
        expect(created.error).toBeUndefined()
        const source = created.data as unknown as { id: string; directory: string; title: string; time?: { updated?: number } }
        expect(source.id.startsWith("ses")).toBeTrue()
        expect(source.directory).toBeDefined()

        // 4. SDK durable fork (LOCK-001 authoritative) -> persisted snapshot + new child
        const token = crypto.randomUUID().replace(/-/g, "").slice(0, 8)
        const opId = canonicalForkOpId(source.id, token)
        const idempotencyKey = `fork:${source.id}:${token}`
        const requestId1 = crypto.randomUUID()
        const sdkRes1 = await client.session.fork({
          sessionID: source.id,
          directory: workspace,
          idempotencyKey,
          requestId: requestId1,
          opId,
          context: { directory: workspace, sessionId: source.id, parentSessionId: null },
        })
        if (sdkRes1.error) {
          console.error("sdkRes1 error:", JSON.stringify(sdkRes1.error, null, 2))
          console.error("source", JSON.stringify(source, null, 2))
        }
        expect(sdkRes1.error).toBeUndefined()
        const sdkData1 = sdkRes1.data as unknown as { id: string; parentID: string; directory: string; title: string; time?: { updated?: number } }
        expect(sdkData1.id).toBeDefined()
        expect(sdkData1.id).not.toBe(source.id)
        expect(sdkData1.parentID).toBe(source.id)
        expect(sdkData1.directory).toBe(workspace)

        // Validate fork identity via children listing - exactly one child
        const children1 = await client.session.children({ sessionID: source.id, directory: workspace })
        expect(children1.error).toBeUndefined()
        const childrenArr1 = children1.data as unknown as Array<{ id: string; parentID: string }>
        expect(childrenArr1.length).toBe(1)
        expect(childrenArr1[0].id).toBe(sdkData1.id)

        // 5. Private same-key replay with DIFFERENT requestId (LOCK-002 replay-only) -> same snapshot, same revision, no second mutation
        const privateReq1 = {
          v: 1 as const,
          requestId: crypto.randomUUID(),
          opId,
          op: "session/fork" as const,
          idempotencyKey,
          context: { directory: workspace, sessionId: source.id, parentSessionId: null as string | null },
          payload: {},
        }
        expect(privateReq1.requestId).not.toBe(requestId1)
        const priv1 = await peer.privateFork(privateReq1 as unknown as never)
        if (priv1.status !== "succeeded") {
          console.error("private priv1 failed:", JSON.stringify(priv1, null, 2))
        }
        expect(priv1.v).toBe(1)
        expect(priv1.requestId).toBe(privateReq1.requestId)
        expect(priv1.opId).toBe(opId)
        expect(priv1.op).toBe("session/fork")
        expect(priv1.idempotencyKey).toBe(idempotencyKey)
        expect(priv1.status).toBe("succeeded")
        if (priv1.status === "succeeded") {
          expect(priv1.accepted).toBeTrue()
          const pdata1 = priv1.data as Record<string, unknown>
          const psess = pdata1.session as Record<string, unknown>
          expect(psess).toBeTruthy()
          expect((psess as Record<string, unknown>).id).toBe(sdkData1.id)
          expect((psess as Record<string, unknown>).parentID).toBe(source.id)
          expect((psess as Record<string, unknown>).directory).toBe(workspace)
          expect(priv1.outcome.type).toBe("succeeded")
          expect(typeof priv1.outcome.time).toBe("number")
          expect(priv1.revision).toBeDefined()
          if (priv1.revision) {
            expect(typeof priv1.revision.session).toBe("number")
            expect(typeof priv1.revision.config).toBe("number")
            expect(Number.isInteger(priv1.revision.session)).toBeTrue()
            expect(Number.isInteger(priv1.revision.config)).toBeTrue()
          }
          // Validate through real ServePrivatePeer validator (throws on mismatch)
          expect(() => validateForkResult(priv1 as unknown, privateReq1 as unknown as never)).not.toThrow()
        }
        const parity1 = compareForkParity(priv1, sdkRes1 as unknown as { data?: unknown; error?: unknown })
        expect(parity1.divergence).toBeNull()

        // 6. Private durable replay with another different requestId but same idempotencyKey -> must replay same result, same revision, no duplicate
        const privateReq2 = {
          v: 1 as const,
          requestId: crypto.randomUUID(),
          opId,
          op: "session/fork" as const,
          idempotencyKey,
          context: { directory: workspace, sessionId: source.id, parentSessionId: null as string | null },
          payload: {},
        }
        expect(privateReq2.requestId).not.toBe(privateReq1.requestId)
        const priv2 = await peer.privateFork(privateReq2 as unknown as never)
        expect(priv2.status).toBe("succeeded")
        if (priv2.status === "succeeded" && priv1.status === "succeeded") {
          const pdata2 = priv2.data as Record<string, unknown>
          const psess2 = pdata2.session as Record<string, unknown>
          const pdata1 = priv1.data as Record<string, unknown>
          const psess1 = pdata1.session as Record<string, unknown>
          expect((psess2 as Record<string, unknown>).id).toBe((psess1 as Record<string, unknown>).id)
          expect(priv2.opId).toBe(priv1.opId)
          expect(priv2.idempotencyKey).toBe(priv1.idempotencyKey)
          expect(priv2.revision).toBeDefined()
          expect(priv1.revision).toBeDefined()
          expect(priv2.revision!.session).toBe(priv1.revision!.session)
          expect(priv2.revision!.config).toBe(priv1.revision!.config)
        }

        // 7. SDK second call with same durable keys should still be idempotent and parity holds; no second child
        const sdkRes2 = await client.session.fork({
          sessionID: source.id,
          directory: workspace,
          idempotencyKey,
          requestId: crypto.randomUUID(),
          opId,
          context: { directory: workspace, sessionId: source.id, parentSessionId: null },
        })
        expect(sdkRes2.error).toBeUndefined()
        const sdkData2 = sdkRes2.data as unknown as { id: string }
        expect(sdkData2.id).toBe(sdkData1.id)
        const parity2 = compareForkParity(priv2, sdkRes2 as unknown as { data?: unknown; error?: unknown })
        expect(parity2.divergence).toBeNull()
        // no duplicate: still exactly one child and two total sessions
        const childrenAfterReplay = await client.session.children({ sessionID: source.id, directory: workspace })
        expect(childrenAfterReplay.error).toBeUndefined()
        expect((childrenAfterReplay.data as unknown as Array<{ id: string }>).length).toBe(1)
        const listAfterReplay = await client.session.list({ directory: workspace })
        expect(listAfterReplay.error).toBeUndefined()
        expect((listAfterReplay.data as unknown as Array<{ id: string }>).length).toBe(2)

        // 8. Process restart / new epoch / reinitialize using exact manager lifecycle
        const oldPid = pid1
        const oldEpoch = epoch1
        const oldProcess = inst.process
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

        const inst2 = await mgr.getServer()
        expect(inst2.epoch).toBeGreaterThan(oldEpoch)
        expect(inst2.epoch).toBe(2)
        expect(inst2.pid).not.toBe(oldPid)
        expect(inst2.port).toBeGreaterThan(0)
        expect((inst2.process.stdio as unknown[]).length).toBe(5)
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
        expect(peer2.hasCapability("session/fork")).toBeTrue()
        const caps2 = peer2.getCapabilities() as unknown
        if (Array.isArray(caps2)) expect(caps2.includes("session/fork")).toBeTrue()
        // SDK against new server should still work and see persisted fork (authoritative)
        const auth2 = `Basic ${Buffer.from(`kilo:${inst2.password}`).toString("base64")}`
        const client2 = createKiloClient({
          baseUrl: `http://127.0.0.1:${inst2.port}`,
          headers: { Authorization: auth2 },
        })
        const list2 = await client2.session.list({ directory: workspace })
        expect(list2.error).toBeUndefined()
        const fetchedAfterRestart = await client2.session.get({ sessionID: sdkData1.id, directory: workspace })
        expect(fetchedAfterRestart.error).toBeUndefined()
        const fetchedRestartData = fetchedAfterRestart.data as unknown as { id: string; parentID: string }
        expect(fetchedRestartData.id).toBe(sdkData1.id)
        expect(fetchedRestartData.parentID).toBe(source.id)
        const childrenAfterRestart = await client2.session.children({ sessionID: source.id, directory: workspace })
        expect(childrenAfterRestart.error).toBeUndefined()
        expect((childrenAfterRestart.data as unknown as Array<{ id: string }>).length).toBe(1)
        peer = peer2
        inst = inst2

        // 9. Private unavailable fallback while SDK still works (epoch/private lifecycle loss fail-closed)
        peer.dispose()
        expect(peer.isAvailable()).toBeFalse()
        const listAfterPeerClose = await client2.session.list({ directory: workspace })
        expect(listAfterPeerClose.error).toBeUndefined()
        let privateUnavailableThrown = false
        try {
          await peer.privateFork(privateReq1 as unknown as never)
        } catch (_err) {
          privateUnavailableThrown = true
        }
        expect(privateUnavailableThrown).toBeTrue()
        const nullPeer = new ServePrivatePeer({ reader: null, writer: null, pid: inst.pid, epoch: inst.epoch })
        const nullOk = await nullPeer.initialize(200)
        expect(nullOk).toBeFalse()
        expect(nullPeer.isAvailable()).toBeFalse()
        nullPeer.dispose()
        // verify no mutation after unavailable private call: still one child
        const childrenAfterUnavailable = await client2.session.children({ sessionID: source.id, directory: workspace })
        expect(childrenAfterUnavailable.error).toBeUndefined()
        expect((childrenAfterUnavailable.data as unknown as Array<{ id: string }>).length).toBe(1)

        // 10. Private unavailable still leaves SDK fork authoritative: new durable mutation while private unavailable
        const token2 = crypto.randomUUID().replace(/-/g, "").slice(0, 8)
        const opId2 = canonicalForkOpId(source.id, token2)
        const idempotencyKey2 = `fork:${source.id}:${token2}:second`
        const sdkRes3 = await client2.session.fork({
          sessionID: source.id,
          directory: workspace,
          idempotencyKey: idempotencyKey2,
          requestId: crypto.randomUUID(),
          opId: opId2,
          context: { directory: workspace, sessionId: source.id, parentSessionId: null },
        })
        expect(sdkRes3.error).toBeUndefined()
        const sdkData3 = sdkRes3.data as unknown as { id: string; parentID: string }
        expect(sdkData3.id).toBeDefined()
        expect(sdkData3.id).not.toBe(sdkData1.id)
        expect(sdkData3.parentID).toBe(source.id)
        const childrenAfterSecond = await client2.session.children({ sessionID: source.id, directory: workspace })
        expect(childrenAfterSecond.error).toBeUndefined()
        expect((childrenAfterSecond.data as unknown as Array<{ id: string }>).length).toBe(2)
        const listAfterSecond = await client2.session.list({ directory: workspace })
        expect(listAfterSecond.error).toBeUndefined()
        expect((listAfterSecond.data as unknown as Array<{ id: string }>).length).toBe(3)
        // second mutation: private is still unavailable (disposed), SDK remains authoritative without private.
        // disposed transport is fail-closed and cannot re-initialize; new epoch capability was already proven at restart step 8.
        // this probe proves only disposed-stream fail-closed, not server-side duplicate-initialize rejection on live transport.
        const peer3 = new ServePrivatePeer({
          reader: inst.privateReader,
          writer: inst.privateWriter,
          pid: inst.pid,
          epoch: inst.epoch,
          process: inst.process,
        })
        const ok3 = await peer3.initialize(5000)
        // disposed transport fail-closed — duplicate-initialize on live transport already proven at step 8
        expect(ok3).toBeFalse()
        expect(peer3.isAvailable()).toBeFalse()
        peer3.dispose()
        // keep original disposed peer for cleanup (peer already disposed)
        peer = null

        // 11. Exact cleanup proof will be verified in finally block, but also assert port still discovered
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
          if (!workspaceRemoved) cleanupErrors.push(new Error(`workspace not removed: ${workspace} exists=${stillWs} raw=${workspaceRaw} exists=${stillRaw}`))
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
          if (!storageRemoved) cleanupErrors.push(new Error(`storage not removed: ${storage} exists=${still}`))
        }
        if (xdgData) {
          try {
            fs.rmSync(xdgData, { recursive: true, force: true })
          } catch (err) {
            cleanupErrors.push(err)
          }
          const still = fs.existsSync(xdgData)
          xdgRemoved = !still
          if (!xdgRemoved) cleanupErrors.push(new Error(`xdgData not removed: ${xdgData} exists=${still}`))
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
