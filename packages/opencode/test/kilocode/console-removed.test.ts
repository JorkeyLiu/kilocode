import { describe, expect, test } from "bun:test"
import path from "path"

// P3.3 (LOCK-003): the local Kilo Console product is permanently removed.
// This guard proves the unambiguous Console chain is absent while asserting
// the shared migration-bridge APIs (config-console, experimental.console.*,
// generated SDK Console group, core consoleState) that later phases rely on
// are still present. Cloud account "console" strings (console.opencode.ai,
// KILO_CONSOLE_TOKEN) are unrelated and must NOT be asserted absent here.

const root = path.resolve(import.meta.dir, "../../../../")

const read = async (rel: string) => {
  const file = Bun.file(path.join(root, rel))
  if (!(await file.exists())) return undefined
  return file.text()
}

describe("P3.3 Kilo Console product removal", () => {
  test("console packages are removed from the workspace", async () => {
    expect(await read("packages/kilo-console/package.json")).toBeUndefined()
    expect(await read("packages/kilo-web-ui/package.json")).toBeUndefined()
    const pkg = await read("package.json")
    expect(pkg).not.toContain('"kilo-console"')
    expect(pkg).not.toContain('"kilo-web-ui"')
  })

  test("CLI console command source, registration, and assets are absent", async () => {
    expect(await read("packages/opencode/src/kilocode/cli/cmd/console.ts")).toBeUndefined()
    expect(await read("packages/opencode/src/kilocode/console/assets.ts")).toBeUndefined()

    const setup = await read("packages/opencode/src/kilocode/cli/setup.ts")
    const barrel = await read("packages/opencode/src/kilocode/commands.ts")
    const index = await read("packages/opencode/src/index.ts")
    expect(setup).not.toContain("KiloConsoleCommand")
    expect(setup).not.toContain("cli/cmd/console")
    expect(barrel).not.toContain("KiloConsoleCommand")
    expect(barrel).not.toContain("cli/cmd/console")
    expect(index).not.toContain(".command(ConsoleCommand)")
  })

  test("serve/workspace routing no longer serves the /console product", async () => {
    const ui = await read("packages/opencode/src/server/shared/ui.ts")
    const routing = await read(
      "packages/opencode/src/server/routes/instance/httpapi/middleware/workspace-routing.ts",
    )
    expect(ui).not.toContain("ConsoleAssets")
    expect(ui).not.toContain('"/console"')
    expect(routing).not.toContain('startsWith("/console")')
    expect(routing).not.toContain('/console"')
  })

  test("opencode build no longer builds or copies the Console product", async () => {
    const build = await read("packages/opencode/script/build.ts")
    expect(build).not.toContain("buildKiloConsole")
    expect(build).not.toContain("copyKiloConsole")
    expect(build).not.toContain("kiloConsoleDist")
    expect(build).not.toContain("KILO_CONSOLE_BASE")
  })

  test("CI workflow no longer builds the Console product", async () => {
    const workflow = await read(".github/workflows/typecheck.yml")
    expect(workflow).not.toContain("kilo-console")
  })

  test("user docs no longer list a kilo console command", async () => {
    const table = await read("packages/kilo-docs/markdoc/partials/cli-commands-table.md")
    const reference = await read("packages/kilo-docs/pages/code-with-ai/platforms/cli-reference.md")
    expect(table).not.toContain("`kilo console`")
    expect(reference).not.toContain("## kilo console")
  })

  test("console-only tests and env are gone, generic console.log stays", async () => {
    expect(await read("packages/opencode/test/kilocode/console-ui.test.ts")).toBeUndefined()
    const build = await read("packages/opencode/script/build.ts")
    // Generic console.log diagnostics must remain; the product env must not.
    expect(build).toContain("console.log")
    expect(build).not.toContain("KILO_CONSOLE_ASSET_DIR")
    expect(build).not.toContain("KILO_CONSOLE_BASE")
  })

  test("shared config-console HttpApi survives for the migration bridge", async () => {
    expect(await read("packages/opencode/src/kilocode/server/httpapi/groups/config-console.ts")).toBeDefined()
    expect(await read("packages/opencode/src/kilocode/server/httpapi/handlers/config-console.ts")).toBeDefined()
    const api = await read("packages/opencode/src/server/routes/instance/httpapi/api.ts")
    expect(api).toContain("ConfigConsoleApi")
  })

  test("experimental.console.* server group and core consoleState survive", async () => {
    const experimental = await read(
      "packages/opencode/src/server/routes/instance/httpapi/groups/experimental.ts",
    )
    expect(experimental).toContain("console")
    const config = await read("packages/opencode/src/config/config.ts")
    expect(config).toContain("consoleState")
  })

  test("generated SDK Console group survives", async () => {
    const gen = await read("packages/sdk/js/src/v2/gen/sdk.gen.ts")
    expect(gen).toContain("Console")
  })

  test("account.ts no longer exports the dead upstream ConsoleCommand", async () => {
    const account = await read("packages/opencode/src/cli/cmd/account.ts")
    expect(account).not.toContain("ConsoleCommand")
    expect(account).toContain("defaultConsoleUrl")
  })
})
