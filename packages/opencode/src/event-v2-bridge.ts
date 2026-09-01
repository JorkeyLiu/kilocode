// Opencode publish boundary for core events. Attach routed instance location
// so direct EventV2 consumers can isolate directory/workspace streams.
import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { GlobalBus } from "@/bus/global"
import * as EventWire from "@/kilocode/event-wire" // kilocode_change
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { Project } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import "@opencode-ai/core/account"
import "@opencode-ai/core/catalog"
import "@opencode-ai/core/session/event"
import { Context, Effect, Layer } from "effect"

export class Service extends Context.Service<Service, EventV2.Interface>()("@opencode/EventV2Bridge") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service

    const publish: EventV2.Interface["publish"] = (definition, data, options) =>
      Effect.gen(function* () {
        if (options?.location) return yield* events.publish(definition, data, options)
        const ctx = yield* InstanceRef
        if (!ctx) return yield* events.publish(definition, data, options)
        const workspaceID = yield* WorkspaceRef
        return yield* events.publish(definition, data, {
          ...options,
          location: new Location.Info({
            directory: AbsolutePath.make(ctx.directory),
            ...(workspaceID ? { workspaceID } : {}),
            project: { id: Project.ID.make(ctx.project.id), directory: AbsolutePath.make(ctx.worktree) },
          }),
        })
      })

    const unsubscribe = yield* events.listen((event) =>
      Effect.gen(function* () {
        const loc = event.location as unknown as Location.Info | undefined
        const ctx = yield* InstanceRef
        const ambientWorkspace = yield* WorkspaceRef
        const directory = loc ? (loc.directory as string) : (ctx?.directory ?? "global")
        const project = loc ? (loc.project as { id: string } | undefined)?.id : ctx?.project?.id
        const workspace = loc ? (loc.workspaceID as string | undefined) : ambientWorkspace
        // kilocode_change start - legacy bus and SSE consumers require the schema's encoded representation
        const definition = EventV2.registry.get(event.type)
        const data = definition ? EventWire.encode(definition.data, event.data) : event.data
        // kilocode_change end
        GlobalBus.emit("event", {
          directory, // kilocode_change - instance-less events are tagged "global" on the wire
          project,
          workspace,
          payload: { id: event.id, type: event.type, properties: data }, // kilocode_change - encoded
        })
        const sync = definition?.sync
        if (sync === undefined || event.seq === undefined || event.version === undefined) return
        const aggregateID = (event.data as Record<string, unknown>)[sync.aggregate]
        if (typeof aggregateID !== "string") return
        GlobalBus.emit("event", {
          directory, // kilocode_change - instance-less events are tagged "global" on the wire
          project,
          workspace,
          payload: {
            type: "sync",
            syncEvent: {
              id: event.id,
              type: EventV2.versionedType(event.type, event.version),
              seq: event.seq,
              aggregateID,
              data, // kilocode_change - encoded
            },
          },
        })
      }),
    )
    yield* Effect.addFinalizer(() => unsubscribe)

    return Service.of({ ...events, publish })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(EventV2.defaultLayer))

export * as EventV2Bridge from "./event-v2-bridge"
