/**
 * P4.1 Config Foundation — Integration tests.
 *
 * End-to-end tests covering the full flow:
 * - Parse JSONC → validate → compose → materialize
 * - Parse markdown asset → validate → round-trip
 * - Stale write detection across full flow
 * - Cross-scope composition with conflict detection
 * - F12: writeJsonc and atomicWrite are private; public API validates
 */

import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { Roots, resolveCanonicalPaths } from "../../../src/config/paths"
import { parseJsonc, contentHash } from "../../../src/config/parse"
import { validateConfig, validateMarkdownAsset, validateCrossScope } from "../../../src/config/validate"
import { composeAll } from "../../../src/config/compose"
import { materialize, resetVersion } from "../../../src/config/materialize"
import { writeJsoncWithConflictDetection, editJsonc, unsetKey } from "../../../src/config/write"
import { getAllEntries } from "../../../src/config/registry"
import type { ScopedContent, ProvenanceStamp } from "../../../src/config/types"

const VALID_MODEL = "anthropic/claude-sonnet-4-20250514"

let tempDir: string

function setup() {
  tempDir = mkdtempSync(join(tmpdir(), "config-integration-test-"))
  return tempDir
}

function cleanup() {
  rmSync(tempDir, { recursive: true, force: true })
}

function makeScope(scope: "global" | "project", raw: Record<string, unknown>): ScopedContent {
  return {
    scope,
    root: scope === "global" ? join(tempDir, "global") : join(tempDir, "project"),
    raw,
    provenance: {
      scope,
      canonicalPath: `${scope}:${scope === "global" ? join(tempDir, "global") : join(tempDir, "project")}/kilo.jsonc`,
      operator: "single",
      explicit: true,
    },
  }
}

beforeEach(() => {
  setup()
  resetVersion()
})

afterEach(cleanup)

describe("full parse → validate → compose → materialize flow", () => {
  it("processes valid config end-to-end", () => {
    const jsoncText = `{
  // Default model
  "model": "${VALID_MODEL}",
  "provider": {
    "myprovider": {
      "endpoint": "https://my-api.example.com",
      "protocol": "openai",
      "models": { "gpt-4": { "name": "GPT-4" }, "gpt-3.5-turbo": { "name": "GPT-3.5 Turbo" } }
    }
  },
  "permission": {
    "read": "allow",
    "write": "ask"
  }
}`

    // Parse
    const parsed = parseJsonc(jsoncText)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return

    // Validate
    const validation = validateConfig(jsoncText, "global", "global/kilo.jsonc")
    expect(validation.valid).toBe(true)
    expect(validation.errors).toHaveLength(0)

    // Compose
    const scope = makeScope("global", parsed.value)
    const { fields, conflicts } = composeAll(getAllEntries(), scope, null)
    expect(conflicts).toHaveLength(0)
    expect(fields.length).toBeGreaterThanOrEqual(3)

    // Materialize
    const result = materialize({ global: scope, project: null })
    expect(result.errors).toHaveLength(0)
    expect(result.config.value.model).toBe(VALID_MODEL)
    expect(result.config.schemaVersion).toBe(1)
  })

  it("rejects config with unknown keys at parse stage", () => {
    const jsoncText = `{
  "model": "${VALID_MODEL}",
  "server": { "port": 3000 }
}`

    const validation = validateConfig(jsoncText, "global", "test")
    expect(validation.valid).toBe(false)
    expect(validation.errors.some((e) => e.message.includes("Unknown"))).toBe(true)
  })

  it("rejects config with plaintext credentials", () => {
    const jsoncText = `{
  "provider": {
    "openai": {
      "apiKey": "sk-1234567890"
    }
  }
}`

    const validation = validateConfig(jsoncText, "global", "test")
    expect(validation.valid).toBe(false)
    expect(validation.errors.some((e) => e.message.includes("Plaintext"))).toBe(true)
  })
})

describe("cross-scope composition with conflicts", () => {
  it("detects model conflict across scopes", () => {
    const global = makeScope("global", { model: "global/model" })
    const project = makeScope("project", { model: "project/model" })

    const result = materialize({ global, project })
    expect(result.errors.length).toBeGreaterThanOrEqual(1)
    const modelError = result.errors.find((e) => e.path[0] === "model")
    expect(modelError).toBeDefined()
  })

  it("detects provider ID conflict across scopes", () => {
    const global = makeScope("global", {
      provider: { openai: { endpoint: "https://api.openai.com" } },
    })
    const project = makeScope("project", {
      provider: { openai: { endpoint: "https://other.com" } },
    })

    const result = materialize({ global, project })
    expect(result.errors.length).toBeGreaterThanOrEqual(1)
    const providerError = result.errors.find(
      (e) => e.path[0] === "provider" && e.path[1] === "openai",
    )
    expect(providerError).toBeDefined()
  })

  it("allows different provider IDs across scopes", () => {
    const global = makeScope("global", {
      provider: { openai: { endpoint: "https://api.openai.com" } },
    })
    const project = makeScope("project", {
      provider: { anthropic: { endpoint: "https://api.anthropic.com" } },
    })

    const result = materialize({ global, project })
    expect(result.errors).toHaveLength(0)
    const providers = result.config.value.provider as Record<string, unknown>
    expect(providers.openai).toBeDefined()
    expect(providers.anthropic).toBeDefined()
  })
})

// ── P4.1 regression: composite writes must preflight single-field conflicts ──

describe("validateCrossScope single-field conflict detection", () => {
  it("returns conflict when model is explicit in both scopes", () => {
    const errors = validateCrossScope(
      { model: "global/model" },
      { model: "project/model" },
    )
    expect(errors).toHaveLength(1)
    expect(errors[0].path).toEqual(["model"])
    expect(errors[0].message).toContain("Conflicting")
  })

  it("returns conflict when subagent_model is explicit in both scopes", () => {
    const errors = validateCrossScope(
      { subagent_model: "global/sub" },
      { subagent_model: "project/sub" },
    )
    expect(errors).toHaveLength(1)
    expect(errors[0].path).toEqual(["subagent_model"])
    expect(errors[0].message).toContain("Conflicting")
  })

  it("returns no conflict when model is in only one scope", () => {
    const errors = validateCrossScope(
      { model: "global/model" },
      {},
    )
    expect(errors).toHaveLength(0)
  })

  it("returns no conflict when subagent_model is in only one scope", () => {
    const errors = validateCrossScope(
      {},
      { subagent_model: "project/sub" },
    )
    expect(errors).toHaveLength(0)
  })

  it("returns multiple conflicts for both model and subagent_model", () => {
    const errors = validateCrossScope(
      { model: "global/model", subagent_model: "global/sub" },
      { model: "project/model", subagent_model: "project/sub" },
    )
    expect(errors).toHaveLength(2)
    const paths = errors.map((e) => e.path[0])
    expect(paths).toContain("model")
    expect(paths).toContain("subagent_model")
  })

  it("returns keyed conflict alongside single conflict", () => {
    const errors = validateCrossScope(
      { model: "global/model", provider: { openai: { endpoint: "https://g.com" } } },
      { model: "project/model", provider: { openai: { endpoint: "https://p.com" } } },
    )
    expect(errors.length).toBeGreaterThanOrEqual(2)
    const paths = errors.map((e) => e.path.join("."))
    expect(paths).toContain("model")
    expect(paths).toContain("provider.openai")
  })

  it("valid global-only composite is not rejected", () => {
    const errors = validateCrossScope(
      { model: "global/model" },
      {},
    )
    expect(errors).toHaveLength(0)
  })

  it("valid project-only composite is not rejected", () => {
    const errors = validateCrossScope(
      {},
      { model: "project/model" },
    )
    expect(errors).toHaveLength(0)
  })

  it("workspace two-scope nonconflicting does not error", () => {
    const errors = validateCrossScope(
      { provider: { openai: { endpoint: "https://g.com" } } },
      { provider: { anthropic: { endpoint: "https://p.com" } } },
    )
    expect(errors).toHaveLength(0)
  })
})

describe("markdown asset round-trip", () => {
  it("parses and validates agent asset", () => {
    const text = `---
name: code-reviewer
displayName: Code Reviewer
description: Reviews code for quality and security
model: ${VALID_MODEL}
variant: thinking
tools:
  read: true
  grep: true
permission:
  read: allow
  write: deny
requirements:
  skills:
    - bun
hidden: false
maxSteps: 20
mode: subagent
---
You are a code reviewer. Analyze the code for:
- Security vulnerabilities
- Performance issues
- Code style violations`

    const result = validateMarkdownAsset(text, "agent", "code-reviewer.md")
    expect(result.valid).toBe(true)
    expect(result.data).toBeDefined()
    expect(result.data!.name).toBe("code-reviewer")
    expect(result.data!.model).toBe(VALID_MODEL)
    expect(result.data!.tools).toEqual({ read: true, grep: true })
    expect(result.data!.permission).toEqual({ read: "allow", write: "deny" })
    expect(result.content).toContain("You are a code reviewer")
  })

  it("parses and validates command asset", () => {
    const text = `---
name: explain-code
description: Explain selected code
agent: code-explainer
model: ${VALID_MODEL}
---
Explain the following code:

\`\`\`
{{selection}}
\`\`\`

Provide a clear, concise explanation.`

    const result = validateMarkdownAsset(text, "command", "explain-code.md")
    expect(result.valid).toBe(true)
    expect(result.data!.name).toBe("explain-code")
    expect(result.content).toContain("Explain the following code")
  })
})

describe("write and read round-trip", () => {
  it("writes and reads back JSONC via public API with validation", () => {
    const filePath = join(tempDir, "kilo.jsonc")
    const config = {
      model: VALID_MODEL,
      provider: {
        myprovider: {
          endpoint: "https://my-api.example.com",
        },
      },
    }

    // Use writeJsoncWithConflictDetection — the validated public API
    // Create file first so stale check passes
    const content = JSON.stringify(config, null, 2) + "\n"
    writeFileSync(filePath, content)
    const hash = contentHash(content)
    const result = writeJsoncWithConflictDetection(filePath, config, hash, "global")
    expect("written" in result).toBe(true)
    expect(existsSync(filePath)).toBe(true)

    const fileContent = readFileSync(filePath, "utf-8")
    const parsed = parseJsonc(fileContent)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.value.model).toBe(VALID_MODEL)
    }
  })

  it("unset removes key and detects stale writes", () => {
    const filePath = join(tempDir, "kilo.jsonc")
    const initial = JSON.stringify({ model: VALID_MODEL, default_agent: "code" }, null, 2) + "\n"
    writeFileSync(filePath, initial)
    const hash = contentHash(initial)

    // Successful unset
    const result = unsetKey(filePath, "model", hash, "global")
    expect("written" in result).toBe(true)

    // Stale detection
    writeFileSync(filePath, '{"model": "openai/gpt-4"}')
    const staleResult = unsetKey(filePath, "model", hash, "global")
    expect("conflict" in staleResult).toBe(true)
  })
})

describe("invalid edit preserves exact prior", () => {
  it("on conflict, returns exact prior materialization", () => {
    const validGlobal = makeScope("global", { model: VALID_MODEL })
    const validResult = materialize({ global: validGlobal, project: null })
    expect(validResult.errors).toHaveLength(0)

    // Now create a conflicting edit
    const conflictingGlobal = makeScope("global", { model: "openai/gpt-4" })
    const conflictingProject = makeScope("project", { model: "openai/gpt-4" })
    const conflictResult = materialize(
      { global: conflictingGlobal, project: conflictingProject },
      validResult.config,
    )

    // Must return exact prior
    expect(conflictResult.config).toBe(validResult.config)
    expect(conflictResult.config.value.model).toBe(VALID_MODEL)
    expect(conflictResult.config.contentHash).toBe(validResult.config.contentHash)
  })
})

describe("F12: public API enforces validation", () => {
  it("editJsonc rejects unknown keys after patch", () => {
    const filePath = join(tempDir, "kilo.jsonc")
    const initial = JSON.stringify({ model: VALID_MODEL }, null, 2) + "\n"
    writeFileSync(filePath, initial)
    const hash = contentHash(initial)

    expect(() => {
      editJsonc(
        filePath,
        (current) => ({ ...current, server: { port: 3000 } }),
        hash,
        "global",
      )
    }).toThrow("Config validation failed")
  })

  it("editJsonc rejects invalid model format after patch", () => {
    const filePath = join(tempDir, "kilo.jsonc")
    const initial = JSON.stringify({ model: VALID_MODEL }, null, 2) + "\n"
    writeFileSync(filePath, initial)
    const hash = contentHash(initial)

    expect(() => {
      editJsonc(
        filePath,
        (current) => ({ ...current, model: "bad" }),
        hash,
        "global",
      )
    }).toThrow("Config validation failed")
  })

  it("writeJsoncWithConflictDetection rejects plaintext credentials", () => {
    const filePath = join(tempDir, "kilo.jsonc")
    const initial = JSON.stringify({ model: VALID_MODEL }, null, 2) + "\n"
    writeFileSync(filePath, initial)
    const hash = contentHash(initial)

    expect(() => {
      writeJsoncWithConflictDetection(
        filePath,
        { provider: { openai: { apiKey: "sk-123" } } },
        hash,
        "global",
      )
    }).toThrow("Config validation failed")
  })
})
