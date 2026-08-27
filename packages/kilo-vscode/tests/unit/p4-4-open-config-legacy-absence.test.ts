import { describe, expect, it } from "bun:test"
import * as fs from "fs"
import * as path from "path"

const root = path.join(import.meta.dir, "../..")

function read(p: string) {
  return fs.readFileSync(path.join(root, p), "utf8")
}

describe("p4.4 open-config legacy absence", () => {
  it("config-file.ts exposes only canonical kilo.jsonc authorities", () => {
    const src = read("src/kilo-provider/config-file.ts")
    expect(src).toContain("sourceGlobal")
    expect(src).toContain("sourceLocal")
    expect(src).not.toContain("sourceXdg")
    expect(src).not.toContain("sourceHomeKilo")
    expect(src).not.toContain("sourceHomeKilocode")
    expect(src).not.toContain("sourceHomeOpencode")
    expect(src).not.toContain("sourceEnvFile")
    expect(src).not.toContain("sourceEnvDir")
    expect(src).not.toContain("sourceEnvContent")
    expect(src).not.toContain("sourceProjectKilo")
    expect(src).not.toContain("sourceProjectRoot")
    expect(src).not.toContain("sourceProjectKilocode")
    expect(src).not.toContain("sourceProjectOpencode")
    // allow KILO_CONFIG_DIR but not bare KILO_CONFIG or KILO_CONFIG_CONTENT
    const stripped = src.replaceAll("KILO_CONFIG_DIR", "__DIR__")
    expect(stripped).not.toContain("KILO_CONFIG")
    expect(stripped).not.toContain("KILO_CONFIG_CONTENT")
    expect(src).not.toContain(".kilocode")
    expect(src).not.toContain(".opencode")
    expect(src).not.toContain("opencode.json")
    expect(src).not.toContain("opencode.jsonc")
    // schema URL legitimately contains config.json, but no legacy GLOBAL list should contain it
    expect(src).not.toContain('GLOBAL')
    expect(src).toContain("kilo.jsonc")
    // resolved global root via KILO_CONFIG_DIR
    expect(src).toContain("KILO_CONFIG_DIR")
    expect(src).toContain("globalRoot")
    // only two expected bad legacy artifacts
    expect(src).not.toContain("virtual")
    // legacy may appear as substring in languages but check field not present
    expect(src).not.toContain("legacy")
    // preserves disabled project semantics
    expect(src).toContain("KILO_DISABLE_PROJECT_CONFIG")
  })

  it("webview message typing has only global/local source labels", () => {
    const src = read("webview-ui/src/types/messages/webview-messages.ts")
    expect(src).toContain("sourceGlobal")
    expect(src).toContain("sourceLocal")
    expect(src).not.toContain("sourceXdg")
    expect(src).not.toContain("sourceEnv")
    expect(src).not.toContain("sourceHome")
    expect(src).not.toContain("sourceProject")
    expect(src).not.toContain("statusLoadedLegacy")
  })

  it("open-config.ts has no legacy status badge", () => {
    const src = read("src/kilo-provider/open-config.ts")
    expect(src).not.toContain("statusLoadedLegacy")
    expect(src).not.toContain("legacy")
    expect(src).not.toContain("virtual")
    // open-config imports Source and delegates to config-file; ensure it no longer hard-codes legacy source strings
    expect(src).not.toContain("sourceXdg")
    expect(src).not.toContain("sourceHome")
    expect(src).not.toContain("sourceEnv")
    expect(src).not.toContain("sourceProject")
  })

  it("webview i18n dictionaries have only canonical source keys", () => {
    const dir = path.join(root, "webview-ui/src/i18n")
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".ts"))
    expect(files.length).toBeGreaterThan(15)
    for (const file of files) {
      const c = fs.readFileSync(path.join(dir, file), "utf8")
      expect(c).not.toContain("settings.config.source.xdg")
      expect(c).not.toContain("settings.config.source.homeKilo")
      expect(c).not.toContain("settings.config.source.homeKilocode")
      expect(c).not.toContain("settings.config.source.homeOpencode")
      expect(c).not.toContain("settings.config.source.envFile")
      expect(c).not.toContain("settings.config.source.envDir")
      expect(c).not.toContain("settings.config.source.envContent")
      expect(c).not.toContain("settings.config.source.projectKilo")
      expect(c).not.toContain("settings.config.source.projectRoot")
      expect(c).not.toContain("settings.config.source.projectKilocode")
      expect(c).not.toContain("settings.config.source.projectOpencode")
      expect(c).not.toContain("settings.config.status.loadedLegacy")
      expect(c).toContain("settings.config.source.global")
      expect(c).toContain("settings.config.source.local")
    }
  })

  it("preserves KILO_CONFIG_DIR global override and sandbox deny", () => {
    const flag = fs.readFileSync(path.join(root, "../../packages/core/src/flag/flag.ts"), "utf8")
    const global = fs.readFileSync(path.join(root, "../../packages/core/src/global.ts"), "utf8")
    const policy = fs.readFileSync(path.join(root, "../../packages/opencode/src/kilocode/sandbox/policy.ts"), "utf8")
    expect(flag).toContain("get KILO_CONFIG_DIR()")
    expect(global).toContain("Flag.KILO_CONFIG_DIR ?? Path.config")
    expect(policy).toContain('"KILO_CONFIG_DIR"')
    expect(policy).toContain('"KILO_CONFIG"')
    expect(policy).toContain('"KILO_CONFIG_CONTENT"')
  })
})
