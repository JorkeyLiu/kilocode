import { afterEach, describe, expect } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { PassThrough } from "node:stream"
import { Deferred, Effect, Fiber } from "effect"
import { Server } from "../../../src/server/server"
import { Global } from "@opencode-ai/core/global"
import { Event } from "../../../src/server/event"
import { GlobalBus } from "../../../src/bus/global"
import { awaitRebuilds } from "../../../src/kilocode/server/config-rebuild"
import {
  setAcquireHooksForTest,
  setLeaseTtlMsForTest,
  setPeerCloseGraceMsForTest,
} from "../../../src/kilocode/server/config-file-convergence"
import { ConfigFileConvergence } from "../../../src/kilocode/server/config-file-convergence"
import { JsonRpcPeer } from "../../../src/private-worker/peer"
import { ErrorCode } from "../../../src/private-worker/json-rpc"
import { createFdCarrier } from "../../../src/kilocode/server/fd-carrier"
import { FD_PROTOCOL_NAME } from "../../../src/kilocode/server/fd-carrier-protocol"
import { AppLayer } from "../../../src/effect/app-runtime"
import { Config } from "../../../src/config/config"
import { ConfigConvergence } from "../../../src/kilocode/server/config-convergence"
import { MCP } from "../../../src/mcp"
import { InstanceStore } from "../../../src/project/instance-store"
import { GenerationGate } from "../../../src/kilocode/server/generation-gate"
import { awaitWithTimeout, pollWithTimeout, testEffectShared } from "../../lib/effect"
import { tmpdir, disposeAllInstances } from "../../fixture/fixture"
import { markProjectConfigReady, markPluginDependenciesReady } from "../../fixture/plugin"
import { resetDatabase } from "../../fixture/db"

const it = testEffectShared(AppLayer)
const originalGlobal = Global.Path.config

afterEach(async () => {
  ;(Global.Path as { config: string }).config = originalGlobal
  GlobalBus.removeAllListeners("event")
  setPeerCloseGraceMsForTest(undefined)
  setLeaseTtlMsForTest(undefined)
  setAcquireHooksForTest(undefined)
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

const projectFile = (dir: string) => path.join(dir, ".kilo", "kilo.jsonc")

const atomicWrite = (file: string, value: Record<string, unknown>) => {
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify({ $schema: "https://app.kilo.ai/config.json", ...value }, null, 2), "utf8")
  fs.renameSync(tmp, file)
}

const readProject = (dir: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(projectFile(dir), "utf8")) as Record<string, unknown>

const seedProject = async (dir: string, value: Record<string, unknown>) => {
  await markProjectConfigReady(dir)
  atomicWrite(projectFile(dir), value)
  await markProjectConfigReady(dir)
}

const isDone = <A>(d: Deferred.Deferred<A>) => Effect.map(Deferred.poll(d), (o) => o._tag === "Some")

const overlay = async (dir: string) => {
  const res = await Server.Default().app.request("/config/overlay?scope=project", {
    headers: { "x-kilo-directory": dir },
  })
  expect(res.status).toBe(200)
  return (await res.json()) as { effective: Record<string, unknown> }
}

describe("fd-carrier config convergence (real production graph)", () => {
  it.live("advertises acquire/resolve capability and rejects invalid acquire fail-closed", () =>
    Effect.gen(function* () {
      const pair = linked()
      try {
        const rawInit: unknown = yield* Effect.promise(() => init(pair.ext))
        const caps = (rawInit as { capabilities: string[] }).capabilities
        expect(caps.includes("config/convergence/acquire")).toBeTrue()
        expect(caps.includes("config/convergence/resolve")).toBeTrue()
        const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
        const dir = tmp.path
        yield* Effect.promise(() => seedProject(dir, { permission: { bash: "allow" } }))
        const gate = yield* GenerationGate.Service
        const badRaw: unknown = yield* Effect.promise(() =>
          pair.ext
            .request(
              "config/convergence/acquire",
              acquireReq("bad-multi", [
                { kind: "config", scope: "project", directory: dir },
                { kind: "config", scope: "project", directory: "/tmp/other" },
              ]),
            )
            .then(
              () => ({ ok: true as const }),
              (e: unknown) => ({ ok: false as const, err: e as { code?: number } }),
            ),
        )
        const bad = badRaw as { ok: boolean; err?: { code?: number } }
        expect(bad.ok).toBe(false)
        if (!bad.ok) expect(bad.err?.code).toBe(ErrorCode.InvalidParams)
        expect(gate.isBarrierActive(dir)).toBe(false)
        const unknownRaw: unknown = yield* Effect.promise(() =>
          pair.ext.request("config/convergence/resolve", resolveReq("no-such")).then(
            () => ({ ok: true as const }),
            (e: unknown) => ({ ok: false as const, err: e }),
          ),
        )
        expect((unknownRaw as { ok: boolean }).ok).toBe(false)
      } finally {
        pair.carrier.dispose()
        pair.ext.dispose()
      }
    }),
  )

  it.live("cold project write: new readers wait, held generation continues, resolve acks before release, latest disk after rebuild", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
      const dir = tmp.path
      yield* Effect.promise(() => seedProject(dir, { permission: { bash: "allow" } }))
      const store = yield* InstanceStore.Service
      const before = yield* store.load({ directory: dir })
      const gate = yield* GenerationGate.Service
      const releaseHeld = yield* gate.acquire(dir)
      const pair = linked()
      try {
        yield* Effect.promise(() => init(pair.ext))
        const lease = `cold-${Date.now()}-${Math.random().toString(36).slice(2)}`
        const rawAcq: unknown = yield* Effect.promise(() =>
          pair.ext.request("config/convergence/acquire", acquireReq(lease, [{ kind: "config", scope: "project", directory: dir }])),
        )
        expect((rawAcq as { acquired: boolean }).acquired).toBe(true)
        expect(gate.isBarrierActive(dir)).toBe(true)
        const admitted = yield* Deferred.make<void>()
        const waiter = yield* Effect.forkDetach(
          Effect.gen(function* () {
            const release = yield* gate.acquire(dir)
            yield* Deferred.succeed(admitted, void 0)
            yield* release
          }),
        )
        yield* Effect.yieldNow
        expect(yield* isDone(admitted)).toBe(false)
        atomicWrite(projectFile(dir), { permission: { bash: "allow" }, username: "cold-user" })
        const rawRes: unknown = yield* Effect.promise(() => pair.ext.request("config/convergence/resolve", resolveReq(lease)))
        expect((rawRes as { outcome: string }).outcome).toBe("cold")
        expect(yield* isDone(admitted)).toBe(false)
        expect(gate.isBarrierActive(dir)).toBe(true)
        const rebuildDone = yield* Deferred.make<void>()
        const rebuildFiber = yield* Effect.forkDetach(awaitRebuilds().pipe(Effect.ensuring(Deferred.succeed(rebuildDone, void 0))))
        expect(yield* isDone(rebuildDone)).toBe(false)
        yield* releaseHeld
        yield* awaitWithTimeout(Deferred.await(admitted), "new reader never admitted after release")
        yield* awaitWithTimeout(Fiber.join(rebuildFiber), "rebuild never settled")
        yield* awaitWithTimeout(awaitRebuilds(), "rebuild quiescence failed")
        expect(gate.isBarrierActive(dir)).toBe(false)
        const after = yield* store.snapshot(dir)
        expect(after._tag).toBe("Some")
        if (after._tag === "Some") expect(after.value).not.toBe(before)
        const eff = yield* Effect.promise(() => overlay(dir))
        expect(eff.effective["username"]).toBe("cold-user")
        expect(readProject(dir)["username"]).toBe("cold-user")
        yield* Fiber.join(waiter).pipe(Effect.ignore)
      } finally {
        pair.carrier.dispose()
        pair.ext.dispose()
      }
    }),
  )

  it.live("real MCP disabled swap converges cold and new MCP status reads latest disk", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
      const dir = tmp.path
      yield* Effect.promise(() =>
        seedProject(dir, {
          permission: { bash: "allow" },
          mcp: { "mcp-a": { type: "local", command: ["echo", "a"], enabled: false } },
        }),
      )
      const store = yield* InstanceStore.Service
      yield* store.load({ directory: dir })
      const readStatus = (directory: string) =>
        store.provide(
          { directory },
          Effect.gen(function* () {
            const mcp = yield* MCP.Service
            return yield* mcp.status()
          }),
        )
      const s0 = yield* readStatus(dir)
      expect(s0["mcp-a"]?.status).toBe("disabled")
      const gate = yield* GenerationGate.Service
      const releaseHeld = yield* gate.acquire(dir)
      const pair = linked()
      try {
        yield* Effect.promise(() => init(pair.ext))
        const lease = `mcp-${Date.now()}-${Math.random().toString(36).slice(2)}`
        yield* Effect.promise(() =>
          pair.ext.request("config/convergence/acquire", acquireReq(lease, [{ kind: "config", scope: "project", directory: dir }])),
        )
        atomicWrite(projectFile(dir), {
          permission: { bash: "allow" },
          mcp: { "mcp-b": { type: "local", command: ["echo", "b"], enabled: false } },
        })
        const rawRes: unknown = yield* Effect.promise(() => pair.ext.request("config/convergence/resolve", resolveReq(lease)))
        expect((rawRes as { outcome: string }).outcome).toBe("cold")
        expect(gate.isBarrierActive(dir)).toBe(true)
        yield* releaseHeld
        yield* awaitWithTimeout(awaitRebuilds(), "mcp rebuild never settled")
        expect(gate.isBarrierActive(dir)).toBe(false)
        const s1 = yield* readStatus(dir)
        expect(s1["mcp-b"]?.status).toBe("disabled")
        expect("mcp-a" in s1).toBe(false)
      } finally {
        pair.carrier.dispose()
        pair.ext.dispose()
      }
    }),
  )

  it.live("hot permission/model write: no dispose, new read sees value, one ConfigUpdated, fence released", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
      const dir = tmp.path
      yield* Effect.promise(() => seedProject(dir, { permission: { bash: "allow" }, model: "test/old-model" }))
      const store = yield* InstanceStore.Service
      const before = yield* store.load({ directory: dir })
      const gate = yield* GenerationGate.Service
      let updated = 0
      const updatedGate = yield* Deferred.make<void>()
      const handler = (evt: { payload: { type: string } }) => {
        if (evt.payload.type !== Event.ConfigUpdated.type) return
        updated += 1
        void Effect.runFork(Deferred.succeed(updatedGate, void 0))
      }
      GlobalBus.on("event", handler)
      const pair = linked()
      try {
        yield* Effect.promise(() => init(pair.ext))
        const lease = `hot-${Date.now()}-${Math.random().toString(36).slice(2)}`
        yield* Effect.promise(() =>
          pair.ext.request("config/convergence/acquire", acquireReq(lease, [{ kind: "config", scope: "project", directory: dir }])),
        )
        expect(gate.isBarrierActive(dir)).toBe(true)
        atomicWrite(projectFile(dir), { permission: { bash: "deny" }, model: "test/new-model" })
        const rawRes: unknown = yield* Effect.promise(() => pair.ext.request("config/convergence/resolve", resolveReq(lease)))
        expect((rawRes as { outcome: string }).outcome).toBe("hot")
        yield* awaitWithTimeout(Deferred.await(updatedGate), "ConfigUpdated never fired for hot")
        expect(updated).toBe(1)
        const after = yield* store.snapshot(dir)
        expect(after._tag).toBe("Some")
        if (after._tag === "Some") expect(after.value).toBe(before)
        expect(gate.isBarrierActive(dir)).toBe(false)
        const eff = yield* Effect.promise(() => overlay(dir))
        expect(eff.effective["model"]).toBe("test/new-model")
        const seen: unknown = yield* store.provide(
          { directory: dir },
          Effect.gen(function* () {
            const cfg = yield* Config.Service
            return yield* cfg.get()
          }),
        )
        expect(JSON.stringify(seen).includes("test/new-model")).toBe(true)
        yield* awaitWithTimeout(awaitRebuilds(), "hot path leaked a rebuild")
      } finally {
        GlobalBus.removeListener("event", handler)
        pair.carrier.dispose()
        pair.ext.dispose()
      }
    }),
  )

  it.live("noop when unchanged, double resolve replays terminal, rollback restores noop", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
      const dir = tmp.path
      yield* Effect.promise(() => seedProject(dir, { permission: { bash: "allow" } }))
      const store = yield* InstanceStore.Service
      const before = yield* store.load({ directory: dir })
      const gate = yield* GenerationGate.Service
      const pair = linked()
      try {
        yield* Effect.promise(() => init(pair.ext))
        const lease = `noop-${Date.now()}-${Math.random().toString(36).slice(2)}`
        yield* Effect.promise(() =>
          pair.ext.request("config/convergence/acquire", acquireReq(lease, [{ kind: "config", scope: "project", directory: dir }])),
        )
        const r1: unknown = yield* Effect.promise(() => pair.ext.request("config/convergence/resolve", resolveReq(lease)))
        expect((r1 as { outcome: string }).outcome).toBe("noop")
        const r2: unknown = yield* Effect.promise(() => pair.ext.request("config/convergence/resolve", resolveReq(lease)))
        expect((r2 as { outcome: string }).outcome).toBe("noop")
        expect(gate.isBarrierActive(dir)).toBe(false)
        const after = yield* store.snapshot(dir)
        if (after._tag === "Some") expect(after.value).toBe(before)
        const rb = `rb-${Date.now()}-${Math.random().toString(36).slice(2)}`
        yield* Effect.promise(() =>
          pair.ext.request("config/convergence/acquire", acquireReq(rb, [{ kind: "config", scope: "project", directory: dir }])),
        )
        const prev = readProject(dir)
        atomicWrite(projectFile(dir), { ...prev, username: "transient" })
        atomicWrite(projectFile(dir), prev)
        const r3: unknown = yield* Effect.promise(() => pair.ext.request("config/convergence/resolve", resolveReq(rb)))
        expect((r3 as { outcome: string }).outcome).toBe("noop")
        expect(gate.isBarrierActive(dir)).toBe(false)
        yield* awaitWithTimeout(awaitRebuilds(), "noop leaked a rebuild")
      } finally {
        pair.carrier.dispose()
        pair.ext.dispose()
      }
    }),
  )

  it.live("peer close before rename auto-noops and after rename auto-converges with injected short grace", () =>
    Effect.gen(function* () {
      setPeerCloseGraceMsForTest(20)
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
      const dir = tmp.path
      yield* Effect.promise(() => seedProject(dir, { permission: { bash: "allow" } }))
      const store = yield* InstanceStore.Service
      yield* store.load({ directory: dir })
      const gate = yield* GenerationGate.Service
      const svc = yield* ConfigFileConvergence.Service
      const pair = linked()
      try {
        yield* Effect.promise(() => init(pair.ext))
        const l1 = `peer-noop-${Date.now()}-1`
        yield* Effect.promise(() =>
          pair.ext.request("config/convergence/acquire", acquireReq(l1, [{ kind: "config", scope: "project", directory: dir }])),
        )
        expect(gate.isBarrierActive(dir)).toBe(true)
        yield* svc.peerClosed()
        yield* pollWithTimeout(
          Effect.sync(() => (!gate.isBarrierActive(dir) ? (true as const) : undefined)),
          "peer-close noop never released",
        )
        expect(yield* svc.unresolvedCount()).toBe(0)
        const l2 = `peer-cold-${Date.now()}-2`
        yield* Effect.promise(() =>
          pair.ext.request("config/convergence/acquire", acquireReq(l2, [{ kind: "config", scope: "project", directory: dir }])),
        )
        atomicWrite(projectFile(dir), { permission: { bash: "allow" }, username: "peer-cold" })
        yield* svc.peerClosed()
        yield* pollWithTimeout(
          Effect.sync(() => (!gate.isBarrierActive(dir) ? (true as const) : undefined)),
          "peer-close cold never released",
        )
        yield* awaitWithTimeout(awaitRebuilds(), "peer-close cold rebuild never settled")
        const eff = yield* Effect.promise(() => overlay(dir))
        expect(eff.effective["username"]).toBe("peer-cold")
      } finally {
        pair.carrier.dispose()
        pair.ext.dispose()
      }
    }),
  )

  it.live("burst of two leases on one fence coalesces and physical fence holds until the latest pass", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
      const dir = tmp.path
      yield* Effect.promise(() => seedProject(dir, { permission: { bash: "allow" } }))
      const store = yield* InstanceStore.Service
      yield* store.load({ directory: dir })
      const gate = yield* GenerationGate.Service
      const releaseHeld = yield* gate.acquire(dir)
      const pair = linked()
      try {
        yield* Effect.promise(() => init(pair.ext))
        const l1 = `burst-1-${Date.now()}`
        const l2 = `burst-2-${Date.now()}`
        yield* Effect.promise(() =>
          pair.ext.request("config/convergence/acquire", acquireReq(l1, [{ kind: "config", scope: "project", directory: dir }])),
        )
        yield* Effect.promise(() =>
          pair.ext.request("config/convergence/acquire", acquireReq(l2, [{ kind: "config", scope: "project", directory: dir }])),
        )
        atomicWrite(projectFile(dir), { permission: { bash: "allow" }, username: "burst-latest" })
        const r1: unknown = yield* Effect.promise(() => pair.ext.request("config/convergence/resolve", resolveReq(l1)))
        expect((r1 as { outcome: string }).outcome).toBe("cold")
        expect(gate.isBarrierActive(dir)).toBe(true)
        const r2: unknown = yield* Effect.promise(() => pair.ext.request("config/convergence/resolve", resolveReq(l2)))
        expect((r2 as { outcome: string }).outcome).toBe("cold")
        expect(gate.isBarrierActive(dir)).toBe(true)
        const rebuildDone = yield* Deferred.make<void>()
        const fiber = yield* Effect.forkDetach(awaitRebuilds().pipe(Effect.ensuring(Deferred.succeed(rebuildDone, void 0))))
        expect(yield* isDone(rebuildDone)).toBe(false)
        yield* releaseHeld
        yield* awaitWithTimeout(Fiber.join(fiber), "burst rebuild never settled")
        expect(gate.isBarrierActive(dir)).toBe(false)
        const eff = yield* Effect.promise(() => overlay(dir))
        expect(eff.effective["username"]).toBe("burst-latest")
      } finally {
        pair.carrier.dispose()
        pair.ext.dispose()
      }
    }),
  )

  it.live("concurrent resolve shares one settlement terminal (F2)", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
      const dir = tmp.path
      yield* Effect.promise(() => seedProject(dir, { permission: { bash: "allow" } }))
      const store = yield* InstanceStore.Service
      yield* store.load({ directory: dir })
      const gate = yield* GenerationGate.Service
      const pair = linked()
      try {
        yield* Effect.promise(() => init(pair.ext))
        const lease = `race-${Date.now()}`
        yield* Effect.promise(() =>
          pair.ext.request("config/convergence/acquire", acquireReq(lease, [{ kind: "config", scope: "project", directory: dir }])),
        )
        atomicWrite(projectFile(dir), { permission: { bash: "allow" }, username: "race-user" })
        const [r1, r2]: unknown[] = yield* Effect.promise(() =>
          Promise.all([
            pair.ext.request("config/convergence/resolve", resolveReq(lease)),
            pair.ext.request("config/convergence/resolve", resolveReq(lease)),
          ]),
        )
        expect((r1 as { outcome: string }).outcome).toBe("cold")
        expect((r2 as { outcome: string }).outcome).toBe("cold")
        yield* awaitWithTimeout(awaitRebuilds(), "race rebuild never settled")
        expect(gate.isBarrierActive(dir)).toBe(false)
        const eff = yield* Effect.promise(() => overlay(dir))
        expect(eff.effective["username"]).toBe("race-user")
      } finally {
        pair.carrier.dispose()
        pair.ext.dispose()
      }
    }),
  )

  it.live("resolved lease acquire replay returns resolved marker, never acquired (F3)", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
      const dir = tmp.path
      yield* Effect.promise(() => seedProject(dir, { permission: { bash: "allow" } }))
      const store = yield* InstanceStore.Service
      yield* store.load({ directory: dir })
      const pair = linked()
      try {
        yield* Effect.promise(() => init(pair.ext))
        const lease = `replay-${Date.now()}`
        const desc = [{ kind: "config", scope: "project", directory: dir }]
        yield* Effect.promise(() => pair.ext.request("config/convergence/acquire", acquireReq(lease, desc)))
        const r1: unknown = yield* Effect.promise(() => pair.ext.request("config/convergence/resolve", resolveReq(lease)))
        expect((r1 as { outcome: string }).outcome).toBe("noop")
        const r2: unknown = yield* Effect.promise(() => pair.ext.request("config/convergence/acquire", acquireReq(lease, desc)))
        // Strictly distinguished: resolved marker, not a fresh acquired.
        expect((r2 as { resolved?: boolean }).resolved).toBe(true)
        expect((r2 as { acquired?: boolean }).acquired).toBeUndefined()
        expect((r2 as { outcome?: string }).outcome).toBe("noop")
      } finally {
        pair.carrier.dispose()
        pair.ext.dispose()
      }
    }),
  )

  it.live("pending replay with different descriptors is a conflict (F4)", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
      const dir = tmp.path
      yield* Effect.promise(() => seedProject(dir, { permission: { bash: "allow" } }))
      const store = yield* InstanceStore.Service
      yield* store.load({ directory: dir })
      const pair = linked()
      try {
        yield* Effect.promise(() => init(pair.ext))
        const lease = `conflict-${Date.now()}`
        yield* Effect.promise(() =>
          pair.ext.request("config/convergence/acquire", acquireReq(lease, [{ kind: "config", scope: "project", directory: dir }])),
        )
        const badRaw: unknown = yield* Effect.promise(() =>
          pair.ext
            .request(
              "config/convergence/acquire",
              acquireReq(lease, [
                { kind: "config", scope: "project", directory: dir },
                { kind: "asset", asset: "agent", scope: "project", directory: dir, id: "helper" },
              ]),
            )
            .then(
              () => ({ ok: true as const }),
              (e: unknown) => ({ ok: false as const, err: e as { code?: number } }),
            ),
        )
        const bad = badRaw as { ok: boolean; err?: { code?: number } }
        expect(bad.ok).toBe(false)
        if (!bad.ok) expect(bad.err?.code).toBe(ErrorCode.InvalidParams)
        const r: unknown = yield* Effect.promise(() => pair.ext.request("config/convergence/resolve", resolveReq(lease)))
        expect((r as { outcome: string }).outcome).toBe("noop")
      } finally {
        pair.carrier.dispose()
        pair.ext.dispose()
      }
    }),
  )

  it.live("TTL expiry auto-resolves noop and frees the lease (F5)", () =>
    Effect.gen(function* () {
      setLeaseTtlMsForTest(40)
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
      const dir = tmp.path
      yield* Effect.promise(() => seedProject(dir, { permission: { bash: "allow" } }))
      const store = yield* InstanceStore.Service
      yield* store.load({ directory: dir })
      const gate = yield* GenerationGate.Service
      const svc = yield* ConfigFileConvergence.Service
      const pair = linked()
      try {
        yield* Effect.promise(() => init(pair.ext))
        const lease = `ttl-${Date.now()}`
        yield* Effect.promise(() =>
          pair.ext.request("config/convergence/acquire", acquireReq(lease, [{ kind: "config", scope: "project", directory: dir }])),
        )
        expect(gate.isBarrierActive(dir)).toBe(true)
        yield* pollWithTimeout(
          Effect.sync(() => (gate.isBarrierActive(dir) ? undefined : (true as const))),
          "TTL expiry never released the fence",
        )
        expect(yield* svc.unresolvedCount()).toBe(0)
      } finally {
        pair.carrier.dispose()
        pair.ext.dispose()
      }
    }),
  )

  it.live("lease limit rejects the 33rd lease (F5)", () =>
    Effect.gen(function* () {
      setLeaseTtlMsForTest(60_000)
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
      const dir = tmp.path
      yield* Effect.promise(() => seedProject(dir, { permission: { bash: "allow" } }))
      const store = yield* InstanceStore.Service
      yield* store.load({ directory: dir })
      const desc = [{ kind: "config", scope: "project", directory: dir }]
      const pair = linked()
      try {
        yield* Effect.promise(() => init(pair.ext))
        const leases: string[] = []
        for (let i = 0; i < 32; i++) {
          const lease = `limit-${Date.now()}-${i}`
          leases.push(lease)
          yield* Effect.promise(() => pair.ext.request("config/convergence/acquire", acquireReq(lease, desc)))
        }
        const overRaw: unknown = yield* Effect.promise(() =>
          pair.ext.request("config/convergence/acquire", acquireReq(`limit-${Date.now()}-over`, desc)).then(
            () => ({ ok: true as const }),
            (e: unknown) => ({ ok: false as const, err: e }),
          ),
        )
        expect((overRaw as { ok: boolean }).ok).toBe(false)
        for (const lease of leases) {
          const r: unknown = yield* Effect.promise(() => pair.ext.request("config/convergence/resolve", resolveReq(lease)))
          expect((r as { outcome: string }).outcome).toBe("noop")
        }
      } finally {
        pair.carrier.dispose()
        pair.ext.dispose()
      }
    }),
  )

  it.live("unauthorized directories rejected: /etc escape and symlink escape (F8)", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
      const dir = tmp.path
      yield* Effect.promise(() => seedProject(dir, { permission: { bash: "allow" } }))
      const gate = yield* GenerationGate.Service
      const svc = yield* ConfigFileConvergence.Service
      const pair = linked()
      try {
        yield* Effect.promise(() => init(pair.ext))
        const escRaw: unknown = yield* Effect.promise(() =>
          pair.ext
            .request("config/convergence/acquire", acquireReq(`esc-${Date.now()}`, [{ kind: "config", scope: "project", directory: "/etc" }]))
            .then(
              () => ({ ok: true as const }),
              (e: unknown) => ({ ok: false as const, err: e as { code?: number } }),
            ),
        )
        const esc = escRaw as { ok: boolean; err?: { code?: number } }
        expect(esc.ok).toBe(false)
        if (!esc.ok) expect(esc.err?.code).toBe(ErrorCode.InvalidParams)
        const link = path.join(dir, "evil-link")
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve, reject) => {
              fs.symlink("/etc", link, (err) => (err ? reject(err) : resolve()))
            }),
        )
        const symRaw: unknown = yield* Effect.promise(() =>
          pair.ext
            .request("config/convergence/acquire", acquireReq(`sym-${Date.now()}`, [{ kind: "config", scope: "project", directory: link }]))
            .then(
              () => ({ ok: true as const }),
              (e: unknown) => ({ ok: false as const, err: e as { code?: number } }),
            ),
        )
        const sym = symRaw as { ok: boolean; err?: { code?: number } }
        expect(sym.ok).toBe(false)
        if (!sym.ok) expect(sym.err?.code).toBe(ErrorCode.InvalidParams)
        expect(yield* svc.unresolvedCount()).toBe(0)
        expect(gate.isBarrierActive(dir)).toBe(false)
      } finally {
        pair.carrier.dispose()
        pair.ext.dispose()
      }
    }),
  )

  it.live("unloaded legal project establishes identity and converges cold (F8)", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
      const dir = tmp.path
      // Intentionally NOT loaded: acquire must establish the identity.
      yield* Effect.promise(() => seedProject(dir, { permission: { bash: "allow" } }))
      const pair = linked()
      try {
        yield* Effect.promise(() => init(pair.ext))
        const lease = `est-${Date.now()}`
        const rawAcq: unknown = yield* Effect.promise(() =>
          pair.ext.request("config/convergence/acquire", acquireReq(lease, [{ kind: "config", scope: "project", directory: dir }])),
        )
        expect((rawAcq as { acquired: boolean }).acquired).toBe(true)
        atomicWrite(projectFile(dir), { permission: { bash: "allow" }, username: "established" })
        const rawRes: unknown = yield* Effect.promise(() => pair.ext.request("config/convergence/resolve", resolveReq(lease)))
        expect((rawRes as { outcome: string }).outcome).toBe("cold")
        yield* awaitWithTimeout(awaitRebuilds(), "establish rebuild never settled")
        const eff = yield* Effect.promise(() => overlay(dir))
        expect(eff.effective["username"]).toBe("established")
      } finally {
        pair.carrier.dispose()
        pair.ext.dispose()
      }
    }),
  )

  it.live("nonexistent target under an authorized parent is allowed (F8)", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
      const dir = tmp.path
      yield* Effect.promise(() => seedProject(dir, { permission: { bash: "allow" } }))
      const store = yield* InstanceStore.Service
      yield* store.load({ directory: dir })
      const future = path.join(dir, "future-proj")
      const pair = linked()
      try {
        yield* Effect.promise(() => init(pair.ext))
        const lease = `future-${Date.now()}`
        const rawAcq: unknown = yield* Effect.promise(() =>
          pair.ext.request(
            "config/convergence/acquire",
            acquireReq(lease, [{ kind: "config", scope: "project", directory: future }]),
          ),
        )
        expect((rawAcq as { acquired: boolean }).acquired).toBe(true)
        const rawRes: unknown = yield* Effect.promise(() => pair.ext.request("config/convergence/resolve", resolveReq(lease)))
        expect((rawRes as { outcome: string }).outcome).toBe("noop")
      } finally {
        pair.carrier.dispose()
        pair.ext.dispose()
      }
    }),
  )

  it.live("unreadable config converges cold, never noop/hot (F7)", () =>
    Effect.gen(function* () {
      if (typeof process.getuid === "function" && process.getuid() === 0) return
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
      const dir = tmp.path
      yield* Effect.promise(() => seedProject(dir, { permission: { bash: "allow" } }))
      const store = yield* InstanceStore.Service
      yield* store.load({ directory: dir })
      const file = projectFile(dir)
      const gate = yield* GenerationGate.Service
      // Held reader: the pass cannot boot until release, so the restore
      // below deterministically precedes the boot-from-disk.
      const releaseHeld = yield* gate.acquire(dir)
      const pair = linked()
      try {
        yield* Effect.promise(() => init(pair.ext))
        const lease = `unread-${Date.now()}`
        yield* Effect.promise(() =>
          pair.ext.request("config/convergence/acquire", acquireReq(lease, [{ kind: "config", scope: "project", directory: dir }])),
        )
        fs.chmodSync(file, 0o000)
        try {
          fs.readFileSync(file, "utf8")
          // Still readable (platform): restore and skip strict assertion.
          fs.chmodSync(file, 0o644)
          const r: unknown = yield* Effect.promise(() => pair.ext.request("config/convergence/resolve", resolveReq(lease)))
          expect(["noop", "cold", "hot"].includes((r as { outcome: string }).outcome)).toBe(true)
          yield* releaseHeld
          return
        } catch {
          // Genuinely unreadable: must converge cold, never noop/hot.
        }
        const rawRes: unknown = yield* Effect.promise(() => pair.ext.request("config/convergence/resolve", resolveReq(lease)))
        expect((rawRes as { outcome: string }).outcome).toBe("cold")
        // Restore before releasing: the pass boots from readable disk.
        fs.chmodSync(file, 0o644)
        yield* releaseHeld
        yield* awaitWithTimeout(awaitRebuilds(), "unreadable rebuild never settled")
        const eff = yield* Effect.promise(() => overlay(dir))
        expect(eff.effective["permission"]).toEqual({ bash: "allow" })
      } finally {
        try {
          fs.chmodSync(file, 0o644)
        } catch {
          // Already restored or removed with tmpdir.
        }
        pair.carrier.dispose()
        pair.ext.dispose()
      }
    }),
  )

  it.live("peerClosed registers and returns immediately; grace auto-settles (F12)", () =>
    Effect.gen(function* () {
      setPeerCloseGraceMsForTest(200)
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
      const dir = tmp.path
      yield* Effect.promise(() => seedProject(dir, { permission: { bash: "allow" } }))
      const store = yield* InstanceStore.Service
      yield* store.load({ directory: dir })
      const gate = yield* GenerationGate.Service
      const svc = yield* ConfigFileConvergence.Service
      const pair = linked()
      try {
        yield* Effect.promise(() => init(pair.ext))
        const lease = `imm-${Date.now()}`
        yield* Effect.promise(() =>
          pair.ext.request("config/convergence/acquire", acquireReq(lease, [{ kind: "config", scope: "project", directory: dir }])),
        )
        expect(gate.isBarrierActive(dir)).toBe(true)
        // Registration returns without waiting for the grace: the lease is
        // still unresolved immediately after peerClosed returns.
        yield* svc.peerClosed()
        expect(yield* svc.unresolvedCount()).toBe(1)
        expect(gate.isBarrierActive(dir)).toBe(true)
        yield* pollWithTimeout(
          Effect.sync(() => (!gate.isBarrierActive(dir) ? (true as const) : undefined)),
          "peer-close grace never auto-settled",
        )
        expect(yield* svc.unresolvedCount()).toBe(0)
      } finally {
        pair.carrier.dispose()
        pair.ext.dispose()
      }
    }),
  )

  it.live("global hot change converges hot across loaded directories (F6)", () =>
    Effect.gen(function* () {
      const global = yield* Effect.promise(() => tmpdir({ retain: true }))
      ;(Global.Path as { config: string }).config = global.path
      fs.writeFileSync(
        path.join(global.path, "kilo.jsonc"),
        JSON.stringify({ $schema: "https://app.kilo.ai/config.json", model: "test/old-model" }),
        "utf8",
      )
      yield* Effect.promise(() => markPluginDependenciesReady(global.path))
      const tmpA = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
      const tmpB = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
      yield* Effect.promise(() => seedProject(tmpA.path, { permission: { bash: "allow" } }))
      yield* Effect.promise(() => seedProject(tmpB.path, { permission: { bash: "allow" } }))
      const store = yield* InstanceStore.Service
      yield* store.load({ directory: tmpA.path })
      yield* store.load({ directory: tmpB.path })
      const gate = yield* GenerationGate.Service
      let updated = 0
      const handler = (evt: { payload: { type: string } }) => {
        if (evt.payload.type !== Event.ConfigUpdated.type) return
        updated += 1
      }
      GlobalBus.on("event", handler)
      const pair = linked()
      try {
        yield* Effect.promise(() => init(pair.ext))
        const lease = `ghot-${Date.now()}`
        yield* Effect.promise(() =>
          pair.ext.request("config/convergence/acquire", acquireReq(lease, [{ kind: "config", scope: "global" }])),
        )
        expect(gate.isBarrierActive(tmpA.path)).toBe(true)
        expect(gate.isBarrierActive(tmpB.path)).toBe(true)
        atomicWrite(path.join(global.path, "kilo.jsonc"), { model: "test/new-model" })
        const raw: unknown = yield* Effect.promise(() => pair.ext.request("config/convergence/resolve", resolveReq(lease)))
        expect((raw as { outcome: string }).outcome).toBe("hot")
        expect(gate.isBarrierActive(tmpA.path)).toBe(false)
        expect(gate.isBarrierActive(tmpB.path)).toBe(false)
        expect(updated).toBeGreaterThanOrEqual(1)
        yield* awaitWithTimeout(awaitRebuilds(), "global hot leaked a rebuild")
      } finally {
        GlobalBus.removeListener("event", handler)
        pair.carrier.dispose()
        pair.ext.dispose()
      }
    }),
  )

  it.live("global cold write via carrier fences and converges latest disk", () =>
    Effect.gen(function* () {
      const global = yield* Effect.promise(() => tmpdir({ retain: true }))
      ;(Global.Path as { config: string }).config = global.path
      fs.writeFileSync(path.join(global.path, "kilo.jsonc"), JSON.stringify({ $schema: "https://app.kilo.ai/config.json", username: "g0" }), "utf8")
      yield* Effect.promise(() => markPluginDependenciesReady(global.path))
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
      const dir = tmp.path
      yield* Effect.promise(() => seedProject(dir, { permission: { bash: "allow" } }))
      const store = yield* InstanceStore.Service
      yield* store.load({ directory: dir })
      const gate = yield* GenerationGate.Service
      const pair = linked()
      try {
        yield* Effect.promise(() => init(pair.ext))
        const lease = `global-${Date.now()}`
        yield* Effect.promise(() =>
          pair.ext.request("config/convergence/acquire", acquireReq(lease, [{ kind: "config", scope: "global" }])),
        )
        expect(gate.isBarrierActive(dir)).toBe(true)
        const file = path.join(global.path, "kilo.jsonc")
        atomicWrite(file, { username: "g1" })
        const raw: unknown = yield* Effect.promise(() => pair.ext.request("config/convergence/resolve", resolveReq(lease)))
        expect((raw as { outcome: string }).outcome).toBe("cold")
        yield* awaitWithTimeout(awaitRebuilds(), "global rebuild never settled")
        expect(gate.isBarrierActive(dir)).toBe(false)
        const disk = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>
        expect(disk["username"]).toBe("g1")
      } finally {
        pair.carrier.dispose()
        pair.ext.dispose()
      }
    }),
  )

  it.live("F-01 concurrent acquire same lease: one begin, one fence, no orphan, deterministic results", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
      const dir = tmp.path
      yield* Effect.promise(() => seedProject(dir, { permission: { bash: "allow" } }))
      const store = yield* InstanceStore.Service
      yield* store.load({ directory: dir })
      const gate = yield* GenerationGate.Service
      const svc = yield* ConfigFileConvergence.Service
      const pair = linked()
      try {
        yield* Effect.promise(() => init(pair.ext))
        const lease = `f01-${Date.now()}-${Math.random().toString(36).slice(2)}`
        const desc = [{ kind: "config", scope: "project", directory: dir }]
        const [r1, r2]: unknown[] = yield* Effect.promise(() =>
          Promise.all([
            pair.ext.request("config/convergence/acquire", acquireReq(lease, desc)),
            pair.ext.request("config/convergence/acquire", acquireReq(lease, desc)),
          ]),
        )
        // Deterministic semantics: both observe the single pending lease.
        expect((r1 as { acquired?: boolean }).acquired).toBe(true)
        expect((r2 as { acquired?: boolean }).acquired).toBe(true)
        expect((r1 as { resolved?: boolean }).resolved).toBeUndefined()
        expect((r2 as { resolved?: boolean }).resolved).toBeUndefined()
        expect(yield* svc.unresolvedCount()).toBe(1)
        expect(gate.isBarrierActive(dir)).toBe(true)
        const res: unknown = yield* Effect.promise(() => pair.ext.request("config/convergence/resolve", resolveReq(lease)))
        expect((res as { outcome: string }).outcome).toBe("noop")
        // No orphan fence: the single physical fence released exactly once.
        expect(gate.isBarrierActive(dir)).toBe(false)
        expect(yield* svc.unresolvedCount()).toBe(0)
        yield* awaitWithTimeout(awaitRebuilds(), "F-01 rebuild quiescence failed")
        expect(gate.isBarrierActive(dir)).toBe(false)
      } finally {
        pair.carrier.dispose()
        pair.ext.dispose()
      }
    }),
  )

  it.live("F-02 stable unreadable converges cold/failed, never noop/hot", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
      const dir = tmp.path
      yield* Effect.promise(() => seedProject(dir, { permission: { bash: "allow" } }))
      const store = yield* InstanceStore.Service
      yield* store.load({ directory: dir })
      const gate = yield* GenerationGate.Service
      const svc = yield* ConfigFileConvergence.Service
      const pair = linked()
      const file = projectFile(dir)
      try {
        yield* Effect.promise(() => init(pair.ext))
        // Make the config path unreadable without chmod (works as root):
        // replace the file with a directory so reads fail EISDIR stably.
        const stash = `${file}.${process.pid}.stash`
        fs.renameSync(file, stash)
        fs.mkdirSync(file)
        try {
          for (const tag of ["a", "b"]) {
            const lease = `f02-${Date.now()}-${tag}`
            const rawAcq: unknown = yield* Effect.promise(() =>
              pair.ext.request("config/convergence/acquire", acquireReq(lease, [{ kind: "config", scope: "project", directory: dir }])),
            )
            expect((rawAcq as { acquired: boolean }).acquired).toBe(true)
            const rawRes: unknown = yield* Effect.promise(() =>
              pair.ext.request("config/convergence/resolve", resolveReq(lease)),
            )
            const outcome = (rawRes as { outcome: string }).outcome
            expect(outcome === "noop" || outcome === "hot").toBe(false)
            expect(outcome === "cold" || outcome === "failed").toBe(true)
          }
        } finally {
          fs.rmdirSync(file)
          fs.renameSync(stash, file)
        }
        // Cold commits register a rebuild pass: await quiescence before the
        // fence-release assertion (same as the existing cold tests).
        yield* awaitWithTimeout(awaitRebuilds(), "F-02 rebuild quiescence failed")
        expect(gate.isBarrierActive(dir)).toBe(false)
        expect(yield* svc.unresolvedCount()).toBe(0)
      } finally {
        pair.carrier.dispose()
        pair.ext.dispose()
      }
    }),
  )

  it.live("F-03 hot invalidation failure falls back to cold commit (failure injection)", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
      const dir = tmp.path
      yield* Effect.promise(() => seedProject(dir, { permission: { bash: "allow" }, model: "test/old-model" }))
      const store = yield* InstanceStore.Service
      yield* store.load({ directory: dir })
      const gate = yield* GenerationGate.Service
      const cfg = yield* Config.Service
      const strict = cfg as unknown as Record<string, unknown>
      const orig = strict["invalidateProjectStrict"]
      strict["invalidateProjectStrict"] = () => Effect.die(new Error("injected hot invalidate failure"))
      const pair = linked()
      try {
        yield* Effect.promise(() => init(pair.ext))
        const lease = `f03-${Date.now()}`
        yield* Effect.promise(() =>
          pair.ext.request("config/convergence/acquire", acquireReq(lease, [{ kind: "config", scope: "project", directory: dir }])),
        )
        atomicWrite(projectFile(dir), { permission: { bash: "deny" }, model: "test/new-model" })
        const rawRes: unknown = yield* Effect.promise(() => pair.ext.request("config/convergence/resolve", resolveReq(lease)))
        // Hot-provable keys but strict invalidation failed: must not return
        // hot — cold commit from disk instead.
        expect((rawRes as { outcome: string }).outcome).toBe("cold")
        expect(gate.isBarrierActive(dir)).toBe(true)
        yield* awaitWithTimeout(awaitRebuilds(), "F-03 fallback rebuild never settled")
        expect(gate.isBarrierActive(dir)).toBe(false)
        const eff = yield* Effect.promise(() => overlay(dir))
        expect(eff.effective["model"]).toBe("test/new-model")
      } finally {
        strict["invalidateProjectStrict"] = orig
        pair.carrier.dispose()
        pair.ext.dispose()
      }
    }),
  )

  it.live("F-04 loaded directory symlink swap is rejected (TOCTOU)", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
      const dir = tmp.path
      yield* Effect.promise(() => seedProject(dir, { permission: { bash: "allow" } }))
      const store = yield* InstanceStore.Service
      yield* store.load({ directory: dir })
      const gate = yield* GenerationGate.Service
      const svc = yield* ConfigFileConvergence.Service
      const pair = linked()
      const backup = `${dir}.${process.pid}.backup`
      try {
        yield* Effect.promise(() => init(pair.ext))
        fs.renameSync(dir, backup)
        fs.symlinkSync("/etc", dir)
        try {
          const badRaw: unknown = yield* Effect.promise(() =>
            pair.ext
              .request("config/convergence/acquire", acquireReq(`f04-${Date.now()}`, [{ kind: "config", scope: "project", directory: dir }]))
              .then(
                () => ({ ok: true as const }),
                (e: unknown) => ({ ok: false as const, err: e as { code?: number } }),
              ),
          )
          const bad = badRaw as { ok: boolean; err?: { code?: number } }
          expect(bad.ok).toBe(false)
          if (!bad.ok) expect(bad.err?.code).toBe(ErrorCode.InvalidParams)
        } finally {
          fs.unlinkSync(dir)
          fs.renameSync(backup, dir)
        }
        expect(yield* svc.unresolvedCount()).toBe(0)
        expect(gate.isBarrierActive(dir)).toBe(false)
      } finally {
        try {
          if (!fs.existsSync(dir) && fs.existsSync(backup)) fs.renameSync(backup, dir)
        } catch {
          // Best-effort restore; tmpdir retain handles the rest.
        }
        pair.carrier.dispose()
        pair.ext.dispose()
      }
    }),
  )

  it.live("F-05 backend wire contract is exact and fail-closed", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
      const dir = tmp.path
      yield* Effect.promise(() => seedProject(dir, { permission: { bash: "allow" } }))
      const store = yield* InstanceStore.Service
      yield* store.load({ directory: dir })
      const pair = linked()
      try {
        yield* Effect.promise(() => init(pair.ext))
        const lease = `f05-${Date.now()}`
        const rawAcq: unknown = yield* Effect.promise(() =>
          pair.ext.request("config/convergence/acquire", acquireReq(lease, [{ kind: "config", scope: "project", directory: dir }])),
        )
        // Exact fresh-acquire shape: v/leaseId/acquired only.
        expect(Object.keys(rawAcq as Record<string, unknown>).sort()).toEqual(["acquired", "leaseId", "v"])
        expect((rawAcq as { v: number }).v).toBe(1)
        expect((rawAcq as { leaseId: string }).leaseId).toBe(lease)
        const rawRes: unknown = yield* Effect.promise(() => pair.ext.request("config/convergence/resolve", resolveReq(lease)))
        // Exact resolve shape: v/leaseId/outcome/scope only.
        expect(Object.keys(rawRes as Record<string, unknown>).sort()).toEqual(["leaseId", "outcome", "scope", "v"])
        // Unknown request field rejected fail-closed.
        const extraRaw: unknown = yield* Effect.promise(() =>
          pair.ext
            .request("config/convergence/acquire", { ...acquireReq(`f05x-${Date.now()}`, [{ kind: "config", scope: "global" }]), bogus: 1 })
            .then(
              () => ({ ok: true as const }),
              (e: unknown) => ({ ok: false as const, err: e as { code?: number } }),
            ),
        )
        expect((extraRaw as { ok: boolean }).ok).toBe(false)
        if (!(extraRaw as { ok: boolean }).ok)
          expect((extraRaw as { err?: { code?: number } }).err?.code).toBe(ErrorCode.InvalidParams)
        // Unbound token trio rejected fail-closed.
        const unboundRaw: unknown = yield* Effect.promise(() =>
          pair.ext
            .request("config/convergence/acquire", {
              v: 1,
              leaseId: "a",
              opId: "b",
              requestId: "a",
              idempotencyKey: "a",
              descriptors: [{ kind: "config", scope: "global" }],
            })
            .then(
              () => ({ ok: true as const }),
              (e: unknown) => ({ ok: false as const, err: e as { code?: number } }),
            ),
        )
        expect((unboundRaw as { ok: boolean }).ok).toBe(false)
      } finally {
        pair.carrier.dispose()
        pair.ext.dispose()
      }
    }),
  )

  it.live("F-06 cold commit failure records failed terminal without fence leak or recommit", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
      const dir = tmp.path
      yield* Effect.promise(() => seedProject(dir, { permission: { bash: "allow" } }))
      const store = yield* InstanceStore.Service
      yield* store.load({ directory: dir })
      const gate = yield* GenerationGate.Service
      const svc = yield* ConfigFileConvergence.Service
      const coord = yield* ConfigConvergence.Service
      const rec = coord as unknown as Record<string, unknown>
      const origCommit = rec["commit"] as (obligation: never) => Effect.Effect<void>
      let commits = 0
      rec["commit"] = (obligation: never): Effect.Effect<void> =>
        Effect.gen(function* () {
          commits += 1
          return yield* Effect.die(new Error("injected cold commit failure"))
        })
      const pair = linked()
      try {
        yield* Effect.promise(() => init(pair.ext))
        const lease = `f06-${Date.now()}`
        yield* Effect.promise(() =>
          pair.ext.request("config/convergence/acquire", acquireReq(lease, [{ kind: "config", scope: "project", directory: dir }])),
        )
        atomicWrite(projectFile(dir), { permission: { bash: "allow" }, username: "f06-user" })
        const r1: unknown = yield* Effect.promise(() => pair.ext.request("config/convergence/resolve", resolveReq(lease)))
        expect((r1 as { outcome: string }).outcome).toBe("failed")
        expect(commits).toBe(1)
        // No fence leak: pending cleared, barrier released.
        expect(yield* svc.unresolvedCount()).toBe(0)
        expect(gate.isBarrierActive(dir)).toBe(false)
        // Reobserve returns the same terminal without recommitting.
        const r2: unknown = yield* Effect.promise(() => pair.ext.request("config/convergence/resolve", resolveReq(lease)))
        expect((r2 as { outcome: string }).outcome).toBe("failed")
        expect(commits).toBe(1)
        expect(yield* svc.unresolvedCount()).toBe(0)
        expect(gate.isBarrierActive(dir)).toBe(false)
      } finally {
        rec["commit"] = origCommit
        pair.carrier.dispose()
        pair.ext.dispose()
      }
    }),
  )

  it.live("F-01 begin snapshot failure releases the fence, next acquire usable", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
      const dir = tmp.path
      yield* Effect.promise(() => seedProject(dir, { permission: { bash: "allow" } }))
      const store = yield* InstanceStore.Service
      yield* store.load({ directory: dir })
      const gate = yield* GenerationGate.Service
      const svc = yield* ConfigFileConvergence.Service
      const coord = yield* ConfigConvergence.Service
      const rec = store as unknown as Record<string, unknown>
      const origSnapshot = rec["snapshot"] as (d: string) => Effect.Effect<unknown>
      rec["snapshot"] = () => Effect.die(new Error("injected begin snapshot failure"))
      const badExit = yield* coord.begin({ directory: dir }).pipe(Effect.exit)
      rec["snapshot"] = origSnapshot
      expect(badExit._tag).toBe("Failure")
      expect(gate.isBarrierActive(dir)).toBe(false)
      const pair = linked()
      try {
        yield* Effect.promise(() => init(pair.ext))
        const lease = `f01-begin-${Date.now()}`
        const rawAcq: unknown = yield* Effect.promise(() =>
          pair.ext.request("config/convergence/acquire", acquireReq(lease, [{ kind: "config", scope: "project", directory: dir }])),
        )
        expect((rawAcq as { acquired: boolean }).acquired).toBe(true)
        expect(yield* svc.unresolvedCount()).toBe(1)
        expect(gate.isBarrierActive(dir)).toBe(true)
        const rawRes: unknown = yield* Effect.promise(() => pair.ext.request("config/convergence/resolve", resolveReq(lease)))
        expect((rawRes as { outcome: string }).outcome).toBe("noop")
        expect(gate.isBarrierActive(dir)).toBe(false)
        expect(yield* svc.unresolvedCount()).toBe(0)
      } finally {
        pair.carrier.dispose()
        pair.ext.dispose()
      }
    }),
  )

  it.live("F-01 post-begin snapshot and TTL failures abort without barrier/pending/timer leak", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
      const dir = tmp.path
      yield* Effect.promise(() => seedProject(dir, { permission: { bash: "allow" } }))
      const store = yield* InstanceStore.Service
      yield* store.load({ directory: dir })
      const gate = yield* GenerationGate.Service
      const svc = yield* ConfigFileConvergence.Service
      const pair = linked()
      try {
        yield* Effect.promise(() => init(pair.ext))
        setAcquireHooksForTest({ afterAuthorize: () => { throw new Error("injected post-begin snapshot failure") } })
        const badRaw: unknown = yield* Effect.promise(() =>
          pair.ext
            .request("config/convergence/acquire", acquireReq(`f01-snap-${Date.now()}`, [{ kind: "config", scope: "project", directory: dir }]))
            .then(
              () => ({ ok: true as const }),
              (e: unknown) => ({ ok: false as const, err: e }),
            ),
        )
        expect((badRaw as { ok: boolean }).ok).toBe(false)
        expect(gate.isBarrierActive(dir)).toBe(false)
        expect(yield* svc.unresolvedCount()).toBe(0)
        setAcquireHooksForTest({ beforeTtl: () => { throw new Error("injected TTL registration failure") } })
        const badTtl: unknown = yield* Effect.promise(() =>
          pair.ext
            .request("config/convergence/acquire", acquireReq(`f01-ttl-${Date.now()}`, [{ kind: "config", scope: "project", directory: dir }]))
            .then(
              () => ({ ok: true as const }),
              (e: unknown) => ({ ok: false as const, err: e }),
            ),
        )
        expect((badTtl as { ok: boolean }).ok).toBe(false)
        expect(gate.isBarrierActive(dir)).toBe(false)
        expect(yield* svc.unresolvedCount()).toBe(0)
        setAcquireHooksForTest(undefined)
        const lease = `f01-retry-${Date.now()}`
        const rawAcq: unknown = yield* Effect.promise(() =>
          pair.ext.request("config/convergence/acquire", acquireReq(lease, [{ kind: "config", scope: "project", directory: dir }])),
        )
        expect((rawAcq as { acquired: boolean }).acquired).toBe(true)
        expect(gate.isBarrierActive(dir)).toBe(true)
        const rawRes: unknown = yield* Effect.promise(() => pair.ext.request("config/convergence/resolve", resolveReq(lease)))
        expect((rawRes as { outcome: string }).outcome).toBe("noop")
        expect(gate.isBarrierActive(dir)).toBe(false)
        expect(yield* svc.unresolvedCount()).toBe(0)
        yield* awaitWithTimeout(awaitRebuilds(), "F-01 retry rebuild quiescence failed")
      } finally {
        setAcquireHooksForTest(undefined)
        pair.carrier.dispose()
        pair.ext.dispose()
      }
    }),
  )

  it.live("F-04 acquire-then-symlink-swap resolve fails closed without reading external target", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
      const dir = tmp.path
      yield* Effect.promise(() => seedProject(dir, { permission: { bash: "allow" } }))
      const store = yield* InstanceStore.Service
      yield* store.load({ directory: dir })
      const gate = yield* GenerationGate.Service
      const svc = yield* ConfigFileConvergence.Service
      const external = yield* Effect.promise(() => tmpdir({ retain: true }))
      yield* Effect.promise(() => markProjectConfigReady(external.path))
      atomicWrite(projectFile(external.path), { permission: { bash: "allow" }, username: "external-evil" })
      const pair = linked()
      const backup = `${dir}.${process.pid}.f04backup`
      let swapped = false
      try {
        yield* Effect.promise(() => init(pair.ext))
        const lease = `f04-swap-${Date.now()}`
        const rawAcq: unknown = yield* Effect.promise(() =>
          pair.ext.request("config/convergence/acquire", acquireReq(lease, [{ kind: "config", scope: "project", directory: dir }])),
        )
        expect((rawAcq as { acquired: boolean }).acquired).toBe(true)
        expect(gate.isBarrierActive(dir)).toBe(true)
        fs.renameSync(dir, backup)
        fs.symlinkSync(external.path, dir)
        swapped = true
        const rawRes: unknown = yield* Effect.promise(() => pair.ext.request("config/convergence/resolve", resolveReq(lease)))
        expect((rawRes as { outcome: string }).outcome).toBe("failed")
        expect((rawRes as { outcome: string }).outcome === "cold").toBe(false)
        expect((rawRes as { outcome: string }).outcome === "hot").toBe(false)
        expect(yield* svc.unresolvedCount()).toBe(0)
      } finally {
        if (swapped) {
          try { fs.unlinkSync(dir) } catch { /* restored below */ }
          try { fs.renameSync(backup, dir) } catch { /* best-effort */ }
        }
        pair.carrier.dispose()
        pair.ext.dispose()
      }
      expect(gate.isBarrierActive(dir)).toBe(false)
      expect(yield* svc.unresolvedCount()).toBe(0)
      const eff = yield* Effect.promise(() => overlay(dir))
      expect(eff.effective["username"]).not.toBe("external-evil")
      expect(readProject(dir)["username"]).not.toBe("external-evil")
      yield* awaitWithTimeout(awaitRebuilds(), "F-04 swap rebuild quiescence failed")
      expect(gate.isBarrierActive(dir)).toBe(false)
    }),
  )

  it.live("F-04 authorize-then-swap acquire fails closed without leak, next acquire usable", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
      const dir = tmp.path
      yield* Effect.promise(() => seedProject(dir, { permission: { bash: "allow" } }))
      const store = yield* InstanceStore.Service
      yield* store.load({ directory: dir })
      const gate = yield* GenerationGate.Service
      const svc = yield* ConfigFileConvergence.Service
      const external = yield* Effect.promise(() => tmpdir({ retain: true }))
      const backup = `${dir}.${process.pid}.f04abackup`
      const pair = linked()
      try {
        yield* Effect.promise(() => init(pair.ext))
        setAcquireHooksForTest({
          afterAuthorize: () => {
            fs.renameSync(dir, backup)
            fs.symlinkSync(external.path, dir)
          },
        })
        const badRaw: unknown = yield* Effect.promise(() =>
          pair.ext
            .request("config/convergence/acquire", acquireReq(`f04-auth-${Date.now()}`, [{ kind: "config", scope: "project", directory: dir }]))
            .then(
              () => ({ ok: true as const }),
              (e: unknown) => ({ ok: false as const, err: e }),
            ),
        )
        expect((badRaw as { ok: boolean }).ok).toBe(false)
        expect(yield* svc.unresolvedCount()).toBe(0)
      } finally {
        setAcquireHooksForTest(undefined)
        try {
          if (fs.existsSync(backup)) {
            try { fs.unlinkSync(dir) } catch { /* not a link */ }
            try { fs.renameSync(backup, dir) } catch { /* best-effort */ }
          }
        } catch { /* best-effort restore */ }
        pair.carrier.dispose()
        pair.ext.dispose()
      }
      expect(gate.isBarrierActive(dir)).toBe(false)
      expect(yield* svc.unresolvedCount()).toBe(0)
      const pair2 = linked()
      try {
        yield* Effect.promise(() => init(pair2.ext))
        const lease = `f04-aretry-${Date.now()}`
        const rawAcq: unknown = yield* Effect.promise(() =>
          pair2.ext.request("config/convergence/acquire", acquireReq(lease, [{ kind: "config", scope: "project", directory: dir }])),
        )
        expect((rawAcq as { acquired: boolean }).acquired).toBe(true)
        const rawRes: unknown = yield* Effect.promise(() => pair2.ext.request("config/convergence/resolve", resolveReq(lease)))
        expect((rawRes as { outcome: string }).outcome).toBe("noop")
        expect(gate.isBarrierActive(dir)).toBe(false)
      } finally {
        pair2.carrier.dispose()
        pair2.ext.dispose()
      }
    }),
  )
})
