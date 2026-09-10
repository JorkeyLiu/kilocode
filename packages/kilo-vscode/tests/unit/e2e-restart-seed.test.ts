/**
 * Focused unit tests for the real-* global canonical root seed
 * (script/e2e-restart-seed.ts writeRealGlobalSeed): the no-op dependency
 * guard and the canonical agent .md assets ModeSwitcher serves post-S5
 * cutover. The agent assets must satisfy the repo's own strict agent
 * frontmatter validator — the same one CanonicalConfigService runs on disk.
 */

import { describe, expect, it } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import {
  REAL_AGENT_ASSETS,
  realProjectSeed,
  writeRealGlobalSeed,
  writeRealRestartSeed,
} from "../../script/e2e-restart-seed"
import { validateMarkdownAsset, validateConfig } from "../../src/config/validate"
import { materialize, MaterializeVersionCounter } from "../../src/config/materialize"
import { snapshot as makeSnapshot } from "../../src/config/snapshot"
import { buildProviderIndex } from "../../src/config/selectors"

describe("writeRealGlobalSeed", () => {
  it("seeds the dependency guard inside <scratch>/xdg-config/kilo", () => {
    const scratch = mkdtempSync(join(tmpdir(), "kilo-e2e-globalseed-"))
    try {
      const seed = writeRealGlobalSeed(scratch)
      expect(seed.configDir).toBe(join(scratch, "xdg-config", "kilo"))
      expect(existsSync(join(seed.configDir, "node_modules"))).toBe(true)
      const lock = JSON.parse(readFileSync(join(seed.configDir, "package-lock.json"), "utf8"))
      expect(lock.lockfileVersion).toBe(3)
      expect(lock.packages[""].dependencies["@kilocode/plugin"]).toBe("0.0.0")
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })

  it("writes agent assets whose ids match the ModeSwitcher fixture identities", () => {
    const scratch = mkdtempSync(join(tmpdir(), "kilo-e2e-globalseed-"))
    try {
      const seed = writeRealGlobalSeed(scratch)
      expect(seed.agentDir).toBe(join(seed.configDir, "agent"))
      const ids = seed.assetFiles.map((file) => basename(file).replace(/\.md$/, ""))
      expect(ids).toEqual(["e2e-agent", "e2e-agent-b"])
      for (const asset of REAL_AGENT_ASSETS) {
        expect(seed.assetFiles).toContain(join(seed.agentDir, `${asset.id}.md`))
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })

  it("agent assets pass the repo's strict agent validator with the expected labels", () => {
    const scratch = mkdtempSync(join(tmpdir(), "kilo-e2e-globalseed-"))
    try {
      const seed = writeRealGlobalSeed(scratch)
      expect(seed.assetFiles).toHaveLength(REAL_AGENT_ASSETS.length)
      for (const asset of REAL_AGENT_ASSETS) {
        const file = join(seed.agentDir, `${asset.id}.md`)
        const result = validateMarkdownAsset(readFileSync(file, "utf8"), "agent", file)
        expect(result.valid).toBe(true)
        expect(result.errors).toHaveLength(0)
        expect(result.data?.displayName).toBe(asset.displayName)
        expect(result.data?.mode).toBe("primary")
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })
})

describe("realProjectSeed (project-scope canonical kilo.jsonc)", () => {
  const PORT = 45659

  function writeAndRead(): { scratch: string; workspace: string; canonicalFile: string; text: string } {
    const scratch = mkdtempSync(join(tmpdir(), "kilo-e2e-seed-"))
    const workspace = join(scratch, "workspace")
    const seed = writeRealRestartSeed(workspace, PORT, "file:///tmp/kilo-e2e-fake-plugin", scratch)
    const text = readFileSync(seed.canonicalFile, "utf8")
    return { scratch, workspace, canonicalFile: seed.canonicalFile, text }
  }

  it("writes <workspace>/.kilo/kilo.jsonc with no legacy kilo.json or global provider file", () => {
    const { scratch, workspace, canonicalFile } = writeAndRead()
    try {
      expect(canonicalFile).toBe(join(workspace, ".kilo", "kilo.jsonc"))
      expect(existsSync(canonicalFile)).toBe(true)
      expect(existsSync(join(workspace, ".kilo", "kilo.json"))).toBeFalse()
      expect(existsSync(join(scratch, "xdg-config", "kilo", "kilo.jsonc"))).toBeFalse()
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })

  it("parses and validates cleanly through the repo's closed project-scope validator", () => {
    const { scratch, canonicalFile, text } = writeAndRead()
    try {
      const result = validateConfig(text, "project", canonicalFile)
      expect(result.errors).toEqual([])
      expect(result.valid).toBe(true)
      const parsed = result.parsed as { model: string; provider: Record<string, Record<string, unknown>> }
      expect(parsed.model).toBe("e2e-local/e2e-model")
      const provider = parsed.provider["e2e-local"]
      expect(provider.endpoint).toBe(`http://127.0.0.1:${PORT}/v1`)
      expect(provider.protocol).toBe("openai/completions")
      expect(provider.credential).toBe("secret:kilo.credentials.project.provider.e2e-local")
      // Closed shape — no plaintext credential material in canonical JSONC
      expect(provider.apiKey).toBeUndefined()
      expect((provider as Record<string, unknown>).options).toBeUndefined()
      expect((provider as Record<string, unknown>).baseURL).toBeUndefined()
      // Secret value itself never appears in canonical JSONC (SecretStorage owns the value)
      expect(text).not.toContain("e2e-fixture-key")
      expect(text).toContain("secret:kilo.credentials.project.provider.e2e-local")
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })

  it("smoke: the seeded provider/model are visible in the derived selector indexes", () => {
    const { scratch, workspace, canonicalFile, text } = writeAndRead()
    try {
      const validation = validateConfig(text, "project", canonicalFile)
      expect(validation.valid).toBe(true)
      const result = materialize(
        {
          global: null,
          project: {
            scope: "project",
            root: workspace,
            raw: validation.parsed!,
            provenance: { scope: "project", canonicalPath: canonicalFile, explicit: true, operator: "single" },
          },
          versionCounter: new MaterializeVersionCounter(),
        },
        null,
      )
      expect(result.errors).toEqual([])
      const index = buildProviderIndex(makeSnapshot(result.config), null)
      const entry = index.providers.find((p) => p.id === "e2e-local")
      expect(entry).toBeDefined()
      expect(entry!.modelIds).toContain("e2e-model")
      expect(entry!.displayName).toBe("E2E Local")
      expect(entry!.modelLabels["e2e-model"]).toBe("E2E Model")
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })

  it("rejects a legacy-shaped entry (baseURL/apiKey) — the seed must stay canonical", () => {
    const legacy = realProjectSeed(PORT) as { provider: Record<string, Record<string, unknown>> }
    legacy.provider["e2e-local"].baseURL = `http://127.0.0.1:${PORT}/v1`
    const result = validateConfig(JSON.stringify(legacy), "project", "/tmp/fake/kilo.jsonc")
    expect(result.valid).toBe(false)
    expect(result.errors.length).toBeGreaterThan(0)
  })

  it("requires absolute scratch", () => {
    const workspace = join(tmpdir(), "ws-req")
    expect(() => writeRealRestartSeed(workspace, PORT, "file:///tmp/x", "" as unknown as string)).toThrow(
      /absolute scratch/,
    )
    expect(() => writeRealRestartSeed(workspace, PORT, "file:///tmp/x", "relative" as unknown as string)).toThrow(
      /absolute scratch/,
    )
  })
})
