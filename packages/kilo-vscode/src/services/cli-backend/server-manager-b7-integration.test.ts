/* eslint-disable complexity */
// P4.4-G3-B7 production evidence: ServerManager → real `kilo serve` child →
// fd3/fd4 → same AppLayer `session/messages` (parity-only, read-only).
// SDK HTTP (`client.session.messages`) remains the sole authority; the
// private path is non-blocking parity diagnostics only (no state/event/error
// impact, no mutation/durable operation, no `session/get` authority change).
// Darwin + Linux run; other platforms skip per B4 convention. Windows/live
// Extension Host evidence is not claimed. Process-global VS Code/env mutation
// is serialized with the B5 tests via server-manager-b5-global-serialization
// (reuse only, no B5 test edits). Limitations: message comparison covers an
// empty session page (no live LLM seeding; non-empty content/order parity is
// covered by synthetic unit/wiring tests); failure parity covers
// missing-session 404 class and invalid-cursor validation.failed; isolation
// covers same-session cross-directory scope_mismatch (SDK messages is
// directory-agnostic for reads, private binds directory); no
// replacement-epoch or live Extension Host proof.
import { describe, expect, test } from "bun:test"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import * as vscode from "vscode"
import { ServerManager } from "./server-manager"
import {
  ServePrivatePeer,
  canonicalMessagesOpId,
  compareMessagesParity,
  getSdkHttpStatus,
  normalizePrivateMessagesWire,
  validateMessagesResult,
} from "./serve-private-peer"
import { observeSessionMessagesParityDetached } from "../../kilo-provider/session-messages-parity"
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

describe("ServerManager → real kilo serve → fd3/fd4 → SessionMessages parity-only production", () => {
  test.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
    "covers initialize session/messages capability + same-directory private messages vs SDK authoritative + invalid-cursor + missing-session + cross-directory isolation + invalid-wire exclusion + fail-closed cleanup",
    async () => {
      const extensionPath = path.resolve(import.meta.dir, "../../..")
      const binPath = path.join(extensionPath, "bin", process.platform === "win32" ? "kilo.exe" : "kilo")
      expect(fs.existsSync(binPath)).toBeTrue()
      const stat = fs.statSync(binPath)
      expect(stat.isFile()).toBeTrue()
      expect(stat.size).toBeGreaterThan(10_000_000)
      const mtimeAge = Date.now() - stat.mtimeMs
      console.log(`[b7-prod] bin mtime age ms=${mtimeAge} size=${stat.size}`)

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
        workspaceRaw = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-prod-b7-ws-"))
        workspace = fs.realpathSync(workspaceRaw)
        peerDirRaw = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-prod-b7-peer-"))
        peerDir = fs.realpathSync(peerDirRaw)
        storage = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-prod-b7-storage-"))
        xdgData = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-prod-b7-xdg-"))
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

        // 2. Initialize private peer against fd3/fd4; require session/messages.
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
        if (Array.isArray(caps)) expect(caps.includes("session/messages")).toBeTrue()
        else {
          const str = JSON.stringify(caps ?? "")
          expect(str.includes("session/messages") || str.includes("messages")).toBeTrue()
        }
        expect(peer.hasCapability("session/messages")).toBeTrue()

        // 3. SDK client against the same child; SDK is the sole authority.
        const auth = `Basic ${Buffer.from(`kilo:${inst.password}`).toString("base64")}`
        const client = createKiloClient({
          baseUrl: `http://127.0.0.1:${inst.port}`,
          headers: { Authorization: auth },
        })
        const created = await client.session.create({ directory: workspace, title: "prod-b7-source" })
        expect((created as unknown as { error?: unknown }).error).toBeUndefined()
        const source = (created as unknown as { data: { id: string; directory: string; title: string } }).data
        expect(source.id.startsWith("ses")).toBeTrue()

        // 4. SDK messages authoritative: full read via SDK (fresh session is empty).
        const sdkFull = await client.session.messages({ sessionID: source.id, directory: workspace })
        expect((sdkFull as unknown as { error?: unknown }).error).toBeUndefined()
        const sdkItems = (sdkFull as unknown as { data: unknown[] }).data
        expect(Array.isArray(sdkItems)).toBeTrue()

        // 5. Private same-directory full read over fd3/fd4; explicit valid outcome.
        const token = crypto.randomUUID().replace(/-/g, "").slice(0, 8)
        const opId = canonicalMessagesOpId(source.id, token)
        const req = {
          v: 1 as const,
          requestId: crypto.randomUUID(),
          opId,
          op: "session/messages" as const,
          idempotencyKey: opId,
          context: { directory: workspace, sessionId: source.id },
          payload: {},
        }
        const outcome = await peer.privateMessagesOutcomeWithHandle(req as unknown as never).promise
        expect(outcome.kind).toBe("valid")
        if (outcome.kind !== "valid") throw new Error(`expected valid wire outcome, got ${outcome.kind}`)
        const priv = outcome.result
        expect(priv.v).toBe(1)
        expect(priv.requestId).toBe(req.requestId)
        expect(priv.opId).toBe(opId)
        expect(priv.op).toBe("session/messages")
        expect(priv.idempotencyKey).toBe(opId)
        expect(priv.status).toBe("succeeded")
        if (priv.status === "succeeded") {
          expect(priv.accepted).toBeTrue()
          expect(Array.isArray(priv.data.messages)).toBeTrue()
          expect(opId.startsWith(`messages:${source.id}:`)).toBeTrue()
          expect(() => validateMessagesResult(priv as unknown, req as unknown as never)).not.toThrow()
        }

        // 6. Parity diagnostics only: SDK agreement on the empty page, no authority change.
        const parity = compareMessagesParity(priv, { data: sdkItems } as unknown as never)
        expect(parity.divergence).toBeNull()

        // 6b. Paged limit:2 read matches SDK paged read (empty page, no cursor).
        const sdkPaged = await client.session.messages({ sessionID: source.id, directory: workspace, limit: 2 })
        expect((sdkPaged as unknown as { error?: unknown }).error).toBeUndefined()
        const pagedItems = (sdkPaged as unknown as { data: unknown[] }).data
        const pToken = crypto.randomUUID().replace(/-/g, "").slice(0, 8)
        const pOpId = canonicalMessagesOpId(source.id, pToken)
        const pReq = {
          v: 1 as const,
          requestId: crypto.randomUUID(),
          opId: pOpId,
          op: "session/messages" as const,
          idempotencyKey: pOpId,
          context: { directory: workspace, sessionId: source.id },
          payload: { limit: 2 },
        }
        const pOutcome = await peer.privateMessagesOutcomeWithHandle(pReq as unknown as never).promise
        expect(pOutcome.kind).toBe("valid")
        if (pOutcome.kind !== "valid") throw new Error("expected valid paged wire outcome")
        expect(pOutcome.result.status).toBe("succeeded")
        if (pOutcome.result.status === "succeeded") {
          expect(() => validateMessagesResult(pOutcome.result as unknown, pReq as unknown as never)).not.toThrow()
          const pParity = compareMessagesParity(pOutcome.result, sdkPaged as unknown as never)
          // Empty page with no cursors on either side agrees.
          expect(pParity.divergence).toBeNull()
        }

        // 6c. limit:0 full-read payload preserves full-read semantics.
        const zToken = crypto.randomUUID().replace(/-/g, "").slice(0, 8)
        const zOpId = canonicalMessagesOpId(source.id, zToken)
        const zReq = {
          v: 1 as const,
          requestId: crypto.randomUUID(),
          opId: zOpId,
          op: "session/messages" as const,
          idempotencyKey: zOpId,
          context: { directory: workspace, sessionId: source.id },
          payload: { limit: 0 },
        }
        const zOutcome = await peer.privateMessagesOutcomeWithHandle(zReq as unknown as never).promise
        expect(zOutcome.kind).toBe("valid")
        if (zOutcome.kind !== "valid") throw new Error("expected valid limit:0 wire outcome")
        expect(zOutcome.result.status).toBe("succeeded")

        // 7. SDK authority / non-blocking: SDK snapshot untouched by private
        // read; detached observer returns synchronously and leaves SDK data intact.
        const beforeSdk = JSON.stringify(sdkItems)
        const parityConn = {
          isPrivateAvailable: () => peer!.isAvailable(),
          privateMessages: (r: unknown) => peer!.privateMessages(r as never),
          privateMessagesWithHandle: (r: unknown) => peer!.privateMessagesWithHandle(r as never),
          privateMessagesOutcomeWithHandle: (r: unknown) => peer!.privateMessagesOutcomeWithHandle(r as never),
          getPrivateEpoch: () => peer!.getEpoch(),
        }
        const ret = observeSessionMessagesParityDetached(
          parityConn as unknown as Parameters<typeof observeSessionMessagesParityDetached>[0],
          sdkFull as unknown as Parameters<typeof observeSessionMessagesParityDetached>[1],
          source.id,
          workspace,
          {},
          3000,
        )
        expect(ret).toBeUndefined()
        expect(JSON.stringify((sdkFull as unknown as { data: unknown }).data)).toBe(beforeSdk)
        await new Promise((r) => setTimeout(r, 300))
        expect(JSON.stringify((sdkFull as unknown as { data: unknown }).data)).toBe(beforeSdk)

        // 8. Invalid cursor maps to validation.failed without data.
        const badToken = crypto.randomUUID().replace(/-/g, "").slice(0, 8)
        const badOpId = canonicalMessagesOpId(source.id, badToken)
        const badReq = {
          v: 1 as const,
          requestId: crypto.randomUUID(),
          opId: badOpId,
          op: "session/messages" as const,
          idempotencyKey: badOpId,
          context: { directory: workspace, sessionId: source.id },
          payload: { limit: 2, before: "bad" },
        }
        const badOutcome = await peer.privateMessagesOutcomeWithHandle(badReq as unknown as never).promise
        expect(badOutcome.kind).toBe("valid")
        if (badOutcome.kind !== "valid") throw new Error("expected valid wire outcome for bad cursor")
        expect(badOutcome.result.status).toBe("failed")
        if (badOutcome.result.status === "failed") {
          expect(badOutcome.result.failure.code).toBe("validation.failed")
          expect(() => validateMessagesResult(badOutcome.result as unknown, badReq as unknown as never)).not.toThrow()
        }

        // 9. Failure parity: missing session fails on both sides with 404 class.
        const missingId = `ses_b7missing${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`
        const sdkMissing = await client.session.messages({ sessionID: missingId, directory: workspace })
        expect((sdkMissing as unknown as { error?: unknown }).error).not.toBeUndefined()
        const missHttp = getSdkHttpStatus(
          sdkMissing as unknown as { response?: unknown; error?: unknown; data?: unknown },
        )
        expect(missHttp).toBe(404)
        const missToken = crypto.randomUUID().replace(/-/g, "").slice(0, 8)
        const missOpId = canonicalMessagesOpId(missingId, missToken)
        const missReq = {
          v: 1 as const,
          requestId: crypto.randomUUID(),
          opId: missOpId,
          op: "session/messages" as const,
          idempotencyKey: missOpId,
          context: { directory: workspace, sessionId: missingId },
          payload: {},
        }
        const missOutcome = await peer.privateMessagesOutcomeWithHandle(missReq as unknown as never).promise
        expect(missOutcome.kind).toBe("valid")
        if (missOutcome.kind !== "valid") throw new Error(`expected valid wire outcome for missing session, got ${missOutcome.kind}`)
        expect(missOutcome.result.status).toBe("failed")
        if (missOutcome.result.status === "failed") {
          expect(missOutcome.result.failure.code).toBe("session.not_found")
          expect(() => validateMessagesResult(missOutcome.result as unknown, missReq as unknown as never)).not.toThrow()
        }
        const missParity = compareMessagesParity(missOutcome.result, sdkMissing as unknown as never)
        expect(missParity.divergence).toBeNull()

        // 10. Cross-directory isolation: same sessionId via a different
        // directory binds strictly — private fails scope_mismatch.
        const xToken = crypto.randomUUID().replace(/-/g, "").slice(0, 8)
        const xOpId = canonicalMessagesOpId(source.id, xToken)
        const xReq = {
          v: 1 as const,
          requestId: crypto.randomUUID(),
          opId: xOpId,
          op: "session/messages" as const,
          idempotencyKey: xOpId,
          context: { directory: peerDir, sessionId: source.id },
          payload: {},
        }
        const xOutcome = await peer.privateMessagesOutcomeWithHandle(xReq as unknown as never).promise
        expect(xOutcome.kind).toBe("valid")
        if (xOutcome.kind !== "valid") throw new Error(`expected valid wire outcome for cross-directory messages, got ${xOutcome.kind}`)
        expect(xOutcome.result.status).toBe("failed")
        if (xOutcome.result.status === "failed") {
          expect(xOutcome.result.failure.code).toBe("scope_mismatch")
        }

        // 11. Direct-helper invalid-wire exclusion: normalizePrivateMessagesWire
        // reports explicit invalid without entering comparator logic. This is a
        // helper-level assertion, not live invalid wire over fd3/fd4.
        const malformed = {
          v: 1,
          requestId: req.requestId,
          opId: req.opId,
          op: "session/messages",
          idempotencyKey: req.idempotencyKey,
          status: "succeeded",
          outcome: { type: "succeeded", time: Date.now() },
          accepted: true,
          data: { messages: ["not-an-object"] },
        }
        const wire = normalizePrivateMessagesWire(malformed, req as unknown as never)
        expect(wire.kind).toBe("invalid")
        if (wire.kind !== "invalid") throw new Error("expected invalid wire outcome for non-object message entry")

        // 12. Private unavailable fallback while SDK stays authoritative.
        peer.dispose()
        expect(peer.isAvailable()).toBeFalse()
        const afterPeerClose = await client.session.messages({ sessionID: source.id, directory: workspace })
        expect((afterPeerClose as unknown as { error?: unknown }).error).toBeUndefined()
        let threw = false
        try {
          await peer.privateMessages(req as unknown as never)
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
