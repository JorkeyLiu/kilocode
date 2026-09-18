import { Auth } from "@/auth"
import { EventServiceClient } from "@/kilocode/event-service/client"
import * as P0Perf from "@/kilocode/perf/instrument"
import { KILO_EVENT_SERVICE_URL } from "@kilocode/kilo-gateway"
import * as Log from "@opencode-ai/core/util/log"
import { Context, Effect, Layer } from "effect"
import type { Platform } from "./context"
import {
  attachedUnion,
  desiredContexts,
  dedupe,
  expiredViewerIds,
  nextExpiryDeadline,
  reconcileContexts,
  validateSnapshot,
  visibleUnion,
  type ViewerSnapshot,
  type ViewerState,
} from "./policy"

const log = Log.create({ service: "kilo-viewers" })

function inferPlatform(): Platform | undefined {
  const p = process.env.KILO_PLATFORM
  if (p === "vscode") return "vscode"
  if (p === "cli") return "cli"
  if (p === undefined || p === "") return "cli"
  return undefined
}

function extract(auth: Auth.Info | undefined): { token: string | undefined; identity: string | undefined } {
  const envKey = process.env.KILO_API_KEY?.trim()
  if (auth?.type === "api" && auth.key.length > 0) return { token: auth.key, identity: "api" }
  if (auth?.type === "oauth" && auth.access.length > 0)
    return { token: auth.access, identity: `oauth:${auth.accountId ?? "no-acct"}` }
  if (auth?.type === "wellknown" && auth.token.length > 0) return { token: auth.token, identity: "wellknown" }
  if (envKey) return { token: envKey, identity: "env" }
  return { token: undefined, identity: undefined }
}

function sameArr(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const set = new Set(a)
  for (const id of b) if (!set.has(id)) return false
  return true
}

export namespace KiloViewers {
  export interface Interface {
    readonly update: (snapshot: ViewerSnapshot) => Effect.Effect<void>
    readonly invalidateAuth: () => Effect.Effect<void>
  }

  export class Service extends Context.Service<Service, Interface>()("@kilocode/KiloViewers") {}

  export type SessionsPort = {
    setAttachedSessions: (ids: readonly string[]) => void
  }

  export type Deps = {
    loadSessions: () => Promise<SessionsPort>
  }

  const defaultLoad: Deps["loadSessions"] = () =>
    import("@/kilo-sessions/kilo-sessions").then((m) => m.KiloSessions as SessionsPort)

  export const makeLayer = (deps?: Partial<Deps>) =>
    Layer.effect(
      Service,
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        const load = deps?.loadSessions ?? defaultLoad

        const platform = inferPlatform()
        const killSwitch = process.env.KILO_DISABLE_PRESENCE === "1"
        // KILO_EVENT_SERVICE_URL is a presence-specific override on top of the
        // gateway's EVENT_SERVICE_URL used for event delivery.
        const url = process.env.KILO_EVENT_SERVICE_URL || KILO_EVENT_SERVICE_URL

        const s = {
          viewers: new Map<string, ViewerState>(),
          prevAttached: [] as string[],
          prevContexts: new Set<string>(),
          identity: undefined as string | undefined,
          token: undefined as string | undefined,
          client: undefined as EventServiceClient | undefined,
          timer: null as ReturnType<typeof setTimeout> | null,
          sessionsMemo: undefined as Promise<SessionsPort> | undefined,
          sessionsSettled: undefined as SessionsPort | undefined,
          disposed: false,
        }

        function loadSessions(): Effect.Effect<SessionsPort> {
          const hit = s.sessionsSettled
          if (hit) return Effect.succeed(hit)
          if (!s.sessionsMemo) {
            // P0 span precisely wraps the heavy module load (dynamic import in
            // production, injected loader in tests). Default-off via KILO_P0_PERF.
            // On failure no p0.end is emitted (unmatched start signals failure
            // per the instrument contract) and the memo is cleared for retry.
            const timer = P0Perf.span("kilo_viewers_module_load")
            const p = load().then(
              (api) => {
                timer.end()
                s.sessionsSettled = api
                return api
              },
              (err) => {
                if (s.sessionsMemo === p) s.sessionsMemo = undefined
                throw err
              },
            )
            s.sessionsMemo = p
          }
          const memo = s.sessionsMemo
          return Effect.promise(() => memo)
        }

        function currentUnion(): string[] {
          return attachedUnion([...s.viewers.values()])
        }

      function presenceEnabled(): boolean {
        return !killSwitch && !!url && !!platform && !!s.token
      }

      function disconnectClient() {
        if (s.client) {
          s.client.disconnect()
          s.client = undefined
        }
        s.prevContexts = new Set()
      }

      function runOwned(effect: Effect.Effect<void>): void {
        void Effect.runPromise(
          effect.pipe(Effect.catchCause((cause) => Effect.sync(() => log.warn("presence apply failed", { error: String(cause) })))),
        )
      }

      function rebuildEffect(): Effect.Effect<void> {
        return Effect.gen(function* () {
          log.warn("rebuilding presence connection")
          disconnectClient()
          yield* applyEffect(Date.now())
        })
      }

      function rebuild() {
        runOwned(rebuildEffect())
      }

      function onServerError(err: unknown) {
        const e = err as Record<string, unknown>
        const code = typeof e.code === "string" ? e.code : typeof e.error === "string" ? e.error : ""
        if (code === "too_many_contexts") rebuild()
      }

      function pruneExpired(now: number) {
        const expired = expiredViewerIds([...s.viewers.values()], now)
        for (const id of expired) s.viewers.delete(id)
      }

      const pushAttachedEffect = Effect.fn("KiloViewers.pushAttached")(function* () {
        const before = currentUnion()
        if (sameArr(before, s.prevAttached)) return
        const api = yield* loadSessions()
        if (s.disposed) return
        const latest = currentUnion()
        if (sameArr(latest, s.prevAttached)) return
        s.prevAttached = latest
        api.setAttachedSessions(latest)
      })

      function applyEffect(now: number): Effect.Effect<void> {
        return Effect.gen(function* () {
          pruneExpired(now)
          yield* pushAttachedEffect()
          reconcilePresence()
          rescheduleExpiry(now)
        })
      }

      function reconcilePresence() {
        if (!presenceEnabled()) {
          if (s.client) disconnectClient()
          return
        }
        const active = [...s.viewers.values()].some((v) => v.active)
        const { ids, omitted } = visibleUnion([...s.viewers.values()])
        if (omitted > 0) log.warn("omitted visible session contexts", { omitted })
        const desired = desiredContexts(platform as Platform, active, ids)
        if (!s.client) {
          // Don't hold an idle socket open: connect only once there is a context
          // to assert (inactive-only viewers keep attachment but publish nothing).
          if (desired.size === 0) return
          if (!s.token) return
          s.client = new EventServiceClient({
            url: url as string,
            getToken: () => Promise.resolve(s.token!),
            onUnauthorized: () => disconnectClient(),
            onServerError,
          })
          s.client.subscribe([...desired])
          s.prevContexts = desired
          void s.client.connect().catch((err) => log.warn("presence connect failed", { error: String(err) }))
          return
        }
        if (desired.size === 0) {
          disconnectClient()
          return
        }
        const { remove, add } = reconcileContexts(s.prevContexts, desired)
        if (remove.length) s.client.unsubscribe(remove)
        if (add.length) s.client.subscribe(add)
        s.prevContexts = desired
      }

      function rescheduleExpiry(now: number) {
        if (s.timer) {
          clearTimeout(s.timer)
          s.timer = null
        }
        const deadline = nextExpiryDeadline([...s.viewers.values()], now)
        if (deadline === undefined) return
        const delay = Math.max(deadline - now, 0)
        s.timer = setTimeout(() => {
          s.timer = null
          if (s.disposed) return
          runOwned(applyEffect(Date.now()))
        }, delay)
      }

      const readAuth = auth.get("kilo").pipe(Effect.orElseSucceed((): Auth.Info | undefined => undefined))

      const update = Effect.fn("KiloViewers.update")(function* (snapshot: ViewerSnapshot) {
        const info = yield* readAuth
        const { token, identity } = extract(info)
        if (identity !== s.identity) {
          disconnectClient()
          s.identity = identity
        }
        s.token = token

        const result = validateSnapshot(snapshot)
        if (!result.ok) {
          log.warn("rejected viewer snapshot", { error: result.error.kind })
          return
        }
        // Process-local monotonic ordering per viewer identity: an older
        // in-flight snapshot must never overwrite a newer accepted snapshot.
        // Duplicate/equal or lower sequences are harmless and must not refresh
        // lastSeen (no TTL extension). No yield between check and set, so the
        // compare-and-store is atomic within this runtime.
        const prev = s.viewers.get(result.viewer.id)
        if (prev !== undefined && result.viewer.sequence <= prev.sequence) return
        s.viewers.set(result.viewer.id, {
          id: result.viewer.id,
          active: result.viewer.active,
          sequence: result.viewer.sequence,
          attached: dedupe(result.attached),
          visible: dedupe(result.visible),
          lastSeen: Date.now(),
        })
        yield* applyEffect(Date.now())
      })

      const invalidateAuth = Effect.fn("KiloViewers.invalidateAuth")(function* () {
        disconnectClient()
        s.identity = undefined
        s.token = undefined
        const info = yield* readAuth
        const { token, identity } = extract(info)
        s.token = token
        s.identity = identity
        yield* applyEffect(Date.now())
      })

      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          s.disposed = true
          if (s.timer) {
            clearTimeout(s.timer)
            s.timer = null
          }
          disconnectClient()
          s.viewers.clear()
          const hit = s.sessionsSettled
          if (hit) {
            hit.setAttachedSessions([])
            s.prevAttached = []
            return
          }
          const memo = s.sessionsMemo
          // Never viewed: no load was ever triggered, so the finalizer must
          // not trigger one and must not touch attachment.
          if (!memo) return
          // Loading: owned settle of the same in-flight load, then clear when
          // it succeeded. In-flight updates check `disposed` after their own
          // load and skip their push, so only this owned clear runs and no
          // post-dispose side effect or detached promise survives.
          const out = yield* Effect.promise(() =>
            memo.then(
              (api) => ({ ok: true as const, api }),
              () => ({ ok: false as const }),
            ),
          )
          if (out.ok) {
            out.api.setAttachedSessions([])
            s.prevAttached = []
          }
          s.sessionsMemo = undefined
        }),
      )

      return Service.of({ update, invalidateAuth })
      }),
    )

  export const layer = makeLayer()

  export const defaultLayer = layer.pipe(Layer.provide(Auth.defaultLayer))
}
