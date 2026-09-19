import type { Argv } from "yargs"
import { InstallationBuildKind } from "@opencode-ai/core/installation/version"
import { createHelpCommand } from "@/kilocode/help-command"
import { RollCallCommand } from "@/kilocode/cli/cmd/roll-call"
import { ProfileCommand } from "@/kilocode/cli/cmd/profile"
import { DaemonCommand } from "@/kilocode/cli/cmd/daemon"
import { DevSetupCommand, DevAliasCommand } from "@/kilocode/cli/dev-setup"
import { RemoteCommand } from "@/cli/cmd/remote"
import { ConfigCommand as ConfigCLICommand } from "@/cli/cmd/config"
import { KiloBootstrap } from "@/kilocode/cli/bootstrap"

// All Kilo-specific CLI customization lives here so the shared entrypoint
// (src/index.ts) stays thin and only hosts Kilo call-sites. Bootstrap and
// shutdown are owned by `kilocode/cli/bootstrap` so the lightweight
// serve entry (`src/serve-entry.ts`) shares the exact same implementation
// without importing this command tree.
export namespace KiloCli {
  export type AuthRef = KiloBootstrap.AuthRef
  export type BootstrapDeps = KiloBootstrap.BootstrapDeps
  export type ShutdownDeps = KiloBootstrap.ShutdownDeps

  export const isExplicitTelemetryLevel = KiloBootstrap.isExplicitTelemetryLevel
  export const __stateForTests = KiloBootstrap.__stateForTests
  export const waitForIdentityForTests = KiloBootstrap.waitForIdentityForTests
  export const __resetForTests = KiloBootstrap.__resetForTests
  export const runner = KiloBootstrap.runner
  export const bootstrap = KiloBootstrap.bootstrap
  export const shutdown = KiloBootstrap.shutdown

  // Register only the Kilo-specific commands. Shared commands stay in index.ts's chain,
  // so this module only owns Kilo command registration.
  export function register<T>(cli: Argv<T>): Argv<T> {
    cli
      .command(RollCallCommand)
      .command(ProfileCommand)
      .command(RemoteCommand)
      .command(DaemonCommand)
      .command(ConfigCLICommand)
    if (InstallationBuildKind !== "release") cli.command(DevSetupCommand).command(DevAliasCommand)
    // Safe self-reference: `cli` is a typed parameter and yargs `.command()` returns the same
    // instance, so the help command can resolve the fully-built root at handler time. This also
    // sidesteps the self-referential type error the old inline registration hit in index.ts.
    cli.command(createHelpCommand(() => cli))
    return cli
  }
}
