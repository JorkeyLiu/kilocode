/**
 * P4.1 Canonical config foundation — atomic writes.
 *
 * Atomic JSONC/markdown editing with:
 * - Comment and trailing-comma preservation (jsonc-parser modify/applyEdits)
 * - Stale-write conflict detection with exact hash comparison
 * - Formatting preservation (2-space indent)
 * - Invalid-edit recovery (exact prior materialization preserved)
 * - Public write APIs validate against the closed registry before writing (F8)
 * - File disappearance with stamp returns stale conflict (F10)
 * - Source-preserving YAML document edits for existing markdown assets
 *
 * Per LOCK-003: temp-file + rename ensures concurrent readers never
 * observe partially written files. Missing parent dirs created on ENOENT.
 *
 * F12: Raw atomic helpers (atomicWrite, writeJsonc) are private.
 * Every exported canonical mutation validates the complete candidate
 * against the exact closed registry and scope before atomic write.
 * Existing markdown assets use updateFrontmatterKeys to preserve
 * YAML comments, ordering, and style where possible.
 */

import * as fs from "fs"
import * as path from "path"
import type { WriteResult, StaleWriteConflict, AssetDirectory } from "./types"
import { contentHash, readFile, parseJsonc, applyJsoncEdits, parseMarkdown, updateFrontmatterKeys } from "./parse"
import { detectStaleWrite } from "./materialize"
import { validateConfig, validateMarkdownAsset } from "./validate"

// ── Private atomic write (F12: raw helpers are not exported) ──────────

/**
 * Bounded residual micro-race: between the final CAS check and renameSync,
 * another process could modify the file. Portable atomic check-then-rename
 * is unavailable without OS-level file locks. This is a documented
 * filesystem limitation; same-service per-path serialization bounds the
 * window to external-process interference only.
 */
const FINAL_CAS_RACE_DOCS =
  "Bounded residual micro-race: final CAS check and rename are not atomic. " +
  "Same-service per-path serialization bounds the window to external processes only."

/**
 * Atomically write content to a file via temp-file + rename.
 * Creates parent directories if they don't exist.
 * Returns the content hash of the written content.
 *
 * When expectedHash is provided, performs a final content-stamp comparison
 * immediately before rename (Finding 10 / Finding 9 correction). If the
 * file changed since the initial CAS check, returns a stale conflict instead
 * of proceeding with the rename. The cleanup of the temp file is logged
 * visibly on failure.
 */
function atomicWrite(filePath: string, content: string): WriteResult
function atomicWrite(filePath: string, content: string, expectedHash: string): WriteResult | { readonly stale: true; readonly path: string }
function atomicWrite(filePath: string, content: string, expectedHash: string, beforeCas?: (filePath: string) => void): WriteResult | { readonly stale: true; readonly path: string }
function atomicWrite(
  filePath: string,
  content: string,
  expectedHash?: string,
  beforeCas?: (filePath: string) => void,
): WriteResult | { readonly stale: true; readonly path: string } {
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })

  const tmp = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`

  try {
    fs.writeFileSync(tmp, content, "utf-8")

    beforeCas?.(filePath)

    // Final CAS: re-read immediately before rename (Finding 10 / Finding 9 correction).
    // The bounded residual micro-race between this check and renameSync is a
    // filesystem limitation documented in FINAL_CAS_RACE_DOCS.
    if (expectedHash !== undefined) {
      const recheck = readFile(filePath)
      if (recheck.type === "present" && recheck.hash !== expectedHash) {
        console.error(`[Kilo Config] Final CAS stale: expected ${expectedHash}, got ${recheck.hash} for ${filePath}. Temp cleanup: unlink`)
        try { fs.unlinkSync(tmp) } catch (cleanupErr) {
          console.error(`[Kilo Config] Temp cleanup failed for ${tmp}: ${String(cleanupErr)}`)
        }
        return { stale: true, path: filePath }
      }
      if (recheck.type === "absent" && expectedHash !== "absent") {
        console.error(`[Kilo Config] Final CAS stale: expected ${expectedHash}, got absent for ${filePath}. Temp cleanup: unlink`)
        try { fs.unlinkSync(tmp) } catch (cleanupErr) {
          console.error(`[Kilo Config] Temp cleanup failed for ${tmp}: ${String(cleanupErr)}`)
        }
        return { stale: true, path: filePath }
      }
      if (recheck.type === "failure") {
        console.error(`[Kilo Config] Final CAS read failure: ${recheck.code} — ${recheck.message} for ${filePath}. Temp cleanup: unlink`)
        try { fs.unlinkSync(tmp) } catch (cleanupErr) {
          console.error(`[Kilo Config] Temp cleanup failed for ${tmp}: ${String(cleanupErr)}`)
        }
        return { stale: true, path: filePath }
      }
      // Absent: file was deleted — for create ops this is fine;
      // for updates, the initial CAS check already caught this.
    }

    fs.renameSync(tmp, filePath)
  } catch (err) {
    // Clean up temp file on failure with visible reporting (Finding 11)
    try {
      fs.unlinkSync(tmp)
    } catch (cleanupErr) {
      console.error(`[Kilo Config] Temp cleanup failed for ${tmp} after write error: ${String(cleanupErr)}`)
    }
    throw err
  }

  const hash = contentHash(content)
  return {
    path: filePath,
    contentHash: hash,
    version: 0, // Caller assigns version from materialization
    provenance: `file:${filePath}`,
  }
}

// ── Private JSONC write with comment preservation (F12) ──────────────

/**
 * Write a JSONC config file, preserving existing comments and structure.
 * Internal helper — all callers must validate before calling.
 * If the file exists, modifies individual top-level keys to preserve
 * comments attached to existing keys. If new, creates with standard
 * 2-space formatting.
 */
function writeJsonc(filePath: string, value: Record<string, unknown>): WriteResult
function writeJsonc(filePath: string, value: Record<string, unknown>, expectedHash: string): WriteResult | { readonly stale: true; readonly path: string }
function writeJsonc(filePath: string, value: Record<string, unknown>, expectedHash: string, beforeCas?: (filePath: string) => void): WriteResult | { readonly stale: true; readonly path: string }
function writeJsonc(
  filePath: string,
  value: Record<string, unknown>,
  expectedHash?: string,
  beforeCas?: (filePath: string) => void,
): WriteResult | { readonly stale: true; readonly path: string } {
  const existing = readFile(filePath)
  if (existing.type === "present") {
    const parsed = parseJsonc(existing.bytes)
    if (parsed.ok) {
      // Modify individual top-level keys to preserve comments
      let updated = existing.bytes
      // First, update/add keys from the new value
      for (const [key, val] of Object.entries(value)) {
        updated = applyJsoncEdits(updated, [key], val)
      }
      // Then, remove keys that are in the old value but not in the new
      for (const key of Object.keys(parsed.value)) {
        if (!(key in value)) {
          updated = applyJsoncEdits(updated, [key], undefined)
        }
      }
      return expectedHash !== undefined
         ? atomicWrite(filePath, updated, expectedHash, beforeCas)
        : atomicWrite(filePath, updated)
    }
  }

  // New file or unparseable existing — create fresh with formatting
  const content = JSON.stringify(value, null, 2) + "\n"
  return expectedHash !== undefined
     ? atomicWrite(filePath, content, expectedHash, beforeCas)
    : atomicWrite(filePath, content)
}

// ── Validation helper ────────────────────────────────────────────────

/**
 * Validate a candidate JSONC value against the closed registry before writing.
 * Throws on invalid data so the bytes are never committed.
 */
function validateBeforeWrite(
  value: Record<string, unknown>,
  scope: "global" | "project",
  filePath: string,
): void {
  const content = JSON.stringify(value, null, 2)
  const validation = validateConfig(content, scope, filePath)
  if (!validation.valid) {
    throw new Error(
      `Config validation failed: ${validation.errors.map((e) => e.message).join("; ")}`,
    )
  }
}

// ── Public JSONC write with stale-write detection ────────────────────

/**
 * F8: Write JSONC with stale-write detection and registry validation.
 * Validates the config against the closed registry before writing.
 * F10: If the file has disappeared since lastHash, returns a StaleWriteConflict
 * with an explicit absent actual state.
 */
export function writeJsoncWithConflictDetection(
  filePath: string,
  value: Record<string, unknown>,
  lastHash: string,
  scope: "global" | "project",
  beforeCas?: (filePath: string) => void,
): { written: WriteResult } | { conflict: StaleWriteConflict } {
  const existing = readFile(filePath)

  // F10: File disappeared with a stamp → stale conflict with absent state
  if (existing.type === "absent" && lastHash !== "absent") {
    return {
      conflict: {
        expectedHash: lastHash,
        actualHash: "absent",
        path: filePath,
      },
    }
  }

  // F10: Read failure → stale conflict
  if (existing.type === "failure") {
    return {
      conflict: {
        expectedHash: lastHash,
        actualHash: `error:${existing.code}`,
        path: filePath,
      },
    }
  }

  if (existing.type === "present") {
    const conflict = detectStaleWrite(lastHash, existing.bytes, filePath)
    if (conflict) return { conflict }
  }

  // F8: Validate against registry before writing
  validateBeforeWrite(value, scope, filePath)

  // Final CAS: re-read immediately before write (Finding 10 / Finding 9 correction).
  // The bounded residual micro-race between this check and the atomic rename
  // in writeJsonc/atomicWrite is documented in FINAL_CAS_RACE_DOCS.
  const finalCheck = readFile(filePath)
  if (finalCheck.type === "present") {
    const finalConflict = detectStaleWrite(lastHash, finalCheck.bytes, filePath)
    if (finalConflict) return { conflict: finalConflict }
  } else if (finalCheck.type === "failure") {
    return { conflict: { expectedHash: lastHash, actualHash: `error:${finalCheck.code}`, path: filePath } }
  }
  // Absent: acceptable for creates; updates were caught by initial CAS check above.

  const writeResult = writeJsonc(filePath, value, lastHash, beforeCas)
  if ("stale" in writeResult) {
    // Final CAS inside atomicWrite detected a race (Finding 10 / Finding 9 correction)
    return { conflict: { expectedHash: lastHash, actualHash: "changed-before-rename", path: filePath } }
  }
  return { written: writeResult }
}

// ── Markdown write with source preservation ──────────────────────────

/**
 * Serialize fresh YAML frontmatter from a data record.
 * Used when creating a new file or when the existing file has no frontmatter.
 */
function serializeFreshFrontmatter(data: Record<string, unknown>): string {
  const { stringify: yamlStr, parseDocument: yamlParseDoc } = require("yaml")
  const doc = yamlParseDoc("")
  const map = new Map(Object.entries(data))
  doc.contents = map as any
  return yamlStr(doc)
}

/**
 * Write a markdown file with frontmatter and body.
 *
 * For existing files with frontmatter, uses source-preserving YAML document
 * edits (updateFrontmatterKeys) to preserve comments, formatting, and key
 * order. Returns a diagnostic error for malformed existing YAML without
 * writing any bytes.
 *
 * For new files or existing files without frontmatter, serializes cleanly
 * with proper YAML formatting.
 *
 * When assetType is provided, validates the assembled markdown against the
 * asset's Zod schema before writing. Returns a diagnostic error on invalid
 * data without writing any bytes.
 */
export function writeMarkdown(
  filePath: string,
  frontmatter: Record<string, unknown>,
  body: string,
  assetType: AssetDirectory,
): WriteResult | { error: string } {
  const existing = readFile(filePath)
  let yamlContent: string

  if (existing.type === "present") {
    const parsed = parseMarkdown(existing.bytes)
    if (parsed.frontmatterRaw) {
      // Source-preserving edit: update existing frontmatter keys while
      // preserving comments, ordering, and style.
      const result = updateFrontmatterKeys(parsed.frontmatterRaw, frontmatter)
      if (!result.ok) {
        return { error: `Malformed YAML frontmatter: ${result.error}` }
      }
      yamlContent = result.value
    } else {
      // Existing file without frontmatter — create frontmatter section
      yamlContent = serializeFreshFrontmatter(frontmatter)
    }
  } else {
    // New file — serialize cleanly
    yamlContent = serializeFreshFrontmatter(frontmatter)
  }

  // Assemble full markdown
  const parts: string[] = ["---\n", yamlContent, "---\n"]
  if (body) {
    parts.push("\n")
    parts.push(body)
    if (!body.endsWith("\n")) parts.push("\n")
  }
  const content = parts.join("")

  // Validate before writing
  const validation = validateMarkdownAsset(content, assetType, filePath)
  if (!validation.valid) {
    return {
      error: `Asset validation failed: ${validation.errors.map((e) => e.message).join("; ")}`,
    }
  }

  return atomicWrite(filePath, content)
}

// ── Stale-write detection ────────────────────────────────────────────

/**
 * Edit a JSONC config file atomically with stale-write detection.
 * Reads the current content, applies a patch function, validates the result
 * against the closed registry, then writes.
 * F10: Returns stale-write conflict if the file disappeared with a stamp.
 */
export function editJsonc(
  filePath: string,
  patchFn: (current: Record<string, unknown>) => Record<string, unknown>,
  lastHash: string | undefined,
  scope: "global" | "project",
): { written: WriteResult } | { conflict: StaleWriteConflict } {
  const existing = readFile(filePath)
  let current: Record<string, unknown> = {}

  if (existing.type === "present") {
    // Check stale write
    if (lastHash !== undefined) {
      const conflict = detectStaleWrite(lastHash, existing.bytes, filePath)
      if (conflict) return { conflict }
    }

    const parsed = parseJsonc(existing.bytes)
    if (!parsed.ok) {
      throw new Error(`Cannot edit invalid JSONC: ${parsed.error}`)
    }
    current = parsed.value
  } else if (existing.type === "failure") {
    if (lastHash !== undefined) {
      return {
        conflict: {
          expectedHash: lastHash,
          actualHash: `error:${existing.code}`,
          path: filePath,
        },
      }
    }
  } else if (lastHash !== undefined) {
    // F10: File disappeared with a stamp → stale conflict
    return {
      conflict: {
        expectedHash: lastHash,
        actualHash: "absent",
        path: filePath,
      },
    }
  }

  const next = patchFn(current)
  // F8: Validate patched result before writing
  validateBeforeWrite(next, scope, filePath)
  return { written: writeJsonc(filePath, next) }
}

// ── Delete / unset with stale conflict ───────────────────────────────

/**
 * Remove a key from a JSONC config file atomically.
 * Validates the result against the closed registry before writing.
 * Requires a content hash stamp for stale conflict detection.
 * F10: If the file disappeared with a stamp, returns stale conflict.
 * If the file becomes empty (no remaining keys), the file is deleted.
 * Returns the write result, deleted flag, or stale conflict.
 */
export function unsetKey(
  filePath: string,
  key: string,
  expectedHash: string,
  scope: "global" | "project",
):
  | { written: WriteResult }
  | { deleted: true }
  | { conflict: StaleWriteConflict }
  | null {
  const existing = readFile(filePath)

  // F10: File disappeared with a stamp → stale conflict
  if (existing.type === "absent") {
    return {
      conflict: {
        expectedHash,
        actualHash: "absent",
        path: filePath,
      },
    }
  }

  // F10: Read failure → stale conflict
  if (existing.type === "failure") {
    return {
      conflict: {
        expectedHash,
        actualHash: `error:${existing.code}`,
        path: filePath,
      },
    }
  }

  // Stale check
  const conflict = detectStaleWrite(expectedHash, existing.bytes, filePath)
  if (conflict) return { conflict }

  const parsed = parseJsonc(existing.bytes)
  if (!parsed.ok) return null

  const next = { ...parsed.value }
  delete next[key]

  if (Object.keys(next).length === 0) {
    fs.unlinkSync(filePath)
    return { deleted: true }
  }

  // F8: Validate result before writing
  validateBeforeWrite(next, scope, filePath)
  return { written: writeJsonc(filePath, next) }
}

/**
 * Remove a nested key from a JSONC config file atomically.
 * Validates the result against the closed registry before writing.
 * Requires a content hash stamp for stale conflict detection.
 * Prunes empty parent objects after removal.
 */
export function unsetNestedKey(
  filePath: string,
  keyPath: string[],
  expectedHash: string,
  scope: "global" | "project",
):
  | { written: WriteResult }
  | { deleted: true }
  | { conflict: StaleWriteConflict }
  | null {
  const existing = readFile(filePath)

  // F10: File disappeared with a stamp → stale conflict
  if (existing.type === "absent") {
    return {
      conflict: {
        expectedHash,
        actualHash: "absent",
        path: filePath,
      },
    }
  }

  // F10: Read failure → stale conflict
  if (existing.type === "failure") {
    return {
      conflict: {
        expectedHash,
        actualHash: `error:${existing.code}`,
        path: filePath,
      },
    }
  }

  // Stale check
  const conflict = detectStaleWrite(expectedHash, existing.bytes, filePath)
  if (conflict) return { conflict }

  const parsed = parseJsonc(existing.bytes)
  if (!parsed.ok) return null

  // Remove the key and prune empty parent objects
  const next = { ...parsed.value }
  removeAtPath(next, keyPath)

  if (Object.keys(next).length === 0) {
    fs.unlinkSync(filePath)
    return { deleted: true }
  }

  // F8: Validate result before writing
  validateBeforeWrite(next, scope, filePath)
  return { written: writeJsonc(filePath, next) }
}

// ── Helpers ──────────────────────────────────────────────────────────

function removeAtPath(obj: Record<string, unknown>, keyPath: string[]): void {
  const [head, ...rest] = keyPath
  if (head === undefined) return
  if (rest.length === 0) {
    delete obj[head]
    return
  }
  const next = obj[head]
  if (!next || typeof next !== "object" || Array.isArray(next)) return
  removeAtPath(next as Record<string, unknown>, rest)
  if (Object.keys(next).length === 0) delete obj[head]
}
