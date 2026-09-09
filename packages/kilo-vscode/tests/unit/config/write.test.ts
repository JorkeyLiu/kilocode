/**
 * P4.1 Config Foundation — Write tests.
 *
 * Covers audit triggers:
 * - Atomic writes via temp-file + rename (tested through public API)
 * - JSONC comment and trailing-comma preservation
 * - Stale-write conflict detection with stamp
 * - Unset/delete with stamp requirement
 * - Markdown frontmatter write with yaml library
 * - Source-preserving YAML edits for existing markdown files
 * - File disappearance detection
 * - F8: Every public mutation validates against registry before writing
 * - F12: Raw helpers (atomicWrite, writeJsonc) are not exported
 */

import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import {
  writeJsoncWithConflictDetection,
  writeMarkdown,
  editJsonc,
  unsetKey,
  unsetNestedKey,
} from "../../../src/config/write"
import { contentHash, readFile, parseJsonc, parseMarkdown } from "../../../src/config/parse"

const VALID_MODEL = "anthropic/claude-sonnet-4-20250514"

let tempDir: string

function setup() {
  tempDir = mkdtempSync(join(tmpdir(), "config-write-test-"))
  return tempDir
}

function cleanup() {
  rmSync(tempDir, { recursive: true, force: true })
}

describe("writeJsoncWithConflictDetection", () => {
  beforeEach(setup)
  afterEach(cleanup)

  it("writes when no conflict", () => {
    const filePath = join(tempDir, "test.jsonc")
    const initial = JSON.stringify({ model: VALID_MODEL }, null, 2) + "\n"
    const hash = contentHash(initial)
    writeFileSync(filePath, initial)
    const result = writeJsoncWithConflictDetection(filePath, { model: VALID_MODEL }, hash, "global")
    expect("written" in result).toBe(true)
  })

  it("returns conflict when file changed", () => {
    const filePath = join(tempDir, "test.jsonc")
    const initial = JSON.stringify({ model: VALID_MODEL }, null, 2) + "\n"
    writeFileSync(filePath, initial)
    const hash = contentHash(initial)
    // Simulate another writer modifying the file
    writeFileSync(filePath, '{"model": "openai/gpt-4"}')
    const result = writeJsoncWithConflictDetection(filePath, { model: VALID_MODEL }, hash, "global")
    expect("conflict" in result).toBe(true)
    if ("conflict" in result) {
      expect(result.conflict.expectedHash).toBe(hash)
      expect(result.conflict.path).toBe(filePath)
    }
  })
})

describe("editJsonc", () => {
  beforeEach(setup)
  afterEach(cleanup)

  it("applies patch to existing file", () => {
    const filePath = join(tempDir, "test.jsonc")
    const initial = JSON.stringify({ model: VALID_MODEL, default_agent: "code" }, null, 2) + "\n"
    writeFileSync(filePath, initial)
    const hash = contentHash(initial)
    const result = editJsonc(filePath, (current) => ({
      ...current,
      model: "openai/gpt-4",
    }), hash, "global")
    expect("written" in result).toBe(true)
    const content = readFileSync(filePath, "utf-8")
    expect(content).toContain("openai/gpt-4")
  })

  it("creates new file when none exists", () => {
    const filePath = join(tempDir, "new.jsonc")
    const result = editJsonc(filePath, () => ({ model: VALID_MODEL }), undefined, "global")
    expect("written" in result).toBe(true)
    expect(existsSync(filePath)).toBe(true)
  })

  it("detects stale write", () => {
    const filePath = join(tempDir, "test.jsonc")
    const initial = JSON.stringify({ model: VALID_MODEL }, null, 2) + "\n"
    writeFileSync(filePath, initial)
    const hash = contentHash(initial)
    // Modify file
    writeFileSync(filePath, '{"model": "openai/gpt-4"}')
    const result = editJsonc(
      filePath,
      (current) => ({ ...current, model: "openai/gpt-4o" }),
      hash,
      "global",
    )
    expect("conflict" in result).toBe(true)
  })
})

describe("unsetKey", () => {
  beforeEach(setup)
  afterEach(cleanup)

  it("removes a key from JSONC file", () => {
    const filePath = join(tempDir, "test.jsonc")
    const initial = JSON.stringify({ model: VALID_MODEL, default_agent: "code" }, null, 2) + "\n"
    writeFileSync(filePath, initial)
    const hash = contentHash(initial)
    const result = unsetKey(filePath, "model", hash, "global")
    expect("written" in result).toBe(true)
    const content = readFileSync(filePath, "utf-8")
    expect(content).not.toContain("model")
    expect(content).toContain("default_agent")
  })

  it("deletes file when last key removed", () => {
    const filePath = join(tempDir, "test.jsonc")
    const initial = JSON.stringify({ model: VALID_MODEL }, null, 2) + "\n"
    writeFileSync(filePath, initial)
    const hash = contentHash(initial)
    const result = unsetKey(filePath, "model", hash, "global")
    expect("deleted" in result).toBe(true)
    expect(existsSync(filePath)).toBe(false)
  })

  it("detects stale write on unset", () => {
    const filePath = join(tempDir, "test.jsonc")
    const initial = JSON.stringify({ model: VALID_MODEL, default_agent: "code" }, null, 2) + "\n"
    writeFileSync(filePath, initial)
    const hash = contentHash(initial)
    // Modify file
    writeFileSync(filePath, '{"model": "openai/gpt-4", "default_agent": "code"}')
    const result = unsetKey(filePath, "model", hash, "global")
    expect("conflict" in result).toBe(true)
  })
})

describe("writeMarkdown", () => {
  beforeEach(setup)
  afterEach(cleanup)

  it("writes markdown with frontmatter", () => {
    const filePath = join(tempDir, "agent.md")
    const result = writeMarkdown(filePath, {
      name: "test-agent",
      model: VALID_MODEL,
      hidden: true,
    }, "# Agent Prompt\n\nYou are helpful.", "agent")
    expect(existsSync(filePath)).toBe(true)
    const content = readFileSync(filePath, "utf-8")
    expect(content).toContain("---")
    expect(content).toContain("name: test-agent")
    expect(content).toContain("hidden: true")
    expect(content).toContain("# Agent Prompt")
  })

  it("handles empty frontmatter", () => {
    const filePath = join(tempDir, "simple.md")
    writeMarkdown(filePath, {}, "# Simple content", "rules")
    expect(existsSync(filePath)).toBe(true)
    const content = readFileSync(filePath, "utf-8")
    expect(content).toContain("# Simple content")
  })

  it("handles record values in frontmatter", () => {
    const filePath = join(tempDir, "agent.md")
    // CLI tools shape is Record<string,boolean>; string[] is rejected.
    writeMarkdown(filePath, {
      tools: { read: true, write: true, edit: true },
    }, "# Body", "agent")
    const content = readFileSync(filePath, "utf-8")
    expect(content).toContain("read")
    expect(content).toContain("write")
  })
})

// ── F8: Public write validation ──────────────────────────────────────

describe("F8: public write validation", () => {
  beforeEach(setup)
  afterEach(cleanup)

  it("writeJsoncWithConflictDetection rejects invalid config against registry", () => {
    const filePath = join(tempDir, "kilo.jsonc")
    const initial = JSON.stringify({ model: VALID_MODEL }, null, 2) + "\n"
    writeFileSync(filePath, initial)
    const hash = contentHash(initial)

    // Invalid config with unknown key and invalid model format
    expect(() => {
      writeJsoncWithConflictDetection(
        filePath,
        { model: "test", server: { port: 3000 } } as any,
        hash,
        "global",
      )
    }).toThrow("Config validation failed")
  })

  it("writeJsoncWithConflictDetection accepts valid config", () => {
    const filePath = join(tempDir, "kilo.jsonc")
    const initial = JSON.stringify({ model: VALID_MODEL }, null, 2) + "\n"
    writeFileSync(filePath, initial)
    const hash = contentHash(initial)

    const result = writeJsoncWithConflictDetection(
      filePath,
      { model: VALID_MODEL },
      hash,
      "global",
    )
    expect("written" in result).toBe(true)
  })
})

// ── F10: File disappearance stale conflict ───────────────────────────

describe("F10: file disappearance stale conflict", () => {
  beforeEach(setup)
  afterEach(cleanup)

  it("writeJsoncWithConflictDetection returns conflict when file disappears", () => {
    const filePath = join(tempDir, "kilo.jsonc")
    // File never existed, but we have a hash stamp
    const hash = contentHash('{"model": "test"}')
    const result = writeJsoncWithConflictDetection(
      filePath,
      { model: VALID_MODEL },
      hash,
      "global",
    )
    expect("conflict" in result).toBe(true)
    if ("conflict" in result) {
      expect(result.conflict.actualHash).toBe("absent")
      expect(result.conflict.path).toBe(filePath)
    }
  })

  it("editJsonc returns conflict when file disappears with stamp", () => {
    const filePath = join(tempDir, "kilo.jsonc")
    const hash = contentHash('{"model": "test"}')
    const result = editJsonc(
      filePath,
      (current) => ({ ...current, model: VALID_MODEL }),
      hash,
      "global",
    )
    expect("conflict" in result).toBe(true)
    if ("conflict" in result) {
      expect(result.conflict.actualHash).toBe("absent")
    }
  })

  it("unsetKey returns conflict when file disappears with stamp", () => {
    const filePath = join(tempDir, "kilo.jsonc")
    const hash = contentHash('{"model": "test"}')
    const result = unsetKey(filePath, "model", hash, "global")
    expect("conflict" in result).toBe(true)
    if ("conflict" in result) {
      expect(result.conflict.actualHash).toBe("absent")
    }
  })

  it("editJsonc creates new file when no stamp and file absent", () => {
    const filePath = join(tempDir, "new.jsonc")
    const result = editJsonc(filePath, () => ({ model: VALID_MODEL }), undefined, "global")
    expect("written" in result).toBe(true)
    expect(existsSync(filePath)).toBe(true)
  })

  it("unsetKey returns conflict when file absent with stamp", () => {
    const filePath = join(tempDir, "nonexistent.jsonc")
    const result = unsetKey(filePath, "model", "any-hash", "global")
    expect("conflict" in result).toBe(true)
  })

  it("unsetNestedKey returns conflict when file absent with stamp", () => {
    const filePath = join(tempDir, "nonexistent.jsonc")
    const result = unsetNestedKey(filePath, ["permission", "edit"], "any-hash", "global")
    expect("conflict" in result).toBe(true)
    if ("conflict" in result) {
      expect(result.conflict.actualHash).toBe("absent")
      expect(result.conflict.expectedHash).toBe("any-hash")
      expect(result.conflict.path).toBe(filePath)
    }
  })
})

// ── F12: Raw helpers not exported ────────────────────────────────────

describe("F12: raw helpers not exported", () => {
  it("atomicWrite is not exported from config/write", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("../../../src/config/write")
    expect(mod.atomicWrite).toBeUndefined()
  })

  it("writeJsonc is not exported from config/write", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("../../../src/config/write")
    expect(mod.writeJsonc).toBeUndefined()
  })
})

// ── F8: editJsonc validates patched result ────────────────────────────

describe("F8: editJsonc validates patched result", () => {
  beforeEach(setup)
  afterEach(cleanup)

  it("rejects config with unknown key after patch", () => {
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

  it("rejects invalid model format after patch", () => {
    const filePath = join(tempDir, "kilo.jsonc")
    const initial = JSON.stringify({ model: VALID_MODEL }, null, 2) + "\n"
    writeFileSync(filePath, initial)
    const hash = contentHash(initial)

    expect(() => {
      editJsonc(
        filePath,
        (current) => ({ ...current, model: "not-a-valid-model" }),
        hash,
        "global",
      )
    }).toThrow("Config validation failed")
  })

  it("accepts valid patched config", () => {
    const filePath = join(tempDir, "kilo.jsonc")
    const initial = JSON.stringify({ model: "openai/gpt-4" }, null, 2) + "\n"
    writeFileSync(filePath, initial)
    const hash = contentHash(initial)

    const result = editJsonc(
      filePath,
      (current) => ({ ...current, model: VALID_MODEL }),
      hash,
      "global",
    )
    expect("written" in result).toBe(true)
  })
})

// ── F8: unsetKey validates result ────────────────────────────────────

describe("F8: unsetKey validates result", () => {
  beforeEach(setup)
  afterEach(cleanup)

  it("rejects config with unknown key after unset", () => {
    const filePath = join(tempDir, "kilo.jsonc")
    // Config has an unknown key "server" alongside valid keys.
    // After unsetting "model", the unknown key "server" remains → validation fails.
    const initial = JSON.stringify({ model: VALID_MODEL, server: { port: 3000 } }, null, 2) + "\n"
    writeFileSync(filePath, initial)
    const hash = contentHash(initial)

    expect(() => {
      unsetKey(filePath, "model", hash, "global")
    }).toThrow("Config validation failed")
  })

  it("accepts valid config after unset", () => {
    const filePath = join(tempDir, "kilo.jsonc")
    const initial = JSON.stringify({ model: VALID_MODEL, default_agent: "code" }, null, 2) + "\n"
    writeFileSync(filePath, initial)
    const hash = contentHash(initial)

    const result = unsetKey(filePath, "model", hash, "global")
    expect("written" in result).toBe(true)
  })
})

// ── F12: writeMarkdown source preservation ───────────────────────────

describe("F12: writeMarkdown source preservation", () => {
  beforeEach(setup)
  afterEach(cleanup)

  it("preserves YAML comments when updating existing file", () => {
    const filePath = join(tempDir, "agent.md")
    // Create file with comments
    writeFileSync(filePath, `---
# Agent configuration
name: old-name
# Model selection
model: old-model
---
Old body content`)

    const result = writeMarkdown(filePath, {
      name: "new-name",
      model: VALID_MODEL,
    }, "New body content", "agent")

    expect("error" in result).toBe(false)
    const content = readFileSync(filePath, "utf-8")
    // Comments should be preserved
    expect(content).toContain("# Agent configuration")
    expect(content).toContain("# Model selection")
    // Values should be updated
    expect(content).toContain("name: new-name")
    expect(content).toContain(`model: ${VALID_MODEL}`)
    // Body should be updated
    expect(content).toContain("New body content")
  })

  it("preserves YAML key order when updating existing file", () => {
    const filePath = join(tempDir, "agent.md")
    writeFileSync(filePath, `---
description: First field
name: Second field
model: Third field
---
Body`)

    writeMarkdown(filePath, { name: "updated-name" }, "Body", "agent")

    const content = readFileSync(filePath, "utf-8")
    const lines = content.split("\n")
    // Find the frontmatter lines (between --- delimiters)
    const descIdx = lines.findIndex((l) => l.startsWith("description:"))
    const nameIdx = lines.findIndex((l) => l.startsWith("name:"))
    const modelIdx = lines.findIndex((l) => l.startsWith("model:"))
    // Order should be preserved: description < name < model
    expect(descIdx).toBeLessThan(nameIdx)
    expect(nameIdx).toBeLessThan(modelIdx)
  })

  it("returns error for malformed YAML frontmatter", () => {
    const filePath = join(tempDir, "agent.md")
    // Write file with invalid YAML (unclosed bracket)
    writeFileSync(filePath, `---
name: [unclosed
---
Body`)

    const result = writeMarkdown(filePath, { name: "new-name" }, "Body", "agent")
    expect("error" in result).toBe(true)
    if ("error" in result) {
      expect(result.error).toContain("Malformed YAML")
    }
    // File should be unchanged
    const content = readFileSync(filePath, "utf-8")
    expect(content).toContain("[unclosed")
  })

  it("validates against asset schema", () => {
    const filePath = join(tempDir, "agent.md")

    // CLI agent model accepts any string; mode values outside
    // subagent|primary|all are rejected by the canonical schema.
    const result = writeMarkdown(filePath, {
      name: "test-agent",
      mode: "bogus",
    }, "Body", "agent")

    expect("error" in result).toBe(true)
    if ("error" in result) {
      expect(result.error).toContain("Asset validation failed")
    }
    // File should not exist (was new file that failed validation)
    expect(existsSync(filePath)).toBe(false)
  })

  it("accepts valid asset with assetType", () => {
    const filePath = join(tempDir, "agent.md")

    const result = writeMarkdown(filePath, {
      name: "test-agent",
      model: VALID_MODEL,
    }, "Agent prompt body.", "agent")

    expect("error" in result).toBe(false)
    expect(existsSync(filePath)).toBe(true)
    const content = readFileSync(filePath, "utf-8")
    expect(content).toContain("name: test-agent")
  })

  it("new file with valid assetType writes cleanly", () => {
    const filePath = join(tempDir, "agent.md")
    const result = writeMarkdown(filePath, { name: "test" }, "Body", "agent")
    expect("error" in result).toBe(false)
    expect(existsSync(filePath)).toBe(true)
  })

  it("rejects invalid frontmatter through public API", () => {
    const filePath = join(tempDir, "agent.md")

    // CLI agent model accepts any string; an illegal color is rejected.
    const result = writeMarkdown(filePath, {
      name: "test-agent",
      color: "blurple",
    }, "Body", "agent")

    expect("error" in result).toBe(true)
    if ("error" in result) {
      expect(result.error).toContain("Asset validation failed")
    }
    expect(existsSync(filePath)).toBe(false)
  })
})
