/* eslint-disable complexity */
// P4.4-G3-B8 production evidence: ServerManager → real `kilo serve` child →
// fd3/fd4 → same AppLayer `session/children` (parity-only, read-only).
// SDK HTTP (`client.session.children`) remains the sole authority; the
// private path is non-blocking parity diagnostics only (no state/event/error
// impact, no mutation/durable operation, no fixture output change).
// Darwin + Linux run; other platforms skip per B4 convention. Windows/live
// Extension Host evidence is not claimed. Process-global VS Code/env mutation
// is serialized with the B5 tests via server-manager-b5-global-serialization
// (reuse only, no B5 test edits). Limitations: child seeding uses SDK create
// with parentID (no live LLM); no replacement-epoch or live Extension Host
// proof.
import { describe, expect, test } from "bun:test"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import * as vscode from "vscode"
import { ServerManager } from "./server-manager"
import {
  ServePrivatePeer,
  canonicalChildrenOpId,
  compareChildrenParity,
  getSdkHttpStatus,
  normalizePrivateChildrenWire,
  validateChildrenResult,
} from "./serve-private-peer"
import { observeSessionChildrenParityDetached } from "../../kilo-provider/session-children-parity"
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

function childIdOf(item: unknown): string {
  if (!isRecord(item)) throw new Error("expected record child")
  const id = item.id
  if (typeof id !== "string") throw new Error("expected string child.id")
  return id
}

describe("ServerManager → real kilo serve → fd3/fd4 → SessionChildren parity-only production", () => {
  test.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
    "covers initialize session/children capability + nonempty private children vs SDK authoritative + missing + cross-directory + invalid boundaries + invalid-wire exclusion + fail-closed cleanup",
    async () => {
      const extensionPath = path.resolve(import.meta.dir, "../../..")
      const binPath = path.join(extensionPath, "bin", process.platform === "win32" ? "kilo.exe" : "kilo")
      expect(fs.existsSync(binPath)).toBeTrue()
      const stat = fs.statSync(binPath)
      expect(stat.isFile()).toBeTrue()
      expect(stat.size).toBeGreaterThan(10_000_000)
      const mtimeAge = Date.now() - stat.mtimeMs
      console.log(`[b8-prod] bin mtime age ms=${mtimeAge} size=${stat.size}`)

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
        workspaceRaw = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-prod-b8-ws-"))
        workspace = fs.realpathSync(workspaceRaw)
        peerDirRaw = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-prod-b8-peer-"))
        peerDir = fs.realpathSync(peerDirRaw)
        storage = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-prod-b8-storage-"))
        xdgData = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-prod-b8-xdg-"))
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

        // 2. Initialize private peer against fd3/fd4; require session/children.
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
        if (Array.isArray(caps)) expect(caps.includes("session/children")).toBeTrue()
        else {
          const str = JSON.stringify(caps ?? "")
          expect(str.includes("session/children") || str.includes("children")).toBeTrue()
        }
        expect(peer.hasCapability("session/children")).toBeTrue()

        // 3. SDK client against the same child; SDK is the sole authority.
        const auth = `Basic ${Buffer.from(`kilo:${inst.password}`).toString("base64")}`
        const client = createKiloClient({
          baseUrl: `http://127.0.0.1:${inst.port}`,
          headers: { Authorization: auth },
        })
        const created = await client.session.create({ directory: workspace, title: "prod-b8-parent" })
        expect((created as unknown as { error?: unknown }).error).toBeUndefined()
        const parent = (created as unknown as { data: { id: string; directory: string; title: string } }).data
        expect(parent.id.startsWith("ses")).toBeTrue()

        // Seed two children via SDK create with parentID (nonempty list).
        const seedA = await client.session.create({ directory: workspace, parentID: parent.id, title: "prod-b8-kid-a" })
        expect((seedA as unknown as { error?: unknown }).error).toBeUndefined()
        const kidA = (seedA as unknown as { data: { id: string; parentID: string } }).data
        expect(kidA.parentID).toBe(parent.id)
        const seedB = await client.session.create({ directory: workspace, parentID: parent.id, title: "prod-b8-kid-b" })
        expect((seedB as unknown as { error?: unknown }).error).toBeUndefined()
        const kidB = (seedB as unknown as { data: { id: string; parentID: string } }).data
        expect(kidB.parentID).toBe(parent.id)

        // 4. SDK children authoritative: nonempty unordered list via SDK.
        const sdkKids = await client.session.children({ sessionID: parent.id, directory: workspace })
        expect((sdkKids as unknown as { error?: unknown }).error).toBeUndefined()
        const sdkItems = (sdkKids as unknown as { data: unknown[] }).data
        expect(Array.isArray(sdkItems)).toBeTrue()
        expect(sdkItems.length).toBe(2)
        expect(sdkItems.map(childIdOf).sort()).toEqual([kidA.id, kidB.id].sort())

        // 5. Private same-directory nonempty read over fd3/fd4; explicit valid outcome.
        const token = crypto.randomUUID().replace(/-/g, "").slice(0, 8)
        const opId = canonicalChildrenOpId(parent.id, token)
        const req = {
          v: 1 as const,
          requestId: crypto.randomUUID(),
          opId,
          op: "session/children" as const,
          idempotencyKey: opId,
          context: { directory: workspace, parentSessionId: parent.id },
          payload: {},
        }
        const outcome = await peer.privateChildrenOutcomeWithHandle(req as unknown as never).promise
        expect(outcome.kind).toBe("valid")
        if (outcome.kind !== "valid") throw new Error(`expected valid wire outcome, got ${outcome.kind}`)
        const priv = outcome.result
        expect(priv.v).toBe(1)
        expect(priv.requestId).toBe(req.requestId)
        expect(priv.opId).toBe(opId)
        expect(priv.op).toBe("session/children")
        expect(priv.idempotencyKey).toBe(opId)
        expect(priv.status).toBe("succeeded")
        if (priv.status === "succeeded") {
          expect(priv.accepted).toBeTrue()
          expect(Array.isArray(priv.data.children)).toBeTrue()
          expect(opId.startsWith(`children:${parent.id}:`)).toBeTrue()
          expect(() => validateChildrenResult(priv as unknown, req as unknown as never)).not.toThrow()
          for (const item of priv.data.children as unknown[]) {
            if (!isRecord(item)) throw new Error("expected record child")
            expect(item.parentID).toBe(parent.id)
            expect(typeof item.directory).toBe("string")
            expect(typeof item.title).toBe("string")
          }
          expect((priv.data.children as unknown[]).map(childIdOf).sort()).toEqual([kidA.id, kidB.id].sort())
        }

        // 6. Parity diagnostics only: SDK agreement on the unordered child set, no authority change.
        const parity = compareChildrenParity(priv, { data: sdkItems } as unknown as never, parent.id)
        expect(parity.divergence).toBeNull()

        // 7. SDK authority / non-blocking: SDK snapshot untouched by private
        // read; detached observer returns synchronously and leaves SDK data intact.
        const beforeSdk = JSON.stringify(sdkItems)
        const parityConn = {
          isPrivateAvailable: () => peer!.isAvailable(),
          privateChildrenOutcomeWithHandle: (r: unknown) => peer!.privateChildrenOutcomeWithHandle(r as never),
          getPrivateEpoch: () => peer!.getEpoch(),
        }
        const ret = observeSessionChildrenParityDetached(
          parityConn as unknown as Parameters<typeof observeSessionChildrenParityDetached>[0],
          sdkKids as unknown as Parameters<typeof observeSessionChildrenParityDetached>[1],
          parent.id,
          workspace,
          3000,
        )
        expect(ret).toBeUndefined()
        expect(JSON.stringify((sdkKids as unknown as { data: unknown }).data)).toBe(beforeSdk)
        await new Promise((r) => setTimeout(r, 300))
        expect(JSON.stringify((sdkKids as unknown as { data: unknown }).data)).toBe(beforeSdk)

        // 8. Failure parity: missing parent fails on both sides with 404 class.
        const missingId = `ses_b8missing${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`
        const sdkMissing = await client.session.children({ sessionID: missingId, directory: workspace })
        expect((sdkMissing as unknown as { error?: unknown }).error).not.toBeUndefined()
        const missHttp = getSdkHttpStatus(
          sdkMissing as unknown as { response?: unknown; error?: unknown; data?: unknown },
        )
        expect(missHttp).toBe(404)
        const missToken = crypto.randomUUID().replace(/-/g, "").slice(0, 8)
        const missOpId = canonicalChildrenOpId(missingId, missToken)
        const missReq = {
          v: 1 as const,
          requestId: crypto.randomUUID(),
          opId: missOpId,
          op: "session/children" as const,
          idempotencyKey: missOpId,
          context: { directory: workspace, parentSessionId: missingId },
          payload: {},
        }
        const missOutcome = await peer.privateChildrenOutcomeWithHandle(missReq as unknown as never).promise
        expect(missOutcome.kind).toBe("valid")
        if (missOutcome.kind !== "valid")
          throw new Error(`expected valid wire outcome for missing parent, got ${missOutcome.kind}`)
        expect(missOutcome.result.status).toBe("failed")
        if (missOutcome.result.status === "failed") {
          expect(missOutcome.result.failure.code).toBe("session.not_found")
          expect(() => validateChildrenResult(missOutcome.result as unknown, missReq as unknown as never)).not.toThrow()
        }
        const missParity = compareChildrenParity(missOutcome.result, sdkMissing as unknown as never, missingId)
        expect(missParity.divergence).toBeNull()

        // 9. Cross-directory isolation: same parentId via a different
        // directory binds strictly — private fails scope_mismatch.
        const xToken = crypto.randomUUID().replace(/-/g, "").slice(0, 8)
        const xOpId = canonicalChildrenOpId(parent.id, xToken)
        const xReq = {
          v: 1 as const,
          requestId: crypto.randomUUID(),
          opId: xOpId,
          op: "session/children" as const,
          idempotencyKey: xOpId,
          context: { directory: peerDir, parentSessionId: parent.id },
          payload: {},
        }
        const xOutcome = await peer.privateChildrenOutcomeWithHandle(xReq as unknown as never).promise
        expect(xOutcome.kind).toBe("valid")
        if (xOutcome.kind !== "valid")
          throw new Error(`expected valid wire outcome for cross-directory children, got ${xOutcome.kind}`)
        expect(xOutcome.result.status).toBe("failed")
        if (xOutcome.result.status === "failed") {
          expect(xOutcome.result.failure.code).toBe("scope_mismatch")
        }

        // 10. Strict boundary: a non-empty payload is rejected client-side
        // before any wire traffic (fail-closed, no data, no retry), and the
        // server's `validation.failed` outcome shape validates and maps to
        // the SDK 400 class. Wire-level invalid-payload rejection is covered
        // by the CLI fd-carrier children tests; here the extension proves
        // strict client validation plus safe failed-outcome handling.
        const badToken = crypto.randomUUID().replace(/-/g, "").slice(0, 8)
        const badOpId = canonicalChildrenOpId(parent.id, badToken)
        const badReq = {
          v: 1 as const,
          requestId: crypto.randomUUID(),
          opId: badOpId,
          op: "session/children" as const,
          idempotencyKey: badOpId,
          context: { directory: workspace, parentSessionId: parent.id },
          payload: { filter: "x" },
        }
        let rejected = ""
        try {
          peer.privateChildrenOutcomeWithHandle(badReq as unknown as never)
        } catch (e) {
          rejected = e instanceof Error ? e.message : String(e)
        }
        expect(rejected).toContain("payload must be empty object")
        const vfToken = crypto.randomUUID().replace(/-/g, "").slice(0, 8)
        const vfOpId = canonicalChildrenOpId(parent.id, vfToken)
        const vfReq = {
          v: 1 as const,
          requestId: crypto.randomUUID(),
          opId: vfOpId,
          op: "session/children" as const,
          idempotencyKey: vfOpId,
          context: { directory: workspace, parentSessionId: parent.id },
          payload: {},
        }
        const vfResult = {
          v: 1,
          requestId: vfReq.requestId,
          opId: vfReq.opId,
          op: "session/children",
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
        expect(() => validateChildrenResult(vfResult as unknown, vfReq as unknown as never)).not.toThrow()
        const vfParity = compareChildrenParity(
          vfResult as unknown as never,
          { data: undefined, error: { status: 400 }, response: { status: 400 } } as unknown as never,
          parent.id,
        )
        expect(vfParity.divergence).toBeNull()

        // 11. Direct-helper invalid-wire exclusion: normalizePrivateChildrenWire
        // reports explicit invalid without entering comparator logic. This is a
        // helper-level assertion, not live invalid wire over fd3/fd4.
        const malformed = {
          v: 1,
          requestId: req.requestId,
          opId: req.opId,
          op: "session/children",
          idempotencyKey: req.idempotencyKey,
          status: "succeeded",
          outcome: { type: "succeeded", time: Date.now() },
          accepted: true,
          data: { children: [{ id: 1 }] },
        }
        const wire = normalizePrivateChildrenWire(malformed, req as unknown as never)
        expect(wire.kind).toBe("invalid")
        if (wire.kind !== "invalid") throw new Error("expected invalid wire outcome for non-object child entry")

        // 12. Private unavailable fallback while SDK stays authoritative.
        peer.dispose()
        expect(peer.isAvailable()).toBeFalse()
        const afterPeerClose = await client.session.children({ sessionID: parent.id, directory: workspace })
        expect((afterPeerClose as unknown as { error?: unknown }).error).toBeUndefined()
        let threw = false
        try {
          peer.privateChildrenOutcomeWithHandle(req as unknown as never)
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
