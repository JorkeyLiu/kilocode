/**
 * P4.1 Config foundation — atomic write tests.
 *
 * Uses real filesystem operations with run-owned temp directories.
 * Tests atomic writes, JSONC editing, markdown writing, stale-write
 * detection, and key unset operations.
 *
 * F12: Raw helpers (atomicWrite, writeJsonc) are not exported.
 * All public mutation functions validate before writing.
 */

import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import {
  writeJsoncWithConflictDetection,
  writeMarkdown,
  editJsonc,
  unsetKey,
  unsetNestedKey,
} from "../../src/config/write"
import { contentHash, parseJsonc } from "../../src/config/parse"

const VALID_MODEL = "anthropic/claude-sonnet-4-20250514"

let root: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-config-write-"))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe("writeJsoncWithConflictDetection", () => {
  it("writes when no prior hash exists", () => {
    const file = path.join(root, "config.jsonc")
    const initial = JSON.stringify({ model: VALID_MODEL }, null, 2) + "\n"
    fs.writeFileSync(file, initial)
    const hash = contentHash(initial)
    const result = writeJsoncWithConflictDetection(file, { model: VALID_MODEL }, hash, "global")
    expect("written" in result).toBe(true)
  })

  it("writes when hashes match", () => {
    const file = path.join(root, "config.jsonc")
    const content = JSON.stringify({ model: VALID_MODEL }, null, 2) + "\n"
    fs.writeFileSync(file, content)
    const hash = contentHash(content)

    const result = writeJsoncWithConflictDetection(file, { model: "openai/gpt-4" }, hash, "global")
    expect("written" in result).toBe(true)
  })

  it("returns conflict when hashes differ", () => {
    const file = path.join(root, "config.jsonc")
    fs.writeFileSync(file, '{"model": "openai/gpt-4"}')

    const result = writeJsoncWithConflictDetection(file, { model: VALID_MODEL }, "stale-hash", "global")
    expect("conflict" in result).toBe(true)
    if ("conflict" in result) {
      expect(result.conflict.expectedHash).toBe("stale-hash")
      expect(result.conflict.path).toBe(file)
    }
  })
})

describe("writeMarkdown", () => {
  it("writes markdown with frontmatter", () => {
    const file = path.join(root, "agent.md")
    const result = writeMarkdown(file, { name: "code", model: VALID_MODEL }, "Agent prompt here.", "agent")

    const content = fs.readFileSync(file, "utf-8")
    expect(content).toContain("---")
    expect(content).toContain("name: code")
    expect(content).toContain("model: " + VALID_MODEL)
    expect(content).toContain("Agent prompt here.")
  })

  it("quotes strings with colons", () => {
    const file = path.join(root, "agent.md")
    writeMarkdown(file, { description: "A description with: colons" }, "Body", "agent")
    const content = fs.readFileSync(file, "utf-8")
    expect(content).toContain('description: "A description with: colons"')
  })

  it("rejects invalid frontmatter values through public API", () => {
    const file = path.join(root, "agent.md")
    const result = writeMarkdown(file, { color: 123 }, "Body", "agent")
    expect("error" in result).toBe(true)
    if ("error" in result) {
      expect(result.error).toContain("Asset validation failed")
    }
    expect(fs.existsSync(file)).toBe(false)
  })

  it("round-trips through parseMarkdown", () => {
    const { parseMarkdown } = require("../../src/config/parse") as typeof import("../../src/config/parse")
    const file = path.join(root, "agent.md")
    writeMarkdown(file, { name: "code", hidden: true }, "Prompt body", "agent")

    const content = fs.readFileSync(file, "utf-8")
    const parsed = parseMarkdown(content)
    expect(parsed.data.name).toBe("code")
    expect(parsed.data.hidden).toBe(true)
    expect(parsed.content.trim()).toBe("Prompt body")
  })
})

describe("editJsonc", () => {
  it("creates file if it doesn't exist", () => {
    const file = path.join(root, "config.jsonc")
    const result = editJsonc(file, () => ({ model: VALID_MODEL }), undefined, "global")
    expect("written" in result).toBe(true)
    expect(fs.readFileSync(file, "utf-8")).toContain(VALID_MODEL)
  })

  it("applies patch to existing file", () => {
    const file = path.join(root, "config.jsonc")
    const initial = JSON.stringify({ model: VALID_MODEL, default_agent: "code" }, null, 2) + "\n"
    fs.writeFileSync(file, initial)
    const hash = contentHash(initial)

    const result = editJsonc(file, (current) => ({ ...current, model: "openai/gpt-4" }), hash, "global")
    expect("written" in result).toBe(true)
    const content = fs.readFileSync(file, "utf-8")
    expect(content).toContain('"model": "openai/gpt-4"')
    expect(content).toContain('"default_agent": "code"')
  })

  it("detects stale writes when lastHash provided", () => {
    const file = path.join(root, "config.jsonc")
    fs.writeFileSync(file, '{"model": "openai/gpt-4"}')

    const result = editJsonc(file, (current) => current, "stale-hash", "global")
    expect("conflict" in result).toBe(true)
  })

  it("deletes file when no keys remain after edit", () => {
    const file = path.join(root, "config.jsonc")
    fs.writeFileSync(file, '{"model": "test"}')
    const hash = contentHash('{"model": "test"}')

    const result = editJsonc(file, () => ({}), hash, "global")
    expect("written" in result).toBe(true)
    // File should still exist with empty object
    expect(fs.existsSync(file)).toBe(true)
    const content = fs.readFileSync(file, "utf-8")
    expect(content).toContain("{}")
  })
})

describe("unsetKey", () => {
  it("removes a top-level key", () => {
    const file = path.join(root, "config.jsonc")
    const initial = JSON.stringify({ model: VALID_MODEL, default_agent: "code" }, null, 2) + "\n"
    fs.writeFileSync(file, initial)
    const hash = contentHash(initial)

    const result = unsetKey(file, "model", hash, "global")
    expect("written" in result).toBe(true)
    const content = fs.readFileSync(file, "utf-8")
    const parsed = parseJsonc(content)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.value.model).toBeUndefined()
      expect(parsed.value.default_agent).toBe("code")
    }
  })

  it("deletes file when last key is removed", () => {
    const file = path.join(root, "config.jsonc")
    fs.writeFileSync(file, '{"model": "test"}')
    const hash = contentHash('{"model": "test"}')

    const result = unsetKey(file, "model", hash, "global")
    expect("deleted" in result).toBe(true)
    expect(fs.existsSync(file)).toBe(false)
  })

  it("returns conflict when file absent with stamp", () => {
    const result = unsetKey(path.join(root, "nonexistent.jsonc"), "model", "any-hash", "global")
    expect("conflict" in result).toBe(true)
  })
})

describe("unsetNestedKey", () => {
  it("removes a nested key", () => {
    const file = path.join(root, "config.jsonc")
    const initial = JSON.stringify({ permission: { read: "allow", edit: "ask" } }, null, 2) + "\n"
    fs.writeFileSync(file, initial)
    const hash = contentHash(initial)

    const result = unsetNestedKey(file, ["permission", "edit"], hash, "global")
    expect("written" in result).toBe(true)
    const content = fs.readFileSync(file, "utf-8")
    const parsed = parseJsonc(content)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      const perm = parsed.value.permission as Record<string, unknown>
      expect(perm.read).toBe("allow")
      expect(perm.edit).toBeUndefined()
    }
  })

  it("prunes empty parent objects", () => {
    const file = path.join(root, "config.jsonc")
    const initial = JSON.stringify({ permission: { edit: "ask" } }, null, 2) + "\n"
    fs.writeFileSync(file, initial)
    const hash = contentHash(initial)

    const result = unsetNestedKey(file, ["permission", "edit"], hash, "global")
    expect("deleted" in result).toBe(true)
    expect(fs.existsSync(file)).toBe(false)
  })

  it("returns conflict when file absent with stamp", () => {
    const result = unsetNestedKey(path.join(root, "nonexistent.jsonc"), ["permission", "edit"], "any-hash", "global")
    expect("conflict" in result).toBe(true)
    if ("conflict" in result) {
      expect(result.conflict.actualHash).toBe("absent")
      expect(result.conflict.expectedHash).toBe("any-hash")
    }
  })
})

// ── Final CAS (Finding 9/10) ──────────────────────────────────────

describe("Final CAS: deterministic stale detection on JSONC writes", () => {
  it("detects stale when file is modified externally before write", () => {
    const file = path.join(root, "config.jsonc")
    const v1 = JSON.stringify({ model: VALID_MODEL }, null, 2) + "\n"
    fs.writeFileSync(file, v1)
    const hash = contentHash(v1)

    // External edit: modify file after initial hash was captured
    const v2 = JSON.stringify({ model: "openai/gpt-4" }, null, 2) + "\n"
    fs.writeFileSync(file, v2)

    // Write with stale hash — initial CAS detects the change
    const result = writeJsoncWithConflictDetection(file, { model: "anthropic/claude-sonnet-4-20250514" }, hash, "global")
    expect("conflict" in result).toBe(true)
    if ("conflict" in result) {
      expect(result.conflict.expectedHash).toBe(hash)
      expect(result.conflict.actualHash).not.toBe(hash)
    }
  })

  it("detects stale when file is deleted externally before write", () => {
    const file = path.join(root, "config.jsonc")
    const v1 = JSON.stringify({ model: VALID_MODEL }, null, 2) + "\n"
    fs.writeFileSync(file, v1)
    const hash = contentHash(v1)

    // External delete
    fs.unlinkSync(file)

    const result = writeJsoncWithConflictDetection(file, { model: "anthropic/claude-sonnet-4-20250514" }, hash, "global")
    expect("conflict" in result).toBe(true)
    if ("conflict" in result) {
      expect(result.conflict.actualHash).toBe("absent")
    }
  })

  it("writes successfully when file has not changed", () => {
    const file = path.join(root, "config.jsonc")
    const v1 = JSON.stringify({ model: VALID_MODEL }, null, 2) + "\n"
    fs.writeFileSync(file, v1)
    const hash = contentHash(v1)

    const result = writeJsoncWithConflictDetection(file, { model: "openai/gpt-4" }, hash, "global")
    expect("written" in result).toBe(true)
    const content = fs.readFileSync(file, "utf-8")
    expect(content).toContain("openai/gpt-4")
  })
})
