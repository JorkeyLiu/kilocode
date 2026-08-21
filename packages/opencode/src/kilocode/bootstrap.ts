import { Cause, Context, Effect, Layer } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { KiloSessions } from "@/kilo-sessions/kilo-sessions"
import * as Log from "@opencode-ai/core/util/log"
import { Global } from "@opencode-ai/core/global"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import path from "node:path"
import { Bus } from "@/bus"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { SessionSummary } from "@/session/summary"
import { SessionExport } from "@/kilocode/session-export"
import { createWorkspaceProvider } from "@/kilocode/session-export/workspace-provider"
import { Instance } from "@/kilocode/instance"
import { Identity } from "@kilocode/kilo-telemetry"

const log = Log.create({ service: "kilocode-bootstrap" })

export namespace KilocodeBootstrap {
  export interface Interface {
    readonly init: () => Effect.Effect<void, unknown>
  }

  export class Service extends Context.Service<Service, Interface>()("@kilocode/Bootstrap") {}

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const kilo = yield* KiloSessions.Service
      const bus = yield* Bus.Service

      const init = Effect.fn("KilocodeBootstrap.init")(function* () {
        yield* kilo.init()
        // kilocode_change start - session export bootstrap
        yield* Effect.gen(function* () {
          if (!SessionExport.enabled) return
          const anon = yield* EffectBridge.fromPromise(() =>
            Identity.getMachineId().catch((err) => {
              log.warn("session export identity failed", { err })
              return undefined
            }),
          )
          yield* Effect.promise(() =>
            SessionExport.init({
              agentVersion: InstallationVersion,
              anonId: anon,
              dbPath: path.join(Global.Path.data, "session-export.db"),
              workspaceKey: Instance.directory,
              subscribeAll: (cb) => Bus.subscribeAll(cb),
              snapshotProvider: createWorkspaceProvider({
                root: Instance.directory,
                statePath: path.join(Global.Path.data, "session-export-workspace.json"),
              }),
            }),
          ).pipe(Effect.orDie)
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.sync(() => log.warn("session export bootstrap failed", { err: Cause.squash(cause) })),
          ),
        )
        // kilocode_change end
      })

      return Service.of({ init })
    }),
  )

  export const defaultLayer = layer.pipe(
    Layer.provide([
      KiloSessions.defaultLayer,
      Session.defaultLayer,
      SessionSummary.defaultLayer,
      Provider.defaultLayer,
      Bus.defaultLayer,
    ]),
  )
}
