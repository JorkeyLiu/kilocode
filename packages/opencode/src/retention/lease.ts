import { Context, Effect, Layer } from "effect"

export interface Lease {
  readonly acquire: (sessionID: string) => Effect.Effect<Effect.Effect<void>>
  readonly isLeased: (sessionID: string) => boolean
  readonly list: () => string[]
}

export class Service extends Context.Service<Service, Lease>()("@opencode/RetentionLease") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const leased = new Map<string, number>()
    const acquire = (sessionID: string) =>
      Effect.gen(function* () {
        const cur = leased.get(sessionID) ?? 0
        leased.set(sessionID, cur + 1)
        let released = false
        return Effect.sync(() => {
          if (released) return
          released = true
          const next = (leased.get(sessionID) ?? 1) - 1
          if (next <= 0) leased.delete(sessionID)
          else leased.set(sessionID, next)
        })
      })
    const isLeased = (sessionID: string) => leased.has(sessionID)
    const list = () => [...leased.keys()]
    return Service.of({ acquire, isLeased, list })
  }),
)

export const noop: Lease = {
  acquire: () => Effect.succeed(Effect.void),
  isLeased: () => false,
  list: () => [],
}
