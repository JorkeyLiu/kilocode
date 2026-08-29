// kilocode_change - new file
import { describe, expect } from "bun:test"
import { Deferred, Effect, Exit, Layer, Option } from "effect"
import { InstanceStore } from "../../../src/project/instance-store"
import { GenerationGate } from "../../../src/kilocode/server/generation-gate"
import { ConfigRebuild, awaitRebuilds, forkRebuild } from "../../../src/kilocode/server/config-rebuild"
import { withWriteTicket } from "../../../src/kilocode/server/config-ticket"
import type { InstanceContext } from "../../../src/project/instance-context"
import { awaitWithTimeout, testEffect } from "../../lib/effect"

const old = { directory: "d", worktree: "d", project: {} } as InstanceContext
const store = Layer.mock(InstanceStore.Service, {
  dispose: () => Effect.die(new Error("dispose failed")),
  load: () => Effect.succeed(old),
})
const it = testEffect(Layer.mergeAll(GenerationGate.defaultLayer, ConfigRebuild.defaultLayer, store))

describe("config rebuild failures", () => {
  it.live("aborts a ticket when the rebuild owner rejects handoff", () =>
    Effect.gen(function* () {
      let aborted = 0
      const ticket = {
        kind: "project" as const,
        directory: "d",
        drained: Deferred.makeUnsafe<void>(),
        release: Effect.sync(() => undefined),
        abort: Effect.sync(() => {
          aborted++
        }),
      }
      Deferred.doneUnsafe(ticket.drained, Effect.succeed(void 0))
      const owner = Layer.succeed(ConfigRebuild.Service, {
        fork: () => Effect.succeed(false),
      })
      const run = withWriteTicket({
        acquire: Effect.succeed(ticket),
        run: () => Effect.succeed({ changed: true, value: true, rebuild: Effect.void }),
      })
      yield* Effect.provide(run, owner)
      expect(aborted).toBe(1)
      yield* awaitRebuilds()
    }),
  )

  it.live("records disposer failure, releases the ticket, and admits later readers and writers", () =>
    Effect.gen(function* () {
      const gate = yield* GenerationGate.Service
      const ticket = yield* gate.beginWrite("d")
      yield* forkRebuild(ConfigRebuild.rebuildInstance(ticket, Option.some(old)))

      const failure = yield* Effect.exit(awaitRebuilds())
      expect(Exit.isFailure(failure)).toBe(true)

      const release = yield* gate.acquire("d")
      yield* release
      const next = yield* gate.beginWrite("d")
      yield* next.release
      yield* awaitWithTimeout(Deferred.await(next.drained), "writer ticket was not usable after rebuild failure")
    }),
  )
})
