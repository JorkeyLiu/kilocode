/**
 * $schema meta-key exclusion from GUI payloads and write-path filters.
 *
 * Audit F1/F2 completion: CLOSED_JSONC_FIELDS accepts `$schema`
 * (validation closure), but every consumer driving payload construction
 * or write-path filtering must exclude composition "meta" keys. Without
 * this alignment, backend-injected `$schema` bytes make
 * canonicalConfigPayload return {} (toCanonicalPayload rejects the key)
 * and the webview silently wipes all settings.
 *
 * Covers:
 * - Payload layer: scope docs containing $schema still produce full
 *   canonical payloads ($schema itself never appears in any payload)
 * - Write path: clean/unset defense-in-depth ignores $schema — a GUI
 *   patch carrying $schema never persists it and an explicit
 *   [["$schema"]] unset never removes the backend-owned value
 * - No regression for normal keys
 * - Unknown-key rejection unchanged
 */

import { afterEach, describe, expect, it } from "bun:test"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { KiloConnectionService } from "../../../src/services/cli-backend/connection-service"
import { CanonicalConfigService } from "../../../src/config/service"
import { Roots } from "../../../src/config/paths"
import { createMemorySecretAdapter } from "../../../src/config/secret-adapter"
import { createMemoryStateAdapter } from "../../../src/config/state-adapter"
import { toCanonicalPayload, type CanonicalStamp } from "../../../src/config/types"
import { isGuiField } from "../../../src/config/registry"

// vscode mock is provided by the shared preload (tests/setup/vscode-mock.ts)
const { KiloProvider } = await import("../../../src/KiloProvider")

const SCHEMA_URL = "https://app.kilo.ai/config.json"

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

type Internals = {
  postMessage: (message: unknown) => void
  fetchAndSendConfig: () => Promise<void>
  handleCanonicalConfigUpdate: (
    partial: Record<string, unknown>,
    projectPatch: Record<string, unknown>,
    globalUnset: string[][],
    projectUnset: string[][],
    saveID: string | undefined,
    stamp: CanonicalStamp,
  ) => Promise<void>
  dispose: () => void
}

/** Service + provider over real disk files whose global/project docs contain $schema. */
async function setupWithSchema() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-schema-payload-"))
  dirs.push(root)
  const global = path.join(root, "global")
  const project = path.join(root, "project")
  fs.mkdirSync(global, { recursive: true })
  fs.mkdirSync(path.join(project, ".kilo"), { recursive: true })
  fs.writeFileSync(path.join(global, "kilo.jsonc"), JSON.stringify({ $schema: SCHEMA_URL, model: "custom/model" }))
  fs.writeFileSync(path.join(project, ".kilo", "kilo.jsonc"), JSON.stringify({ $schema: SCHEMA_URL, permission: { bash: "allow" } }))
  const secrets = createMemorySecretAdapter()
  const canonical = new CanonicalConfigService({ secrets } as never, {
    roots: new Roots(project, global),
    secretAdapter: secrets,
    globalState: createMemoryStateAdapter(),
    workspaceState: createMemoryStateAdapter(),
  })
  await canonical.initialize()
  const connection = new KiloConnectionService({} as never)
  const provider = new KiloProvider({} as never, connection, undefined, { canonicalConfig: canonical })
  const messages: Record<string, unknown>[] = []
  const internal = provider as unknown as Internals
  internal.postMessage = (message) => messages.push(message as Record<string, unknown>)
  return { canonical, internal, messages, globalFile: path.join(global, "kilo.jsonc"), projectFile: path.join(project, ".kilo", "kilo.jsonc") }
}

describe("$schema excluded from GUI payloads", () => {
  it("returns full payloads when scope files contain $schema (audit F1)", async () => {
    const { canonical, internal, messages } = await setupWithSchema()
    await internal.fetchAndSendConfig()
    const msg = messages.find((m) => m.type === "configLoaded") as Record<string, unknown> | undefined
    expect(msg).toBeDefined()
    const config = msg!.config as Record<string, unknown>
    const globalConfig = msg!.globalConfig as Record<string, unknown>
    const projectConfig = msg!.projectConfig as Record<string, unknown>
    expect(config.model).toBe("custom/model")
    expect(globalConfig.model).toBe("custom/model")
    expect(projectConfig.permission).toEqual({ bash: "allow" })
    for (const payload of [config, globalConfig, projectConfig]) {
      expect(payload.$schema).toBeUndefined()
      expect(Object.keys(payload)).not.toContain("$schema")
    }
    internal.dispose()
    canonical.dispose()
  })

  it("payloads are unaffected when files contain no $schema (no regression)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-schema-clean-"))
    dirs.push(root)
    const global = path.join(root, "global")
    const project = path.join(root, "project")
    fs.mkdirSync(global, { recursive: true })
    fs.mkdirSync(path.join(project, ".kilo"), { recursive: true })
    fs.writeFileSync(path.join(global, "kilo.jsonc"), JSON.stringify({ model: "custom/model" }))
    const secrets = createMemorySecretAdapter()
    const canonical = new CanonicalConfigService({ secrets } as never, {
      roots: new Roots(project, global),
      secretAdapter: secrets,
      globalState: createMemoryStateAdapter(),
      workspaceState: createMemoryStateAdapter(),
    })
    await canonical.initialize()
    const connection = new KiloConnectionService({} as never)
    const provider = new KiloProvider({} as never, connection, undefined, { canonicalConfig: canonical })
    const messages: Record<string, unknown>[] = []
    const internal = provider as unknown as Internals
    internal.postMessage = (message) => messages.push(message as Record<string, unknown>)
    await internal.fetchAndSendConfig()
    const msg = messages.find((m) => m.type === "configLoaded") as Record<string, unknown>
    expect(msg.config).toMatchObject({ model: "custom/model" })
    expect(msg.globalConfig).toMatchObject({ model: "custom/model" })
    internal.dispose()
    canonical.dispose()
  })
})

describe("$schema ignored by write-path filters", () => {
  it("clean drops $schema from GUI patches instead of persisting it (audit F2)", async () => {
    const { canonical, internal, messages, globalFile, projectFile } = await setupWithSchema()
    await internal.handleCanonicalConfigUpdate(
      { $schema: "https://evil.example/injected.json", model: "custom/next" },
      { $schema: "https://evil.example/injected.json" },
      [],
      [],
      undefined,
      canonical.stamp,
    )
    const failed = messages.find((m) => m.type === "configUpdateFailed")
    expect(failed).toBeUndefined()
    const updated = messages.find((m) => m.type === "configUpdated") as Record<string, unknown> | undefined
    expect(updated).toBeDefined()
    // GUI-supplied $schema never reaches disk; the backend-owned URL survives
    const globalDoc = JSON.parse(fs.readFileSync(globalFile, "utf8"))
    const projectDoc = JSON.parse(fs.readFileSync(projectFile, "utf8"))
    expect(globalDoc.$schema).toBe(SCHEMA_URL)
    expect(projectDoc.$schema).toBe(SCHEMA_URL)
    // Normal keys in the same patch are applied
    expect(globalDoc.model).toBe("custom/next")
    const config = updated!.config as Record<string, unknown>
    expect(config.model).toBe("custom/next")
    internal.dispose()
    canonical.dispose()
  })

  it("unset paths targeting $schema are ignored", async () => {
    const { canonical, internal, messages, globalFile } = await setupWithSchema()
    await internal.handleCanonicalConfigUpdate(
      {},
      {},
      [["$schema"], ["model"]],
      [],
      undefined,
      canonical.stamp,
    )
    const updated = messages.find((m) => m.type === "configUpdated") as Record<string, unknown> | undefined
    expect(updated).toBeDefined()
    const globalDoc = JSON.parse(fs.readFileSync(globalFile, "utf8"))
    // Backend-owned $schema preserved despite explicit GUI unset request
    expect(globalDoc.$schema).toBe(SCHEMA_URL)
    expect(globalDoc.model).toBeUndefined()
    internal.dispose()
    canonical.dispose()
  })
})

describe("closure guarantees unchanged", () => {
  it("isGuiField excludes meta keys only", () => {
    expect(isGuiField("$schema")).toBe(false)
    expect(isGuiField("model")).toBe(true)
    expect(isGuiField("permission")).toBe(true)
    expect(isGuiField("instructions")).toBe(true)
    expect(isGuiField("server")).toBe(false)
    expect(isGuiField("$ref")).toBe(false)
  })

  it("unknown keys remain rejected at every layer", () => {
    expect(toCanonicalPayload({ server: {} })).toBeUndefined()
    expect(toCanonicalPayload({ compaction: {} })).toBeUndefined()
  })
})
