import { afterEach, describe, expect } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { PassThrough } from "node:stream"
import { Effect } from "effect"
import { Server } from "../../../src/server/server"
import { Global } from "@opencode-ai/core/global"
import { GlobalBus } from "../../../src/bus/global"
import { awaitRebuilds } from "../../../src/kilocode/server/config-rebuild"
import { JsonRpcPeer } from "../../../src/private-worker/peer"
import { createFdCarrier } from "../../../src/kilocode/server/fd-carrier"
import { FD_PROTOCOL_NAME } from "../../../src/kilocode/server/fd-carrier-protocol"
import { AppLayer } from "../../../src/effect/app-runtime"
import { GenerationGate } from "../../../src/kilocode/server/generation-gate"
import { InstanceStore } from "../../../src/project/instance-store"
import { awaitWithTimeout, pollWithTimeout, testEffectShared } from "../../lib/effect"
import { tmpdir, disposeAllInstances } from "../../fixture/fixture"
import { markProjectConfigReady, markPluginDependenciesReady } from "../../fixture/plugin"
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

const observeReq = (id: string, descriptors: unknown, extra: Record<string, unknown> = {}) => ({
  v: 1,
  observeId: id,
  opId: id,
  requestId: id,
  idempotencyKey: id,
  descriptors,
  ...extra,
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

describe("fd-carrier config observe (external canonical edits)", () => {
  it.live("advertises observe capability", () =>
    Effect.gen(function* () {
      const pair = linked()
      try {
        const rawInit: unknown = yield* Effect.promise(() => init(pair.ext))
        const caps = (rawInit as { capabilities: string[] }).capabilities
        expect(caps.includes("config/convergence/observe")).toBeTrue()
      } finally {
        pair.carrier.dispose()
        pair.ext.dispose()
      }
    }),
  )

  it.live("naive post-edit acquire/resolve stays noop while observe registers cold", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
      const dir = tmp.path
      yield* Effect.promise(() => seedProject(dir, { permission: { bash: "allow" } }))
      const store = yield* InstanceStore.Service
      yield* store.load({ directory: dir })
      const pair = linked()
      try {
        yield* Effect.promise(() => init(pair.ext))
        // External edit bypasses the fence: direct disk write.
        atomicWrite(projectFile(dir), { permission: { bash: "deny" } })
        // Naive GUI lease acquired AFTER the edit snapshots the new state,
        // so resolve sees no before/after delta and stays noop/stale.
        const lease = `naive-${Date.now()}`
        yield* Effect.promise(() =>
          pair.ext.request("config/convergence/acquire", acquireReq(lease, [{ kind: "config", scope: "project", directory: dir }])),
        )
        const naive: unknown = yield* Effect.promise(() => pair.ext.request("config/convergence/resolve", resolveReq(lease)))
        expect((naive as { outcome: string }).outcome).toBe("noop")
        // Observe on the same edit registers fail-safe cold.
        const obs: unknown = yield* Effect.promise(() =>
          pair.ext.request("config/convergence/observe", observeReq(`obs-${Date.now()}`, [{ kind: "config", scope: "project", directory: dir }])),
        )
        expect((obs as { outcome: string }).outcome).toBe("cold")
        yield* awaitWithTimeout(awaitRebuilds(), "observe rebuild never settled")
        const eff = yield* Effect.promise(() => overlay(dir))
        expect(eff.effective["permission"]).toEqual({ bash: "deny" })
      } finally {
        pair.carrier.dispose()
        pair.ext.dispose()
      }
    }),
  )

  it.live("project and global observe are cold; repeated same-state observe stays cold", () =>
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
      const pair = linked()
      try {
        yield* Effect.promise(() => init(pair.ext))
        atomicWrite(projectFile(dir), { permission: { bash: "deny" } })
        const first: unknown = yield* Effect.promise(() =>
          pair.ext.request("config/convergence/observe", observeReq(`p1-${Date.now()}`, [{ kind: "config", scope: "project", directory: dir }])),
        )
        expect((first as { outcome: string }).outcome).toBe("cold")
        yield* awaitWithTimeout(awaitRebuilds(), "project observe rebuild never settled")
        // Repeated same-state hint is cold by design (may rebuild; no false noop).
        const repeat: unknown = yield* Effect.promise(() =>
          pair.ext.request("config/convergence/observe", observeReq(`p2-${Date.now()}`, [{ kind: "config", scope: "project", directory: dir }])),
        )
        expect((repeat as { outcome: string }).outcome).toBe("cold")
        yield* awaitWithTimeout(awaitRebuilds(), "repeat observe rebuild never settled")
        const gfile = path.join(global.path, "kilo.jsonc")
        atomicWrite(gfile, { username: "g1" })
        const gobs: unknown = yield* Effect.promise(() =>
          pair.ext.request("config/convergence/observe", observeReq(`g-${Date.now()}`, [{ kind: "config", scope: "global" }])),
        )
        expect((gobs as { outcome: string }).outcome).toBe("cold")
        yield* awaitWithTimeout(awaitRebuilds(), "global observe rebuild never settled")
        yield* pollWithTimeout(
          Effect.gen(function* () {
            const eff = yield* Effect.promise(() => overlay(dir))
            return eff.effective["username"] === "g1" ? (true as const) : undefined
          }),
          "global observe never served new state",
        )
      } finally {
        pair.carrier.dispose()
        pair.ext.dispose()
      }
    }),
  )

  it.live("malformed disk still cold-converges; retry after fix stays cold", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
      const dir = tmp.path
      yield* Effect.promise(() => seedProject(dir, { permission: { bash: "allow" } }))
      const store = yield* InstanceStore.Service
      yield* store.load({ directory: dir })
      const pair = linked()
      try {
        yield* Effect.promise(() => init(pair.ext))
        const file = projectFile(dir)
        const good = fs.readFileSync(file, "utf8")
        // Malformed JSONC still registers cold (boot surfaces loader
        // diagnostics); never a false noop.
        fs.writeFileSync(file, "{ not-jsonc: ,,,", "utf8")
        const bad: unknown = yield* Effect.promise(() =>
          pair.ext.request("config/convergence/observe", observeReq(`bad-${Date.now()}`, [{ kind: "config", scope: "project", directory: dir }])),
        )
        expect((bad as { outcome: string }).outcome).toBe("cold")
        yield* awaitWithTimeout(awaitRebuilds(), "malformed observe rebuild never settled")
        // Fix disk: retry must still be cold (no baseline gates a retry).
        fs.writeFileSync(file, good, "utf8")
        yield* awaitWithTimeout(awaitRebuilds(), "malformed recovery never settled")
        atomicWrite(file, { permission: { bash: "deny" } })
        const retry: unknown = yield* Effect.promise(() =>
          pair.ext.request("config/convergence/observe", observeReq(`retry-${Date.now()}`, [{ kind: "config", scope: "project", directory: dir }])),
        )
        expect((retry as { outcome: string }).outcome).toBe("cold")
        yield* awaitWithTimeout(awaitRebuilds(), "retry observe rebuild never settled")
        const eff = yield* Effect.promise(() => overlay(dir))
        expect(eff.effective["permission"]).toEqual({ bash: "deny" })
      } finally {
        pair.carrier.dispose()
        pair.ext.dispose()
      }
    }),
  )

  it.live("held admission fences new readers; V1+V2 burst converges latest with bounded hints", () =>
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
        // Hold an active generation reader so cold convergence must fence.
        const releaseHeld = yield* gate.acquire(dir)
        const desc = [{ kind: "config", scope: "project", directory: dir }]
        atomicWrite(projectFile(dir), { permission: { bash: "allow" } })
        const o1: unknown = yield* Effect.promise(() =>
          pair.ext.request("config/convergence/observe", observeReq(`v1-${Date.now()}`, desc)),
        )
        expect((o1 as { outcome: string }).outcome).toBe("cold")
        // Response returns after seq registration while the drain is held:
        // new admission stays fenced until the active generation releases.
        expect(gate.isBarrierActive(dir)).toBe(true)
        // V2 materializes while the first convergence is still fenced; the
        // follow-up hint uses latest disk state.
        atomicWrite(projectFile(dir), { permission: { bash: "deny" } })
        const o2: unknown = yield* Effect.promise(() =>
          pair.ext.request("config/convergence/observe", observeReq(`v2-${Date.now()}`, desc)),
        )
        expect((o2 as { outcome: string }).outcome).toBe("cold")
        // Exactly two hints for the burst: bounded, no per-event explosion.
        yield* releaseHeld
        yield* awaitWithTimeout(awaitRebuilds(), "burst observe rebuild never settled")
        expect(gate.isBarrierActive(dir)).toBe(false)
        yield* pollWithTimeout(
          Effect.gen(function* () {
            const eff = yield* Effect.promise(() => overlay(dir))
            const perm = eff.effective["permission"] as unknown as { bash?: unknown } | undefined
            return perm?.bash === "deny" ? (true as const) : undefined
          }),
          "burst observe never served latest V2 state",
        )
        const eff = yield* Effect.promise(() => overlay(dir))
        expect(eff.effective["permission"]).toEqual({ bash: "deny" })
      } finally {
        pair.carrier.dispose()
        pair.ext.dispose()
      }
    }),
  )

  it.live("strict observe rejects asset descriptors and client bytes/hash/outcome", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
      const dir = tmp.path
      yield* Effect.promise(() => seedProject(dir, { permission: { bash: "allow" } }))
      const pair = linked()
      try {
        yield* Effect.promise(() => init(pair.ext))
        const assetErr = yield* Effect.promise(() =>
          pair.ext
            .request(
              "config/convergence/observe",
              observeReq(`a-${Date.now()}`, [{ kind: "asset", asset: "agent", scope: "project", directory: dir, id: "x" }]),
            )
            .then(
              () => "ok",
              (e: unknown) => String((e as { code?: unknown }).code ?? e),
            ),
        )
        expect(assetErr).toBe("-32602")
        for (const forbidden of ["bytes", "hash", "outcome"]) {
          const err = yield* Effect.promise(() =>
            pair.ext
              .request(
                "config/convergence/observe",
                observeReq(`f-${Date.now()}-${forbidden}`, [{ kind: "config", scope: "project", directory: dir }], {
                  [forbidden]: "x",
                }),
              )
              .then(
                () => "ok",
                (e: unknown) => String((e as { code?: unknown }).code ?? e),
              ),
          )
          expect(err).toBe("-32602")
        }
      } finally {
        pair.carrier.dispose()
        pair.ext.dispose()
      }
    }),
  )

  it.live("concurrent duplicate observes both register cold; latest disk wins", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
      const dir = tmp.path
      yield* Effect.promise(() => seedProject(dir, { permission: { bash: "allow" } }))
      const store = yield* InstanceStore.Service
      yield* store.load({ directory: dir })
      const pair = linked()
      try {
        yield* Effect.promise(() => init(pair.ext))
        const desc = [{ kind: "config", scope: "project", directory: dir }]
        const mk = (suffix: string) => Effect.promise(() => pair.ext.request("config/convergence/observe", observeReq(`c-${Date.now()}-${suffix}`, desc)))
        const [r1, r2] = yield* Effect.all([mk("a"), mk("b")], { concurrency: "unbounded" }) as Effect.Effect<unknown[], never, never>
        for (const r of [r1, r2]) expect((r as { outcome: string }).outcome).toBe("cold")
        atomicWrite(projectFile(dir), { permission: { bash: "deny" } })
        const latest: unknown = yield* Effect.promise(() => pair.ext.request("config/convergence/observe", observeReq(`c-late-${Date.now()}`, desc)))
        expect((latest as { outcome: string }).outcome).toBe("cold")
        yield* awaitWithTimeout(awaitRebuilds(), "concurrent observe rebuild never settled")
        const eff = yield* Effect.promise(() => overlay(dir))
        expect(eff.effective["permission"]).toEqual({ bash: "deny" })
      } finally {
        pair.carrier.dispose()
        pair.ext.dispose()
      }
    }),
  )
})
