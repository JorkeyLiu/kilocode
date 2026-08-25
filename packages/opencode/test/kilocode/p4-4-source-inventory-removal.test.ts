import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

// P4.4 source-removal evidence — legacy effective-config source inventory reader
// and `/config/sources` reporting endpoint physically removed (LOCK-010/014/015).
// - `packages/opencode/src/kilocode/config/sources.ts` deleted (12-source inventory).
// - `KilocodeConfigSources` type/echo removed from overlay and config-console.
// - `/config/sources` schema/path/endpoint/handler removed; `sources` field removed
//   from the overlay response.
// - Generated SDK/OpenAPI regenerated; `config.sources` / `ConfigSourcesResponse`
//   must be absent from checked-in generated artifacts.
// - Retained config-console bridge surfaces (`/config/overlay`, `/config/effective`,
//   `/config/transaction`, rules, model-state, TUI config/keybinds) must remain.
// Spec anchors: P4.4 section 8.1 source-removal evidence; tracker section 7
// effective-config source removal rows. This file asserts absence of the removed
// inventory and of the generated contract; it does not claim P4.4 completion.

const opencode = join(import.meta.dir, "../../src")
const repo = resolve(join(import.meta.dir, "../../../../"))
const sdkGen = join(repo, "packages/sdk/js/src/v2/gen")
const openapi = join(repo, "packages/sdk/openapi.json")

function read(path: string): string {
  return readFileSync(path, "utf8")
}

describe("P4.4 source-inventory removal — legacy reader and /config/sources absent", () => {
  test("legacy sources.ts inventory reader is deleted", () => {
    expect(existsSync(join(opencode, "kilocode/config/sources.ts"))).toBe(false)
  })

  test("no production source references KilocodeConfigSources", () => {
    const files = ["kilocode/config/overlay.ts", "kilocode/server/httpapi/groups/config-console.ts"]
    for (const file of files) {
      expect(read(join(opencode, file)), `${file}`).not.toContain("KilocodeConfigSources")
    }
  })

  test("no production source references the /config/sources contract", () => {
    const files = [
      "kilocode/config/overlay.ts",
      "kilocode/server/httpapi/groups/config-console.ts",
      "kilocode/server/httpapi/handlers/config-console.ts",
    ]
    for (const file of files) {
      const src = read(join(opencode, file))
      expect(src, `${file}`).not.toContain("/config/sources")
      expect(src, `${file}`).not.toContain("ConfigSourcesResponse")
    }
  })

  test("overlay result no longer carries the sources echo", () => {
    const overlay = read(join(opencode, "kilocode/config/overlay.ts"))
    expect(overlay).not.toContain("KilocodeConfigSources")
    expect(overlay).not.toContain("sources:")
    expect(overlay).toContain("fields:")
    expect(overlay).toContain("collections:")
  })

  test("config-console group keeps retained bridge endpoints and drops sources", () => {
    const group = read(join(opencode, "kilocode/server/httpapi/groups/config-console.ts"))
    // removed surface
    expect(group).not.toContain("sources:")
    expect(group).not.toContain("ConfigConsolePaths.sources")
    // retained bridge surfaces
    expect(group).toContain("effective: \"/config/effective\"")
    expect(group).toContain("overlay: \"/config/overlay\"")
    expect(group).toContain("transaction: \"/config/transaction\"")
    expect(group).toContain("rules: \"/config/rules\"")
    expect(group).toContain("modelState: \"/config/model-state\"")
    expect(group).toContain("tuiConfig: \"/tui/config\"")
    expect(group).toContain("tuiKeybinds: \"/tui/keybinds\"")
  })

  test("config-console handler drops the sources handler and keeps overlay/transaction", () => {
    const handler = read(join(opencode, "kilocode/server/httpapi/handlers/config-console.ts"))
    expect(handler).not.toContain("ConfigConsoleHttpApi.sources")
    expect(handler).not.toContain('handle("sources"')
    expect(handler).not.toContain("KilocodeConfigSources.list")
    // retained handlers
    expect(handler).toContain("overlayUpdate")
    expect(handler).toContain('handle("overlay"')
    expect(handler).toContain('handle("configTransaction"')
    expect(handler).toContain('handle("effective"')
    expect(handler).not.toContain('handle("sources"')
  })

  test("generated v2 SDK has no config.sources contract but keeps config bridge methods", () => {
    const sdk = read(join(sdkGen, "sdk.gen.ts"))
    const types = read(join(sdkGen, "types.gen.ts"))
    expect(sdk).not.toContain("config.sources")
    expect(sdk).not.toContain('url: "/config/sources"')
    expect(types).not.toContain('url: "/config/sources"')
    expect(sdk).not.toContain("ConfigSourcesResponse")
    expect(types).not.toContain("ConfigSourcesResponse")
    // retained config-console bridge methods
    expect(sdk).toContain('url: "/config/overlay"')
    expect(sdk).toContain('url: "/config/effective"')
    expect(sdk).toContain('url: "/config/transaction"')
    expect(sdk).toContain('url: "/config/rules"')
    expect(sdk).toContain('url: "/config/model-state"')
    expect(sdk).toContain('url: "/config/warnings"')
  })

  test("checked-in openapi.json has no /config/sources path or ConfigSourcesResponse schema", () => {
    const spec = read(openapi)
    expect(spec).not.toContain('"/config/sources"')
    expect(spec).not.toContain("ConfigSourcesResponse")
    // retained config-console paths remain in the spec
    expect(spec).toContain('"/config/overlay"')
    expect(spec).toContain('"/config/effective"')
    expect(spec).toContain('"/config/transaction"')
  })
})