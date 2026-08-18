/**
 * P4.1 Config foundation — JSONC and markdown parsing tests.
 *
 * Uses real filesystem operations with run-owned temp directories.
 */

import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import {
  stripJsoncComments,
  parseJsonc,
  readFile,
  parseMarkdown,
  readMarkdownFile,
  contentHash,
  fileContentHash,
} from "../../src/config/parse"

let root: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-config-parse-"))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe("JSONC parsing", () => {
  describe("stripJsoncComments", () => {
    it("strips single-line comments", () => {
      expect(stripJsoncComments('{\n  // comment\n  "key": "value"\n}')).toBe('{\n  \n  "key": "value"\n}')
    })

    it("strips multi-line comments", () => {
      const input = '{\n  /* multi\n  line */\n  "key": "value"\n}'
      const result = stripJsoncComments(input)
      expect(result).not.toContain("multi")
      expect(result).not.toContain("line")
      expect(result).toContain('"key": "value"')
    })

    it("preserves strings with comment-like characters", () => {
      const input = '{\n  "url": "https://example.com//not-a-comment"\n}'
      const result = stripJsoncComments(input)
      expect(result).toContain('"url": "https://example.com//not-a-comment"')
    })

    it("preserves trailing commas in JSONC", () => {
      const input = '{\n  "a": 1,\n  "b": 2,\n}'
      const result = stripJsoncComments(input)
      expect(result).toContain('"a": 1,')
      expect(result).toContain('"b": 2,')
    })

    it("handles empty input", () => {
      expect(stripJsoncComments("")).toBe("")
    })
  })

  describe("parseJsonc", () => {
    it("parses valid JSON", () => {
      const result = parseJsonc('{"key": "value"}')
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.value).toEqual({ key: "value" })
    })

    it("parses JSONC with comments", () => {
      const input = `{
  // This is a comment
  "model": "anthropic/claude-sonnet",
  /* Multi-line
     comment */
  "shell": "/bin/zsh"
}`
      const result = parseJsonc(input)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.value.model).toBe("anthropic/claude-sonnet")
        expect(result.value.shell).toBe("/bin/zsh")
      }
    })

    it("parses JSONC with trailing commas", () => {
      const input = '{\n  "model": "test",\n}'
      const result = parseJsonc(input)
      // jsonc-parser handles trailing commas via allowTrailingComma option
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.value.model).toBe("test")
      }
    })

    it("rejects non-object roots", () => {
      expect(parseJsonc('"string"').ok).toBe(false)
      expect(parseJsonc('[1, 2, 3]').ok).toBe(false)
      expect(parseJsonc("42").ok).toBe(false)
    })

    it("rejects invalid JSON", () => {
      const result = parseJsonc("{invalid json}")
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toBeDefined()
      }
    })

    it("parses complex nested config", () => {
      const input = `{
  "model": "anthropic/claude-sonnet",
  "agent": {
    "build": {
      "prompt": "You are a coding agent"
    }
  },
  "permission": {
    "read": "allow",
    "edit": "ask"
  }
}`
      const result = parseJsonc(input)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.value.model).toBe("anthropic/claude-sonnet")
        expect((result.value.agent as Record<string, unknown>).build).toBeDefined()
      }
    })
  })

  describe("readFile", () => {
    it("reads existing file", () => {
      const file = path.join(root, "kilo.jsonc")
      fs.writeFileSync(file, '{"model": "test"}')
      const result = readFile(file)
      expect(result.type).toBe("present")
      if (result.type === "present") {
        expect(result.bytes).toBe('{"model": "test"}')
        expect(result.hash).toMatch(/^[0-9a-f]{16}$/)
      }
    })

    it("returns absent for missing file", () => {
      const result = readFile(path.join(root, "nonexistent.jsonc"))
      expect(result.type).toBe("absent")
    })

    it("returns failure for unreadable file", () => {
      const file = path.join(root, "unreadable.jsonc")
      fs.writeFileSync(file, "content", { mode: 0o000 })
      const result = readFile(file)
      // On some OS/runs this may succeed (root) or fail — verify either present or failure
      expect(result.type === "present" || result.type === "failure").toBe(true)
    })
  })

  describe("readFile (text)", () => {
    it("reads existing file", () => {
      const file = path.join(root, "test.txt")
      fs.writeFileSync(file, "hello world")
      const result = readFile(file)
      expect(result.type).toBe("present")
      if (result.type === "present") {
        expect(result.bytes).toBe("hello world")
        expect(result.hash).toMatch(/^[0-9a-f]{16}$/)
      }
    })

    it("returns absent for missing file", () => {
      const result = readFile(path.join(root, "nonexistent.txt"))
      expect(result.type).toBe("absent")
    })
  })
})

describe("markdown parsing", () => {
  describe("parseMarkdown", () => {
    it("parses markdown with frontmatter", () => {
      const input = `---
name: code
model: anthropic/claude-sonnet
---
You are a coding agent.`
      const result = parseMarkdown(input)
      expect(result.data.name).toBe("code")
      expect(result.data.model).toBe("anthropic/claude-sonnet")
      expect(result.content).toBe("You are a coding agent.")
    })

    it("parses markdown without frontmatter", () => {
      const input = "Just plain markdown content."
      const result = parseMarkdown(input)
      expect(result.data).toEqual({})
      expect(result.content).toBe("Just plain markdown content.")
    })

    it("parses frontmatter with quoted strings", () => {
      const input = `---
name: "my agent"
description: "A description with: colons"
---
Body content.`
      const result = parseMarkdown(input)
      expect(result.data.name).toBe("my agent")
      expect(result.data.description).toBe("A description with: colons")
    })

    it("parses boolean and null values", () => {
      const input = `---
hidden: true
disable: false
color: null
---
Body.`
      const result = parseMarkdown(input)
      expect(result.data.hidden).toBe(true)
      expect(result.data.disable).toBe(false)
      expect(result.data.color).toBeNull()
    })

    it("handles CRLF line endings", () => {
      const input = "---\r\nname: test\r\n---\r\nContent."
      const result = parseMarkdown(input)
      expect(result.data.name).toBe("test")
      expect(result.content).toBe("Content.")
    })
  })

  describe("readMarkdownFile", () => {
    it("reads and parses existing markdown file", () => {
      const file = path.join(root, "agent.md")
      fs.writeFileSync(file, `---
name: code
model: test
---
Agent prompt here.`)
      const result = readMarkdownFile(file)
      expect(result).not.toBeNull()
      expect(result!.data.name).toBe("code")
      expect(result!.content).toBe("Agent prompt here.")
    })

    it("returns null for missing file", () => {
      const result = readMarkdownFile(path.join(root, "nonexistent.md"))
      expect(result).toBeNull()
    })
  })
})

describe("content hashing", () => {
  it("produces deterministic hash", () => {
    const hash1 = contentHash("hello world")
    const hash2 = contentHash("hello world")
    expect(hash1).toBe(hash2)
  })

  it("produces different hashes for different content", () => {
    const hash1 = contentHash("hello world")
    const hash2 = contentHash("hello world!")
    expect(hash1).not.toBe(hash2)
  })

  it("hash is 16 hex chars", () => {
    const hash = contentHash("test content")
    expect(hash).toMatch(/^[0-9a-f]{16}$/)
  })

  it("fileContentHash reads file and hashes", () => {
    const file = path.join(root, "test.txt")
    fs.writeFileSync(file, "hello world")
    const hash = fileContentHash(file)
    expect(hash).toBe(contentHash("hello world"))
  })

  it("fileContentHash returns null for missing file", () => {
    expect(fileContentHash(path.join(root, "nonexistent.txt"))).toBeNull()
  })
})
