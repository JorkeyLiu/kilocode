import { afterEach, describe, expect } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { PassThrough } from "node:stream"
import { Effect } from "effect"
import { Server } from "../../../src/server/server"
import { Global } from "@opencode-ai/core/global"
import { GlobalBus } from "../../../src/bus/global"
import { awaitRebuilds } from "../../../src/kilocode/server/config-rebuild"
import { ConfigFileConvergence } from "../../../src/kilocode/server/config-file-convergence"
import { JsonRpcPeer } from "../../../src/private-worker/peer"
import { ErrorCode } from "../../../src/private-worker/json-rpc"
import { createFdCarrier } from "../../../src/kilocode/server/fd-carrier"
import { FD_PROTOCOL_NAME } from "../../../src/kilocode/server/fd-carrier-protocol"
import { AppLayer } from "../../../src/effect/app-runtime"
import { InstanceStore } from "../../../src/project/instance-store"
import { GenerationGate } from "../../../src/kilocode/server/generation-gate"
import { awaitWithTimeout, testEffectShared } from "../../lib/effect"
import { tmpdir, disposeAllInstances } from "../../fixture/fixture"
import { markProjectConfigReady } from "../../fixture/plugin"
import { resetDatabase } from "../../fixture/db"

const it = testEffectShared(AppLayer)
const originalGlobal = Global.Path.config

afterEach(async () => {
  ;(Global.Path as { config: string }).config = originalGlobal
  GlobalBus.removeAllListeners("event")
  await Effect.runPromise(awaitRebuilds().pipe(Effect.ignore))
  await disposeAllInstances()
  await resetDatabase()
})

const linked = () => {
  const extToCarrier = new PassThrough()
  const carrierToExt = new PassThrough()
  const carrier = createFdCarrier(extToCarrier, carrierToExt)
  const ext = new JsonRpcPeer({ reader: carrierToExt, writer: extToCarrier })
  return { carrier, ext }
}

const init = (ext: JsonRpcPeer) =>
  ext.request("initialize", {
    protocol: { name: FD_PROTOCOL_NAME, major: 1, minor: 0 },
    clientInfo: { name: "kilo-vscode", version: "7.4.11" },
    capabilities: ["config/convergence/acquire", "config/convergence/resolve"],
  })

const acquireReq = (lease: string, descriptors: unknown) => ({
  v: 1,
  leaseId: lease,
  opId: lease,
  requestId: lease,
  idempotencyKey: lease,
  descriptors,
})

const resolveReq = (lease: string) => ({ v: 1, leaseId: lease, opId: lease, requestId: lease, idempotencyKey: lease })

const observeReq = (id: string, descriptors: unknown) => ({
  v: 1,
  observeId: id,
  opId: id,
  requestId: id,
  idempotencyKey: id,
  descriptors,
})

const projectFile = (dir: string) => path.join(dir, ".kilo", "kilo.jsonc")

const atomicWrite = (file: string, value: Record<string, unknown>) => {
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify({ $schema: "https://app.kilo.ai/config.json", ...value }, null, 2), "utf8")
  fs.renameSync(tmp, file)
}

const seedProject = async (dir: string, value: Record<string, unknown>) => {
  await markProjectConfigReady(dir)
  atomicWrite(projectFile(dir), value)
  await markProjectConfigReady(dir)
}

const overlay = async (dir: string) => {
  const res = await Server.Default().app.request("/config/overlay?scope=project", {
    headers: { "x-kilo-directory": dir },
  })
  expect(res.status).toBe(200)
  return (await res.json()) as { effective: Record<string, unknown> }
}

const acquireErr = (ext: JsonRpcPeer, lease: string, descriptors: unknown) =>
  ext
    .request("config/convergence/acquire", acquireReq(lease, descriptors))
    .then(
      () => ({ ok: true as const }),
      (e: unknown) => ({ ok: false as const, err: e as { code?: number } }),
    )

describe("config-file descriptor path guard (intermediate/leaf symlinks)", () => {
  it.live("project config intermediate symlink rejected on acquire", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
      const dir = tmp.path
      yield* Effect.promise(() => seedProject(dir, { permission: { bash: "allow" } }))
      const external = yield* Effect.promise(() => tmpdir({ retain: true }))
      const kiloDir = path.join(dir, ".kilo")
      const backup = `${kiloDir}.${process.pid}.backup`
      const svc = yield* ConfigFileConvergence.Service
      const gate = yield* GenerationGate.Service
      const pair = linked()
      try {
        yield* Effect.promise(() => init(pair.ext))
        fs.renameSync(kiloDir, backup)
        fs.symlinkSync(external.path, kiloDir)
        try {
          const bad = yield* Effect.promise(() =>
            acquireErr(pair.ext, `kilo-link-${Date.now()}`, [{ kind: "config", scope: "project", directory: dir }]),
          )
          expect(bad.ok).toBe(false)
          if (!bad.ok) expect(bad.err?.code).toBe(ErrorCode.InvalidParams)
        } finally {
          fs.unlinkSync(kiloDir)
          fs.renameSync(backup, kiloDir)
        }
        expect(yield* svc.unresolvedCount()).toBe(0)
        expect(gate.isBarrierActive(dir)).toBe(false)
      } finally {
        pair.carrier.dispose()
        pair.ext.dispose()
      }
    }),
  )

  it.live("project asset dir/file symlinks rejected; absent asset allowed", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
      const dir = tmp.path
      yield* Effect.promise(() => seedProject(dir, { permission: { bash: "allow" } }))
      const external = yield* Effect.promise(() => tmpdir({ retain: true }))
      const svc = yield* ConfigFileConvergence.Service
      const pair = linked()
      try {
        yield* Effect.promise(() => init(pair.ext))
        const assetDesc = (id: string) => [{ kind: "asset", asset: "agent", scope: "project", directory: dir, id }]
        // Intermediate asset dir symlink escapes.
        const agentDir = path.join(dir, ".kilo", "agent")
        fs.symlinkSync(external.path, agentDir)
        try {
          const badDir = yield* Effect.promise(() => acquireErr(pair.ext, `asset-dir-${Date.now()}`, assetDesc("helper")))
          expect(badDir.ok).toBe(false)
          if (!badDir.ok) expect(badDir.err?.code).toBe(ErrorCode.InvalidParams)
        } finally {
          fs.unlinkSync(agentDir)
        }
        // Leaf asset file symlink escapes.
        fs.mkdirSync(agentDir, { recursive: true })
        const evilSrc = path.join(external.path, "evil.md")
        fs.writeFileSync(evilSrc, "# evil\n", "utf8")
        const leaf = path.join(agentDir, "evil.md")
        fs.symlinkSync(evilSrc, leaf)
        try {
          const badLeaf = yield* Effect.promise(() => acquireErr(pair.ext, `asset-leaf-${Date.now()}`, assetDesc("evil")))
          expect(badLeaf.ok).toBe(false)
          if (!badLeaf.ok) expect(badLeaf.err?.code).toBe(ErrorCode.InvalidParams)
        } finally {
          fs.unlinkSync(leaf)
        }
        // Legitimate absent asset stays allowed (create path).
        const lease = `asset-absent-${Date.now()}`
        const rawAcq: unknown = yield* Effect.promise(() =>
          pair.ext.request("config/convergence/acquire", acquireReq(lease, assetDesc("fresh"))),
        )
        expect((rawAcq as { acquired: boolean }).acquired).toBe(true)
        const rawRes: unknown = yield* Effect.promise(() => pair.ext.request("config/convergence/resolve", resolveReq(lease)))
        expect((rawRes as { outcome: string }).outcome).toBe("noop")
        expect(yield* svc.unresolvedCount()).toBe(0)
      } finally {
        pair.carrier.dispose()
        pair.ext.dispose()
      }
    }),
  )

  it.live("global asset dir/file symlinks rejected on acquire", () =>
    Effect.gen(function* () {
      const global = yield* Effect.promise(() => tmpdir({ retain: true }))
      ;(Global.Path as { config: string }).config = global.path
      fs.writeFileSync(path.join(global.path, "kilo.jsonc"), JSON.stringify({ $schema: "https://app.kilo.ai/config.json" }), "utf8")
      const external = yield* Effect.promise(() => tmpdir({ retain: true }))
      const svc = yield* ConfigFileConvergence.Service
      const pair = linked()
      try {
        yield* Effect.promise(() => init(pair.ext))
        const assetDesc = (id: string) => [{ kind: "asset", asset: "agent", scope: "global", id }]
        const agentDir = path.join(global.path, "agent")
        fs.symlinkSync(external.path, agentDir)
        try {
          const badDir = yield* Effect.promise(() => acquireErr(pair.ext, `g-dir-${Date.now()}`, assetDesc("helper")))
          expect(badDir.ok).toBe(false)
          if (!badDir.ok) expect(badDir.err?.code).toBe(ErrorCode.InvalidParams)
        } finally {
          fs.unlinkSync(agentDir)
        }
        fs.mkdirSync(agentDir, { recursive: true })
        const evilSrc = path.join(external.path, "evil.md")
        fs.writeFileSync(evilSrc, "# evil\n", "utf8")
        const leaf = path.join(agentDir, "evil.md")
        fs.symlinkSync(evilSrc, leaf)
        try {
          const badLeaf = yield* Effect.promise(() => acquireErr(pair.ext, `g-leaf-${Date.now()}`, assetDesc("evil")))
          expect(badLeaf.ok).toBe(false)
          if (!badLeaf.ok) expect(badLeaf.err?.code).toBe(ErrorCode.InvalidParams)
        } finally {
          fs.unlinkSync(leaf)
        }
        expect(yield* svc.unresolvedCount()).toBe(0)
      } finally {
        pair.carrier.dispose()
        pair.ext.dispose()
      }
    }),
  )

  it.live("observe shares the guard: project intermediate symlink rejected", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
      const dir = tmp.path
      yield* Effect.promise(() => seedProject(dir, { permission: { bash: "allow" } }))
      const external = yield* Effect.promise(() => tmpdir({ retain: true }))
      const kiloDir = path.join(dir, ".kilo")
      const backup = `${kiloDir}.${process.pid}.backup`
      const pair = linked()
      try {
        yield* Effect.promise(() => init(pair.ext))
        fs.renameSync(kiloDir, backup)
        fs.symlinkSync(external.path, kiloDir)
        try {
          const err = yield* Effect.promise(() =>
            pair.ext
              .request("config/convergence/observe", observeReq(`obs-link-${Date.now()}`, [{ kind: "config", scope: "project", directory: dir }]))
              .then(
                () => "ok",
                (e: unknown) => String((e as { code?: unknown }).code ?? e),
              ),
          )
          expect(err).toBe(String(ErrorCode.InvalidParams))
        } finally {
          fs.unlinkSync(kiloDir)
          fs.renameSync(backup, kiloDir)
        }
      } finally {
        pair.carrier.dispose()
        pair.ext.dispose()
      }
    }),
  )

  it.live("resolve swap of intermediate dir fails closed without adopting external", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
      const dir = tmp.path
      yield* Effect.promise(() => seedProject(dir, { permission: { bash: "allow" } }))
      const store = yield* InstanceStore.Service
      yield* store.load({ directory: dir })
      const gate = yield* GenerationGate.Service
      const svc = yield* ConfigFileConvergence.Service
      const external = yield* Effect.promise(() => tmpdir({ retain: true }))
      yield* Effect.promise(() => seedProject(external.path, { permission: { bash: "allow" }, username: "external-evil" }))
      const kiloDir = path.join(dir, ".kilo")
      const backup = `${kiloDir}.${process.pid}.backup`
      const pair = linked()
      let swapped = false
      try {
        yield* Effect.promise(() => init(pair.ext))
        const lease = `swap-${Date.now()}`
        const rawAcq: unknown = yield* Effect.promise(() =>
          pair.ext.request("config/convergence/acquire", acquireReq(lease, [{ kind: "config", scope: "project", directory: dir }])),
        )
        expect((rawAcq as { acquired: boolean }).acquired).toBe(true)
        fs.renameSync(kiloDir, backup)
        fs.symlinkSync(path.join(external.path, ".kilo"), kiloDir)
        swapped = true
        const rawRes: unknown = yield* Effect.promise(() => pair.ext.request("config/convergence/resolve", resolveReq(lease)))
        expect((rawRes as { outcome: string }).outcome).toBe("failed")
        expect(yield* svc.unresolvedCount()).toBe(0)
      } finally {
        if (swapped) {
          try { fs.unlinkSync(kiloDir) } catch { /* best-effort */ }
          try { fs.renameSync(backup, kiloDir) } catch { /* best-effort */ }
        }
        pair.carrier.dispose()
        pair.ext.dispose()
      }
      expect(gate.isBarrierActive(dir)).toBe(false)
      const eff = yield* Effect.promise(() => overlay(dir))
      expect(eff.effective["username"]).not.toBe("external-evil")
      yield* awaitWithTimeout(awaitRebuilds(), "swap rebuild quiescence failed")
      expect(yield* svc.unresolvedCount()).toBe(0)
    }),
  )
})
