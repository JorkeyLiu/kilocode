import { Context, Effect, Layer } from "effect"

export interface Ownership {
  readonly isActive: (id: string) => boolean
  readonly isLeased: (id: string) => boolean
  readonly acquireActive: (id: string) => Effect.Effect<Effect.Effect<void>>
  readonly acquireLease: (id: string) => Effect.Effect<Effect.Effect<void>>
  readonly listActive: () => string[]
  readonly listLeased: () => string[]
}

export class Service extends Context.Service<Service, Ownership>()("@opencode/RetentionOwnership") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const active = new Map<string, number>()
    const leased = new Map<string, number>()

    const isActive = (id: string) => active.has(id)
    const isLeased = (id: string) => leased.has(id)
    const listActive = () => [...active.keys()]
    const listLeased = () => [...leased.keys()]

    const acquireActive = (id: string) =>
      Effect.gen(function* () {
        const cur = active.get(id) ?? 0
        active.set(id, cur + 1)
        let released = false
        return Effect.sync(() => {
          if (released) return
          released = true
          const next = (active.get(id) ?? 1) - 1
          if (next <= 0) active.delete(id)
          else active.set(id, next)
        })
      })

    const acquireLease = (id: string) =>
      Effect.gen(function* () {
        const cur = leased.get(id) ?? 0
        leased.set(id, cur + 1)
        let released = false
        return Effect.sync(() => {
          if (released) return
          released = true
          const next = (leased.get(id) ?? 1) - 1
          if (next <= 0) leased.delete(id)
          else leased.set(id, next)
        })
      })

    return Service.of({ isActive, isLeased, acquireActive, acquireLease, listActive, listLeased })
  }),
)

export const noop: Ownership = {
  isActive: () => false,
  isLeased: () => false,
  acquireActive: () => Effect.succeed(Effect.void),
  acquireLease: () => Effect.succeed(Effect.void),
  listActive: () => [],
  listLeased: () => [],
}
