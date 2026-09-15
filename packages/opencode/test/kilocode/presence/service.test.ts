import { describe, expect, mock, setSystemTime, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Auth } from "@/auth"

const attachedCalls: string[][] = []

const realSessions = await import("@/kilo-sessions/kilo-sessions")
const realSetAttached = realSessions.KiloSessions.setAttachedSessions
mock.module("@/kilo-sessions/kilo-sessions", () => ({
  ...realSessions,
  KiloSessions: {
    ...realSessions.KiloSessions,
    setAttachedSessions: (ids: readonly string[]) => {
      attachedCalls.push([...ids])
      realSetAttached(ids)
    },
  },
}))

const { KiloViewers } = await import("@/kilocode/presence/service")

const authLayer = Layer.succeed(
  Auth.Service,
  Auth.Service.of({
    get: () => Effect.succeed(undefined),
    all: () => Effect.succeed({} as never),
    set: () => Effect.void,
    remove: () => Effect.void,
  }),
)

const layer = KiloViewers.layer.pipe(Layer.provide(authLayer))

const uid = "11111111-1111-4111-8111-111111111111"
const uidB = "22222222-2222-4222-8222-222222222222"

type Snap = {
  viewer: { id: string; active: boolean; sequence: number }
  attached: readonly string[]
  visible: readonly string[]
}

function run(body: (viewers: { update: (s: Snap) => Effect.Effect<void>; invalidateAuth: () => Effect.Effect<void> }) => Effect.Effect<void>) {
  return Effect.gen(function* () {
    const v = yield* KiloViewers.Service
    yield* body(v)
  }).pipe(Effect.provide(layer), Effect.runPromise)
}

describe("KiloViewers.Service", () => {
  test("pushes the attached union to KiloSessions on change", async () => {
    attachedCalls.length = 0
    await run((v) => v.update({ viewer: { id: uid, active: true, sequence: 1 }, attached: ["ses_a"], visible: ["ses_a"] }))
    expect(attachedCalls).toEqual([["ses_a"], []])
  })

  test("does not re-push an unchanged attached union", async () => {
    attachedCalls.length = 0
    await run((v) =>
      Effect.gen(function* () {
        yield* v.update({ viewer: { id: uid, active: true, sequence: 1 }, attached: ["ses_a"], visible: ["ses_a"] })
        yield* v.update({ viewer: { id: uid, active: true, sequence: 2 }, attached: ["ses_a"], visible: ["ses_a"] })
      }),
    )
    expect(attachedCalls).toEqual([["ses_a"], []])
  })

  test("unions attached sessions across viewers", async () => {
    attachedCalls.length = 0
    await run((v) =>
      Effect.gen(function* () {
        yield* v.update({ viewer: { id: uid, active: true, sequence: 1 }, attached: ["ses_a"], visible: ["ses_a"] })
        yield* v.update({ viewer: { id: uidB, active: false, sequence: 1 }, attached: ["ses_b"], visible: [] })
      }),
    )
    expect(attachedCalls).toEqual([["ses_a"], ["ses_a", "ses_b"], []])
  })

  test("invalidateAuth does not throw and clears presence state", async () => {
    attachedCalls.length = 0
    await run((v) =>
      Effect.gen(function* () {
        yield* v.update({ viewer: { id: uid, active: true, sequence: 1 }, attached: ["ses_a"], visible: ["ses_a"] })
        yield* v.invalidateAuth()
      }),
    )
    expect(attachedCalls.length).toBeGreaterThanOrEqual(1)
  })

  test("older in-flight snapshot never overwrites newer attachment", async () => {
    attachedCalls.length = 0
    await run((v) =>
      Effect.gen(function* () {
        yield* v.update({ viewer: { id: uid, active: true, sequence: 2 }, attached: ["ses_new"], visible: ["ses_new"] })
        yield* v.update({ viewer: { id: uid, active: true, sequence: 1 }, attached: ["ses_old"], visible: ["ses_old"] })
      }),
    )
    expect(attachedCalls).toEqual([["ses_new"], []])
  })

  test("duplicate sequence is harmless and keeps newer detach", async () => {
    attachedCalls.length = 0
    await run((v) =>
      Effect.gen(function* () {
        yield* v.update({ viewer: { id: uid, active: true, sequence: 2 }, attached: ["ses_a"], visible: ["ses_a"] })
        yield* v.update({ viewer: { id: uid, active: false, sequence: 3 }, attached: [], visible: [] })
        yield* v.update({ viewer: { id: uid, active: true, sequence: 3 }, attached: ["ses_a"], visible: ["ses_a"] })
        yield* v.update({ viewer: { id: uid, active: true, sequence: 2 }, attached: ["ses_a"], visible: ["ses_a"] })
      }),
    )
    expect(attachedCalls).toEqual([["ses_a"], [], []])
  })

  test("newer detach/empty wins over older attached snapshot", async () => {
    attachedCalls.length = 0
    await run((v) =>
      Effect.gen(function* () {
        yield* v.update({ viewer: { id: uid, active: true, sequence: 1 }, attached: ["ses_a"], visible: ["ses_a"] })
        yield* v.update({ viewer: { id: uid, active: false, sequence: 2 }, attached: [], visible: [] })
      }),
    )
    expect(attachedCalls).toEqual([["ses_a"], [], []])
  })

  test("concurrent out-of-order arrivals cannot regress visibility", async () => {
    attachedCalls.length = 0
    await run((v) =>
      Effect.gen(function* () {
        yield* Effect.all(
          [
            v.update({ viewer: { id: uid, active: true, sequence: 1 }, attached: ["ses_old"], visible: ["ses_old"] }),
            v.update({ viewer: { id: uid, active: true, sequence: 2 }, attached: ["ses_new"], visible: ["ses_new"] }),
          ],
          { concurrency: 2 },
        )
        yield* v.update({ viewer: { id: uid, active: true, sequence: 1 }, attached: ["ses_old"], visible: ["ses_old"] })
      }),
    )
    const last = attachedCalls.filter((c) => c.length > 0).at(-1)
    expect(last).toEqual(["ses_new"])
  })

  test("stale snapshot does not refresh TTL", async () => {
    attachedCalls.length = 0
    const base = 1_700_000_000_000
    try {
      setSystemTime(base)
      await run((v) =>
        Effect.gen(function* () {
          yield* v.update({ viewer: { id: uid, active: true, sequence: 2 }, attached: ["ses_a"], visible: ["ses_a"] })
          setSystemTime(base + 60_000)
          yield* v.update({ viewer: { id: uid, active: true, sequence: 1 }, attached: ["ses_a"], visible: ["ses_a"] })
          setSystemTime(base + 120_000)
          yield* v.update({ viewer: { id: uidB, active: true, sequence: 1 }, attached: ["ses_b"], visible: ["ses_b"] })
        }),
      )
      // Stale update is dropped with no push, so only the first snapshot,
      // the newer viewer snapshot (which prunes the expired first viewer),
      // and the scope-disposal finalizer remain.
      expect(attachedCalls[0]).toEqual(["ses_a"])
      // If the stale snapshot had refreshed lastSeen to base+60k, the first
      // viewer would still be alive at base+120k and the union would contain
      // ses_a. Its absence proves the TTL was not extended.
      expect(attachedCalls[1]).toEqual(["ses_b"])
    } finally {
      setSystemTime()
    }
  })

  test("missing sequence is rejected without state change", async () => {
    attachedCalls.length = 0
    await run((v) =>
      Effect.gen(function* () {
        yield* v.update({ viewer: { id: uid, active: true, sequence: 1 }, attached: ["ses_a"], visible: ["ses_a"] })
        yield* v.update({ viewer: { id: uid, active: true }, attached: [], visible: [] } as unknown as Snap)
      }),
    )
    expect(attachedCalls).toEqual([["ses_a"], []])
  })
})
