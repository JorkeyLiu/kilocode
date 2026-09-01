import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join, resolve } from "node:path"

// P4.4-G2 — preset provider catalog and models.dev fallback physically removed (LOCK-006)
// - `packages/opencode/src/kilocode/provider/models-api.json` (3 MB snapshot) deleted
// - `packages/core/src/models-dev.ts` disk/cache/network/refresh runtime deleted
// - `packages/core/src/kilocode/models-refresh.ts` deleted
// - `packages/core/src/plugin/models-dev.ts` deleted
// - `packages/opencode/src/provider/models.ts` Kilo wrapper deleted
// - `packages/opencode/src/kilocode/provider/models-refresh.ts` deleted
// - `packages/opencode/src/kilocode/provider/models-snapshot-shape.ts` deleted
// - `packages/opencode/script/kilocode/refresh-models.ts` and `models-snapshot.ts` deleted
// - build snapshot embedding (`KILO_MODELS_DEV`, `MODELS_SNAPSHOT_RELATIVE`, `refresh:models` script) removed
// - ModelsDev service/layer wiring removed from Provider, runtime, Server, CLI, handlers
// - Custom-provider save/delete/auth + generic BUNDLED_PROVIDERS adapters preserved
// Spec anchors: LOCK-005, LOCK-006, LOCK-007, LOCK-009, LOCK-010/011.

const opencode = join(import.meta.dir, "../../src")
const core = resolve(join(import.meta.dir, "../../../core/src"))
const repo = resolve(join(import.meta.dir, "../../../../"))

function read(rel: string): string {
  return readFileSync(join(opencode, rel), "utf8")
}
function readCore(rel: string): string {
  return readFileSync(join(core, rel), "utf8")
}
function readRepo(rel: string): string {
  return readFileSync(join(repo, rel), "utf8")
}

describe("P4.4-G2 preset catalog removal — files deleted", () => {
  test("checked-in snapshot file deleted", () => {
    expect(existsSync(join(opencode, "kilocode/provider/models-api.json"))).toBe(false)
  })

  test("core runtime deleted", () => {
    expect(existsSync(join(core, "models-dev.ts"))).toBe(false)
    expect(existsSync(join(core, "kilocode/models-refresh.ts"))).toBe(false)
    expect(existsSync(join(core, "plugin/models-dev.ts"))).toBe(false)
  })

  test("Kilo wrapper and snapshot helpers deleted", () => {
    expect(existsSync(join(opencode, "provider/models.ts"))).toBe(false)
    expect(existsSync(join(opencode, "kilocode/provider/models-refresh.ts"))).toBe(false)
    expect(existsSync(join(opencode, "kilocode/provider/models-snapshot-shape.ts"))).toBe(false)
    expect(existsSync(resolve(join(repo, "packages/opencode/script/kilocode/refresh-models.ts")))).toBe(false)
    expect(existsSync(resolve(join(repo, "packages/opencode/script/kilocode/models-snapshot.ts")))).toBe(false)
  })

  test("build snapshot embedding removed", () => {
    const build = readRepo("packages/opencode/script/build.ts")
    expect(build).not.toContain("generated.modelsData")
    expect(build).not.toContain("generate.ts")
    // No snapshot smoke test
    expect(build).not.toContain("smokeModels")
    expect(build).not.toContain("models anthropic")
    expect(existsSync(resolve(join(repo, "packages/opencode/script/generate.ts")))).toBe(false)
    const pkg = readRepo("packages/opencode/package.json")
    expect(pkg).not.toContain("refresh:models")
    const buildNode = readRepo("packages/opencode/script/build-node.ts")
    expect(buildNode).not.toContain("generated.modelsData")
    expect(buildNode).not.toContain("generate.ts")
  })

  test("no production source references preset catalog symbols", () => {
    let combined = ""
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          if (entry.name === "node_modules" || entry.name === ".git") continue
          walk(full)
        } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
          combined += readFileSync(full, "utf8") + "\n"
        }
      }
    }
    walk(opencode)
    // Preset catalog and models.dev runtime symbols must be absent
    expect(combined).not.toContain("models-api.json")
    expect(combined).not.toContain("MODELS_SNAPSHOT_RELATIVE")
    expect(combined).not.toContain("KILO_MODELS_DEV")
    // ModelsDev service must not be referenced except via local provider/model-status shim
    // We allow the string in comments that mention removal, but not service wiring
    const withoutComments = combined
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.includes("P4.4-G2"))
      .join("\n")
    expect(withoutComments).not.toContain("ModelsDev.Service")
    expect(withoutComments).not.toContain('from "@opencode-ai/core/models-dev"')
    expect(withoutComments).not.toContain('from "@/provider/models"')
    expect(withoutComments).not.toContain("fromModelsDevProvider")
    expect(withoutComments).not.toContain("fromModelsDevModel")
  })

  test("core no longer references models.dev runtime", () => {
    let combined = ""
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          if (entry.name === "node_modules" || entry.name === ".git") continue
          walk(full)
        } else if (entry.name.endsWith(".ts")) {
          combined += readFileSync(full, "utf8") + "\n"
        }
      }
    }
    walk(core)
    expect(combined).not.toContain("models-dev")
    expect(combined).not.toContain("ModelsDev")
    expect(combined).not.toContain("KILO_MODELS_DEV")
    expect(combined).not.toContain("KILO_MODELS_URL")
    expect(combined).not.toContain("KILO_MODELS_PATH")
    expect(combined).not.toContain("KILO_DISABLE_MODELS_FETCH")
  })

  test("provider no longer depends on catalog injection", () => {
    const src = read("provider/provider.ts")
    expect(src).not.toContain('from "./models"')
    expect(src).not.toContain("ModelsDev")
    expect(src).not.toContain("fromModelsDev")
    expect(src).not.toContain("ModelsRefresh")
    // catalog injection removed — database is built from config only
    expect(src).toContain("const database: Record<string, Info> = {}")
    expect(src).toContain("BUNDLED_PROVIDERS")
  })

  test("app runtime and server no longer expose models injection seam", () => {
    const rt = read("effect/app-runtime.ts")
    expect(rt).not.toContain("ModelsDev")
    expect(rt).toContain("buildCoreLayer")
    expect(rt).toContain("makeAppLayer")
    const server = read("server/routes/instance/httpapi/server.ts")
    expect(server).not.toContain("ModelsDev")
    expect(server).not.toContain("models?:")
    const handler = read("server/routes/instance/httpapi/handlers/provider.ts")
    expect(handler).not.toContain("ModelsDev")
    expect(handler).not.toContain("overlayAnacondaDesktop")
    expect(handler).not.toContain("fromModelsDevProvider")
  })

  test("generic adapters preserved (LOCK-006)", () => {
    const provider = read("provider/provider.ts")
    expect(provider).toContain("const BUNDLED_PROVIDERS")
    expect(provider).toContain('"@ai-sdk/openai"')
    expect(provider).toContain('"@ai-sdk/anthropic"')
    expect(provider).toContain('"@ai-sdk/openai-compatible"')
    const kilo = read("kilocode/provider/provider.ts")
    expect(kilo).toContain("KILO_MODEL_SCHEMA_EXTENSIONS")
    expect(kilo).toContain("patchConfigModel")
    // Generic adapters remain, preset Kilo loader already removed in T6 remains absent
    expect(kilo).not.toContain("KILO_BUNDLED_PROVIDERS")
  })

  test("custom-provider save/delete/auth and generic provider handlers preserved", () => {
    expect(existsSync(join(opencode, "kilocode/server/custom-provider-save.ts"))).toBe(true)
    expect(existsSync(join(opencode, "kilocode/server/custom-provider-delete.ts"))).toBe(true)
    expect(existsSync(join(opencode, "kilocode/server/provider-auth-lifecycle.ts"))).toBe(true)
    expect(read("kilocode/server/custom-provider-save.ts")).not.toContain("ModelCache")
    expect(read("server/routes/instance/httpapi/handlers/provider.ts")).toContain('handle("list"')
    expect(read("server/routes/instance/httpapi/groups/provider.ts")).toContain('HttpApiEndpoint.get("list"')
  })

  test("CLI no longer references models.dev refresh", () => {
    const models = read("cli/cmd/models.ts")
    expect(models).not.toContain("ModelsDev")
    expect(models).not.toContain("refresh")
    const providers = read("cli/cmd/providers.ts")
    expect(providers).not.toContain("ModelsDev")
    const github = read("cli/cmd/github.handler.ts")
    expect(github).not.toContain("ModelsDev")
  })

  test("source wrapper no longer injects KILO_MODELS_PATH", () => {
    const wrapper = readRepo("packages/kilo-vscode/script/source-wrapper.ts")
    expect(wrapper).not.toContain('export KILO_MODELS_PATH')
    expect(wrapper).not.toContain("models-api.json")
    expect(wrapper).toContain("generateSourceWrapperContent")
  })

  test("test preload no longer pins KILO_MODELS_PATH", () => {
    const preload = readRepo("packages/opencode/test/preload.ts")
    expect(preload).not.toContain("KILO_MODELS_PATH")
  })

  test("flag no longer exposes models.dev controls", () => {
    const flag = readCore("flag/flag.ts")
    expect(flag).not.toContain("KILO_MODELS_URL")
    expect(flag).not.toContain("KILO_MODELS_PATH")
    expect(flag).not.toContain("KILO_DISABLE_MODELS_FETCH")
  })

  test("Nix build no longer depends on models-dev preset catalog", () => {
    const nix = readRepo("nix/kilo.nix")
    expect(nix).not.toContain("models-dev")
    expect(nix).not.toContain("MODELS_DEV_API_JSON")
    expect(nix).not.toContain("KILO_DISABLE_MODELS_FETCH")
    // Other build inputs/env preserved — not an unrelated Nix topology change
    expect(nix).toContain("nativeBuildInputs")
    expect(nix).toContain("KILO_SKIP_BUNDLED_BWRAP")
    expect(nix).toContain("KILO_VERSION")
    expect(nix).toContain("KILO_CHANNEL")
    // Flake no longer supplies a models-dev input; static callPackage closure is self-contained
    const flake = readRepo("flake.nix")
    expect(flake).not.toContain("models-dev")
    expect(flake).toContain('kilo = pkgs.callPackage ./nix/kilo.nix')
  })

  test("developer-only cost tooling and schema $ref remain (not a product catalog dependency)", () => {
    // Recording cost report is developer-only cost tooling — allowed to fetch models.dev pricing externally
    const cost = readRepo("packages/llm/script/recording-cost-report.ts")
    expect(cost).toContain("models.dev/api.json")
    expect(existsSync(resolve(join(repo, "packages/llm/script/recording-cost-report.ts")))).toBe(true)
    // Schema MODEL_REF is an external $ref identifier only — not a build-time catalog dependency
    const schema = readRepo("packages/opencode/script/schema.ts")
    expect(schema).toContain('MODEL_REF = "https://models.dev/model-schema.json')
    expect(schema).toContain("$ref")
  })
})

describe("P4.4-G2 functional preservation — custom providers still resolve", () => {
  test("provider handles explicit config models with generic adapter fallback", () => {
    const src = read("provider/provider.ts")
    // Config-defined models are parsed with explicit npm fallback to openai-compatible
    expect(src).toContain('provider.npm ??')
    expect(src).toContain('"@ai-sdk/openai-compatible"')
    expect(src).toContain("patchKiloConfigModel")
    expect(src).toContain("KILO_MODEL_SCHEMA_EXTENSIONS")
  })

  test("provider auth and custom-provider paths preserved", () => {
    const auth = read("provider/auth.ts")
    expect(auth.length).toBeGreaterThan(0)
    expect(existsSync(join(opencode, "kilocode/server/custom-provider-save.ts"))).toBe(true)
    expect(existsSync(join(opencode, "kilocode/server/custom-provider-delete.ts"))).toBe(true)
  })
})
