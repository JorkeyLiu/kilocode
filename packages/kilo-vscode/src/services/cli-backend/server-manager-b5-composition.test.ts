/* eslint-disable complexity */
// P4.4-G3-B5 production-composition evidence via KiloConnectionService ownership.
// ServerManager (stdio/epoch owner) -> KiloConnectionService (ServePrivatePeer
// owner) -> ServePrivatePeer/session/status parity observer. SDK HTTP
// (`client.session.status`) is the sole authority; the private path is
// non-blocking parity diagnostics only (no map/post/reconcile impact,
// LOCK-B5-001). B0-B5 protocol compatibility preserved, no cutover or Gate
// B-D completion claim (LOCK-B5-002). Wire outcomes are explicit
// valid/invalid; malformed never enters comparator; current-epoch cancel
// miss/throw is fail-closed (LOCK-B5-003). A stale captured handle cleans
// only its captured peer and reports "stale" by design, but this test creates
// no replacement peer/epoch, so it proves only no-current-peer stale cleanup
// (captured-peer cleanup while the current peer is absent), not
// replacement-epoch preservation. Evidence-only: mock workspace + real `kilo
// serve` child; not live Extension Host evidence (LOCK-B5-004). Darwin +
// Linux run; other platforms skip per B4 convention. Process-global VS
// Code/env mutation is serialized with the B5 direct test via
// server-manager-b5-global-serialization (LOCK-B5-005). Limitations:
// fresh-session idle map is empty by design (no non-idle status
// manufactured); malformed-wire exclusion is a direct-helper assertion, not
// live invalid wire over fd3/fd4; no replacement-epoch or live Extension
// Host/Windows proof.
import { describe, expect, test } from "bun:test"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import * as vscode from "vscode"
import { KiloConnectionService } from "./connection-service"
import type { ServerManager } from "./server-manager"
import { ServePrivatePeer, buildStatusOpId, compareStatusParity, normalizePrivateStatusWire, validateStatusResult } from "./serve-private-peer"
import { seedSessionStatuses, type StatusParityConnection } from "../../session-status"
import { acquireB5GlobalLock } from "./server-manager-b5-global-serialization"

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
    workspaceState: { get: () => undefined, update: async () => undefined },
    extensionMode: 1,
    extension: { packageJSON: { version: "7.4.11" } },
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

describe("KiloConnectionService owns ServerManager stdio + ServePrivatePeer B5 status parity production composition", () => {
  test.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
    "covers connect/startup ownership, initialize+capability gate, SDK-first same-directory status, invalid-wire exclusion, deferred dedupe, current-miss fail-closed plus no-current-peer stale cleanup, exact cleanup",
    async () => {
      const extensionPath = path.resolve(import.meta.dir, "../../..")
      const binPath = path.join(extensionPath, "bin", process.platform === "win32" ? "kilo.exe" : "kilo")
      expect(fs.existsSync(binPath)).toBeTrue()
      const stat = fs.statSync(binPath)
      expect(stat.isFile()).toBeTrue()
      expect(stat.size).toBeGreaterThan(10_000_000)
      // Diagnostic only, not a freshness gate: an older binary fails honestly at
      // initialize/capability fail-closed. Freshness proof belongs to the B4 gate
      // so this composition task stays independent of the CLI rebuild task.
      console.log(`[b5-composition] bin size=${stat.size} mtimeAgeMs=${Date.now() - stat.mtimeMs}`)

      let workspaceRaw: string | undefined
      let workspace: string | undefined
      let storage: string | undefined
      let xdgData: string | undefined
      let origXdg: string | undefined
      let hadOrigXdg = false
      let origKiloDb: string | undefined
      let hadOrigKiloDb = false
      let restoreWorkspace: (() => void) | undefined
      let svc: KiloConnectionService | undefined
      let pidBeforeDispose: number | undefined

      let workspaceRemoved = false
      let storageRemoved = false
      let xdgRemoved = false
      const cleanupErrors: unknown[] = []

      // Serialize the whole global-mutation lifecycle (setup, use,
      // restoration) across B5 integration files (LOCK-B5-005).
      const release = await acquireB5GlobalLock()
      try {
        workspaceRaw = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-b5comp-ws-"))
        workspace = fs.realpathSync(workspaceRaw)
        storage = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-b5comp-storage-"))
        xdgData = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-b5comp-xdg-"))
        hadOrigXdg = Object.prototype.hasOwnProperty.call(process.env, "XDG_DATA_HOME")
        origXdg = process.env.XDG_DATA_HOME
        hadOrigKiloDb = Object.prototype.hasOwnProperty.call(process.env, "KILO_DB")
        origKiloDb = process.env.KILO_DB
        restoreWorkspace = mockWorkspace(workspace)
        process.env.XDG_DATA_HOME = xdgData
        delete process.env.KILO_DB
        const ctx = makeCtx(storage, extensionPath) as import("vscode").ExtensionContext

        // 1. Production composition entry: connect() owns ServerManager spawn +
        // SSE + private negotiation (no PassThrough, no manual peer wiring).
        svc = new KiloConnectionService(ctx)
        await svc.connect(workspace)
        expect(svc.getConnectionState()).toBe("connected")
        const info = svc.getServerInfo()
        expect(info).toBeTruthy()
        expect(info!.port).toBeGreaterThan(0)
        expect(info!.port).toBeLessThan(65536)
        const cfg = svc.getServerConfig()
        expect(cfg).toBeTruthy()
        expect(cfg!.baseUrl).toContain(`127.0.0.1:${info!.port}`)

        // 2. ServerManager stdio/epoch ownership through the service owner.
        const mgr = (svc as unknown as { serverManager: ServerManager }).serverManager
        const inst = await mgr.getServer()
        expect(inst.port).toBe(info!.port)
        expect((inst.process.stdio as unknown[]).length).toBe(5)
        expect(inst.privateReader).toBeTruthy()
        expect(inst.privateWriter).toBeTruthy()
        expect(inst.pid).toBe(inst.process.pid)
        expect(inst.epoch).toBeGreaterThan(0)
        pidBeforeDispose = inst.pid
        expect(svc.getPrivatePid()).toBe(inst.pid)
        expect(svc.getPrivateEpoch()).toBe(inst.epoch)

        // 3. B5 initialize + capability gate through the service owner.
        const deadline = Date.now() + 10_000
        while (!svc.isPrivateAvailable() && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 100))
        }
        expect(svc.isPrivateAvailable()).toBeTrue()
        const peer = svc.getPrivatePeer()
        expect(peer).toBeTruthy()
        expect(peer!.isAvailable()).toBeTrue()
        expect(peer!.getEpoch()).toBe(inst.epoch)
        expect(peer!.getPid()).toBe(inst.pid)
        expect(peer!.hasCapability("session/status")).toBeTrue()
        expect(peer!.hasCapability("session/status-missing-capability")).toBeFalse()
        const caps = peer!.getCapabilities() as unknown
        if (Array.isArray(caps)) expect(caps.includes("session/status")).toBeTrue()
        else expect(JSON.stringify(caps ?? "").includes("session/status")).toBeTrue()
        const initRaw = peer!.getInitResult() as Record<string, unknown> | null
        expect(initRaw).toBeTruthy()
        const proto = (initRaw as Record<string, unknown>)?.protocol as Record<string, unknown> | undefined
        expect(proto?.name).toBe("kilo-private")
        expect(proto?.major).toBe(1)

        // 4. SDK is the sole authority (LOCK-B5-001): create + status via SDK.
        const client = svc.getClient()
        const created = await client.session.create({ directory: workspace, title: "b5-composition-source" })
        expect((created as unknown as { error?: unknown }).error).toBeUndefined()
        const source = (created as unknown as { data: { id: string } }).data
        expect(source.id.startsWith("ses")).toBeTrue()
        const sdkStatus = await client.session.status({ directory: workspace })
        expect((sdkStatus as unknown as { error?: unknown }).error).toBeUndefined()
        const sdkData = (sdkStatus as unknown as { data: Record<string, unknown> }).data
        expect(isRecord(sdkData)).toBeTrue()
        // Fresh-session idle map is empty by design (idle omitted, not a gap).
        expect(Object.keys(sdkData)).toEqual([])
        expect(buildStatusOpId("probe").startsWith("status:")).toBeTrue()

        // 5. Same-directory private status via the owner wrapper (epoch-aware).
        const token = crypto.randomUUID().replace(/-/g, "").slice(0, 8)
        const opId = buildStatusOpId(token)
        const req = {
          v: 1 as const,
          requestId: crypto.randomUUID(),
          opId,
          op: "session/status" as const,
          idempotencyKey: opId,
          context: { directory: workspace },
          payload: {},
        }
        const handle = svc.privateStatusOutcomeWithHandle(req as unknown as never)
        expect(typeof handle.id).toBe("number")
        const outcome = await handle.promise
        expect(outcome.kind).toBe("valid")
        if (outcome.kind !== "valid") throw new Error(`expected valid wire outcome, got ${outcome.kind}`)
        expect(outcome.result.v).toBe(1)
        expect(outcome.result.requestId).toBe(req.requestId)
        expect(outcome.result.opId).toBe(opId)
        expect(outcome.result.op).toBe("session/status")
        expect(outcome.result.idempotencyKey).toBe(opId)
        expect(() => validateStatusResult(outcome.result as unknown, req as unknown as never)).not.toThrow()
        if (outcome.result.status === "succeeded") {
          expect(Object.keys(outcome.result.data.statuses)).toEqual(Object.keys(sdkData))
        }
        // Parity diagnostics only: agreement at rest, SDK map untouched.
        const parity = compareStatusParity(outcome.result, { data: sdkData } as unknown as never)
        expect(parity.divergence).toBeNull()

        // 6. SDK-first non-blocking observer: SDK applies first, private observes
        // detached and never mutates map/posts/reconcile (LOCK-B5-001).
        const map = new Map<string, string>()
        const posts: unknown[] = []
        const post = (msg: unknown) => {
          posts.push(msg)
        }
        const start = Date.now()
        await seedSessionStatuses(
          client as unknown as Parameters<typeof seedSessionStatuses>[0],
          workspace,
          map as unknown as Parameters<typeof seedSessionStatuses>[2],
          post,
          true,
          { connection: svc as unknown as StatusParityConnection, timeoutMs: 3000 },
        )
        const elapsed = Date.now() - start
        expect(elapsed).toBeLessThan(10_000)
        expect(map.size).toBe(Object.keys(sdkData).length)
        expect(posts.length).toBe(Object.keys(sdkData).length)
        const before = JSON.stringify([...map.entries()])
        await new Promise((r) => setTimeout(r, 800))
        expect(JSON.stringify([...map.entries()])).toBe(before)

        // 7. Deferred observer dedupe: same epoch+directory registers once.
        const inner = (svc as unknown as { deferredStatusObservers: Map<string, () => void> }).deferredStatusObservers
        const sizeBefore = inner.size
        const unsub1 = svc.addDeferredStatusObserver(workspace, () => {})
        expect(inner.size).toBe(sizeBefore + 1)
        const unsub2 = svc.addDeferredStatusObserver(workspace, () => {})
        expect(inner.size).toBe(sizeBefore + 1)
        unsub2()
        expect(inner.size).toBe(sizeBefore + 1)
        unsub1()
        expect(inner.size).toBe(sizeBefore)

        // 8. Direct-helper invalid-wire exclusion (LOCK-B5-003): helper-level
        // normalize/validate assertion, not live invalid wire over fd3/fd4, so
        // it never enters comparator logic.
        const malformed = {
          v: 1,
          requestId: req.requestId,
          opId: req.opId,
          op: "session/status",
          idempotencyKey: req.idempotencyKey,
          status: "succeeded",
          outcome: { type: "succeeded", time: Date.now() },
          accepted: true,
          data: { statuses: { ses_bogus: { type: "bogus" } } },
        }
        const wire = normalizePrivateStatusWire(malformed, req as unknown as never)
        expect(wire.kind).toBe("invalid")
        let threwValidate = false
        try {
          validateStatusResult(malformed as unknown, req as unknown as never)
        } catch {
          threwValidate = true
        }
        expect(threwValidate).toBeTrue()

        // 9. Fail-closed with no replacement peer (LOCK-B5-003): current-peer
        // cancel miss invalidates the current peer; a second captured handle
        // then exercises the no-current-peer stale path. No replacement
        // peer/epoch is created here, so this proves stale cleanup against an
        // absent current peer only, not replacement-epoch preservation.
        const tokenA = crypto.randomUUID().replace(/-/g, "").slice(0, 8)
        const opIdA = buildStatusOpId(tokenA)
        const reqA = {
          v: 1 as const,
          requestId: crypto.randomUUID(),
          opId: opIdA,
          op: "session/status" as const,
          idempotencyKey: opIdA,
          context: { directory: workspace },
          payload: {},
        }
        const tokenB = crypto.randomUUID().replace(/-/g, "").slice(0, 8)
        const opIdB = buildStatusOpId(tokenB)
        const reqB = {
          v: 1 as const,
          requestId: crypto.randomUUID(),
          opId: opIdB,
          op: "session/status" as const,
          idempotencyKey: opIdB,
          context: { directory: workspace },
          payload: {},
        }
        const pendingA = svc.privateStatusOutcomeWithHandle(reqA as unknown as never)
        const staleHandle = svc.privateStatusOutcomeWithHandle(reqB as unknown as never)
        const outA = await pendingA.promise
        expect(outA.kind).toBe("valid")
        await staleHandle.promise
        // Exact cancel after completion misses (pending already settled) and
        // must fail-closed invalidate the current peer.
        const miss = pendingA.cancel("private parity timeout")
        expect(miss).toBeFalse()
        expect(svc.isPrivateAvailable()).toBeFalse()
        expect(svc.getPrivatePeer()).toBeNull()
        expect(svc.getPrivateEpoch()).toBeNull()
        // No-current-peer stale path: the second captured handle cleans only
        // its captured peer and reports "stale". No replacement peer exists
        // in this test (current peer is still absent afterwards).
        const stale = staleHandle.cancel("private parity timeout")
        expect(stale).toBe("stale")
        expect(svc.isPrivateAvailable()).toBeFalse()
        expect(svc.getPrivatePeer()).toBeNull()
        expect(svc.getPrivateEpoch()).toBeNull()
        // SDK stays authoritative while private is fail-closed.
        const sdkAfter = await client.session.status({ directory: workspace })
        expect((sdkAfter as unknown as { error?: unknown }).error).toBeUndefined()
        let threwPrivate = false
        try {
          svc.privateStatusOutcomeWithHandle(req as unknown as never)
        } catch {
          threwPrivate = true
        }
        expect(threwPrivate).toBeTrue()
        const nullPeer = new ServePrivatePeer({ reader: null, writer: null, pid: inst.pid, epoch: inst.epoch })
        expect(await nullPeer.initialize(200)).toBeFalse()
        expect(nullPeer.isAvailable()).toBeFalse()
        nullPeer.dispose()
      } finally {
        try {
          try {
            svc?.dispose()
        } catch (err) {
          cleanupErrors.push(err)
        }
        if (pidBeforeDispose) {
          const stop = Date.now() + 5000
          let alive = true
          while (Date.now() < stop) {
            try {
              process.kill(pidBeforeDispose, 0)
              await new Promise((r) => setTimeout(r, 200))
            } catch (err) {
              const code = (err as NodeJS.ErrnoException)?.code
              if (code === "ESRCH") {
                alive = false
                break
              }
              cleanupErrors.push(err)
              break
            }
          }
          if (alive) {
            try {
              process.kill(pidBeforeDispose, 0)
            } catch (err) {
              const code = (err as NodeJS.ErrnoException)?.code
              if (code === "ESRCH") alive = false
              else cleanupErrors.push(err)
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
        for (const [label, raw, real] of [
          ["workspace", workspaceRaw, workspace],
          ["storage", storage, storage],
          ["xdg", xdgData, xdgData],
        ] as Array<[string, string | undefined, string | undefined]>) {
          if (real) {
            try {
              fs.rmSync(real, { recursive: true, force: true })
            } catch (err) {
              cleanupErrors.push(err)
            }
            if (raw && raw !== real) {
              try {
                fs.rmSync(raw, { recursive: true, force: true })
              } catch (err) {
                cleanupErrors.push(err)
              }
            }
            const still = fs.existsSync(real) || (raw ? fs.existsSync(raw) : false)
            if (label === "workspace") workspaceRemoved = !still
            if (label === "storage") storageRemoved = !still
            if (label === "xdg") xdgRemoved = !still
            if (still) cleanupErrors.push(new Error(`${label} not removed: ${real}`))
          } else if (raw) {
            // realpath setup failed after the raw workspace was created: remove
            // the raw directory so it cannot leak, without masking the primary
            // setup error (recorded separately in cleanupErrors).
            try {
              fs.rmSync(raw, { recursive: true, force: true })
            } catch (err) {
              cleanupErrors.push(err)
            }
            const gone = !fs.existsSync(raw)
            if (label === "workspace") workspaceRemoved = gone
            if (label === "storage") storageRemoved = gone
            if (label === "xdg") xdgRemoved = gone
            if (!gone) cleanupErrors.push(new Error(`${label}Raw not removed: ${raw}`))
          }
        }
        // Cleanup assertions track only created resources so a setup failure
        // before creation cannot mask the original error.
        if (workspace ?? workspaceRaw) expect(workspaceRemoved).toBeTrue()
        if (storage) expect(storageRemoved).toBeTrue()
        if (xdgData) expect(xdgRemoved).toBeTrue()
        if (cleanupErrors.length) {
          throw new Error(`cleanup failed: ${cleanupErrors.map((e) => (e instanceof Error ? e.message : String(e))).join("; ")}`)
        }
          } finally {
            await release()
          }
      }
    },
    60000,
  )
})
