import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

// P3.4 (LOCK-004/005/014/015): codebase indexing, project memory, user-visible
// context/compaction, autocomplete (FIM), and commit-message generation are
// permanent removals. Invisible automatic overflow recovery remains (LOCK-005)
// with no manual/configurable product surface. These static guards assert
// structural absence across the shared tree: removed HTTP groups/handlers,
// config keys, CLI/TUI surfaces, the deleted kilo-indexing/kilo-memory
// packages, the regenerated SDK, and the dependency graph — while preserving
// every retained collision (generic recall/search, automatic CompactionPart
// types/events required by H-13, custom-provider APIs, session export, the
// migration bridge, revert/snapshot, checkpoint APIs).
const opencode = join(import.meta.dir, "../../src")
const sdk = join(import.meta.dir, "../../../sdk/js/src/v2/gen")
const core = join(import.meta.dir, "../../../core")

function read(path: string): string {
  return readFileSync(path, "utf8")
}

describe("P3.4 indexing + memory + autocomplete + commit-message structural absence", () => {
  test("deleted packages are absent from the workspace source tree", () => {
    const indexing = join(import.meta.dir, "../../../kilo-indexing")
    const memory = join(import.meta.dir, "../../../kilo-memory")
    expect(existsSync(indexing)).toBe(false)
    expect(existsSync(memory)).toBe(false)
  })

  test("removed HTTP route groups and handlers are gone", () => {
    const groups = join(opencode, "kilocode/server/httpapi/groups")
    const handlers = join(opencode, "kilocode/server/httpapi/handlers")
    for (const stale of ["commit-message", "indexing", "memory"]) {
      expect(existsSync(join(groups, `${stale}.ts`))).toBe(false)
      expect(existsSync(join(handlers, `${stale}.ts`))).toBe(false)
    }
    // No stale imports of the deleted groups remain anywhere in the server layer.
    for (const dir of [groups, handlers, join(opencode, "server/routes/instance/httpapi")]) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
          const src = read(join(dir, entry.name))
          expect(src, `${entry.name} still imports a removed route group`).not.toContain("httpapi/groups/commit-message")
          expect(src, `${entry.name} still imports a removed route group`).not.toContain("httpapi/groups/indexing")
          expect(src, `${entry.name} still imports a removed route group`).not.toContain("httpapi/groups/memory")
        }
      }
    }
  })

  test("no removed HTTP routes or resources are registered or referenced", () => {
    const api = read(join(opencode, "server/routes/instance/httpapi/api.ts"))
    const publicApi = read(join(opencode, "server/routes/instance/httpapi/public.ts"))
    const kiloPublic = read(join(opencode, "kilocode/server/httpapi/public.ts"))
    for (const src of [api, publicApi, kiloPublic]) {
      expect(src).not.toContain("/commit-message")
      expect(src).not.toContain("/indexing")
      expect(src).not.toContain("/memory/")
      expect(src).not.toContain("/kilo/fim")
      expect(src).not.toContain("/kilo/edit")
    }
  })

  test("removed config keys are gone from the shared core and kilocode config", () => {
    const coreCfg = read(join(core, "src/v1/config/config.ts"))
    const kiloCfg = read(join(opencode, "kilocode/config/config.ts"))
    const genCfg = read(join(opencode, "config/config.ts"))
    for (const cfg of [coreCfg, kiloCfg, genCfg]) {
      // Assert on the schema-field forms so comments ("...in memory:") do not
      // create false collisions.
      expect(cfg).not.toContain("commit_message: CommitMessageSchema")
      expect(cfg).not.toContain("indexing: Schema.optional(IndexingRef)")
      expect(cfg).not.toContain("memory: Schema.")
      expect(cfg).not.toContain('"memory":')
    }
    // Retained config collisions survive.
    expect(coreCfg).toContain("compaction:")
  })

  test("retired config keys are stripped during migration/load (LOCK-005 no configurable surface)", () => {
    const genCfg = read(join(opencode, "config/config.ts"))
    expect(genCfg).toContain('if ("indexing" in copy)')
    expect(genCfg).toContain("codebase indexing was removed")
  })

  test("config overlay exposes no indexing fieldPaths", () => {
    const overlay = read(join(opencode, "kilocode/config/overlay.ts"))
    expect(overlay).not.toContain('["indexing"')
    expect(overlay).not.toContain('"vectorStore"')
    expect(overlay).not.toContain("isIndexing")
  })

  test("dead public-schema IndexingConfig handling is gone", () => {
    const publicApi = read(join(opencode, "server/routes/instance/httpapi/public.ts"))
    expect(publicApi).not.toContain("IndexingConfig")
    expect(publicApi).not.toContain("indexing config patches")
  })

  test("LanceDB runtime, install test, and build wiring are gone (removed env flag)", () => {
    for (const stale of ["kilocode/lancedb.ts", "test/kilocode/lancedb-runtime.test.ts"]) {
      expect(existsSync(join(opencode, stale))).toBe(false)
    }
    const build = read(join(import.meta.dir, "../../script/build.ts"))
    expect(build).not.toContain("LanceDBRuntime")
    expect(build).not.toContain("lancedb")
    // No removed vector-store env flag anywhere in the remaining runtime source.
    for (const relative of [
      "config/config.ts",
      "kilocode/config/config.ts",
      "kilocode/config/overlay.ts",
      "kilocode/session/overflow.ts",
      "session/compaction.ts",
      "effect/app-runtime.ts",
    ]) {
      expect(read(join(opencode, relative)), `${relative} still references KILO_LANCEDB_PATH`).not.toContain(
        "KILO_LANCEDB_PATH",
      )
    }
  })

  test("build script has no indexing-worker entry, path define, or output (LOCK-004/PERF-3)", () => {
    const build = read(join(import.meta.dir, "../../script/build.ts"))
    expect(build, "build script still defines indexingWorkerPath").not.toContain("indexingWorkerPath")
    expect(build, "build script still references KILO_INDEXING_WORKER_PATH").not.toContain("KILO_INDEXING_WORKER_PATH")
    expect(build, "build script still includes indexing-worker.ts in entrypoints").not.toContain("indexing-worker.ts")
    expect(build, "build script still outputs indexing-worker").not.toContain("indexing-worker")
  })

  test("user-triggered compact/summarize builtins are gone", () => {
    expect(existsSync(join(opencode, "kilocode/session/builtin-commands.ts"))).toBe(false)
    const run = read(join(opencode, "kilocode/cli/cmd/run.ts"))
    expect(run).not.toContain("resolveBuiltin")
    expect(run).not.toContain("runBuiltin")
    const prompt = read(join(opencode, "session/prompt.ts"))
    expect(prompt).not.toContain("builtin-commands")
    expect(prompt).not.toContain("BUILTIN_COMMANDS")
  })

  test("/session/{sessionID}/summarize route, schema, and handler are gone", () => {
    const groups = read(join(opencode, "server/routes/instance/httpapi/groups/session.ts"))
    const handlers = read(join(opencode, "server/routes/instance/httpapi/handlers/session.ts"))
    expect(groups).not.toContain("summarize")
    expect(groups).not.toContain("SummarizePayload")
    expect(handlers).not.toContain("summarize")
    expect(handlers).not.toContain("SummarizePayload")
    expect(handlers).not.toContain("SessionCompaction")
    // Remaining RoutePath keys are retained endpoints only.
    for (const stale of ["SessionPaths.summarize"]) expect(groups).not.toContain(stale)
  })

  test("v2 compact placeholder route and service operation are gone", () => {
    const v2Groups = join(import.meta.dir, "../../../server/src/groups/v2/session.ts")
    const v2Handlers = join(import.meta.dir, "../../../server/src/handlers/v2/session.ts")
    for (const stale of [v2Groups, v2Handlers]) {
      const src = read(stale)
      expect(src).not.toContain("v2.session.compact")
      expect(src).not.toContain('"/api/session/:sessionID/compact"')
    }
    const coreSession = join(core, "src/session.ts")
    const coreSrc = read(coreSession)
    expect(coreSrc).not.toContain("readonly compact:")
    expect(coreSrc).not.toContain("V2Session.compact")
    expect(coreSrc).not.toContain("CompactInput")
    // Retained v2 wait placeholder stays.
    expect(coreSrc).toContain("V2Session.wait")
  })

  test("CLI/TUI compact keybind, command palette entry, and tips are gone", () => {
    const keybind = read(join(opencode, "cli/cmd/tui/config/keybind.ts"))
    const event = read(join(opencode, "cli/cmd/tui/event.ts"))
    const tuiHandler = read(join(opencode, "server/routes/instance/httpapi/handlers/tui.ts"))
    const sessionRoute = read(join(opencode, "cli/cmd/tui/routes/session/index.tsx"))
    for (const src of [keybind, event, tuiHandler]) {
      expect(src).not.toContain("session.compact")
    }
    expect(sessionRoute).not.toContain("Compact session")
    expect(sessionRoute).not.toContain("aliases: [\"summarize\"]")
    for (const stale of [
      "kilocode/components/tips.tsx",
      "kilocode/cli/cmd/tui/feature-plugins/home/tips.ts",
      "cli/cmd/tui/feature-plugins/home/tips-view.tsx",
    ]) {
      expect(read(join(opencode, stale))).not.toContain("/compact")
    }
  })

  test("orphaned gateway embedding catalog, export, and tests are gone", () => {
    const gateway = join(import.meta.dir, "../../../kilo-gateway")
    expect(existsSync(join(gateway, "src/api/embedding-models.ts"))).toBe(false)
    expect(existsSync(join(gateway, "test/api/embedding-models.test.ts"))).toBe(false)
    const index = read(join(gateway, "src/index.ts"))
    expect(index).not.toContain("fetchKiloEmbeddingModelCatalog")
    expect(index).not.toContain("KiloEmbeddingModel")
    const urlTest = read(join(gateway, "test/api/url.test.ts"))
    expect(urlTest).not.toContain("embedding-models")
  })

  test("automatic overflow recovery and CompactionPart semantics are retained", () => {
    // LOCK-005: invisible automatic overflow compaction remains.
    const overflow = read(join(opencode, "kilocode/session/overflow.ts"))
    expect(overflow).toContain("automatic")
    const compaction = read(join(opencode, "session/compaction.ts"))
    expect(compaction).toContain("CompactionPart")
    expect(compaction).toContain("isOverflow")
    // Automatic overflow tests survive.
    expect(existsSync(join(import.meta.dir, "session-overflow.test.ts"))).toBe(true)
  })

  test("CLI/TUI indexing and memory surfaces are absent", () => {
    const kiloApp = read(join(opencode, "kilocode/cli/cmd/tui/app.tsx"))
    const commands = read(join(opencode, "kilocode/kilo-commands.tsx"))
    const kiloIndex = join(opencode, "kilocode/indexing.ts")
    const memoryDir = join(opencode, "kilocode/memory")
    expect(() => readFileSync(kiloIndex, "utf8")).toThrow()
    expect(existsSync(memoryDir)).toBe(false)
    for (const src of [kiloApp, commands]) {
      expect(src).not.toContain("memory-prompt")
      expect(src).not.toContain("memory-status")
      expect(src).not.toContain("indexing-warning")
      expect(src).not.toContain("dialog-indexing")
    }
  })

  test("removed tools are unregistered and absent from the source tree", () => {
    const toolDir = join(opencode, "kilocode/tool")
    for (const stale of ["memory-recall", "memory-save", "semantic-search"]) {
      expect(existsSync(join(toolDir, `${stale}.ts`))).toBe(false)
    }
    const registry = read(join(opencode, "kilocode/tool/registry.ts"))
    expect(registry).not.toContain("memory-recall")
    expect(registry).not.toContain("memory-save")
    expect(registry).not.toContain("semantic-search")
  })

  test("regenerated SDK removes all deleted route groups and config types", () => {
    const sdkFile = read(join(sdk, "sdk.gen.ts"))
    const typesFile = read(join(sdk, "types.gen.ts"))
    for (const stale of [
      "/commit-message",
      "/indexing/status",
      "/indexing/warnings",
      "/indexing/models",
      "/kilo/fim",
      "/kilo/edit",
      "/memory/status",
      "/memory/show",
      "/memory/enable",
      "/memory/disable",
      "/memory/configure",
      "/memory/rebuild",
      "/memory/remember",
      "/memory/correct",
      "/memory/forget",
      "/memory/purge",
    ]) {
      expect(sdkFile, `SDK still exposes stale route ${stale}`).not.toContain(stale)
    }
    for (const stale of ["Indexing", "CommitMessage", "MemoryStatus", "MemoryConfig"]) {
      expect(typesFile, `SDK types still reference ${stale}`).not.toContain(stale)
    }
  })

  test("generated OpenAPI spec removes the deleted route groups", () => {
    const spec = read(join(import.meta.dir, "../../../sdk/openapi.json"))
    for (const stale of ["/kilo/fim", "/kilo/edit", "/commit-message", "/indexing/", "/memory/"]) {
      expect(spec, `openapi.json still contains ${stale}`).not.toContain(stale)
    }
  })

  test("retained H-13 / custom-provider / migration-bridge / revert collisions survive", () => {
    const sdkFile = read(join(sdk, "sdk.gen.ts"))
    const typesFile = read(join(sdk, "types.gen.ts"))
    // H-13 automatic compaction types/events.
    expect(typesFile).toContain("CompactionPart")
    // Revert/snapshot (LOCK-007/008).
    expect(sdkFile).toContain("/session/{sessionID}/revert")
    expect(sdkFile).toContain("/session/{sessionID}/unrevert")
    // Custom-provider APIs (LOCK-006).
    expect(sdkFile).toContain("/custom-provider/{providerID}/save")
    expect(sdkFile).toContain("/custom-provider/{providerID}/delete")
    // Migration bridge.
    expect(sdkFile).toContain("/kilocode/session-import/session")
    // Generic session endpoints survive.
    expect(sdkFile).toContain("/session/{sessionID}/message")
    // CompactionPart survives in the opencode session source for H-13.
    const compaction = read(join(opencode, "session/compaction.ts"))
    expect(compaction).toContain("CompactionPart")
  })
})
