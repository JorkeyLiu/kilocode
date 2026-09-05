/* eslint-disable complexity */
// Session-list production evidence: ServerManager → real `kilo serve` child →
// fd3/fd4 → same AppLayer `experimental/session/list` (parity-only, read-only).
// SDK HTTP (`client.experimental.session.list`) remains the sole authority;
// the private path is non-blocking parity diagnostics only (no state/event/
// error impact, no mutation/durable operation, no list authority change).
// Darwin + Linux run; other platforms skip per B4 convention. Windows/live
// Extension Host evidence is not claimed. Process-global VS Code/env mutation
// is serialized with the B5 tests via server-manager-b5-global-serialization
// (reuse only, no B5 test edits). Limitations: failure parity covers
// validation.failed redaction only (list has no missing-session 404 — an
// unknown directory simply scopes to empty); isolation covers cross-directory
// scoping (SDK list is directory-filtered, private binds the same directory);
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
  canonicalSessionListOpId,
  compareSessionListParity,
  normalizePrivateSessionListWire,
  validateSessionListResult,
} from "./serve-private-session-list-contract"
import { observeSessionListParityDetached } from "../../kilo-provider/session-list-parity"
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

function listReq(dir: string, filter: Record<string, unknown>, token: string, requestId: string) {
  const opId = canonicalSessionListOpId(token)
  return {
    v: 1 as const,
    requestId,
    opId,
    op: "experimental/session/list" as const,
    idempotencyKey: opId,
    context: { directory: dir },
    payload: { filter },
  }
}

const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

describe("ServerManager → real kilo serve → fd3/fd4 → SessionList parity-only production", () => {
  test.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
    "covers initialize session-list capability + same-directory summaries vs SDK authoritative + limit/cursor continuation + invalid redaction + cross-directory isolation + invalid-wire exclusion + fail-closed cleanup",
    async () => {
      const extensionPath = path.resolve(import.meta.dir, "../../..")
      const binPath = path.join(extensionPath, "bin", process.platform === "win32" ? "kilo.exe" : "kilo")
      expect(fs.existsSync(binPath)).toBeTrue()
      const stat = fs.statSync(binPath)
      expect(stat.isFile()).toBeTrue()
      expect(stat.size).toBeGreaterThan(10_000_000)
      const mtimeAge = Date.now() - stat.mtimeMs
      console.log(`[session-list-prod] bin mtime age ms=${mtimeAge} size=${stat.size}`)

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
        workspaceRaw = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-prod-slist-ws-"))
        workspace = fs.realpathSync(workspaceRaw)
        peerDirRaw = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-prod-slist-peer-"))
        peerDir = fs.realpathSync(peerDirRaw)
        storage = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-prod-slist-storage-"))
        xdgData = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-prod-slist-xdg-"))
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

        // 2. Initialize private peer against fd3/fd4; require experimental/session/list.
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
        if (Array.isArray(caps)) expect(caps.includes("experimental/session/list")).toBeTrue()
        else {
          const str = JSON.stringify(caps ?? "")
          expect(str.includes("experimental/session/list") || str.includes("experimental-session-list")).toBeTrue()
        }
        expect(peer.hasCapability("experimental/session/list")).toBeTrue()

        // 3. SDK client against the same child; SDK is the sole authority.
        const auth = `Basic ${Buffer.from(`kilo:${inst.password}`).toString("base64")}`
        const client = createKiloClient({
          baseUrl: `http://127.0.0.1:${inst.port}`,
          headers: { Authorization: auth },
        })
        const createdIds: string[] = []
        for (const title of ["prod-slist-1", "prod-slist-2", "prod-slist-3"]) {
          const created = await client.session.create({ directory: workspace, title })
          expect((created as unknown as { error?: unknown }).error).toBeUndefined()
          const info = (created as unknown as { data: { id: string } }).data
          expect(info.id.startsWith("ses")).toBeTrue()
          createdIds.push(info.id)
          await sleepMs(60)
        }

        // 4. SDK list authoritative: full read via SDK.
        const sdkFull = await client.experimental.session.list({ directory: workspace, limit: 100 })
        expect((sdkFull as unknown as { error?: unknown }).error).toBeUndefined()
        const sdkFullItems = (sdkFull as unknown as { data: unknown[] }).data
        expect(Array.isArray(sdkFullItems)).toBeTrue()
        expect(sdkFullItems.length).toBe(3)
        const sdkFullCursor = (sdkFull as unknown as { response: { headers: { get: (k: string) => string | null } } }).response.headers.get("x-next-cursor")
        expect(sdkFullCursor).toBeNull()

        // 5. Private same-directory full read over fd3/fd4; explicit valid outcome.
        const fullReq = listReq(workspace, {}, crypto.randomUUID().replace(/-/g, "").slice(0, 8), crypto.randomUUID())
        const fullOutcome = await peer.privateSessionListOutcomeWithHandle(fullReq as unknown as never).promise
        expect(fullOutcome.kind).toBe("valid")
        if (fullOutcome.kind !== "valid") throw new Error(`expected valid wire outcome, got ${fullOutcome.kind}`)
        const fullPriv = fullOutcome.result
        expect(fullPriv.v).toBe(1)
        expect(fullPriv.requestId).toBe(fullReq.requestId)
        expect(fullPriv.opId).toBe(fullReq.opId)
        expect(fullPriv.op).toBe("experimental/session/list")
        expect(fullPriv.idempotencyKey).toBe(fullReq.opId)
        expect(fullPriv.status).toBe("succeeded")
        if (fullPriv.status === "succeeded") {
          expect(fullPriv.accepted).toBeTrue()
          expect(Array.isArray(fullPriv.data.sessions)).toBeTrue()
          expect(fullPriv.data.sessions.length).toBe(3)
          expect((fullPriv.data as { nextCursor?: unknown }).nextCursor).toBeUndefined()
          for (const s of fullPriv.data.sessions) {
            const rec = s as Record<string, unknown>
            expect(Object.keys(rec).sort()).toEqual(["directory", "id", "title", "updated"])
            expect(typeof rec.id === "string" && (rec.id as string).startsWith("ses")).toBeTrue()
          }
          const gotIds = (fullPriv.data.sessions as Array<{ id: string }>).map((s) => s.id).sort()
          expect(gotIds).toEqual([...createdIds].sort())
          expect(() => validateSessionListResult(fullPriv as unknown, fullReq as unknown as never)).not.toThrow()
        }

        // 6. Parity diagnostics only: full-page agreement, no authority change.
        const fullParity = compareSessionListParity(fullPriv, sdkFull as unknown as never)
        expect(fullParity.divergence).toBeNull()

        // 7. Limit truncation: SDK page (limit 2) carries x-next-cursor; private
        // page carries the equal inline numeric nextCursor.
        const sdkPage = await client.experimental.session.list({ directory: workspace, limit: 2 })
        expect((sdkPage as unknown as { error?: unknown }).error).toBeUndefined()
        const sdkPageItems = (sdkPage as unknown as { data: unknown[] }).data
        expect(sdkPageItems.length).toBe(2)
        const sdkCursorRaw = (sdkPage as unknown as { response: { headers: { get: (k: string) => string | null } } }).response.headers.get("x-next-cursor")
        expect(typeof sdkCursorRaw).toBe("string")
        const sdkCursor = Number(sdkCursorRaw)
        expect(Number.isFinite(sdkCursor)).toBeTrue()
        const pageReq = listReq(workspace, { limit: 2 }, crypto.randomUUID().replace(/-/g, "").slice(0, 8), crypto.randomUUID())
        const pageOutcome = await peer.privateSessionListOutcomeWithHandle(pageReq as unknown as never).promise
        expect(pageOutcome.kind).toBe("valid")
        if (pageOutcome.kind !== "valid") throw new Error("expected valid paged wire outcome")
        expect(pageOutcome.result.status).toBe("succeeded")
        if (pageOutcome.result.status === "succeeded") {
          expect(pageOutcome.result.data.sessions.length).toBe(2)
          expect(() => validateSessionListResult(pageOutcome.result as unknown, pageReq as unknown as never)).not.toThrow()
          const privCursor = (pageOutcome.result.data as { nextCursor?: unknown }).nextCursor
          expect(typeof privCursor).toBe("number")
          expect(privCursor).toBe(sdkCursor)
          const pageParity = compareSessionListParity(pageOutcome.result, sdkPage as unknown as never)
          expect(pageParity.divergence).toBeNull()
        }

        // 8. Cursor continuation on both sides agrees on the remainder.
        const sdkPage2 = await client.experimental.session.list({ directory: workspace, limit: 2, cursor: sdkCursor })
        expect((sdkPage2 as unknown as { error?: unknown }).error).toBeUndefined()
        const sdkPage2Items = (sdkPage2 as unknown as { data: unknown[] }).data
        expect(sdkPage2Items.length).toBe(1)
        const page2Req = listReq(
          workspace,
          { limit: 2, cursor: sdkCursor },
          crypto.randomUUID().replace(/-/g, "").slice(0, 8),
          crypto.randomUUID(),
        )
        const page2Outcome = await peer.privateSessionListOutcomeWithHandle(page2Req as unknown as never).promise
        expect(page2Outcome.kind).toBe("valid")
        if (page2Outcome.kind !== "valid") throw new Error("expected valid continuation wire outcome")
        expect(page2Outcome.result.status).toBe("succeeded")
        if (page2Outcome.result.status === "succeeded") {
          expect(page2Outcome.result.data.sessions.length).toBe(1)
          expect((page2Outcome.result.data as { nextCursor?: unknown }).nextCursor).toBeUndefined()
          expect(() => validateSessionListResult(page2Outcome.result as unknown, page2Req as unknown as never)).not.toThrow()
          const contParity = compareSessionListParity(page2Outcome.result, sdkPage2 as unknown as never)
          expect(contParity.divergence).toBeNull()
        }

        // 9. SDK authority / non-blocking: SDK snapshot untouched by private
        // reads; detached observer returns synchronously and leaves SDK data intact.
        const beforeSdk = JSON.stringify(sdkFullItems)
        const parityConn = {
          isPrivateAvailable: () => peer!.isAvailable(),
          privateSessionListOutcomeWithHandle: (r: unknown) => peer!.privateSessionListOutcomeWithHandle(r as never),
          getPrivateEpoch: () => peer!.getEpoch(),
        }
        const ret = observeSessionListParityDetached(
          parityConn as unknown as Parameters<typeof observeSessionListParityDetached>[0],
          sdkFull as unknown as Parameters<typeof observeSessionListParityDetached>[1],
          workspace,
          undefined,
          { limit: 100 },
          3000,
        )
        expect(ret).toBeUndefined()
        expect(JSON.stringify((sdkFull as unknown as { data: unknown }).data)).toBe(beforeSdk)
        await new Promise((r) => setTimeout(r, 300))
        expect(JSON.stringify((sdkFull as unknown as { data: unknown }).data)).toBe(beforeSdk)

        // 10. Invalid request fails closed client-side without touching the
        // transport (fail-closed validation parity with the carrier, whose
        // server-side `validation.failed` redaction is proven over real
        // dispatch in `fd-carrier-session-list.test.ts`). Redacted failure
        // shape is asserted at helper level below.
        const badReq = listReq(workspace, { limit: 0 }, crypto.randomUUID().replace(/-/g, "").slice(0, 8), crypto.randomUUID())
        const pendingBefore = peer.getPendingCount()
        let badThrew = false
        try {
          peer.privateSessionListOutcomeWithHandle(badReq as unknown as never)
        } catch (err) {
          badThrew = true
          expect(String((err as Error).message).includes("filter.limit")).toBeTrue()
        }
        expect(badThrew).toBeTrue()
        expect(peer.getPendingCount()).toBe(pendingBefore)
        const failedShape = {
          v: 1,
          requestId: badReq.requestId,
          opId: badReq.opId,
          op: "experimental/session/list",
          idempotencyKey: badReq.opId,
          status: "failed",
          outcome: { type: "failed", time: 1, failure: { code: "validation.failed", message: "x", retryable: false } },
          accepted: false,
          failure: { code: "validation.failed", message: "x", retryable: false },
        }
        expect(() => validateSessionListResult(failedShape as unknown, badReq as unknown as never)).not.toThrow()
        const failedWire = JSON.stringify(failedShape)
        expect(failedWire.includes("sessions")).toBeFalse()
        expect(failedWire.includes("nextCursor")).toBeFalse()

        // 11. Cross-directory isolation: sessions live under workspace; the
        // peer directory scopes to its own (empty) set.
        const xReq = listReq(peerDir!, {}, crypto.randomUUID().replace(/-/g, "").slice(0, 8), crypto.randomUUID())
        const xOutcome = await peer.privateSessionListOutcomeWithHandle(xReq as unknown as never).promise
        expect(xOutcome.kind).toBe("valid")
        if (xOutcome.kind !== "valid") throw new Error(`expected valid wire outcome for cross-directory list, got ${xOutcome.kind}`)
        expect(xOutcome.result.status).toBe("succeeded")
        if (xOutcome.result.status === "succeeded") {
          const ids = (xOutcome.result.data.sessions as Array<{ id: string }>).map((s) => s.id)
          for (const id of createdIds) expect(ids.includes(id)).toBeFalse()
          expect(() => validateSessionListResult(xOutcome.result as unknown, xReq as unknown as never)).not.toThrow()
        }

        // 12. Direct-helper invalid-wire exclusion: normalizePrivateSessionListWire
        // reports explicit invalid without entering comparator logic. This is a
        // helper-level assertion, not live invalid wire over fd3/fd4.
        const malformed = {
          v: 1,
          requestId: fullReq.requestId,
          opId: fullReq.opId,
          op: "experimental/session/list",
          idempotencyKey: fullReq.opId,
          status: "succeeded",
          outcome: { type: "succeeded", time: Date.now() },
          accepted: true,
          data: { sessions: [], nextCursor: "not-a-number" },
        }
        const wire = normalizePrivateSessionListWire(malformed, fullReq as unknown as never)
        expect(wire.kind).toBe("invalid")
        if (wire.kind !== "invalid") throw new Error("expected invalid wire outcome for string nextCursor")

        // 13. Private unavailable fallback while SDK stays authoritative.
        peer.dispose()
        expect(peer.isAvailable()).toBeFalse()
        const afterPeerClose = await client.experimental.session.list({ directory: workspace, limit: 2 })
        expect((afterPeerClose as unknown as { error?: unknown }).error).toBeUndefined()
        let threw = false
        try {
          peer.privateSessionListOutcomeWithHandle(fullReq as unknown as never)
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
    90000,
  )
})
