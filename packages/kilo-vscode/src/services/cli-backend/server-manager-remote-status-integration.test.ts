/* eslint-disable complexity */
// Remote-status first runtime batch: ServerManager → real `kilo serve` child →
// fd3/fd4 → process-global KiloSessions `remote/status` (parity-only, read-only).
// SDK HTTP (`client.remote.status`) remains the sole authority; the private
// path is non-blocking parity diagnostics only (no state/event/error impact,
// no enable/disable/event-stream change, no mutation/pagination/config).
// Darwin + Linux run; other platforms skip per B4 convention. Windows/live
// Extension Host evidence is not claimed. Process-global VS Code/env mutation
// is serialized with the B5 tests via server-manager-b5-global-serialization
// (reuse only, no B5 test edits).
import { describe, expect, test } from "bun:test"
import * as crypto from "crypto"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import * as vscode from "vscode"
import { ServerManager } from "./server-manager"
import {
  ServePrivatePeer,
  canonicalRemoteStatusOpId,
  compareRemoteStatusParity,
  getSdkHttpStatus,
  normalizePrivateRemoteStatusWire,
  validateRemoteStatusResult,
} from "./serve-private-peer"
import { observeRemoteStatusParityDetached } from "../../kilo-provider/remote-status-parity"
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

describe("ServerManager → real kilo serve → fd3/fd4 → RemoteStatus parity-only production", () => {
  test.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
    "covers initialize remote/status capability + process-global private snapshot vs SDK authoritative + cross-directory equality + invalid boundaries + invalid-wire exclusion + fail-closed cleanup",
    async () => {
      const extensionPath = path.resolve(import.meta.dir, "../../..")
      const binPath = path.join(extensionPath, "bin", process.platform === "win32" ? "kilo.exe" : "kilo")
      expect(fs.existsSync(binPath)).toBeTrue()
      const stat = fs.statSync(binPath)
      expect(stat.isFile()).toBeTrue()
      expect(stat.size).toBeGreaterThan(10_000_000)

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

      const release = await acquireB5GlobalLock()
      try {
        workspaceRaw = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-prod-rs-ws-"))
        workspace = fs.realpathSync(workspaceRaw)
        peerDirRaw = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-prod-rs-peer-"))
        peerDir = fs.realpathSync(peerDirRaw)
        storage = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-prod-rs-storage-"))
        xdgData = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-prod-rs-xdg-"))
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

        // 2. Initialize private peer against fd3/fd4; require remote/status.
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
        if (Array.isArray(caps)) expect(caps.includes("remote/status")).toBeTrue()
        else expect(JSON.stringify(caps ?? "").includes("remote/status")).toBeTrue()
        expect(peer.hasCapability("remote/status")).toBeTrue()

        // 3. SDK client against the same child; SDK is the sole authority.
        const auth = `Basic ${Buffer.from(`kilo:${inst.password}`).toString("base64")}`
        const client = createKiloClient({
          baseUrl: `http://127.0.0.1:${inst.port}`,
          headers: { Authorization: auth },
        })
        const sdkStatus = await client.remote.status()
        expect((sdkStatus as unknown as { error?: unknown }).error).toBeUndefined()
        const sdkData = (sdkStatus as unknown as { data: { enabled: boolean; connected: boolean } }).data
        expect(typeof sdkData.enabled).toBe("boolean")
        expect(typeof sdkData.connected).toBe("boolean")

        // 4. Private same-directory snapshot over fd3/fd4; explicit valid outcome.
        const token = crypto.randomUUID().replace(/-/g, "").slice(0, 8)
        const opId = canonicalRemoteStatusOpId(token)
        const req = {
          v: 1 as const,
          requestId: crypto.randomUUID(),
          opId,
          op: "remote/status" as const,
          idempotencyKey: opId,
          context: { directory: workspace },
          payload: {},
        }
        const outcome = await peer.privateRemoteStatusOutcomeWithHandle(req as unknown as never).promise
        expect(outcome.kind).toBe("valid")
        if (outcome.kind !== "valid") throw new Error(`expected valid wire outcome, got ${outcome.kind}`)
        const priv = outcome.result
        expect(priv.v).toBe(1)
        expect(priv.requestId).toBe(req.requestId)
        expect(priv.opId).toBe(opId)
        expect(priv.op).toBe("remote/status")
        expect(priv.idempotencyKey).toBe(opId)
        expect(priv.status).toBe("succeeded")
        if (priv.status === "succeeded") {
          expect(priv.accepted).toBeTrue()
          expect(typeof priv.data.status.enabled).toBe("boolean")
          expect(typeof priv.data.status.connected).toBe("boolean")
          expect(() => validateRemoteStatusResult(priv as unknown, req as unknown as never)).not.toThrow()
        }

        // 5. Parity diagnostics only: process-global booleans agree, no authority change.
        const parity = compareRemoteStatusParity(priv, { data: sdkData } as unknown as never)
        expect(parity.divergence).toBeNull()
        expect(parity.details.processGlobal).toBeTrue()

        // 6. SDK authority / non-blocking: SDK snapshot untouched by private
        // read; detached observer returns synchronously and leaves SDK data intact.
        const beforeSdk = JSON.stringify(sdkData)
        const parityConn = {
          isPrivateAvailable: () => peer!.isAvailable(),
          privateRemoteStatusOutcomeWithHandle: (r: unknown) => peer!.privateRemoteStatusOutcomeWithHandle(r as never),
          getPrivateEpoch: () => peer!.getEpoch(),
        }
        const ret = observeRemoteStatusParityDetached(
          parityConn as unknown as Parameters<typeof observeRemoteStatusParityDetached>[0],
          sdkStatus as unknown as Parameters<typeof observeRemoteStatusParityDetached>[1],
          workspace,
          undefined,
          3000,
        )
        expect(ret).toBeUndefined()
        expect(JSON.stringify(sdkData)).toBe(beforeSdk)
        await new Promise((r) => setTimeout(r, 300))
        expect(JSON.stringify(sdkData)).toBe(beforeSdk)

        // 7. Cross-directory equality: same process-global booleans under a
        // different routing directory are expected, not scope_mismatch.
        const xToken = crypto.randomUUID().replace(/-/g, "").slice(0, 8)
        const xOpId = canonicalRemoteStatusOpId(xToken)
        const xReq = {
          v: 1 as const,
          requestId: crypto.randomUUID(),
          opId: xOpId,
          op: "remote/status" as const,
          idempotencyKey: xOpId,
          context: { directory: peerDir },
          payload: {},
        }
        const xOutcome = await peer.privateRemoteStatusOutcomeWithHandle(xReq as unknown as never).promise
        expect(xOutcome.kind).toBe("valid")
        if (xOutcome.kind !== "valid")
          throw new Error(`expected valid wire outcome for cross-directory remote/status, got ${xOutcome.kind}`)
        expect(xOutcome.result.status).toBe("succeeded")
        if (xOutcome.result.status === "succeeded" && priv.status === "succeeded") {
          expect(xOutcome.result.data.status).toEqual(priv.data.status)
        }
        const sdkCross = await client.remote.status({ directory: peerDir })
        const sdkCrossData = (sdkCross as unknown as { data: { enabled: boolean; connected: boolean } }).data
        const xParity = compareRemoteStatusParity(xOutcome.result, { data: sdkCrossData } as unknown as never)
        expect(xParity.divergence).toBeNull()

        // 8. Failed/missing mapping: SDK failure shape is terminal and the
        // private validation.failed outcome validates; failure-class parity
        // is not overclaimed beyond shape validity here.
        const vfToken = crypto.randomUUID().replace(/-/g, "").slice(0, 8)
        const vfOpId = canonicalRemoteStatusOpId(vfToken)
        const vfReq = {
          v: 1 as const,
          requestId: crypto.randomUUID(),
          opId: vfOpId,
          op: "remote/status" as const,
          idempotencyKey: vfOpId,
          context: { directory: workspace },
          payload: {},
        }
        const vfResult = {
          v: 1,
          requestId: vfReq.requestId,
          opId: vfReq.opId,
          op: "remote/status",
          idempotencyKey: vfReq.idempotencyKey,
          status: "failed",
          outcome: {
            type: "failed",
            time: Date.now(),
            failure: { code: "validation.failed", message: "x", retryable: false },
          },
          accepted: false,
          failure: { code: "validation.failed", message: "x", retryable: false },
        }
        expect(() => validateRemoteStatusResult(vfResult as unknown, vfReq as unknown as never)).not.toThrow()
        void getSdkHttpStatus

        // 9. Strict boundary: a non-empty payload is rejected client-side
        // before any wire traffic (fail-closed, no data, no retry).
        const badToken = crypto.randomUUID().replace(/-/g, "").slice(0, 8)
        const badOpId = canonicalRemoteStatusOpId(badToken)
        const badReq = {
          v: 1 as const,
          requestId: crypto.randomUUID(),
          opId: badOpId,
          op: "remote/status" as const,
          idempotencyKey: badOpId,
          context: { directory: workspace },
          payload: { reason: "x" },
        }
        let rejected = ""
        try {
          peer.privateRemoteStatusOutcomeWithHandle(badReq as unknown as never)
        } catch (e) {
          rejected = e instanceof Error ? e.message : String(e)
        }
        expect(rejected).toContain("payload must be empty object")

        // 10. Direct-helper invalid-wire exclusion: normalize reports explicit
        // invalid without entering comparator logic. Helper-level only, not
        // live invalid wire over fd3/fd4.
        const malformed = {
          v: 1,
          requestId: req.requestId,
          opId: req.opId,
          op: "remote/status",
          idempotencyKey: req.idempotencyKey,
          status: "succeeded",
          outcome: { type: "succeeded", time: Date.now() },
          accepted: true,
          data: { status: { enabled: "yes", connected: false } },
        }
        const wire = normalizePrivateRemoteStatusWire(malformed, req as unknown as never)
        expect(wire.kind).toBe("invalid")
        if (wire.kind !== "invalid") throw new Error("expected invalid wire outcome for non-boolean payload")

        // 11. Private unavailable fallback while SDK stays authoritative.
        peer.dispose()
        expect(peer.isAvailable()).toBeFalse()
        const afterPeerClose = await client.remote.status()
        expect((afterPeerClose as unknown as { error?: unknown }).error).toBeUndefined()
        let threw = false
        try {
          peer.privateRemoteStatusOutcomeWithHandle(req as unknown as never)
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
                  new Error(
                    `cleanup probe unknown for pid ${pidBeforeDispose}: ${code ?? (err instanceof Error ? err.message : String(err))}`,
                  ),
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
                    new Error(
                      `cleanup probe unknown for pid ${pidBeforeDispose}: ${code ?? (err instanceof Error ? err.message : String(err))}`,
                    ),
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
          if (workspace ?? workspaceRaw) expect(workspaceRemoved).toBeTrue()
          if (peerDir ?? peerDirRaw) expect(peerDirRemoved).toBeTrue()
          if (storage) expect(storageRemoved).toBeTrue()
          if (xdgData) expect(xdgRemoved).toBeTrue()
          if (cleanupErrors.length) {
            throw new Error(
              `cleanup failed: ${cleanupErrors.map((e) => (e instanceof Error ? e.message : String(e))).join("; ")}`,
            )
          }
        } finally {
          await release()
        }
      }
    },
    60000,
  )
})
