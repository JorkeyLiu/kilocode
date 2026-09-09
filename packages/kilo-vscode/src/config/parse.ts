/**
 * P4.1 Canonical config foundation — JSONC and markdown parsing.
 *
 * Uses jsonc-parser (real library) for JSONC: comment/trailing-comma
 * preservation via modify/applyEdits; parse for reading.
 *
 * Uses yaml (real library) for structured frontmatter round-trip:
 * YAML.parseDocument preserves comments and formatting.
 *
 * Content hashing uses Node crypto (SHA-256) for deterministic identity.
 */

import * as fs from "fs"
import type { Scope, ValidationError, FileReadResult } from "./types"

// Re-export jsonc-parser functions for callers
import {
  parse as jsoncParse,
  modify as jsoncModify,
  applyEdits as jsoncApplyEdits,
  format as jsoncFormat,
  stripComments as jsoncStripComments,
  type ParseError as JsoncParseError,
  type JSONPath,
} from "jsonc-parser"

import { parseDocument as yamlParseDocument, stringify as yamlStringify, isMap, isSeq, isScalar } from "yaml"

// ── JSONC parsing ────────────────────────────────────────────────────

/** Parse JSONC text into a plain object. Handles trailing commas and comments. */
export function parseJsonc(text: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const errors: JsoncParseError[] = []
  const value = jsoncParse(text, errors, { allowTrailingComma: true })
  if (errors.length > 0) {
    return { ok: false, error: `JSONC parse error at offset ${errors[0].offset}: ${errors[0].error}` }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, error: "Config root must be a JSON object" }
  }
  return { ok: true, value: value as Record<string, unknown> }
}

/** Strip comments from JSONC text (for content hashing). */
export function stripJsoncComments(text: string): string {
  return jsoncStripComments(text)
}

/** Format JSONC text to a canonical form (2-space indent). */
export function formatJsonc(text: string): string {
  const edits = jsoncFormat(text, undefined, {
    tabSize: 2,
    insertSpaces: true,
    insertFinalNewline: true,
  })
  return jsoncApplyEdits(text, edits)
}

/** Apply a JSONC modification preserving comments and trailing commas. */
export function applyJsoncEdits(
  text: string,
  jsoncPath: JSONPath,
  newValue: unknown,
): string {
  const edits = jsoncModify(text, jsoncPath, newValue, {
    formattingOptions: {
      tabSize: 2,
      insertSpaces: true,
      insertFinalNewline: true,
    },
  })
  return jsoncApplyEdits(text, edits)
}

// ── File reading ─────────────────────────────────────────────────────

/** Read a file as discriminated result: present/absent/failure. */
export function readFile(filePath: string): FileReadResult {
  try {
    const bytes = fs.readFileSync(filePath, "utf-8")
    const hash = contentHash(bytes)
    return { type: "present", bytes, hash }
  } catch (err: any) {
    if (err?.code === "ENOENT") return { type: "absent" }
    return { type: "failure", code: err?.code ?? "UNKNOWN", message: err?.message ?? String(err) }
  }
}

// ── Markdown / frontmatter parsing ───────────────────────────────────

export interface ParsedMarkdown {
  /** YAML frontmatter as key-value pairs (or empty if no frontmatter). */
  data: Record<string, unknown>
  /** Markdown body (content after frontmatter). */
  content: string
  /** Raw frontmatter text between delimiters (preserves formatting). */
  frontmatterRaw: string
  /** The full raw text of the file. */
  rawText: string
  /** YAML document parse errors (empty if frontmatter is valid or absent). */
  errors: string[]
}

/**
 * Parse a markdown file with optional YAML frontmatter (--- delimited).
 * Uses the yaml library for structured round-trip with comment preservation.
 * Correction 6: surfaces YAML document parse errors in the returned errors array.
 */
export function parseMarkdown(text: string): ParsedMarkdown {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) return { data: {}, content: text, frontmatterRaw: "", rawText: text, errors: [] }

  const frontmatterText = match[1]
  const content = match[2] ?? ""

  // Use yaml library for proper structured parsing
  const doc = yamlParseDocument(frontmatterText)
  const data: Record<string, unknown> = {}
  const errors: string[] = []

  // Correction 6: Surface YAML document errors (e.g. incomplete flow sequences)
  if (doc.errors && doc.errors.length > 0) {
    for (const e of doc.errors) {
      errors.push(e.message)
    }
  }

  if (isMap(doc.contents)) {
    for (const item of doc.contents.items) {
      const key = String((item as any).key.value)
      const val = nodeToPlainValue((item as any).value)
      data[key] = val
    }
  }

  return {
    data,
    content: content.trimEnd(),
    frontmatterRaw: frontmatterText,
    rawText: text,
    errors,
  }
}

/**
 * Serialize structured frontmatter from a data record.
 * Produces properly formatted YAML suitable for markdown files.
 */
export function stringifyFrontmatter(data: Record<string, unknown>): string {
  const doc = yamlParseDocument("")
  const map = new Map(Object.entries(data))
  doc.contents = map as any
  return yamlStringify(doc)
}

/**
 * Update specific keys in existing YAML frontmatter, preserving comments,
 * formatting, and key order where possible. Returns the updated frontmatter
 * text. If the original frontmatter cannot be parsed, returns null to
 * signal a diagnostic error rather than silent regeneration.
 */
export function updateFrontmatterKeys(
  originalFrontmatter: string,
  updates: Record<string, unknown>,
): { ok: true; value: string } | { ok: false; error: string } {
  try {
    const doc = yamlParseDocument(originalFrontmatter)
    if (doc.errors.length > 0) {
      return {
        ok: false,
        error: `YAML parse error: ${doc.errors.map((e) => e.message).join("; ")}`,
      }
    }

    // Update or add each key, preserving existing order/comments
    for (const [key, val] of Object.entries(updates)) {
      const existing = doc.get(key)
      if (existing !== undefined) {
        doc.set(key, val as any)
      } else {
        doc.add({ key, value: val as any } as any)
      }
    }

    // Remove keys set to undefined
    for (const [key, val] of Object.entries(updates)) {
      if (val === undefined) {
        doc.delete(key)
      }
    }

    return { ok: true, value: yamlStringify(doc) }
  } catch (err) {
    return {
      ok: false,
      error: `YAML processing error: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

/**
 * Read and parse a markdown file (agent/command/asset).
 * Returns null if the file cannot be read (ENOENT or failure).
 */
export function readMarkdownFile(filePath: string): ParsedMarkdown | null {
  const result = readFile(filePath)
  if (result.type !== "present") return null
  return parseMarkdown(result.bytes)
}

// ── Content hashing ──────────────────────────────────────────────────

/**
 * Compute a content hash (SHA-256 hex, first 16 chars) for deterministic
 * identity stamping. Uses Node crypto (available in extension host).
 */
export function contentHash(text: string): string {
  const { createHash } = require("crypto") as typeof import("crypto")
  return createHash("sha256").update(text).digest("hex").slice(0, 16)
}

/**
 * Compute content hash from a file path. Returns null if file not readable.
 */
export function fileContentHash(filePath: string): string | null {
  const result = readFile(filePath)
  return result.type === "present" ? result.hash : null
}

// ── Validation helpers ───────────────────────────────────────────────

/** Validate that a raw config only contains known keys per closed registry. */
export function validateNoUnknownKeys(
  raw: Record<string, unknown>,
  scope: Scope,
  file: string,
): ValidationError[] {
  const errors: ValidationError[] = []
  const { isKnownKey, getEntry } = require("./registry") as typeof import("./registry")

  for (const key of Object.keys(raw)) {
    if (!isKnownKey(key)) {
      errors.push({
        path: [key],
        message: `Unknown config key "${key}" — registry is closed`,
        scope,
        file,
      })
      continue
    }
    const entry = getEntry(key)
    if (entry && !entry.scopes.includes(scope)) {
      errors.push({
        path: [key],
        message: `Config key "${key}" is not valid in ${scope} scope`,
        scope,
        file,
      })
    }
  }

  return errors
}

/**
 * Validate that provider options do not contain plaintext credentials.
 * Rejects any credential-bearing field that is not an opaque SecretStorage
 * reference (a string starting with "secret:").
 * Case/format-variant aware; traverses nested objects and arrays.
 */
export function validateNoPlaintextCredentials(
  raw: Record<string, unknown>,
  scope: Scope,
  file: string,
): ValidationError[] {
  const errors: ValidationError[] = []

  // Check provider records
  const provider = raw.provider
  if (provider && typeof provider === "object" && !Array.isArray(provider)) {
    for (const [id, config] of Object.entries(provider as Record<string, unknown>)) {
      if (!config || typeof config !== "object" || Array.isArray(config)) continue
      const cfg = config as Record<string, unknown>

      // Schema-limited: only canonical provider keys allowed (name/endpoint/protocol/models/credential)
       const allowedKeys = new Set(["name", "endpoint", "protocol", "models", "credential"])

      for (const key of Object.keys(cfg)) {
        // Credential pattern keys are reported as plaintext credential errors
        if (isCredentialKey(key)) continue
        if (!allowedKeys.has(key) && !isOpaqueCredentialRef(cfg[key])) {
          errors.push({
            path: ["provider", id, key],
            message: `Provider "${id}" has disallowed key "${key}" — only endpoint/protocol/model definitions and opaque credential refs are accepted`,
            scope,
            file,
          })
        }
      }

      // Check for plaintext credential patterns in any field (recursive)
      checkPlaintextCredentials(cfg, ["provider", id], scope, file, errors)
    }
  }

  // Check MCP records
  const mcp = raw.mcp
  if (mcp && typeof mcp === "object" && !Array.isArray(mcp)) {
    for (const [name, config] of Object.entries(mcp as Record<string, unknown>)) {
      if (!config || typeof config !== "object" || Array.isArray(config)) continue
      const cfg = config as Record<string, unknown>
      // Recursive check: env.API_KEY, headers.Authorization, nested options, arrays in args
      checkPlaintextCredentials(cfg, ["mcp", name], scope, file, errors)
    }
  }

  return errors
}

// ── Internal helpers ─────────────────────────────────────────────────

/**
 * Convert a YAML AST node to a plain JS value.
 */
function nodeToPlainValue(node: any): unknown {
  if (!node) return undefined
  if (isScalar(node)) {
    if (node.tag === "!!null" || node.value === null) return null
    if (typeof node.value === "string") return node.value
    if (typeof node.value === "number") return node.value
    if (typeof node.value === "boolean") return node.value
    return node.value
  }
  if (isMap(node)) {
    const result: Record<string, unknown> = {}
    for (const item of node.items) {
      const key = String((item as any).key.value)
      result[key] = nodeToPlainValue((item as any).value)
    }
    return result
  }
  if (isSeq(node)) {
    return node.items.map((item: any) => nodeToPlainValue(item))
  }
  return node.value
}

/**
 * Check if a value is an opaque credential reference (starts with "secret:").
 */
export function isOpaqueCredentialRef(value: unknown): boolean {
  return typeof value === "string" && value.startsWith("secret:")
}

/**
 * Credential key patterns — single-sourced from the shared agent rule so
 * host (provider/MCP) and agent checks never drift. The shared set covers
 * the historic patterns plus credential/cookie(s)/header(s).
 */
import { isCredentialKey } from "../shared/agent-credentials"
export { isCredentialKey }

/** Keys that are structural containers, not credentials themselves.
 *  We still recurse INTO these to check their contents for credentials. */
const STRUCTURAL_KEYS = new Set(["models"])

/**
 * Detect if a value looks like it contains a plaintext credential
 * (non-empty string that is not an opaque ref).
 */
function isPlaintextCredential(value: unknown): boolean {
  return typeof value === "string" && value.length > 0 && !isOpaqueCredentialRef(value)
}

/**
 * Check for plaintext credential patterns in a record. Traverses objects
 * and arrays recursively. Recognizes case/format variants for credential
 * keys, environment variable contexts (env.*), and authorization header
 * contexts (headers.*).
 */
function checkPlaintextCredentials(
  record: Record<string, unknown>,
  pathPrefix: string[],
  scope: Scope,
  file: string,
  errors: ValidationError[],
): void {
  // Check direct credential fields
  for (const [key, val] of Object.entries(record)) {
    if (isCredentialKey(key) && isPlaintextCredential(val)) {
      errors.push({
        path: [...pathPrefix, key],
        message: `Plaintext credential "${key}" is rejected — use SecretStorage reference (prefix "secret:")`,
        scope,
        file,
      })
    }
  }

  // Recurse into nested objects (including env, headers, options, etc.)
  for (const [key, val] of Object.entries(record)) {
    if (val && typeof val === "object" && !Array.isArray(val) && !STRUCTURAL_KEYS.has(key)) {
      checkPlaintextCredentials(val as Record<string, unknown>, [...pathPrefix, key], scope, file, errors)
    }
    // Recurse into arrays (e.g. args containing credential strings)
    if (Array.isArray(val)) {
      checkPlaintextCredentialArray(val, [...pathPrefix, key], scope, file, errors)
    }
  }
}

/**
 * Check array elements for plaintext credentials.
 * String elements in env-like arrays are checked for credential patterns.
 */
function checkPlaintextCredentialArray(
  arr: unknown[],
  pathPrefix: string[],
  scope: Scope,
  file: string,
  errors: ValidationError[],
): void {
  for (let i = 0; i < arr.length; i++) {
    const val = arr[i]
    if (val && typeof val === "object" && !Array.isArray(val)) {
      checkPlaintextCredentials(val as Record<string, unknown>, [...pathPrefix, String(i)], scope, file, errors)
    }
    if (Array.isArray(val)) {
      checkPlaintextCredentialArray(val, [...pathPrefix, String(i)], scope, file, errors)
    }
  }
}
