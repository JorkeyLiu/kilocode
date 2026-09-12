/* eslint-disable complexity */
// Config-warnings production evidence: ServerManager → real `kilo serve` child →
// fd3/fd4 → same AppLayer `config/warnings` (read-only safe projection).
// The safe list is consumed private-first with exactly-one same-directory SDK
// fallback (no state/event/error impact, no mutation/durable operation, no
// freshness claim). Darwin + Linux run; other platforms skip per B4 convention. Windows/
// live Extension Host evidence is not claimed. Process-global VS Code/env mutation
// is serialized with the B5 tests via server-manager-b5-global-serialization
// (reuse only, no B5 test edits). Cross-directory coverage asserts
// per-directory routing isolation (broken agent marker visible only under the
// workspace directory, each side matching its own SDK read) rather than an
// invented mismatch error; failure parity covers validation.failed redaction;
// invalid wire is a helper-level exclusion (no live malformed fd3/fd4 claim);
// no replacement-epoch or live Extension Host proof. Private payloads carry
// only finite `{pathCategory,messageCategory}` entries: no absolute path, no
// raw diagnostic text, no detail.
import { describe, expect, test } from "bun:test"
import * as crypto from "crypto"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import * as vscode from "vscode"
import { ServerManager } from "./server-manager"
import { ServePrivatePeer } from "./serve-private-peer"
import {
  canonicalConfigWarningsOpId,
  compareConfigWarningsParity,
  normalizePrivateConfigWarningsWire,
  validateConfigWarningsResult,
} from "./serve-private-config-warnings-contract"
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

function warningsReq(dir: string, token: string, requestId: string) {
  const opId = canonicalConfigWarningsOpId(token)
  return {
    v: 1 as const,
    requestId,
    opId,
    op: "config/warnings" as const,
    idempotencyKey: opId,
    context: { directory: dir },
    payload: {},
  }
}

function safeKeyOf(item: unknown): string {
  const rec = item as Record<string, unknown>
  return JSON.stringify([rec.pathCategory, rec.messageCategory])
}

describe("ServerManager → real kilo serve → fd3/fd4 → ConfigWarnings safe projection", () => {
  test.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
    "covers initialize config/warnings capability + same-directory safe projection vs SDK + invalid redaction + cross-directory routing isolation + invalid-wire exclusion + fail-closed cleanup",
    async () => {
      const extensionPath = path.resolve(import.meta.dir, "../../..")
      const binPath = path.join(extensionPath, "bin", process.platform === "win32" ? "kilo.exe" : "kilo")
      expect(fs.existsSync(binPath)).toBeTrue()
      const stat = fs.statSync(binPath)
      expect(stat.isFile()).toBeTrue()
      expect(stat.size).toBeGreaterThan(10_000_000)
      const mtimeAge = Date.now() - stat.mtimeMs
      console.log(`[config-warnings-prod] bin mtime age ms=${mtimeAge} size=${stat.size}`)

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
        workspaceRaw = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-prod-cfgwarn-ws-"))
        workspace = fs.realpathSync(workspaceRaw)
        peerDirRaw = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-prod-cfgwarn-peer-"))
        peerDir = fs.realpathSync(peerDirRaw)
        storage = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-prod-cfgwarn-storage-"))
        xdgData = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-prod-cfgwarn-xdg-"))
        // Broken agent marker visible only to the workspace directory's
        // instance warnings (proves per-directory routing).
        fs.mkdirSync(path.join(workspace, ".kilo", "agent"), { recursive: true })
        fs.writeFileSync(
          path.join(workspace, ".kilo", "agent", "broken.md"),
          '---\nmode: "banana"\n---\nBroken agent\n',
        )
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

        // 2. Initialize private peer against fd3/fd4; require config/warnings.
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
        if (Array.isArray(caps)) expect(caps.includes("config/warnings")).toBeTrue()
        else {
          const str = JSON.stringify(caps ?? "")
          expect(str.includes("config/warnings")).toBeTrue()
        }
        expect(peer.hasCapability("config/warnings")).toBeTrue()

        // 3. SDK client against the same child; SDK is the sole authority.
        const auth = `Basic ${Buffer.from(`kilo:${inst.password}`).toString("base64")}`
        const client = createKiloClient({
          baseUrl: `http://127.0.0.1:${inst.port}`,
          headers: { Authorization: auth },
        })

        // 4. SDK warnings authoritative: workspace instance carries the broken marker.
        const sdkFull = await client.config.warnings({ directory: workspace })
        expect((sdkFull as unknown as { error?: unknown }).error).toBeUndefined()
        const sdkFullItems = (sdkFull as unknown as { data: unknown[] }).data
        expect(Array.isArray(sdkFullItems)).toBeTrue()
        expect(sdkFullItems.length).toBeGreaterThan(0)
        const sdkMarker = (sdkFullItems as Array<Record<string, unknown>>).find(
          (e) => typeof e.path === "string" && e.path.includes("broken.md"),
        )
        expect(sdkMarker !== undefined).toBeTrue()

        // 5. Private same-directory read over fd3/fd4; explicit valid outcome.
        const fullReq = warningsReq(workspace, crypto.randomUUID().replace(/-/g, "").slice(0, 8), crypto.randomUUID())
        const fullOutcome = await peer.privateConfigWarningsOutcomeWithHandle(fullReq as unknown as never).promise
        expect(fullOutcome.kind).toBe("valid")
        if (fullOutcome.kind !== "valid") throw new Error(`expected valid wire outcome, got ${fullOutcome.kind}`)
        const fullPriv = fullOutcome.result
        expect(fullPriv.v).toBe(1)
        expect(fullPriv.requestId).toBe(fullReq.requestId)
        expect(fullPriv.opId).toBe(fullReq.opId)
        expect(fullPriv.op).toBe("config/warnings")
        expect(fullPriv.idempotencyKey).toBe(fullReq.opId)
        expect(fullPriv.status).toBe("succeeded")
        if (fullPriv.status === "succeeded") {
          expect(fullPriv.accepted).toBeTrue()
          expect(Array.isArray(fullPriv.data.warnings)).toBeTrue()
          expect(fullPriv.data.warnings.length).toBe(sdkFullItems.length)
          for (const e of fullPriv.data.warnings) {
            const rec = e as Record<string, unknown>
            expect(Object.keys(rec).every((k) => ["pathCategory", "messageCategory"].includes(k))).toBeTrue()
            expect("path" in rec).toBeFalse()
            expect("message" in rec).toBeFalse()
            expect("detail" in rec).toBeFalse()
          }
          const keys = (fullPriv.data.warnings as unknown[]).map(safeKeyOf)
          expect(keys.includes(JSON.stringify(["agent-file", "invalid-file"]))).toBeTrue()
          const wire = JSON.stringify(fullPriv)
          expect(wire.includes(workspace)).toBeFalse()
          expect(wire.includes("broken.md")).toBeFalse()
          expect(wire.includes("detail")).toBeFalse()
          expect(wire.includes("banana")).toBeFalse()
          expect(() => validateConfigWarningsResult(fullPriv as unknown, fullReq as unknown as never)).not.toThrow()
        }

        // 6. Same-input safe agreement: the private projection carries only
        // safe categories, with `compareConfigWarningsParity` as pure
        // diagnostic evidence (no third request in production).
        const fullParity = compareConfigWarningsParity(fullPriv, sdkFull as unknown as never)
        expect(fullParity.divergence).toBeNull()

        // 7. Invalid request fails closed client-side without touching the
        // transport (fail-closed validation parity with the carrier, whose
        // server-side `validation.failed` redaction is proven over real
        // dispatch in `fd-carrier-config-warnings.test.ts`). Redacted failure
        // shape is asserted at helper level below.
        const badReq = {
          ...warningsReq(workspace, crypto.randomUUID().replace(/-/g, "").slice(0, 8), crypto.randomUUID()),
          payload: { filter: {} },
        }
        const pendingBefore = peer.getPendingCount()
        let badThrew = false
        try {
          peer.privateConfigWarningsOutcomeWithHandle(badReq as unknown as never)
        } catch (err) {
          badThrew = true
          expect(String((err as Error).message).includes("empty object")).toBeTrue()
        }
        expect(badThrew).toBeTrue()
        expect(peer.getPendingCount()).toBe(pendingBefore)
        const failedShape = {
          v: 1,
          requestId: badReq.requestId,
          opId: badReq.opId,
          op: "config/warnings",
          idempotencyKey: badReq.opId,
          status: "failed",
          outcome: {
            type: "failed",
            time: 1,
            failure: { code: "validation.failed", message: "invalid config-warnings request", retryable: false },
          },
          accepted: false,
          failure: { code: "validation.failed", message: "invalid config-warnings request", retryable: false },
        }
        expect(() => validateConfigWarningsResult(failedShape as unknown, badReq as unknown as never)).not.toThrow()
        const failedWire = JSON.stringify(failedShape)
        // The fixed `op` label `config/warnings` legitimately contains the
        // word "warnings"; assert the data/detail keys instead.
        expect(failedWire.includes('"data"')).toBeFalse()
        expect(failedWire.includes("detail")).toBeFalse()

        // 9. Cross-directory routing isolation: the peer directory scopes to
        // its own instance warnings (no broken marker); each side matches
        // its own SDK read.
        const sdkPeer = await client.config.warnings({ directory: peerDir! })
        expect((sdkPeer as unknown as { error?: unknown }).error).toBeUndefined()
        const sdkPeerItems = (sdkPeer as unknown as { data: unknown[] }).data
        expect(Array.isArray(sdkPeerItems)).toBeTrue()
        expect(
          (sdkPeerItems as Array<Record<string, unknown>>).some(
            (e) => typeof e.path === "string" && e.path.includes("broken.md"),
          ),
        ).toBeFalse()
        const xReq = warningsReq(peerDir!, crypto.randomUUID().replace(/-/g, "").slice(0, 8), crypto.randomUUID())
        const xOutcome = await peer.privateConfigWarningsOutcomeWithHandle(xReq as unknown as never).promise
        expect(xOutcome.kind).toBe("valid")
        if (xOutcome.kind !== "valid")
          throw new Error(`expected valid wire outcome for cross-directory read, got ${xOutcome.kind}`)
        expect(xOutcome.result.status).toBe("succeeded")
        if (xOutcome.result.status === "succeeded") {
          const keys = (xOutcome.result.data.warnings as unknown[]).map(safeKeyOf)
          expect(keys.includes(JSON.stringify(["agent-file", "invalid-file"]))).toBeFalse()
          expect(xOutcome.result.data.warnings.length).toBe(sdkPeerItems.length)
          expect(() => validateConfigWarningsResult(xOutcome.result as unknown, xReq as unknown as never)).not.toThrow()
          const xParity = compareConfigWarningsParity(xOutcome.result, sdkPeer as unknown as never)
          expect(xParity.divergence).toBeNull()
        }

        // 10. Direct-helper invalid-wire exclusion: normalizePrivateConfigWarningsWire
        // reports explicit invalid without entering comparator logic. This is a
        // helper-level assertion, not live invalid wire over fd3/fd4.
        const malformed = {
          v: 1,
          requestId: fullReq.requestId,
          opId: fullReq.opId,
          op: "config/warnings",
          idempotencyKey: fullReq.opId,
          status: "succeeded",
          outcome: { type: "succeeded", time: Date.now() },
          accepted: true,
          data: { warnings: [{ path: "/secret/x.md", message: "raw text", detail: "hidden" }] },
        }
        const wire = normalizePrivateConfigWarningsWire(malformed, fullReq as unknown as never)
        expect(wire.kind).toBe("invalid")
        if (wire.kind !== "invalid") throw new Error("expected invalid wire outcome for raw-bearing entry")

        // 11. Private unavailable fallback while SDK stays authoritative.
        peer.dispose()
        expect(peer.isAvailable()).toBeFalse()
        const afterPeerClose = await client.config.warnings({ directory: workspace })
        expect((afterPeerClose as unknown as { error?: unknown }).error).toBeUndefined()
        let threw = false
        try {
          peer.privateConfigWarningsOutcomeWithHandle(fullReq as unknown as never)
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
    90000,
  )
})
