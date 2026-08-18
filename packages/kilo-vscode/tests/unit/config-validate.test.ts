/**
 * P4.1 Config foundation — validation tests.
 *
 * Tests strict validation of JSONC configs and markdown assets
 * against the closed registry, including unknown key rejection,
 * scope validation, credential rejection, and cross-scope conflicts.
 */

import { describe, expect, it } from "bun:test"
import { validateConfig, validateMarkdownAsset, validateCrossScope } from "../../src/config/validate"

describe("validateConfig", () => {
  describe("valid configs", () => {
    it("accepts valid global config", () => {
      const raw = '{"model": "anthropic/claude-sonnet"}'
      const result = validateConfig(raw, "global", "test.jsonc")
      expect(result.valid).toBe(true)
      expect(result.errors).toHaveLength(0)
      expect(result.parsed).toBeDefined()
    })

    it("accepts valid project config", () => {
      const raw = '{"model": "anthropic/claude-sonnet-4-20250514", "permission": {"read": "allow"}}'
      const result = validateConfig(raw, "project", "test.jsonc")
      expect(result.valid).toBe(true)
    })

    it("accepts empty config", () => {
      const result = validateConfig("{}", "global", "test.jsonc")
      expect(result.valid).toBe(true)
    })
  })

  describe("JSONC parse errors", () => {
    it("rejects invalid JSONC", () => {
      const result = validateConfig("{invalid", "global", "test.jsonc")
      expect(result.valid).toBe(false)
      expect(result.errors[0].message).toContain("JSONC parse error")
    })

    it("rejects non-object root", () => {
      const result = validateConfig('"string"', "global", "test.jsonc")
      expect(result.valid).toBe(false)
    })
  })

  describe("unknown key rejection", () => {
    it("rejects unknown keys", () => {
      const raw = '{"model": "test", "unknown_field": "value"}'
      const result = validateConfig(raw, "global", "test.jsonc")
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.message.includes("Unknown config key"))).toBe(true)
    })

    it("rejects deprecated/removed keys", () => {
      const raw = '{"model": "test", "compaction": true}'
      const result = validateConfig(raw, "global", "test.jsonc")
      expect(result.valid).toBe(false)
    })

    it("rejects removed keys (agent, command, shell, etc.)", () => {
      const raw = '{"model": "test", "agent": {}}'
      const result = validateConfig(raw, "global", "test.jsonc")
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.message.includes("Unknown config key"))).toBe(true)
    })
  })

  describe("scope validation", () => {
    it("rejects unknown keys in project scope", () => {
      const raw = '{"unknown_key": "value"}'
      const result = validateConfig(raw, "project", "test.jsonc")
      expect(result.valid).toBe(false)
    })

    it("accepts valid model in global scope", () => {
      const raw = '{"model": "anthropic/claude-sonnet-4-20250514"}'
      const result = validateConfig(raw, "global", "test.jsonc")
      expect(result.valid).toBe(true)
    })
  })

  describe("plaintext credential rejection", () => {
    it("rejects plaintext apiKey in provider options", () => {
      const raw = JSON.stringify({
        provider: {
          "my-provider": {
            options: { apiKey: "sk-test-123" },
          },
        },
      })
      const result = validateConfig(raw, "global", "test.jsonc")
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.message.includes("Plaintext credential"))).toBe(true)
    })

    it("accepts provider without apiKey", () => {
      const raw = JSON.stringify({
        provider: {
          "my-provider": {
            endpoint: "https://example.com/v1",
          },
        },
      })
      const result = validateConfig(raw, "global", "test.jsonc")
      expect(result.valid).toBe(true)
    })

    it("rejects provider with apiKey field (legacy, not canonical)", () => {
      const raw = JSON.stringify({
        provider: {
          "my-provider": {
            apiKey: "",
          },
        },
      })
      const result = validateConfig(raw, "global", "test.jsonc")
      expect(result.valid).toBe(false)
    })
  })

  describe("error provenance", () => {
    it("includes file path in errors", () => {
      const raw = '{"unknown_key": "value"}'
      const result = validateConfig(raw, "global", "/path/to/config.jsonc")
      expect(result.errors[0].file).toBe("/path/to/config.jsonc")
    })
  })
})

describe("validateMarkdownAsset", () => {
  describe("agent assets", () => {
    it("accepts valid agent frontmatter", () => {
      const raw = `---
name: code
model: anthropic/claude-sonnet-4-20250514
hidden: false
---
Agent prompt.`
      const result = validateMarkdownAsset(raw, "agent", "agent.md")
      expect(result.valid).toBe(true)
      expect(result.data).toBeDefined()
      expect(result.content).toBe("Agent prompt.")
    })
  })

  describe("command assets", () => {
    it("accepts valid command frontmatter", () => {
      const raw = `---
description: Run tests
agent: code
---
/test suite`
      const result = validateMarkdownAsset(raw, "command", "command.md")
      expect(result.valid).toBe(true)
    })

    it("rejects commands without template body", () => {
      const raw = `---
description: Empty command
---`
      const result = validateMarkdownAsset(raw, "command", "command.md")
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.message.includes("non-empty template body"))).toBe(true)
    })
  })
})

describe("validateCrossScope", () => {
  it("detects duplicate provider IDs across scopes", () => {
    const global = { provider: { anthropic: { name: "Anthropic" } } }
    const project = { provider: { anthropic: { name: "Override" } } }
    const errors = validateCrossScope(global, project)
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0].message).toContain("Duplicate keyed ID")
  })

  it("allows different provider IDs across scopes", () => {
    const global = { provider: { anthropic: { name: "Anthropic" } } }
    const project = { provider: { openai: { name: "OpenAI" } } }
    const errors = validateCrossScope(global, project)
    expect(errors).toHaveLength(0)
  })

  it("allows non-keyed fields across scopes", () => {
    const global = { model: "test" }
    const project = { model: "override" }
    const errors = validateCrossScope(global, project)
    // model is single with crossScopeConflict: true — both explicit = conflict
    expect(errors).toHaveLength(1)
    expect(errors[0].path).toContain("model")
    expect(errors[0].message).toContain("Conflicting")
  })
})

// ── MCP credential schema tests ──────────────────────────────────────

describe("MCP credential schema", () => {
  it("accepts MCP entry with valid owned credential ref", () => {
    const raw = JSON.stringify({
      mcp: {
        filesystem: {
          type: "local",
          command: "node",
          args: ["server.js"],
          credential: "secret:kilo.credentials.global.mcp.filesystem",
        },
      },
    })
    const result = validateConfig(raw, "global", "test.jsonc")
    expect(result.valid).toBe(true)
  })

  it("rejects MCP entry with provider-kind credential ref", () => {
    const raw = JSON.stringify({
      mcp: {
        filesystem: {
          type: "local",
          command: "node",
          credential: "secret:kilo.credentials.global.provider.filesystem",
        },
      },
    })
    const result = validateConfig(raw, "global", "test.jsonc")
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.message.includes("MCP credential ref"))).toBe(true)
  })

  it("rejects MCP entry with wrong-scope credential ref", () => {
    const raw = JSON.stringify({
      mcp: {
        filesystem: {
          type: "local",
          command: "node",
          credential: "secret:kilo.credentials.project.mcp.filesystem",
        },
      },
    })
    const result = validateConfig(raw, "global", "test.jsonc")
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.message.includes("MCP credential ref"))).toBe(true)
  })

  it("rejects MCP entry with wrong-name credential ref", () => {
    const raw = JSON.stringify({
      mcp: {
        filesystem: {
          type: "local",
          command: "node",
          credential: "secret:kilo.credentials.global.mcp.other",
        },
      },
    })
    const result = validateConfig(raw, "global", "test.jsonc")
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.message.includes("MCP credential ref"))).toBe(true)
  })

  it("rejects MCP entry with plaintext credential", () => {
    const raw = JSON.stringify({
      mcp: {
        filesystem: {
          type: "local",
          command: "node",
          apiKey: "sk-secret-value",
        },
      },
    })
    const result = validateConfig(raw, "global", "test.jsonc")
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.message.includes("Plaintext credential"))).toBe(true)
  })

  it("accepts MCP entry without credential field", () => {
    const raw = JSON.stringify({
      mcp: {
        filesystem: {
          type: "local",
          command: "node",
          args: ["server.js"],
        },
      },
    })
    const result = validateConfig(raw, "global", "test.jsonc")
    expect(result.valid).toBe(true)
  })

  it("accepts MCP entry with unknown keys rejected", () => {
    const raw = JSON.stringify({
      mcp: {
        filesystem: {
          type: "local",
          command: "node",
          env: { API_KEY: "secret" },
        },
      },
    })
    const result = validateConfig(raw, "global", "test.jsonc")
    // env is not in the approved MCP keys — should be rejected
    expect(result.valid).toBe(false)
  })
})
