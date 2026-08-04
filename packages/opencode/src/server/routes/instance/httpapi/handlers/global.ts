import { Config } from "@/config/config"
import { GlobalBus, type GlobalEvent as GlobalBusEvent } from "@/bus/global"
import { EventV2 } from "@opencode-ai/core/event"
import { Installation } from "@/installation"
import { disconnect } from "@/kilocode/server/sse" // kilocode_change
import { emitGlobalDisposed } from "@/server/global-lifecycle" // kilocode_change
import { GenerationGate } from "@/kilocode/server/generation-gate" // kilocode_change
import { ConfigRebuild } from "@/kilocode/server/config-rebuild" // kilocode_change
import { withWriteTicket } from "@/kilocode/server/config-ticket" // kilocode_change
import { withColdMutation } from "@/kilocode/server/config-convergence" // kilocode_change - canonical cold-save wrapper
import { configFailure } from "@/kilocode/server/config-failure" // kilocode_change
import { isHotPatch } from "@/kilocode/config/hot-keys" // kilocode_change
import { InstanceStore } from "@/project/instance-store" // kilocode_change
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import * as Log from "@opencode-ai/core/util/log"
import { Effect, Option, Queue, Schema } from "effect"
import * as Stream from "effect/Stream"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as Sse from "effect/unstable/encoding/Sse"
import { RootHttpApi } from "../api"
import { GlobalUpgradeInput } from "../groups/global"

const log = Log.create({ service: "server" })

function eventData(data: unknown): Sse.Event {
  return {
    _tag: "Event",
    event: "message",
    id: undefined,
    data: JSON.stringify(data),
  }
}

function parseBody(body: string) {
  try {
    return JSON.parse(body || "{}") as unknown
  } catch {
    return undefined
  }
}

// kilocode_change start
function eventResponse(request: HttpServerRequest.HttpServerRequest) {
  // kilocode_change end
  log.info("global event connected")
  const events = Stream.callback<GlobalBusEvent>((queue) => {
    const handler = (event: GlobalBusEvent) => Queue.offerUnsafe(queue, event)
    return Effect.acquireRelease(
      Effect.sync(() => GlobalBus.on("event", handler)),
      () => Effect.sync(() => GlobalBus.off("event", handler)),
    )
  })
  const heartbeat = Stream.tick("10 seconds").pipe(
    Stream.drop(1),
    Stream.map(() => ({ payload: { id: EventV2.ID.create(), type: "server.heartbeat", properties: {} } })),
  )

  return HttpServerResponse.stream(
    Stream.make({ payload: { id: EventV2.ID.create(), type: "server.connected", properties: {} } }).pipe(
      Stream.concat(events.pipe(Stream.merge(heartbeat, { haltStrategy: "left" }))),
      Stream.map(eventData),
      Stream.pipeThroughChannel(Sse.encode()),
      Stream.encodeText,
      // kilocode_change start - prevent disconnected SSE clients from retaining full diff payloads
      // Explicit interruption closes the stream scope, unregisters its GlobalBus listener, and
      // releases the unbounded callback queue even when transport cancellation is not propagated.
      Stream.interruptWhen(disconnect(request)),
      // kilocode_change end
      Stream.ensuring(Effect.sync(() => log.info("global event disconnected"))),
    ),
    {
      contentType: "text/event-stream",
      headers: {
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
        "X-Content-Type-Options": "nosniff",
      },
    },
  )
}

export const globalHandlers = HttpApiBuilder.group(RootHttpApi, "global", (handlers) =>
  Effect.gen(function* () {
    const config = yield* Config.Service
    const installation = yield* Installation.Service
    const gate = Option.getOrElse(yield* Effect.serviceOption(GenerationGate.Service), () => GenerationGate.noop) // kilocode_change
    const store = Option.getOrElse(yield* Effect.serviceOption(InstanceStore.Service), () => undefined) // kilocode_change

    const health = Effect.fn("GlobalHttpApi.health")(function* () {
      return { healthy: true as const, version: InstallationVersion }
    })

    const event = Effect.fn("GlobalHttpApi.event")(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest // kilocode_change
      return eventResponse(request) // kilocode_change
    })

    const configGet = Effect.fn("GlobalHttpApi.configGet")(function* () {
      return yield* config.getGlobal()
    })

    const configUpdate = Effect.fn("GlobalHttpApi.configUpdate")(function* (ctx) {
      const hot = isHotPatch(ctx.payload as Record<string, unknown>)
      if (hot) return (yield* configFailure(config.updateGlobal(ctx.payload, { dispose: false }))).info
      // kilocode_change start - cold global save routed through the canonical
      // ConfigConvergence fence; emits only after the rebuild registration owns
      // the fence (LOCK-002/003).
      return yield* withColdMutation({
        scope: "global",
        run: () =>
          Effect.gen(function* () {
            // kilocode_change start - emit:false defers the ConfigUpdated publish
            const exit = yield* configFailure(config.updateGlobal(ctx.payload, { emit: false })).pipe(Effect.exit)
            // kilocode_change end
            if (exit._tag === "Failure") return yield* Effect.failCause(exit.cause)
            return {
              changed: exit.value.changed,
              value: exit.value.info,
              event: exit.value.changed ? config.emitUpdated("global") : undefined, // kilocode_change
            }
          }),
      })
      // kilocode_change end
    })

    const dispose = Effect.fn("GlobalHttpApi.dispose")(function* () {
      // kilocode_change start - LOCK-001: one global writer ticket, pre-barrier
      // identity capture, exactly one ControlLease-aware rebuild. The response
      // returns true after rebuild registration, before generation drain; the
      // rebuild preserves the single `global.disposed` emission after disposal.
      yield* withWriteTicket({
        acquire: gate.beginWriteGlobal(),
        run: (ticket) =>
          Effect.gen(function* () {
            const dirs = store ? yield* store.directories() : []
            const olds = yield* Effect.forEach(dirs, (directory) =>
              store!.snapshot(directory).pipe(Effect.map((old) => ({ directory, old }))),
            )
            if (!store) return { changed: false, value: true as const, event: emitGlobalDisposed }
            return { changed: true, value: true as const, rebuild: ConfigRebuild.rebuildGlobal(ticket, olds) }
          }),
      })
      // kilocode_change end
      return true
    })

    const upgrade = Effect.fn("GlobalHttpApi.upgrade")(function* (ctx: { payload: typeof GlobalUpgradeInput.Type }) {
      const method = yield* installation.method()
      if (method === "unknown") {
        return {
          status: 400,
          body: { success: false as const, error: "Unknown installation method" },
        }
      }
      const target = ctx.payload.target || (yield* installation.latest(method))
      const result = yield* installation.upgrade(method, target).pipe(
        Effect.as({ status: 200, body: { success: true as const, version: target } }),
        Effect.catch((err) =>
          Effect.succeed({
            status: 500,
            body: {
              success: false as const,
              error: err instanceof Error ? err.message : String(err),
            },
          }),
        ),
      )
      if (!result.body.success) return result
      GlobalBus.emit("event", {
        directory: "global",
        payload: {
          type: Installation.Event.Updated.type,
          properties: { version: target },
        },
      })
      return result
    })

    const upgradeRaw = Effect.fn("GlobalHttpApi.upgradeRaw")(function* (ctx: {
      request: HttpServerRequest.HttpServerRequest
    }) {
      const body = yield* Effect.orDie(ctx.request.text)
      const json = parseBody(body)
      if (json === undefined) {
        return HttpServerResponse.jsonUnsafe({ success: false, error: "Invalid request body" }, { status: 400 })
      }
      const payload = yield* Schema.decodeUnknownEffect(GlobalUpgradeInput)(json).pipe(
        Effect.map((payload) => ({ valid: true as const, payload })),
        Effect.catch(() => Effect.succeed({ valid: false as const })),
      )
      if (!payload.valid) {
        return HttpServerResponse.jsonUnsafe({ success: false, error: "Invalid request body" }, { status: 400 })
      }
      const result = yield* upgrade({ payload: payload.payload })
      return HttpServerResponse.jsonUnsafe(result.body, { status: result.status })
    })

    return handlers
      .handle("health", health)
      .handleRaw("event", event)
      .handle("configGet", configGet)
      .handle("configUpdate", configUpdate)
      .handle("dispose", dispose)
      .handleRaw("upgrade", upgradeRaw)
  }),
)
