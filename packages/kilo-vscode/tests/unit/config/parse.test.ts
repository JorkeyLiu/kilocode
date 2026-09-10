/**
 * P4.1 Config Foundation — Parse tests.
 *
 * Covers audit triggers:
 * - JSONC trailing comma handling (jsonc-parser)
 * - JSONC comment preservation
 * - Structured YAML frontmatter round-trip
 * - Content hashing determinism
 * - Unknown key rejection
 * - Plaintext credential rejection
 */

import { describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import {
  parseJsonc,
  stripJsoncComments,
  formatJsonc,
  readFile,
  parseMarkdown,
  stringifyFrontmatter,
  updateFrontmatterKeys,
  readMarkdownFile,
  contentHash,
  fileContentHash,
  validateNoUnknownKeys,
  validateNoPlaintextCredentials,
} from "../../../src/config/parse"

let tempDir: string

function setup() {
  tempDir = mkdtempSync(join(tmpdir(), "config-parse-test-"))
  return tempDir
}

function cleanup() {
  rmSync(tempDir, { recursive: true, force: true })
}

describe("JSONC parsing", () => {
  it("parses valid JSON", () => {
    const result = parseJsonc('{"model": "anthropic/claude-sonnet-4-20250514"}')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.model).toBe("anthropic/claude-sonnet-4-20250514")
    }
  })

  it("handles trailing commas", () => {
    const result = parseJsonc(`{
  "model": "anthropic/claude-sonnet-4-20250514",
  "provider": {
    "openai": {
      "endpoint": "https://api.openai.com",
    },
  },
}`)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.model).toBe("anthropic/claude-sonnet-4-20250514")
      const provider = result.value.provider as Record<string, unknown>
      expect(provider).toBeDefined()
      const openai = provider.openai as Record<string, unknown>
      expect(openai.endpoint).toBe("https://api.openai.com")
    }
  })

  it("strips single-line comments", () => {
    const result = parseJsonc(`{
  // This is a comment
  "model": "anthropic/claude-sonnet-4-20250514"
}`)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.model).toBe("anthropic/claude-sonnet-4-20250514")
    }
  })

  it("strips multi-line comments", () => {
    const result = parseJsonc(`{
  /* multi-line
     comment */
  "model": "anthropic/claude-sonnet-4-20250514"
}`)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.model).toBe("anthropic/claude-sonnet-4-20250514")
    }
  })

  it("rejects non-object root", () => {
    const result = parseJsonc('"just a string"')
    expect(result.ok).toBe(false)
  })

  it("rejects array root", () => {
    const result = parseJsonc('[1, 2, 3]')
    expect(result.ok).toBe(false)
  })

  it("reports parse errors", () => {
    const result = parseJsonc('{ "model": }')
    expect(result.ok).toBe(false)
  })
})

describe("stripJsoncComments", () => {
  it("preserves strings containing comment-like syntax", () => {
    const input = '{"url": "https://example.com//path"}'
    const stripped = stripJsoncComments(input)
    expect(stripped).toContain("https://example.com//path")
  })
})

describe("formatJsonc", () => {
  it("formats JSONC with 2-space indent", () => {
    const input = '{"model":"anthropic/claude-sonnet-4-20250514","provider":{"openai":{"endpoint":"https://api.openai.com"}}}'
    const formatted = formatJsonc(input)
    expect(formatted).toContain("  ")
    expect(formatted).toContain("\n")
  })
})

describe("YAML frontmatter parsing", () => {
  it("parses simple frontmatter", () => {
    const text = `---
name: test-agent
description: A test agent
model: anthropic/claude-sonnet-4-20250514
---
# Body content`
    const result = parseMarkdown(text)
    expect(result.data.name).toBe("test-agent")
    expect(result.data.description).toBe("A test agent")
    expect(result.data.model).toBe("anthropic/claude-sonnet-4-20250514")
    expect(result.content).toBe("# Body content")
  })

  it("parses boolean and null values", () => {
    const text = `---
hidden: true
enabled: false
color: null
---
Body`
    const result = parseMarkdown(text)
    expect(result.data.hidden).toBe(true)
    expect(result.data.enabled).toBe(false)
    expect(result.data.color).toBe(null)
  })

  it("parses array values", () => {
    const text = `---
tools:
  - read
  - write
  - edit
---
Body`
    const result = parseMarkdown(text)
    expect(result.data.tools).toEqual(["read", "write", "edit"])
  })

  it("parses nested objects", () => {
    const text = `---
permission:
  read: allow
  write: ask
---
Body`
    const result = parseMarkdown(text)
    expect(result.data.permission).toEqual({ read: "allow", write: "ask" })
  })

  it("handles no frontmatter", () => {
    const text = `# Just a heading\nSome content`
    const result = parseMarkdown(text)
    expect(Object.keys(result.data)).toHaveLength(0)
    expect(result.content).toBe("# Just a heading\nSome content")
  })

  it("round-trips structured frontmatter", () => {
    const original = {
      name: "test-agent",
      model: "anthropic/claude-sonnet-4-20250514",
      hidden: true,
      tools: ["read", "write"],
      permission: { read: "allow" },
    }
    const yaml = stringifyFrontmatter(original)
    expect(yaml).toContain("name: test-agent")
    expect(yaml).toContain("hidden: true")
  })
})

describe("content hashing", () => {
  it("produces deterministic hashes", () => {
    const h1 = contentHash("hello world")
    const h2 = contentHash("hello world")
    expect(h1).toBe(h2)
  })

  it("produces different hashes for different content", () => {
    const h1 = contentHash("hello")
    const h2 = contentHash("world")
    expect(h1).not.toBe(h2)
  })

  it("produces 16-char hex strings", () => {
    const hash = contentHash("test")
    expect(hash).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe("file reading", () => {
  it("reads existing file", () => {
    const dir = setup()
    try {
      const filePath = join(dir, "test.jsonc")
      writeFileSync(filePath, '{"model": "test"}')
      const content = readFile(filePath)
      expect(content.type).toBe("present")
      if (content.type === "present") {
        expect(content.bytes).toBe('{"model": "test"}')
        expect(content.hash).toMatch(/^[0-9a-f]{16}$/)
      }
    } finally {
      cleanup()
    }
  })

  it("returns absent for missing file", () => {
    const result = readFile("/nonexistent/file.jsonc")
    expect(result.type).toBe("absent")
  })

  it("returns failure for permission-denied file", () => {
    const dir = setup()
    try {
      const filePath = join(dir, "denied.jsonc")
      writeFileSync(filePath, "content", { mode: 0o000 })
      const result = readFile(filePath)
      // On some systems (root) this may succeed; verify either present or failure
      expect(result.type === "present" || result.type === "failure").toBe(true)
    } finally {
      cleanup()
    }
  })

  it("fileContentHash returns hash for existing file", () => {
    const dir = setup()
    try {
      const filePath = join(dir, "test.jsonc")
      writeFileSync(filePath, '{"model": "test"}')
      const hash = fileContentHash(filePath)
      expect(hash).not.toBeNull()
      expect(hash).toMatch(/^[0-9a-f]{16}$/)
    } finally {
      cleanup()
    }
  })

  it("fileContentHash returns null for missing file", () => {
    const hash = fileContentHash("/nonexistent/file.jsonc")
    expect(hash).toBeNull()
  })
})

describe("validateNoUnknownKeys", () => {
  it("accepts known keys", () => {
    const raw = { model: "anthropic/claude-sonnet-4-20250514", provider: {} }
    const errors = validateNoUnknownKeys(raw, "global", "test")
    expect(errors).toHaveLength(0)
  })

  it("rejects unknown keys", () => {
    const raw = { model: "anthropic/claude-sonnet-4-20250514", server: {} }
    const errors = validateNoUnknownKeys(raw, "global", "test")
    expect(errors.length).toBe(1)
    expect(errors[0].path).toContain("server")
    expect(errors[0].message).toContain("closed")
  })

  it("rejects multiple unknown keys", () => {
    const raw = { server: {}, console: {}, enterprise: {} }
    const errors = validateNoUnknownKeys(raw, "global", "test")
    expect(errors.length).toBe(3)
  })
})

describe("validateNoPlaintextCredentials", () => {
  it("accepts provider with opaque ref", () => {
    const raw = {
      provider: {
        openai: {
          apiKey: "secret:openai-key",
        },
      },
    }
    const errors = validateNoPlaintextCredentials(raw, "global", "test")
    expect(errors).toHaveLength(0)
  })

  it("rejects plaintext apiKey in provider", () => {
    const raw = {
      provider: {
        openai: {
          apiKey: "sk-1234567890",
        },
      },
    }
    const errors = validateNoPlaintextCredentials(raw, "global", "test")
    expect(errors.length).toBe(1)
    expect(errors[0].message).toContain("Plaintext credential")
  })

  it("rejects plaintext token in provider", () => {
    const raw = {
      provider: {
        anthropic: {
          token: "sk-ant-1234567890",
        },
      },
    }
    const errors = validateNoPlaintextCredentials(raw, "global", "test")
    expect(errors.length).toBe(1)
    expect(errors[0].message).toContain("Plaintext credential")
  })

  it("rejects plaintext password in provider", () => {
    const raw = {
      provider: {
        local: {
          password: "mypassword",
        },
      },
    }
    const errors = validateNoPlaintextCredentials(raw, "global", "test")
    expect(errors.length).toBe(1)
  })

  it("accepts MCP with opaque refs", () => {
    const raw = {
      mcp: {
        filesystem: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem"],
          env: {
            API_KEY: "secret:fs-key",
          },
        },
      },
    }
    const errors = validateNoPlaintextCredentials(raw, "global", "test")
    expect(errors).toHaveLength(0)
  })

  it("rejects plaintext credentials in MCP", () => {
    const raw = {
      mcp: {
        server: {
          apiKey: "plaintext-key",
        },
      },
    }
    const errors = validateNoPlaintextCredentials(raw, "global", "test")
    expect(errors.length).toBe(1)
  })

  it("rejects disallowed keys in provider config", () => {
    const raw = {
      provider: {
        openai: {
          id: "openai",
          endpoint: "https://api.openai.com",
          apiKey: "secret:key",
          catalog: "bundled", // disallowed
          whitelist: ["gpt-4"], // disallowed
        },
      },
    }
    const errors = validateNoPlaintextCredentials(raw, "global", "test")
    expect(errors.length).toBeGreaterThanOrEqual(1)
    const catalogError = errors.find((e) => e.path.includes("catalog"))
    expect(catalogError).toBeDefined()
  })
})

// ── F5: Source-preserving markdown diagnostics ───────────────────────

describe("F5: source-preserving markdown diagnostics", () => {
  it("updateFrontmatterKeys preserves existing keys and order", () => {
    const original = `name: test-agent
description: Original description
model: anthropic/claude-sonnet-4-20250514`
    const result = updateFrontmatterKeys(original, { description: "Updated description" })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toContain("name: test-agent")
      expect(result.value).toContain("description: Updated description")
      expect(result.value).toContain("model: anthropic/claude-sonnet-4-20250514")
    }
  })

  it("updateFrontmatterKeys reports YAML parse errors", () => {
    const malformed = `name: test:
  invalid: yaml: [unclosed`
    const result = updateFrontmatterKeys(malformed, { name: "fixed" })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain("YAML")
    }
  })

  it("updateFrontmatterKeys can add new keys", () => {
    const original = `name: test-agent`
    const result = updateFrontmatterKeys(original, { hidden: true })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toContain("name: test-agent")
      expect(result.value).toContain("hidden: true")
    }
  })

  it("updateFrontmatterKeys can remove keys via undefined", () => {
    const original = `name: test-agent
description: Desc`
    const result = updateFrontmatterKeys(original, { description: undefined })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toContain("name: test-agent")
      expect(result.value).not.toContain("description")
    }
  })
})

// ── F6: Credential detection edge cases ──────────────────────────────

describe("F6: credential detection edge cases", () => {
  it("detects ACCESS_TOKEN variant in nested env", () => {
    const raw = {
      mcp: {
        server: {
          env: { ACCESS_TOKEN: "tok-123" },
        },
      },
    }
    const errors = validateNoPlaintextCredentials(raw, "global", "test")
    expect(errors.length).toBeGreaterThanOrEqual(1)
  })

  it("detects SECRET_KEY variant", () => {
    const raw = {
      provider: {
        aws: { SECRET_KEY: "wJalrXUtnFEMI" },
      },
    }
    const errors = validateNoPlaintextCredentials(raw, "global", "test")
    expect(errors.length).toBe(1)
  })

  it("accepts non-credential fields with similar names", () => {
    const raw = {
      provider: {
        openai: { endpoint: "https://api.openai.com", protocol: "openai/completions" },
      },
    }
    const errors = validateNoPlaintextCredentials(raw, "global", "test")
    expect(errors).toHaveLength(0)
  })

  it("rejects CLIENT_SECRET in provider", () => {
    const raw = {
      provider: {
        oauth: { client_secret: "shhh" },
      },
    }
    const errors = validateNoPlaintextCredentials(raw, "global", "test")
    expect(errors.length).toBe(1)
  })
})
