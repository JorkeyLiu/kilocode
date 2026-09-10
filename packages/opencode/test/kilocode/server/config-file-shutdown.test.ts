import { afterEach, describe, expect } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { Effect } from "effect"
import { awaitRebuilds } from "../../../src/kilocode/server/config-rebuild"
import {
  setAcquireHooksForTest,
  setFileReadHooksForTest,
  setLeaseTtlMsForTest,
  setPeerCloseGraceMsForTest,
} from "../../../src/kilocode/server/config-file-convergence"
import { ConfigFileConvergence } from "../../../src/kilocode/server/config-file-convergence"
import { ConfigConvergence } from "../../../src/kilocode/server/config-convergence"
import { GenerationGate } from "../../../src/kilocode/server/generation-gate"
import { InstanceStore } from "../../../src/project/instance-store"
import { AppLayer } from "../../../src/effect/app-runtime"
import { testEffect } from "../../lib/effect"
import { tmpdir, disposeAllInstances } from "../../fixture/fixture"
import { markProjectConfigReady } from "../../fixture/plugin"
import { resetDatabase } from "../../fixture/db"

const it = testEffect(AppLayer)

afterEach(async () => {
  setPeerCloseGraceMsForTest(undefined)
  setLeaseTtlMsForTest(undefined)
  setAcquireHooksForTest(undefined)
  setFileReadHooksForTest(undefined)
  await Effect.runPromise(awaitRebuilds().pipe(Effect.ignore))
  await disposeAllInstances()
  await resetDatabase()
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

describe("config-file-convergence F-01 shutdown ownership (isolated)", () => {
  it.live("held peer grace shutdown releases fibers/leases/barrier with no boot, idempotent", () =>
    Effect.gen(function* () {
      setPeerCloseGraceMsForTest(60_000)
      setLeaseTtlMsForTest(60_000)
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
      const dir = tmp.path
      yield* Effect.promise(() => seedProject(dir, { permission: { bash: "allow" } }))
      const store = yield* InstanceStore.Service
      const gate = yield* GenerationGate.Service
      const svc = yield* ConfigFileConvergence.Service
      const before = yield* store.load({ directory: dir })
      let loads = 0
      const rec = store as unknown as Record<string, unknown>
      const origLoad = rec["load"] as (input: never) => Effect.Effect<unknown>
      rec["load"] = (input: never) => Effect.gen(function* () {
        loads += 1
        return yield* (origLoad as (i: never) => Effect.Effect<unknown>)(input)
      })
      try {
        const out = yield* svc.acquire(`shutdown-${Date.now()}`, [
          { kind: "config", scope: "project", directory: dir },
        ])
        if (!("acquired" in out)) throw new Error(`expected acquired, got resolved: ${JSON.stringify(out)}`)
        expect(out.acquired).toBe(true)
        expect(gate.isBarrierActive(dir)).toBe(true)
        expect(yield* svc.unresolvedCount()).toBe(1)
        yield* svc.peerClosed()
        expect(yield* svc.unresolvedCount()).toBe(1)
        expect(gate.isBarrierActive(dir)).toBe(true)
        const snapBefore = yield* store.snapshot(dir)
        expect(snapBefore._tag).toBe("Some")
        yield* svc.shutdown
        expect(yield* svc.unresolvedCount()).toBe(0)
        expect(gate.isBarrierActive(dir)).toBe(false)
        expect(loads).toBe(0)
        const snapAfter = yield* store.snapshot(dir)
        expect(snapAfter._tag).toBe("Some")
        if (snapAfter._tag === "Some" && snapBefore._tag === "Some") expect(snapAfter.value).toBe(snapBefore.value)
        if (snapAfter._tag !== "Some") throw new Error("expected Some snapshot")
        expect(before).toBe(snapAfter.value)
        yield* svc.shutdown
        expect(yield* svc.unresolvedCount()).toBe(0)
        expect(gate.isBarrierActive(dir)).toBe(false)
        const exit = yield* svc.acquire(`shutdown-after-${Date.now()}`, [
          { kind: "config", scope: "project", directory: dir },
        ]).pipe(Effect.exit)
        expect(exit._tag).toBe("Failure")
        yield* Effect.promise(() => tmpdir({ retain: true })).pipe(Effect.ignore)
      } finally {
        rec["load"] = origLoad
      }
      yield* store.disposeAll().pipe(Effect.ignore)
    }),
  )
})

describe("config-file-convergence F-02 identity-guarded reads (isolated)", () => {
  it.live("beforeRead swap during acquire fails closed without leak, next acquire usable", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
      const dir = tmp.path
      yield* Effect.promise(() => seedProject(dir, { permission: { bash: "allow" } }))
      const store = yield* InstanceStore.Service
      const gate = yield* GenerationGate.Service
      const svc = yield* ConfigFileConvergence.Service
      yield* store.load({ directory: dir })
      const external = yield* Effect.promise(() => tmpdir({ retain: true }))
      yield* Effect.promise(() => markProjectConfigReady(external.path))
      atomicWrite(path.join(external.path, ".kilo", "kilo.jsonc"), { permission: { bash: "allow" } })
      const backup = `${dir}.${process.pid}.f02acq`
      setFileReadHooksForTest({
        beforeRead: () => {
          fs.renameSync(dir, backup)
          fs.symlinkSync(external.path, dir)
        },
      })
      let exit
      try {
        exit = yield* svc.acquire(`f02-acq-${Date.now()}`, [
          { kind: "config", scope: "project", directory: dir },
        ]).pipe(Effect.exit)
      } finally {
        setFileReadHooksForTest(undefined)
        try {
          fs.unlinkSync(dir)
        } catch { /* not a link */ }
        try {
          fs.renameSync(backup, dir)
        } catch { /* best-effort */ }
      }
      expect(exit!._tag).toBe("Failure")
      expect(yield* svc.unresolvedCount()).toBe(0)
      expect(gate.isBarrierActive(dir)).toBe(false)
      const retry = yield* svc.acquire(`f02-acq-retry-${Date.now()}`, [
        { kind: "config", scope: "project", directory: dir },
      ])
      if (!("acquired" in retry)) throw new Error(`expected acquired, got resolved: ${JSON.stringify(retry)}`)
      expect(retry.acquired).toBe(true)
      const term = yield* svc.resolve(retry.leaseId)
      expect(term.outcome).toBe("noop")
      expect(gate.isBarrierActive(dir)).toBe(false)
    }),
  )

  it.live("beforeRead swap during resolve discards external bytes to failed, never cold/hot", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
      const dir = tmp.path
      yield* Effect.promise(() => seedProject(dir, { permission: { bash: "allow" } }))
      const store = yield* InstanceStore.Service
      const gate = yield* GenerationGate.Service
      const svc = yield* ConfigFileConvergence.Service
      const coord = yield* ConfigConvergence.Service
      const beforeCtx = yield* store.load({ directory: dir })
      const bootedBefore = yield* coord.getBootedVersion(dir)
      void bootedBefore
      const external = yield* Effect.promise(() => tmpdir({ retain: true }))
      yield* Effect.promise(() => markProjectConfigReady(external.path))
      atomicWrite(path.join(external.path, ".kilo", "kilo.jsonc"), {
        permission: { bash: "allow" },
        username: "external-evil",
      })
      const out = yield* svc.acquire(`f02-res-${Date.now()}`, [{ kind: "config", scope: "project", directory: dir }])
      if (!("acquired" in out)) throw new Error(`expected acquired, got resolved: ${JSON.stringify(out)}`)
      expect(out.acquired).toBe(true)
      const backup = `${dir}.${process.pid}.f02res`
      setFileReadHooksForTest({
        beforeRead: () => {
          try {
            fs.renameSync(dir, backup)
          } catch {
            return
          }
          fs.symlinkSync(external.path, dir)
        },
      })
      let term
      try {
        term = yield* svc.resolve(out.leaseId)
      } finally {
        setFileReadHooksForTest(undefined)
        try {
          fs.unlinkSync(dir)
        } catch { /* not a link */ }
        try {
          fs.renameSync(backup, dir)
        } catch { /* best-effort */ }
      }
      expect(term!.outcome).toBe("failed")
      expect(term!.outcome === "cold" || term!.outcome === "hot").toBe(false)
      expect(yield* svc.unresolvedCount()).toBe(0)
      expect(gate.isBarrierActive(dir)).toBe(false)
      const disk = JSON.parse(fs.readFileSync(projectFile(dir), "utf8")) as Record<string, unknown>
      expect(disk["username"]).not.toBe("external-evil")
      const snap = yield* store.snapshot(dir)
      expect(snap._tag).toBe("Some")
      if (snap._tag === "Some") expect(snap.value).toBe(beforeCtx)
    }),
  )

  it.live("afterRead swap during resolve discards to failed even for original bytes", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
      const dir = tmp.path
      yield* Effect.promise(() => seedProject(dir, { permission: { bash: "allow" } }))
      const store = yield* InstanceStore.Service
      const gate = yield* GenerationGate.Service
      const svc = yield* ConfigFileConvergence.Service
      yield* store.load({ directory: dir })
      const external = yield* Effect.promise(() => tmpdir({ retain: true }))
      const backup = `${dir}.${process.pid}.f02after`
      const out = yield* svc.acquire(`f02-after-${Date.now()}`, [{ kind: "config", scope: "project", directory: dir }])
      if (!("acquired" in out)) throw new Error(`expected acquired, got resolved: ${JSON.stringify(out)}`)
      expect(out.acquired).toBe(true)
      setFileReadHooksForTest({
        afterRead: () => {
          try {
            fs.renameSync(dir, backup)
          } catch {
            return
          }
          fs.symlinkSync(external.path, dir)
        },
      })
      let term
      try {
        term = yield* svc.resolve(out.leaseId)
      } finally {
        setFileReadHooksForTest(undefined)
        try {
          fs.unlinkSync(dir)
        } catch { /* not a link */ }
        try {
          fs.renameSync(backup, dir)
        } catch { /* best-effort */ }
      }
      expect(term!.outcome).toBe("failed")
      expect(yield* svc.unresolvedCount()).toBe(0)
      expect(gate.isBarrierActive(dir)).toBe(false)
    }),
  )
})
