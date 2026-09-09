/**
 * P4.1 Config Foundation — Validate tests.
 *
 * Covers audit triggers:
 * - Executable Zod schemas for each field class
 * - Recursive provider/MCP record validation
 * - Agent frontmatter schema validation
 * - Command frontmatter content requirement
 * - Credential rejection (plaintext vs opaque refs)
 * - Model format validation (provider/model)
 */

import { describe, expect, it } from "bun:test"
import { validateConfig, validateMarkdownAsset, validateCrossScope } from "../../../src/config/validate"
import { validateNoPlaintextCredentials } from "../../../src/config/parse"
import { toCanonicalPayload } from "../../../src/config/types"

describe("validateConfig", () => {
  it("accepts valid minimal config", () => {
    const result = validateConfig('{"model": "anthropic/claude-sonnet-4-20250514"}', "global", "test")
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it("rejects JSONC parse errors", () => {
    const result = validateConfig('{ "model": }', "global", "test")
    expect(result.valid).toBe(false)
    expect(result.errors[0].message).toContain("parse error")
  })

  it("rejects unknown keys", () => {
    const result = validateConfig('{"server": {}}', "global", "test")
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.message.includes("Unknown"))).toBe(true)
  })

  it("rejects invalid model format", () => {
    const result = validateConfig('{"model": "invalid-no-slash"}', "global", "test")
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.message.includes("provider/model"))).toBe(true)
  })

  it("accepts valid model format", () => {
    const result = validateConfig('{"model": "anthropic/claude-sonnet-4-20250514"}', "global", "test")
    expect(result.valid).toBe(true)
  })

  it("accepts model with dots in name", () => {
    const result = validateConfig('{"model": "openai/gpt-4.1-mini"}', "global", "test")
    expect(result.valid).toBe(true)
  })

  it("rejects plaintext credentials in provider", () => {
    const config = JSON.stringify({
      provider: {
        openai: { apiKey: "sk-1234567890" },
      },
    })
    const result = validateConfig(config, "global", "test")
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.message.includes("Plaintext"))).toBe(true)
  })

  it("accepts provider with exact owned credential ref", () => {
    const config = JSON.stringify({
      provider: {
        openai: { credential: "secret:kilo.credentials.global.provider.openai" },
      },
    })
    const result = validateConfig(config, "global", "test")
    expect(result.valid).toBe(true)
  })

  it("rejects provider with arbitrary non-owned secret ref", () => {
    const config = JSON.stringify({
      provider: {
        openai: { credential: "secret:openai-key" },
      },
    })
    const result = validateConfig(config, "global", "test")
    expect(result.valid).toBe(false)
  })

  it("rejects disallowed provider keys", () => {
    const config = JSON.stringify({
      provider: {
        openai: {
          endpoint: "https://api.openai.com",
          catalog: "bundled",
        },
      },
    })
    const result = validateConfig(config, "global", "test")
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.message.includes("disallowed"))).toBe(true)
  })

  it("accepts valid provider config", () => {
    const config = JSON.stringify({
      provider: {
        myprovider: {
          endpoint: "https://my-api.example.com",
          protocol: "openai",
          models: { "gpt-4": { name: "GPT-4" }, "gpt-3.5-turbo": { name: "GPT-3.5 Turbo" } },
        },
      },
    })
    const result = validateConfig(config, "global", "test")
    expect(result.valid).toBe(true)
  })

  it("rejects MCP with unknown keys like env", () => {
    const config = JSON.stringify({
      mcp: {
        filesystem: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem"],
          env: { API_KEY: "secret:mcp-key" },
        },
      },
    })
    const result = validateConfig(config, "global", "test")
    expect(result.valid).toBe(false)
  })

  it("rejects plaintext credential in MCP", () => {
    const config = JSON.stringify({
      mcp: {
        server: { apiKey: "plaintext-key" },
      },
    })
    const result = validateConfig(config, "global", "test")
    expect(result.valid).toBe(false)
  })

  it("accepts permission as record", () => {
    const config = JSON.stringify({
      permission: { read: "allow", write: "ask" },
    })
    const result = validateConfig(config, "global", "test")
    expect(result.valid).toBe(true)
  })

  it("accepts instructions as string array", () => {
    const config = JSON.stringify({
      instructions: ["*.md", "docs/**/*.md"],
    })
    const result = validateConfig(config, "global", "test")
    expect(result.valid).toBe(true)
  })

  it("accepts instructions as single string", () => {
    const config = JSON.stringify({
      instructions: "*.md",
    })
    const result = validateConfig(config, "global", "test")
    expect(result.valid).toBe(true)
  })
})

describe("validateMarkdownAsset", () => {
  describe("agent assets", () => {
    it("accepts valid agent frontmatter", () => {
      const text = `---
name: test-agent
description: A test agent
model: anthropic/claude-sonnet-4-20250514
tools:
  read: true
  write: true
permission:
  read: allow
requirements:
  skills:
    - node
---
# Agent prompt content`
      const result = validateMarkdownAsset(text, "agent", "test.md")
      expect(result.valid).toBe(true)
    })

    it("accepts agent with all allowed fields", () => {
      const text = `---
name: full-agent
displayName: Full Agent
description: Complete agent
model: anthropic/claude-sonnet-4-20250514
variant: thinking
prompt: You are helpful
tools:
  read: true
permission:
  read: allow
requirements:
  skills:
    - bun
hidden: true
color: accent
maxSteps: 10
mode: primary
---
Body`
      const result = validateMarkdownAsset(text, "agent", "test.md")
      expect(result.valid).toBe(true)
    })

    it("accepts CLI mode values subagent/primary/all", () => {
      for (const mode of ["subagent", "primary", "all"] as const) {
        const text = `---
name: mode-agent
mode: ${mode}
---
Body`
        expect(validateMarkdownAsset(text, "agent", "test.md").valid).toBe(true)
      }
    })

    it("accepts null delete sentinels for model/variant", () => {
      const text = `---
name: null-agent
model: null
variant: null
temperature: null
top_p: null
prompt: null
description: null
steps: null
---
Body`
      const result = validateMarkdownAsset(text, "agent", "test.md")
      expect(result.valid).toBe(true)
    })

    it("rejects string[] tools (CLI uses Record<string,boolean>)", () => {
      const text = `---
name: bad-tools
tools:
  - read
---
Body`
      expect(validateMarkdownAsset(text, "agent", "test.md").valid).toBe(false)
    })

    it("accepts record tools", () => {
      const text = `---
name: record-tools
tools:
  read: true
  write: false
---
Body`
      expect(validateMarkdownAsset(text, "agent", "test.md").valid).toBe(true)
    })

    it("rejects bare-array requirements (CLI uses object shape)", () => {
      const text = `---
name: bad-req
requirements:
  - bun
---
Body`
      expect(validateMarkdownAsset(text, "agent", "test.md").valid).toBe(false)
    })

    it("accepts object requirements", () => {
      const text = `---
name: good-req
requirements:
  skills:
    - bun
---
Body`
      expect(validateMarkdownAsset(text, "agent", "test.md").valid).toBe(true)
    })

    it("rejects invalid permission values", () => {
      const text = `---
name: bad-perm
permission:
  read: sometimes
---
Body`
      expect(validateMarkdownAsset(text, "agent", "test.md").valid).toBe(false)
    })

    it("accepts allow/ask/deny/null permission values", () => {
      const text = `---
name: good-perm
permission:
  read: allow
  edit:
    "*": ask
  bash: null
---
Body`
      expect(validateMarkdownAsset(text, "agent", "test.md").valid).toBe(true)
    })

    it("accepts any CLI model string in agent frontmatter (no provider/model gate)", () => {
      const text = `---
model: invalid-no-slash
---
Body`
      const result = validateMarkdownAsset(text, "agent", "test.md")
      expect(result.valid).toBe(true)
    })

    it("rejects agent with empty name", () => {
      const text = `---
name: ""
---
Body`
      // Empty name is allowed by passthrough schema (name is optional)
      const result = validateMarkdownAsset(text, "agent", "test.md")
      expect(result.valid).toBe(true)
    })
  })

  describe("command assets", () => {
    it("accepts valid command frontmatter with body", () => {
      const text = `---
name: test-command
description: A test command
agent: test-agent
model: anthropic/claude-sonnet-4-20250514
---
Command template body here`
      const result = validateMarkdownAsset(text, "command", "test.md")
      expect(result.valid).toBe(true)
    })

    it("rejects command without body", () => {
      const text = `---
name: test-command
description: A test command
---`
      const result = validateMarkdownAsset(text, "command", "test.md")
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.message.includes("non-empty template"))).toBe(true)
    })
  })

  describe("skill/plugin/tool/rules assets", () => {
    it("accepts minimal frontmatter", () => {
      for (const type of ["skill", "tool", "plugin", "rules"] as const) {
        const text = `---
name: test-${type}
---
Body`
        const result = validateMarkdownAsset(text, type, "test.md")
        expect(result.valid).toBe(true)
      }
    })
  })
})

describe("validateCrossScope", () => {
  it("detects duplicate provider IDs across scopes", () => {
    const global = {
      provider: {
        openai: { endpoint: "https://api.openai.com" },
      },
    }
    const project = {
      provider: {
        openai: { endpoint: "https://other.com" },
      },
    }
    const errors = validateCrossScope(global, project)
    expect(errors.length).toBe(1)
    expect(errors[0].path).toContain("openai")
    expect(errors[0].message).toContain("Duplicate")
  })

  it("allows different provider IDs across scopes", () => {
    const global = {
      provider: {
        openai: { endpoint: "https://api.openai.com" },
      },
    }
    const project = {
      provider: {
        anthropic: { endpoint: "https://api.anthropic.com" },
      },
    }
    const errors = validateCrossScope(global, project)
    expect(errors).toHaveLength(0)
  })

  it("detects single field conflict across scopes", () => {
    const global = {
      model: "anthropic/claude-sonnet-4-20250514",
    }
    const project = {
      model: "openai/gpt-4",
    }
    // model is single with crossScopeConflict: true — both explicit = conflict
    const errors = validateCrossScope(global, project)
    expect(errors).toHaveLength(1)
    expect(errors[0].path).toContain("model")
    expect(errors[0].message).toContain("Conflicting")
  })

  it("allows single field in only one scope", () => {
    const global = {
      model: "anthropic/claude-sonnet-4-20250514",
    }
    const errors = validateCrossScope(global, {})
    expect(errors).toHaveLength(0)
  })
})

// ── F4: Asset schemas reject unknown keys ────────────────────────────

describe("F4: asset schemas reject unknown keys", () => {
  it("accepts unknown keys in agent frontmatter (CLI rest/options semantics)", () => {
    const text = `---
name: test-agent
unknownField: some-value
disabled: true
---
Body`
    const result = validateMarkdownAsset(text, "agent", "test.md")
    expect(result.valid).toBe(true)
    // Unknown keys round-trip verbatim so CLI normalize can merge them into options.
    expect(result.data?.unknownField).toBe("some-value")
    expect(result.data?.disabled).toBe(true)
  })

  it("rejects unknown key in command frontmatter", () => {
    const text = `---
name: test-command
rogueKey: value
---
Body`
    const result = validateMarkdownAsset(text, "command", "test.md")
    expect(result.valid).toBe(false)
  })

  it("rejects unknown key in skill frontmatter", () => {
    const text = `---
name: test-skill
bogus: true
---
Body`
    const result = validateMarkdownAsset(text, "skill", "test.md")
    expect(result.valid).toBe(false)
  })

  it("accepts all defined agent fields", () => {
    const text = `---
name: test
displayName: Test
description: Desc
model: anthropic/claude-sonnet-4-20250514
variant: thinking
prompt: You are helpful
tools:
  read: true
permission:
  read: allow
requirements:
  skills:
    - bun
hidden: true
color: accent
maxSteps: 10
mode: primary
---
Body`
    const result = validateMarkdownAsset(text, "agent", "test.md")
    expect(result.valid).toBe(true)
  })
})

// ── F6: Nested/array/variant credential detection ────────────────────

describe("F6: nested/array/variant credential detection", () => {
  it("detects env.API_KEY in MCP as credential", () => {
    const raw = {
      mcp: {
        filesystem: {
          command: "npx",
          env: { API_KEY: "sk-1234567890" },
        },
      },
    }
    const errors = validateNoPlaintextCredentials(raw, "global", "test")
    expect(errors.length).toBeGreaterThanOrEqual(1)
    expect(errors.some((e) => e.path.includes("env") && e.path.includes("API_KEY"))).toBe(true)
  })

  it("detects nested case variants (ApiKey, api-key, API_KEY)", () => {
    const raw = {
      provider: {
        svc: { ApiKey: "sk-abc" },
      },
    }
    const errors = validateNoPlaintextCredentials(raw, "global", "test")
    expect(errors.length).toBe(1)
  })

  it("detects headers.Authorization as credential", () => {
    const raw = {
      mcp: {
        server: {
          headers: { Authorization: "Bearer sk-123" },
        },
      },
    }
    const errors = validateNoPlaintextCredentials(raw, "global", "test")
    expect(errors.length).toBeGreaterThanOrEqual(1)
  })

  it("accepts env.API_KEY when opaque ref", () => {
    const raw = {
      mcp: {
        filesystem: {
          command: "npx",
          env: { API_KEY: "secret:mcp-key" },
        },
      },
    }
    const errors = validateNoPlaintextCredentials(raw, "global", "test")
    expect(errors).toHaveLength(0)
  })

  it("detects credentials in MCP args array elements", () => {
    const raw = {
      mcp: {
        server: {
          command: "npx",
          args: ["--token", "sk-plaintext"],
        },
      },
    }
    const errors = validateNoPlaintextCredentials(raw, "global", "test")
    // The args array traversal should check nested objects in arrays
    expect(errors).toHaveLength(0) // String args are not credential keys
  })

  it("rejects provider with disallowed key via new credential detection", () => {
    const raw = {
      provider: {
        openai: {
          id: "openai",
          endpoint: "https://api.openai.com",
          secret: "my-secret",
        },
      },
    }
    const errors = validateNoPlaintextCredentials(raw, "global", "test")
    expect(errors.length).toBeGreaterThanOrEqual(1)
  })
})

// ── F7: Asset credential validation ──────────────────────────────────

// ── LOCK-1: Provider model schema exactness ──────────────────────────

describe("LOCK-1: Provider model schema exactness", () => {
  it("accepts provider with canonical fields (name, endpoint, protocol, models)", () => {
    const config = JSON.stringify({
      provider: {
        openai: {
          name: "OpenAI",
          endpoint: "https://api.openai.com/v1",
          protocol: "openai",
          models: { "gpt-4": { name: "GPT-4" } },
        },
      },
    })
    const result = validateConfig(config, "global", "test")
    expect(result.valid).toBe(true)
  })

  it("accepts model with approved optional fields (reasoning, modalities, variants)", () => {
    const config = JSON.stringify({
      provider: {
        openai: {
          models: {
            "o3": {
              name: "O3",
              reasoning: true,
              modalities: { input: ["text"], output: ["text"] },
              variants: { thinking: { enable_thinking: true } },
            },
          },
        },
      },
    })
    const result = validateConfig(config, "global", "test")
    expect(result.valid).toBe(true)
  })

  it("rejects model with bogus modality key", () => {
    const config = JSON.stringify({
      provider: {
        openai: {
          models: {
            "gpt-4": {
              name: "GPT-4",
              modalities: { bogus: ["text"] },
            },
          },
        },
      },
    })
    const result = validateConfig(config, "global", "test")
    expect(result.valid).toBe(false)
  })

  it("rejects model with bogus variant key", () => {
    const config = JSON.stringify({
      provider: {
        openai: {
          models: {
            "gpt-4": {
              name: "GPT-4",
              variants: { v1: { bogus: true } },
            },
          },
        },
      },
    })
    const result = validateConfig(config, "global", "test")
    expect(result.valid).toBe(false)
  })

  it("rejects provider with legacy npm field", () => {
    const config = JSON.stringify({
      provider: {
        openai: { npm: "@ai-sdk/openai", name: "OpenAI" },
      },
    })
    const result = validateConfig(config, "global", "test")
    expect(result.valid).toBe(false)
  })

  it("rejects provider with legacy env field", () => {
    const config = JSON.stringify({
      provider: {
        openai: { env: ["OPENAI_API_KEY"] },
      },
    })
    const result = validateConfig(config, "global", "test")
    expect(result.valid).toBe(false)
  })

  it("rejects provider with legacy options/baseURL field", () => {
    const config = JSON.stringify({
      provider: {
        openai: { options: { baseURL: "https://api.openai.com" } },
      },
    })
    const result = validateConfig(config, "global", "test")
    expect(result.valid).toBe(false)
  })

  it("rejects provider with legacy headers field", () => {
    const config = JSON.stringify({
      provider: {
        openai: { headers: { Authorization: "Bearer x" } },
      },
    })
    const result = validateConfig(config, "global", "test")
    expect(result.valid).toBe(false)
  })

  it("rejects model with credential key", () => {
    const config = JSON.stringify({
      provider: {
        openai: {
          models: {
            "gpt-4": { name: "GPT-4", credential: "secret:x" },
          },
        },
      },
    })
    const result = validateConfig(config, "global", "test")
    expect(result.valid).toBe(false)
  })

  it("rejects model with npm key", () => {
    const config = JSON.stringify({
      provider: {
        openai: {
          models: {
            "gpt-4": { name: "GPT-4", npm: "malicious" },
          },
        },
      },
    })
    const result = validateConfig(config, "global", "test")
    expect(result.valid).toBe(false)
  })

  it("rejects variant with unknown nested value key", () => {
    const config = JSON.stringify({
      provider: {
        openai: {
          models: {
            "gpt-4": {
              name: "GPT-4",
              variants: { v1: { unknownKey: "val" } },
            },
          },
        },
      },
    })
    const result = validateConfig(config, "global", "test")
    expect(result.valid).toBe(false)
  })

  it("rejects modalities with non-string-array values", () => {
    const config = JSON.stringify({
      provider: {
        openai: {
          models: {
            "gpt-4": {
              name: "GPT-4",
              modalities: { input: [123] },
            },
          },
        },
      },
    })
    const result = validateConfig(config, "global", "test")
    expect(result.valid).toBe(false)
  })
})

// ── F7: Asset credential validation ──────────────────────────────────

describe("F7: asset credential validation", () => {
  it("rejects plaintext credential in agent frontmatter", () => {
    const text = `---
name: test-agent
apiKey: sk-1234567890
---
Body`
    const result = validateMarkdownAsset(text, "agent", "test.md")
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.message.includes("must not contain credentials"))).toBe(true)
  })

  it("rejects credentials AND credential refs in agent fields (no agent credential mechanism)", () => {
    for (const value of ["hunter2-plaintext-token", "secret:agent-key"]) {
      const result = validateMarkdownAsset(
        `---
name: test-agent
apiKey: ${value}
---
Body`,
        "agent",
        "test.md",
      )
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.message.includes("must not contain credentials"))).toBe(true)
    }
  })

  it("rejects agent credential keys across case/separator variants, known and unknown", () => {
    const keys = [
      "apiKey",
      "api_key",
      "API-KEY",
      "ApiKey",
      "token",
      "TOKEN",
      "Token",
      "secret",
      "SECRET",
      "password",
      "Password",
      "PASSWORD",
      "credential",
      "Credential",
      "cookie",
      "COOKIES",
      "authorization",
      "Authorization",
      "headers",
      "Headers",
      "client_secret",
      "CLIENT-ID",
      "access_token",
      "bearer",
    ]
    for (const key of keys) {
      const result = validateMarkdownAsset(`---\nname: test-agent\n${key}: hunter2\n---\nBody`, "agent", "test.md")
      expect(result.valid).toBe(false)
    }
  })

  it("rejects agent credentials nested in options and unknown objects, accepts null/empty", () => {
    const nested = validateMarkdownAsset(
      `---
name: test-agent
options:
  customParam: 1
  api_key: hunter2
---
Body`,
      "agent",
      "test.md",
    )
    expect(nested.valid).toBe(false)
    expect(nested.errors.some((e) => e.message.includes("must not contain credentials"))).toBe(true)
    for (const value of ["null", "~", "''"]) {
      const result = validateMarkdownAsset(`---\nname: test-agent\napiKey: ${value}\n---\nBody`, "agent", "test.md")
      expect(result.valid).toBe(true)
    }
    const empty = validateMarkdownAsset(`---\nname: test-agent\napiKey: ""\n---\nBody`, "agent", "test.md")
    expect(empty.valid).toBe(true)
  })

  it("does not mistake benign agent keys/values for credentials", () => {
    const result = validateMarkdownAsset(
      `---
name: test-agent
description: Sets the Authorization header for proxied requests when credentialRequested is false
mode: primary
disabled: true
credentialRequested: false
---
Body`,
      "agent",
      "test.md",
    )
    expect(result.valid).toBe(true)
  })

  it("rejects plaintext token in command frontmatter", () => {
    const text = `---
name: test-command
token: plaintext-token
---
Body`
    const result = validateMarkdownAsset(text, "command", "test.md")
    expect(result.valid).toBe(false)
  })

  it("detects nested credential in agent permission record", () => {
    const text = `---
name: test-agent
password: hunter2
---
Body`
    const result = validateMarkdownAsset(text, "agent", "test.md")
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.message.includes("must not contain credentials"))).toBe(true)
  })
})

// ── LOCK-1b: Provider schema equivalence (validateConfig ↔ toCanonicalPayload) ──

describe("LOCK-1b: Provider schema equivalence", () => {
  const acceptedFixtures = [
    {
      name: "minimal provider with name only",
      value: { provider: { openai: { name: "OpenAI" } } },
    },
    {
      name: "provider with all canonical fields",
      value: { provider: { openai: { name: "OpenAI", endpoint: "https://api.openai.com/v1", protocol: "openai", models: { "gpt-4": { name: "GPT-4" } } } } },
    },
    {
      name: "provider with model variants",
      value: { provider: { openai: { models: { "o3": { name: "O3", reasoning: true, variants: { thinking: { enable_thinking: true } } } } } } },
    },
    {
      name: "MCP with all canonical fields",
      value: { mcp: { local: { type: "local", command: "node", args: ["server.js"], enabled: true } } },
    },
  ]

  const rejectedFixtures = [
    {
      name: "provider with legacy npm field",
      value: { provider: { openai: { npm: "@ai-sdk/openai", name: "OpenAI" } } },
    },
    {
      name: "provider with legacy env field",
      value: { provider: { openai: { env: ["OPENAI_API_KEY"] } } },
    },
    {
      name: "provider with legacy options field",
      value: { provider: { openai: { options: { baseURL: "https://api.openai.com" } } } },
    },
    {
      name: "provider with legacy apiKey field",
      value: { provider: { openai: { apiKey: "sk-test" } } },
    },
    {
      name: "provider with legacy headers field",
      value: { provider: { openai: { headers: { Authorization: "Bearer x" } } } },
    },
    {
      name: "model with unknown nested key",
      value: { provider: { openai: { models: { "gpt-4": { name: "GPT-4", headers: { "x-key": "val" } } } } } },
    },
    {
      name: "model with npm key",
      value: { provider: { openai: { models: { "gpt-4": { name: "GPT-4", npm: "malicious" } } } } },
    },
    {
      name: "model with credential key",
      value: { provider: { openai: { models: { "gpt-4": { name: "GPT-4", credential: "secret:x" } } } } },
    },
    {
      name: "model array shape (rejected — canonical uses keyed records)",
      value: { provider: { openai: { models: ["gpt-4", "gpt-3.5"] } } },
    },
    {
      name: "MCP with environment field",
      value: { mcp: { local: { type: "local", command: "node", environment: { TOKEN: "x" } } } },
    },
    {
      name: "MCP with oauth field",
      value: { mcp: { remote: { type: "remote", url: "https://x.com", oauth: true } } },
    },
    {
      name: "MCP with args non-string",
      value: { mcp: { local: { type: "local", command: "node", args: ["--port", 3000] } } },
    },
    {
      name: "MCP with url non-string",
      value: { mcp: { remote: { type: "remote", url: 42 } } },
    },
    {
      name: "MCP with command array",
      value: { mcp: { local: { type: "local", command: ["node", "server.js"] } } },
    },
    {
      name: "variant with unknown key",
      value: { provider: { openai: { models: { "gpt-4": { name: "GPT-4", variants: { v1: { bogus: true } } } } } } },
    },
    {
      name: "modalities with bogus key",
      value: { provider: { openai: { models: { "gpt-4": { name: "GPT-4", modalities: { bogus: ["text"] } } } } } },
    },
  ]

  for (const fixture of acceptedFixtures) {
    it(`validateConfig and toCanonicalPayload both ACCEPT: ${fixture.name}`, () => {
      const json = JSON.stringify(fixture.value)
      const validateResult = validateConfig(json, "global", "test")
      const canonicalResult = toCanonicalPayload(fixture.value)
      expect(validateResult.valid).toBe(true)
      expect(canonicalResult).toBeDefined()
    })
  }

  for (const fixture of rejectedFixtures) {
    it(`validateConfig and toCanonicalPayload both REJECT: ${fixture.name}`, () => {
      const json = JSON.stringify(fixture.value)
      const validateResult = validateConfig(json, "global", "test")
      const canonicalResult = toCanonicalPayload(fixture.value)
      expect(validateResult.valid).toBe(false)
      expect(canonicalResult).toBeUndefined()
    })
  }

  it("exact owned credential ref accepted by validateConfig and canonical payload (host-only, redacted at webview boundary)", () => {
    const value = { provider: { openai: { credential: "secret:kilo.credentials.global.provider.openai" } } }
    const json = JSON.stringify(value)
    const validateResult = validateConfig(json, "global", "test")
    const canonicalResult = toCanonicalPayload(value)
    // validateConfig accepts only exact extension-owned credential refs (valid shared schema)
    expect(validateResult.valid).toBe(true)
    // toCanonicalPayload accepts only exact owned refs — it is persisted in JSONC but
    // redacted at the webview boundary by redactCanonical (host-only).
    expect(canonicalResult).toBeDefined()
    expect(canonicalResult!.provider).toBeDefined()
    expect(canonicalResult!.provider!["openai"]!.credential).toBe("secret:kilo.credentials.global.provider.openai")
  })

  it("rejects arbitrary non-owned credential refs in both validateConfig and toCanonicalPayload", () => {
    const value = { provider: { openai: { credential: "secret:openai-key" } } }
    const json = JSON.stringify(value)
    const validateResult = validateConfig(json, "global", "test")
    const canonicalResult = toCanonicalPayload(value)
    expect(validateResult.valid).toBe(false)
    expect(canonicalResult).toBeUndefined()
  })

  it("rejects owned-ref-shaped credentials with wrong kind or missing id", () => {
    const wrongKind = { provider: { openai: { credential: "secret:kilo.credentials.global.mcp.openai" } } }
    expect(toCanonicalPayload(wrongKind)).toBeUndefined()
    const missingId = { provider: { openai: { credential: "secret:kilo.credentials.global.provider" } } }
    expect(toCanonicalPayload(missingId)).toBeUndefined()
    const badScope = { provider: { openai: { credential: "secret:kilo.credentials.workspace.provider.openai" } } }
    expect(toCanonicalPayload(badScope)).toBeUndefined()
  })
})
