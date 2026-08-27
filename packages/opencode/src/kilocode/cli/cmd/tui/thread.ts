import { randomUUID } from "node:crypto"
import { UI } from "@/cli/ui"
import type { NetworkOptions } from "@/cli/network"
import { ServerAuth } from "@/server/auth"
import { Flag } from "@opencode-ai/core/flag/flag"
import { errorMessage } from "@/util/error"
import { TuiConfig } from "@/cli/cmd/tui/config/tui"
import { validateSession } from "@/cli/cmd/tui/validate-session"
import { DaemonClient } from "@/kilocode/daemon/client"
import { Effect, Layer } from "effect"
import { CurrentWorkingDirectory } from "@/cli/cmd/tui/config/cwd"

type TuiInput = Parameters<typeof import("@/cli/cmd/tui/app").tui>[0]
export type StartInput = Omit<TuiInput, "renderer">

type Args = NetworkOptions & {
  prompt?: string
  session?: string
  continue?: boolean
  agent?: string
  model?: string
  fork?: boolean
}

type Input = {
  args: Args
  cwd: string
  input: () => Promise<string | undefined>
  start: (input: StartInput) => Promise<void>
}

export namespace KiloTuiThreadDaemon {
  // Protect TUI-owned HTTP routes from unauthenticated local callers: derive
  // worker credentials once so the spawned worker server and the TUI's SDK
  // clients share the same Basic auth material.
  export function workerAuth() {
    const password = Flag.KILO_SERVER_PASSWORD ?? randomUUID()
    const username = Flag.KILO_SERVER_USERNAME ?? "kilo"
    return {
      env: { KILO_SERVER_USERNAME: username, KILO_SERVER_PASSWORD: password },
      headers: ServerAuth.headers({ password, username }),
    }
  }

  export async function attach(input: Input) {
    const daemon = await DaemonClient.maybe()
    if (!daemon) return false

    const prompt = await input.input()
    // Thread canonical root already resolved by caller (LOCK-SOURCE): do not use raw process cwd.
    const config = await Effect.runPromise(
      TuiConfig.Service.use((svc) => svc.get()).pipe(
        Effect.provide(TuiConfig.defaultLayer.pipe(Layer.provide(Layer.succeed(CurrentWorkingDirectory, input.cwd)))),
      ),
    )

    try {
      await validateSession({
        url: daemon.url,
        sessionID: input.args.session,
        directory: input.cwd,
        headers: daemon.headers,
      })
    } catch (error) {
      UI.error(errorMessage(error))
      process.exitCode = 1
      return true
    }

    await input.start({
      url: daemon.url,
      config,
      directory: input.cwd,
      headers: daemon.headers,
      args: {
        continue: input.args.continue,
        sessionID: input.args.session,
        agent: input.args.agent,
        model: input.args.model,
        prompt,
        fork: input.args.fork,
      },
    })
    return true
  }
}
