import { Effect, Layer, Context } from "effect"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { FetchHttpClient } from "effect/unstable/http"
import { ChildProcess } from "effect/unstable/process"
import { AppProcess } from "@opencode-ai/core/process"
import path from "path"
import { makeRuntime } from "@opencode-ai/core/effect/runtime"
import { InstallationChannel, InstallationVersion } from "@opencode-ai/core/installation/version"
// kilocode_change start
import {
  Brew as KiloBrew,
  Choco as KiloChoco,
  Npm as KiloNpm,
  Scoop as KiloScoop,
} from "@/kilocode/installation"
// kilocode_change end

export type Method = "curl" | "npm" | "yarn" | "pnpm" | "bun" | "brew" | "scoop" | "choco" | "unknown"

export function userAgent(client = "cli") {
  return `kilo/${InstallationChannel}/${InstallationVersion}/${client}` // kilocode_change
}

export const USER_AGENT = userAgent()

export function isPreview() {
  return InstallationChannel !== "latest"
}

export function isLocal() {
  return InstallationChannel === "local"
}

export interface Interface {
  readonly method: () => Effect.Effect<Method>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Installation") {}

export const use = serviceUse(Service)

export const layer: Layer.Layer<Service, never, AppProcess.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const appProcess = yield* AppProcess.Service

    const text = Effect.fnUntraced(
      function* (cmd: string[], opts?: { cwd?: string; env?: Record<string, string> }) {
        const result = yield* appProcess.run(
          ChildProcess.make(cmd[0], cmd.slice(1), {
            cwd: opts?.cwd,
            env: opts?.env,
            extendEnv: true,
          }),
        )
        return result.stdout.toString("utf8")
      },
      Effect.catch(() => Effect.succeed("")),
    )

    const result: Interface = {
      method: Effect.fn("Installation.method")(function* () {
        if (process.execPath.includes(path.join(".kilo", "bin"))) return "curl" as Method // kilocode_change
        if (process.execPath.includes(path.join(".opencode", "bin"))) return "curl" as Method
        if (process.execPath.includes(path.join(".local", "bin"))) return "curl" as Method
        const exec = process.execPath.toLowerCase()

        const checks: Array<{
          name: Method
          command: () => Effect.Effect<string>
        }> = [
          {
            name: "npm",
            command: () => text(["npm", "list", "-g", "--depth=0"]),
          },
          { name: "yarn", command: () => text(["yarn", "global", "list"]) },
          {
            name: "pnpm",
            command: () => text(["pnpm", "list", "-g", "--depth=0"]),
          },
          { name: "bun", command: () => text(["bun", "pm", "ls", "-g"]) },
          {
            name: "brew",
            command: () => text(["brew", "list", "--formula", KiloBrew.formula]),
          }, // kilocode_change
          {
            name: "scoop",
            command: () => text(["scoop", "list", KiloScoop.name]),
          }, // kilocode_change
          {
            name: "choco",
            command: () => text(["choco", "list", "--limit-output", KiloChoco.name]),
          }, // kilocode_change
        ]

        checks.sort((a, b) => {
          const aMatches = exec.includes(a.name)
          const bMatches = exec.includes(b.name)
          if (aMatches && !bMatches) return -1
          if (!aMatches && bMatches) return 1
          return 0
        })

        for (const check of checks) {
          const output = yield* check.command()
          // kilocode_change start
          const installedName =
            check.name === "brew"
              ? KiloBrew.name
              : check.name === "choco"
                ? KiloChoco.name
                : check.name === "scoop"
                  ? KiloScoop.name
                  : KiloNpm.name
          // kilocode_change end
          if (output.includes(installedName)) {
            return check.name
          }
        }

        return "unknown" as Method
      }),
    }

    return Service.of(result)
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(AppProcess.defaultLayer))

const { runPromise } = makeRuntime(Service, defaultLayer)

export const method = () => runPromise((s) => s.method())

export * as Installation from "."
