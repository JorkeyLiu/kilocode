import { afterEach, describe, expect, test } from "bun:test"
import { Context, Deferred, Effect, Exit, Layer, Scope } from "effect"
import { sql } from "drizzle-orm"
import { randomUUID } from "crypto"
import { createServer } from "node:net"
import { Database } from "@opencode-ai/core/database/database"
import { Server } from "../../../src/server/server"
import * as KiloListener from "../../../src/kilocode/server/listener"
import { AppLayer, AppRuntime } from "../../../src/effect/app-runtime"
import * as Maintenance from "../../../src/retention/maintenance"
import * as Ownership from "../../../src/retention/ownership"
import * as Lease from "../../../src/retention/lease"
import * as Accounting from "../../../src/retention/accounting"
import { Storage } from "../../../src/storage/storage"
import { withTimeout } from "../../../src/util/timeout"
import { tmpdir, disposeAllInstances } from "../../fixture/fixture"
import { resetDatabase } from "../../fixture/db"
import { pollWithTimeout } from "../../lib/effect"

function seedObligation(root: string) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .run(
        sql`INSERT INTO retention_obligation (family_root_id, session_ids, time_created, attempts) VALUES (${root}, ${JSON.stringify(["sess-blocked"])}, ${Date.now()}, 0)`,
      )
      .pipe(Effect.orDie)
  })
}

function rowExists(root: string) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const rows = yield* db
      .all<{ id: number }>(sql`SELECT id FROM retention_obligation WHERE family_root_id = ${root}`)
      .pipe(Effect.orDie)
    return rows.length > 0
  })
}

function pollRowGone(root: string, label: string) {
  return AppRuntime.runPromise(
    pollWithTimeout(
      Effect.gen(function* () {
        const gone = !(yield* rowExists(root))
        if (gone) return true as const
        return undefined
      }),
      label,
      "10 seconds",
    ),
  )
}

// Explicit ports keep each `Server.listen` to a single `startListener`
// attempt. Port `0` falls back (4096, then 0), and a fallback retry would
// construct the fresh maintenance node once per attempt, which would read
// as a second worker and blur the single-build assertion below.
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once("error", reject)
    probe.listen(0, "127.0.0.1", () => {
      const addr = probe.address()
      if (addr !== null && typeof addr === "object") {
        const port = addr.port
        probe.close((err) => (err ? reject(err) : resolve(port)))
      } else {
        probe.close(() => reject(new Error("probe has no address")))
      }
    })
  })
}

describe("Server.listen bounded retention boot", () => {
  afterEach(async () => {
    await disposeAllInstances()
    await resetDatabase()
  })

  test(
    "listen returns and serves HTTP while deferred retention replay is blocked",
    async () => {
      await using tmp = await tmpdir({ git: true })
      // Seed before the first listen: the canonical worker replays exactly
      // once after start, so this row deterministically proves canonical boot
      // ran and can no longer interfere with the blocking app below.
      const probe = `canonical-probe-${randomUUID()}`
      await AppRuntime.runPromise(seedObligation(probe))
      const first = await Server.listen({ hostname: "127.0.0.1", port: 0 })
      try {
        await pollRowGone(probe, "canonical replay did not drain probe row")

        // Real maintenance over a Storage whose remove blocks on a gate: the
        // seeded row forces the deferred replay to park until released. The
        // maintenance node is wrapped in Layer.fresh: the module-level
        // Maintenance.layer node is already memoized in the process memoMap
        // (canonical instance), so without fresh the custom app would resolve
        // to the already-started canonical worker and the gate would be
        // vacuous. Fresh rebuilds the maintenance subtree in an isolated
        // memo map while still sharing the canonical Database instance, so
        // the seeded row is visible to the parked replay.
        const gate = await Effect.runPromise(Deferred.make<void>())
        const canonicalDb = await AppRuntime.runPromise(
          Effect.gen(function* () {
            return yield* Database.Service
          }),
        )
        const blockingStorage = Layer.succeed(
          Storage.Service,
          Storage.Service.of({
            remove: () => Deferred.await(gate),
            read: () => Effect.die(new Error("storage read unused in retention boot test")),
            update: () => Effect.die(new Error("storage update unused in retention boot test")),
            write: () => Effect.die(new Error("storage write unused in retention boot test")),
            list: () => Effect.die(new Error("storage list unused in retention boot test")),
          }),
        )
        const testBase = Layer.mergeAll(
          Layer.succeed(Database.Service, canonicalDb),
          blockingStorage,
          Ownership.layer,
          Lease.layer,
          Accounting.layer,
        )
        const blockedMaintenance = Layer.fresh(Maintenance.layer.pipe(Layer.provide(testBase)))
        // Single-build proof: each listener build must construct the fresh
        // maintenance node exactly once. The pre-fix double
        // `buildWithMemoMap` rebuilt the `Layer.fresh` node a second time, so
        // the post-bind `start()` released a different worker than the one
        // serving transport (both sharing the same DB, so the row still
        // drained and the old test passed vacuously). Counting constructions
        // distinguishes the serving worker from "another worker sharing the
        // same DB": with a single instance, the drained row must come from
        // the serving instance's owned worker.
        const built: unknown[] = []
        const countedMaintenance = blockedMaintenance.pipe(
          Layer.tap((ctx) =>
            Effect.sync(() => {
              built.push(Context.get(ctx, Maintenance.Service))
            }),
          ),
        )
        const appLayer = Layer.mergeAll(AppLayer, countedMaintenance)

        const root = `blocked-replay-${randomUUID()}`
        await AppRuntime.runPromise(seedObligation(root))

        // The gate stays closed: if layer construction did retention I/O or
        // listen awaited replay/boot cleanup, this would time out.
        const listener = await withTimeout(
          Server.listen({ hostname: "127.0.0.1", port: await freePort(), appLayer: appLayer as never }),
          20_000,
          "Server.listen blocked on retention replay/boot",
        )
        // Single-build topology: transport + post-bind trigger share the
        // exact same app instance even though the custom app contains
        // `Layer.fresh`. Two constructions here would mean the started gate
        // belongs to a different worker than the serving transport.
        expect(built.length).toBe(1)
        try {
          // HTTP serves while replay is still parked.
          const response = await fetch(new URL("/session/status", listener.url), {
            headers: { "x-kilo-directory": tmp.path },
          })
          expect(response.status).toBe(200)
          expect(await AppRuntime.runPromise(rowExists(root))).toBe(true)

          // Two-listener shared-app idempotency within the same seam: a
          // second listener reusing the same custom app object gets its own
          // isolated worker (one construction per listener, still
          // single-built) parked on the same gate/DB. Both serve HTTP while
          // the row stays parked; one gate release drains the row exactly
          // once and the loser finds nothing (no failure, no duplicate).
          const second = await withTimeout(
            Server.listen({ hostname: "127.0.0.1", port: await freePort(), appLayer: appLayer as never }),
            20_000,
            "second Server.listen blocked on retention replay/boot",
          )
          expect(built.length).toBe(2)
          try {
            const response2 = await fetch(new URL("/session/status", second.url), {
              headers: { "x-kilo-directory": tmp.path },
            })
            expect(response2.status).toBe(200)
            expect(await AppRuntime.runPromise(rowExists(root))).toBe(true)

            // Release the gate: deferred boot completes after listen returned.
            await Effect.runPromise(Deferred.succeed(gate, void 0))
            await pollRowGone(root, "deferred replay did not complete after gate release")
          } finally {
            await withTimeout(second.stop(true), 10_000, "stop second blocking listener").catch(() => undefined)
          }
        } finally {
          await withTimeout(listener.stop(true), 10_000, "stop blocking listener").catch(() => undefined)
        }
      } finally {
        await withTimeout(first.stop(true), 10_000, "stop canonical listener").catch(() => undefined)
      }
    },
    { timeout: 90_000 },
  )

  test(
    "KiloListener.build resolves transport and trigger from one app instance",
    async () => {
      // Minimal transport that requires Maintenance.Service and exposes the
      // resolved instance as a probe. The custom app builds a distinct
      // object per construction (`Layer.fresh` + `Effect.sync`), so the old
      // double acquisition resolved two different workers while the fixed
      // single acquisition resolves one.
      class Probe extends Context.Service<Probe, Maintenance.Maintenance>()("test/retention-probe") {}
      const transport = Layer.effect(
        Probe,
        Effect.gen(function* () {
          return yield* Maintenance.Service
        }),
      )
      let builds = 0
      const freshApp = Layer.fresh(
        Layer.effect(
          Maintenance.Service,
          Effect.sync(() => {
            builds += 1
            return {
              schedule: () => Effect.void,
              runOnce: () =>
                Effect.die(new Error("runOnce unused in listener identity test")) as never,
              replay: () => Effect.void,
              start: Effect.void,
            } satisfies Maintenance.Maintenance as Maintenance.Maintenance
          }),
        ),
      )
      const scope = await Effect.runPromise(Scope.make())
      try {
        const { ctx, appCtx } = await Effect.runPromise(
          KiloListener.build(transport, scope, freshApp as never),
        )
        expect(builds).toBe(1)
        expect(Context.get(ctx, Probe)).toBe(Context.get(appCtx as Context.Context<Maintenance.Service>, Maintenance.Service))
      } finally {
        await Effect.runPromise(Scope.close(scope, Exit.void).pipe(Effect.ignore)).catch(() => undefined)
      }
    },
    { timeout: 30_000 },
  )
})
