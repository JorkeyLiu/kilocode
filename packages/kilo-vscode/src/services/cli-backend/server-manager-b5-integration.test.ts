/* eslint-disable complexity */
// P4.4-G3-B5 production evidence: ServerManager → real `kilo serve` child →
// fd3/fd4 → same AppLayer `session/status` (parity-only, read-only).
// SDK HTTP (`client.session.status`) remains the sole authority; the private
// path is non-blocking parity diagnostics only (no map/post/reconcile impact,
// no auto-retry/cutover, no Gate B-D closure claim). Darwin + Linux run;
// other platforms skip per B4 convention. Windows/Linux live Extension Host
// evidence is not claimed. Process-global VS Code/env mutation is serialized
// with the B5 composition test via server-manager-b5-global-serialization
// (LOCK-B5-005). Limitations: fresh-session idle map is empty by design (no
// non-idle status manufactured); malformed-wire exclusion below is a
// direct-helper assertion on normalizePrivateStatusWire, not live invalid wire
// over fd3/fd4; no replacement-epoch or current-cancel-throw proof here.
import { describe, expect, test } from "bun:test"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import * as vscode from "vscode"
import { ServerManager } from "./server-manager"
import {
  ServePrivatePeer,
  buildStatusOpId,
  compareStatusParity,
  normalizePrivateStatusWire,
  validateStatusResult,
} from "./serve-private-peer"
import { createKiloClient } from "@kilocode/sdk/v2/client"
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
    extensionMode: 1,
    extension: { packageJSON: { version: "7.4.11" } },
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

describe("ServerManager → real kilo serve → fd3/fd4 → SessionStatus parity-only production", () => {
  test.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
    "covers initialize session/status capability + same-directory private status vs SDK authoritative + invalid-wire exclusion + fail-closed cleanup",
    async () => {
      const extensionPath = path.resolve(import.meta.dir, "../../..")
      const binPath = path.join(extensionPath, "bin", process.platform === "win32" ? "kilo.exe" : "kilo")
      expect(fs.existsSync(binPath)).toBeTrue()
      const stat = fs.statSync(binPath)
      expect(stat.isFile()).toBeTrue()
      expect(stat.size).toBeGreaterThan(10_000_000)
      // Diagnostic only (not a freshness gate): a binary predating the B5
      // carrier fails below at initialize/capability fail-closed, which is the
      // honest signal. Rebuild-freshness proof belongs to the B4 gate.
      const mtimeAge = Date.now() - stat.mtimeMs
      console.log(`[b5-prod] bin mtime age ms=${mtimeAge} size=${stat.size}`)

      let workspaceRaw: string | undefined
      let workspace: string | undefined
      let peerDirRaw: string | undefined
      let peerDir: string | undefined
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
      let peerDirRemoved = false
      let storageRemoved = false
      let xdgRemoved = false
      const cleanupErrors: unknown[] = []

      // Serialize the whole global-mutation lifecycle (setup, use,
      // restoration) across B5 integration files (LOCK-B5-005).
      const release = await acquireB5GlobalLock()
      try {
        workspaceRaw = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-prod-b5-ws-"))
        workspace = fs.realpathSync(workspaceRaw)
        peerDirRaw = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-prod-b5-peer-"))
        peerDir = fs.realpathSync(peerDirRaw)
        storage = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-prod-b5-storage-"))
        xdgData = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-prod-b5-xdg-"))
        hadOrigXdg = Object.prototype.hasOwnProperty.call(process.env, "XDG_DATA_HOME")
        origXdg = process.env.XDG_DATA_HOME
        hadOrigKiloDb = Object.prototype.hasOwnProperty.call(process.env, "KILO_DB")
        origKiloDb = process.env.KILO_DB
        restoreWorkspace = mockWorkspace(workspace)
        process.env.XDG_DATA_HOME = xdgData
        delete process.env.KILO_DB
        ctx = makeCtx(storage, extensionPath) as import("vscode").ExtensionContext
        mgr = new ServerManager(ctx as import("vscode").ExtensionContext)

        // 1. Start server via real ServerManager (production child-process path).
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

        // 2. Initialize private peer against fd3/fd4; require session/status.
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
        if (Array.isArray(caps)) expect(caps.includes("session/status")).toBeTrue()
        else {
          const str = JSON.stringify(caps ?? "")
          expect(str.includes("session/status") || str.includes("status")).toBeTrue()
        }
        expect(peer.hasCapability("session/status")).toBeTrue()
        const initRaw = peer.getInitResult() as Record<string, unknown> | null
        expect(initRaw).toBeTruthy()
        const proto = (initRaw as Record<string, unknown>)?.protocol as Record<string, unknown> | undefined
        const protoVersion = (initRaw as Record<string, unknown>)?.protocolVersion as unknown
        if (proto) expect(proto.major).toBe(1)
        else if (typeof protoVersion === "string") expect(protoVersion).toBe("1.0")
        else if (protoVersion && typeof protoVersion === "object") expect((protoVersion as Record<string, unknown>).major).toBe(1)

        // 3. SDK client against the same child; SDK is the sole authority.
        const auth = `Basic ${Buffer.from(`kilo:${inst.password}`).toString("base64")}`
        const client = createKiloClient({
          baseUrl: `http://127.0.0.1:${inst.port}`,
          headers: { Authorization: auth },
        })
        const created = await client.session.create({ directory: workspace, title: "prod-b5-source" })
        expect((created as unknown as { error?: unknown }).error).toBeUndefined()
        const source = (created as unknown as { data: { id: string; directory: string } }).data
        expect(source.id.startsWith("ses")).toBeTrue()

        // 4. SDK status authoritative (fresh session is idle → omitted from map;
        // empty map is the expected at-rest shape, not a gap).
        const sdkStatus = await client.session.status({ directory: workspace })
        expect((sdkStatus as unknown as { error?: unknown }).error).toBeUndefined()
        const sdkData = (sdkStatus as unknown as { data: Record<string, unknown> }).data
        expect(isRecord(sdkData)).toBeTrue()
        expect(Object.keys(sdkData)).toEqual([])

        // 5. Private same-directory status over fd3/fd4; explicit valid outcome.
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
        const outcome = await peer.privateStatusOutcomeWithHandle(req as unknown as never).promise
        expect(outcome.kind).toBe("valid")
        if (outcome.kind !== "valid") throw new Error(`expected valid wire outcome, got ${outcome.kind}`)
        const priv = outcome.result
        expect(priv.v).toBe(1)
        expect(priv.requestId).toBe(req.requestId)
        expect(priv.opId).toBe(opId)
        expect(priv.op).toBe("session/status")
        expect(priv.idempotencyKey).toBe(opId)
        expect(priv.status).toBe("succeeded")
        if (priv.status === "succeeded") {
          expect(priv.accepted).toBeTrue()
          expect(isRecord(priv.data.statuses)).toBeTrue()
          expect(Object.keys(priv.data.statuses)).toEqual([])
          expect(opId.startsWith("status:")).toBeTrue()
          expect(() => validateStatusResult(priv as unknown, req as unknown as never)).not.toThrow()
        }

        // 6. Parity diagnostics only: SDK agreement at rest, no authority change.
        const parity = compareStatusParity(priv, { data: sdkData } as unknown as never)
        expect(parity.divergence).toBeNull()
        if (priv.status === "succeeded") {
          expect(Object.keys(priv.data.statuses)).toEqual(Object.keys(sdkData))
        }

        // 7. Same-directory isolation: peer directory sees an empty map.
        const token2 = crypto.randomUUID().replace(/-/g, "").slice(0, 8)
        const opId2 = buildStatusOpId(token2)
        const req2 = {
          v: 1 as const,
          requestId: crypto.randomUUID(),
          opId: opId2,
          op: "session/status" as const,
          idempotencyKey: opId2,
          context: { directory: peerDir },
          payload: {},
        }
        const outcome2 = await peer.privateStatusOutcomeWithHandle(req2 as unknown as never).promise
        expect(outcome2.kind).toBe("valid")
        if (outcome2.kind !== "valid") throw new Error(`expected valid wire outcome, got ${outcome2.kind}`)
        expect(outcome2.result.status).toBe("succeeded")
        if (outcome2.result.status === "succeeded") {
          expect(Object.keys(outcome2.result.data.statuses)).toEqual([])
        }
        const sdkPeer = await client.session.status({ directory: peerDir })
        expect((sdkPeer as unknown as { error?: unknown }).error).toBeUndefined()
        const sdkPeerData = (sdkPeer as unknown as { data: Record<string, unknown> }).data
        const parity2 = compareStatusParity(outcome2.result, { data: sdkPeerData } as unknown as never)
        expect(parity2.divergence).toBeNull()

        // 8. Direct-helper invalid-wire exclusion: normalizePrivateStatusWire
        // reports explicit invalid without entering comparator logic. This is a
        // helper-level assertion, not live invalid wire over fd3/fd4.
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
        if (wire.kind !== "invalid") throw new Error("expected invalid wire outcome for bogus status type")

        // 9. Private unavailable fallback while SDK stays authoritative.
        peer.dispose()
        expect(peer.isAvailable()).toBeFalse()
        const listAfterPeerClose = await client.session.status({ directory: workspace })
        expect((listAfterPeerClose as unknown as { error?: unknown }).error).toBeUndefined()
        let threw = false
        try {
          await peer.privateStatus(req as unknown as never)
        } catch (_err) {
          threw = true
        }
        expect(threw).toBeTrue()
        const nullPeer = new ServePrivatePeer({ reader: null, writer: null, pid: inst.pid, epoch: inst.epoch })
        const nullOk = await nullPeer.initialize(200)
        expect(nullOk).toBeFalse()
        expect(nullPeer.isAvailable()).toBeFalse()
        nullPeer.dispose()
        peer = null

        expect(inst.port).toBeGreaterThan(0)
      } finally {
        try {
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
        for (const [label, raw, real] of [
          ["workspace", workspaceRaw, workspace],
          ["peerDir", peerDirRaw, peerDir],
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
            else peerDirRemoved = !still
            if (still) cleanupErrors.push(new Error(`${label} not removed: ${real}`))
          } else if (raw) {
            try {
              fs.rmSync(raw, { recursive: true, force: true })
            } catch (err) {
              cleanupErrors.push(err)
            }
            const gone = !fs.existsSync(raw)
            if (label === "workspace") workspaceRemoved = gone
            else peerDirRemoved = gone
            if (!gone) cleanupErrors.push(new Error(`${label}Raw not removed: ${raw}`))
          }
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
        // Cleanup assertions track only created resources so a setup failure
        // before creation cannot mask the original error.
        if (workspace ?? workspaceRaw) expect(workspaceRemoved).toBeTrue()
        if (peerDir ?? peerDirRaw) expect(peerDirRemoved).toBeTrue()
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
