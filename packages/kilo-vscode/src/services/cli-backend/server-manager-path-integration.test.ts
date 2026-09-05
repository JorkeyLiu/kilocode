/* eslint-disable complexity */
// Path production evidence: ServerManager → real `kilo serve` child →
// fd3/fd4 → same AppLayer `path/get` (parity-only, read-only).
// SDK HTTP (`client.path.get`) remains the sole authority; the private path
// is non-blocking parity diagnostics only (no state/event/error impact, no
// mutation, no path authority change). Darwin + Linux run; other platforms
// skip per B4 convention. Windows/live Extension Host evidence is not
// claimed. Process-global VS Code/env mutation is serialized with the B5
// tests via server-manager-b5-global-serialization (reuse only, no B5 test
// edits). Limitations: failure parity covers validation.failed redaction
// only (path has no missing-session 404 — routing is directory identity);
// no replacement-epoch or live Extension Host proof.
import { describe, expect, test } from "bun:test"
import * as crypto from "crypto"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import * as vscode from "vscode"
import { ServerManager } from "./server-manager"
import { ServePrivatePeer } from "./serve-private-peer"
import {
  canonicalPathOpId,
  comparePathParity,
  normalizePrivatePathWire,
  validatePathResult,
} from "./serve-private-path-contract"
import { observePathParityDetached } from "../../kilo-provider/path-parity"
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

function pathReq(dir: string, token: string, requestId: string, workspace?: string) {
  const opId = canonicalPathOpId(token)
  return {
    v: 1 as const,
    requestId,
    opId,
    op: "path/get" as const,
    idempotencyKey: opId,
    context: workspace === undefined ? { directory: dir } : { directory: dir, workspace },
    payload: {},
  }
}

describe("ServerManager → real kilo serve → fd3/fd4 → Path parity-only production", () => {
  test.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
    "covers initialize path/get capability + same-directory five fields vs SDK authoritative + workspace routing + invalid redaction + invalid-wire exclusion + fail-closed cleanup",
    async () => {
      const extensionPath = path.resolve(import.meta.dir, "../../..")
      const binPath = path.join(extensionPath, "bin", process.platform === "win32" ? "kilo.exe" : "kilo")
      expect(fs.existsSync(binPath)).toBeTrue()
      const stat = fs.statSync(binPath)
      expect(stat.isFile()).toBeTrue()
      expect(stat.size).toBeGreaterThan(10_000_000)

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

      const release = await acquireB5GlobalLock()
      try {
        workspaceRaw = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-prod-path-ws-"))
        workspace = fs.realpathSync(workspaceRaw)
        storage = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-prod-path-storage-"))
        xdgData = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-prod-path-xdg-"))
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

        // 2. Initialize private peer against fd3/fd4; require path/get.
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
        expect(peer.hasCapability("path/get")).toBeTrue()

        // 3. SDK client against the same child; SDK is the sole authority.
        const auth = `Basic ${Buffer.from(`kilo:${inst.password}`).toString("base64")}`
        const client = createKiloClient({
          baseUrl: `http://127.0.0.1:${inst.port}`,
          headers: { Authorization: auth },
        })
        const sdk = await client.path.get({ directory: workspace })
        expect((sdk as unknown as { error?: unknown }).error).toBeUndefined()
        const sdkData = (sdk as unknown as { data: Record<string, unknown> }).data
        expect(typeof sdkData.home).toBe("string")
        expect(typeof sdkData.state).toBe("string")
        expect(typeof sdkData.config).toBe("string")
        expect(typeof sdkData.worktree).toBe("string")
        expect(typeof sdkData.directory).toBe("string")

        // 4. Private same-directory read over fd3/fd4; explicit valid outcome.
        const req = pathReq(workspace, crypto.randomUUID().replace(/-/g, "").slice(0, 8), crypto.randomUUID())
        const outcome = await peer.privatePathOutcomeWithHandle(req as unknown as never).promise
        expect(outcome.kind).toBe("valid")
        if (outcome.kind !== "valid") throw new Error(`expected valid wire outcome, got ${outcome.kind}`)
        const priv = outcome.result
        expect(priv.v).toBe(1)
        expect(priv.requestId).toBe(req.requestId)
        expect(priv.opId).toBe(req.opId)
        expect(priv.op).toBe("path/get")
        expect(priv.idempotencyKey).toBe(req.opId)
        expect(priv.status).toBe("succeeded")
        if (priv.status === "succeeded") {
          expect(priv.accepted).toBeTrue()
          expect(Object.keys(priv.data.path).sort()).toEqual(["config", "directory", "home", "state", "worktree"])
          // Globals are process-global: private and SDK agree without
          // directory binding; directory is the routed identity.
          expect(priv.data.path.directory).toBe(sdkData.directory)
          expect(() => validatePathResult(priv as unknown, req as unknown as never)).not.toThrow()
        }

        // 5. Parity diagnostics only: directory-derived agreement, globals excluded.
        const parity = comparePathParity(priv as never, sdk as never)
        expect(parity.divergence).toBeNull()
        expect((parity.details as Record<string, unknown>).globalExcluded).toBeTrue()

        // 6. Workspace routing label accepted on the private side.
        const wsReq = pathReq(
          workspace,
          crypto.randomUUID().replace(/-/g, "").slice(0, 8),
          crypto.randomUUID(),
          "ws1",
        )
        const wsOutcome = await peer.privatePathOutcomeWithHandle(wsReq as unknown as never).promise
        expect(wsOutcome.kind).toBe("valid")
        if (wsOutcome.kind === "valid") {
          expect(wsOutcome.result.status).toBe("succeeded")
          expect(() => validatePathResult(wsOutcome.result as unknown, wsReq as unknown as never)).not.toThrow()
        }

        // 7. SDK authority / non-blocking: SDK snapshot untouched by private
        // reads; detached observer returns synchronously and leaves SDK intact.
        const beforeSdk = JSON.stringify(sdkData)
        const parityConn = {
          isPrivateAvailable: () => peer!.isAvailable(),
          privatePathOutcomeWithHandle: (r: unknown) => peer!.privatePathOutcomeWithHandle(r as never),
          getPrivateEpoch: () => peer!.getEpoch(),
        }
        const ret = observePathParityDetached(
          parityConn as unknown as Parameters<typeof observePathParityDetached>[0],
          sdk as unknown as Parameters<typeof observePathParityDetached>[1],
          workspace,
          undefined,
          3000,
        )
        expect(ret).toBeUndefined()
        expect(JSON.stringify((sdk as unknown as { data: unknown }).data)).toBe(beforeSdk)
        await new Promise((r) => setTimeout(r, 300))
        expect(JSON.stringify((sdk as unknown as { data: unknown }).data)).toBe(beforeSdk)

        // 8. Invalid request fails closed client-side without touching the
        // transport. Redacted failure shape asserted at helper level.
        const badOpId = canonicalPathOpId("bad-tok")
        const badReq = {
          v: 1 as const,
          requestId: crypto.randomUUID(),
          opId: badOpId,
          op: "path/get" as const,
          idempotencyKey: badOpId,
          context: { directory: "relative" },
          payload: {},
        }
        const pendingBefore = peer.getPendingCount()
        let badThrew = false
        try {
          peer.privatePathOutcomeWithHandle(badReq as unknown as never)
        } catch (err) {
          badThrew = true
          expect(String((err as Error).message).length).toBeGreaterThan(0)
        }
        expect(badThrew).toBeTrue()
        expect(peer.getPendingCount()).toBe(pendingBefore)

        // 9. Direct-helper invalid-wire exclusion (helper level, not live fd3/fd4).
        const malformed = {
          v: 1,
          requestId: req.requestId,
          opId: req.opId,
          op: "path/get",
          idempotencyKey: req.opId,
          status: "succeeded",
          outcome: { type: "succeeded", time: Date.now() },
          accepted: true,
          data: { path: { directory: "/tmp" } },
        }
        const wire = normalizePrivatePathWire(malformed, req as unknown as never)
        expect(wire.kind).toBe("invalid")
        if (wire.kind !== "invalid") throw new Error("expected invalid wire outcome for partial path")

        // 10. Private unavailable fallback while SDK stays authoritative.
        peer.dispose()
        expect(peer.isAvailable()).toBeFalse()
        const afterPeerClose = await client.path.get({ directory: workspace })
        expect((afterPeerClose as unknown as { error?: unknown }).error).toBeUndefined()
        let threw = false
        try {
          peer.privatePathOutcomeWithHandle(req as unknown as never)
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
              if (still) cleanupErrors.push(new Error(`${label} not removed: ${real}`))
            } else if (raw) {
              try {
                fs.rmSync(raw, { recursive: true, force: true })
              } catch (err) {
                cleanupErrors.push(err)
              }
              const gone = !fs.existsSync(raw)
              if (label === "workspace") workspaceRemoved = gone
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
    90000,
  )
})
