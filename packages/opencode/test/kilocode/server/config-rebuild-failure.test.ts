// kilocode_change - new file
import { describe, expect } from "bun:test"
import { Deferred, Effect, Exit, Layer, Option } from "effect"
import { InstanceStore } from "../../../src/project/instance-store"
import { GenerationGate } from "../../../src/kilocode/server/generation-gate"
import { ConfigRebuild, awaitRebuilds, forkRebuild } from "../../../src/kilocode/server/config-rebuild"
import type { InstanceContext } from "../../../src/project/instance-context"
import { awaitWithTimeout, testEffect } from "../../lib/effect"

const old = { directory: "d", worktree: "d", project: {} } as InstanceContext
const store = Layer.mock(InstanceStore.Service, {
  dispose: () => Effect.die(new Error("dispose failed")),
  load: () => Effect.succeed(old),
})
const it = testEffect(Layer.mergeAll(GenerationGate.defaultLayer, store))

describe("config rebuild failures", () => {
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
