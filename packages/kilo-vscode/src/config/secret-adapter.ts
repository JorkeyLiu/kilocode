/**
 * P4.1 SecretStorage credential adapter.
 *
 * Wraps VS Code SecretStorage to store provider and MCP credentials
 * behind opaque refs. Canonical files receive only `secret:<id>` strings;
 * plaintext credentials never appear in files, messages, or state.
 *
 * Key format: `kilo.credentials.<scope>.<kind>.<id>`
 * - scope: "global" or "project"
 * - kind: "provider" or "mcp"
 * - id: user-defined provider/server name (non-empty, no empty dot segments)
 *
 * Every read/has/restore/delete/cleanup entry point validates through the
 * single strict owned-ref parser in config/types (parseOwnedCredentialRef).
 * Arbitrary `secret:*` refs are rejected and never passed to SecretStorage.
 */

import type { ExtensionContext, SecretStorage } from "vscode"
import { parseOwnedCredentialRef } from "./types"

const SECRET_PREFIX = "kilo.credentials"

/** Resolve a stable secret key from scope + kind + id. */
export function secretKey(scope: "global" | "project", kind: "provider" | "mcp", id: string): string {
  return `${SECRET_PREFIX}.${scope}.${kind}.${id}`
}

/**
 * Parse a secret key back into its components using the single strict
 * owned-ref parser. Returns null for non-kilo keys and for keys whose id
 * is empty or contains empty dot segments.
 */
export function parseSecretKey(key: string): { scope: "global" | "project"; kind: "provider" | "mcp"; id: string } | null {
  return parseOwnedCredentialRef(`secret:${key}`)
}

/** Validate a ref through the strict owned-ref parser; throws on any non-owned ref. */
function strictOwnedRef(ref: string): { scope: "global" | "project"; kind: "provider" | "mcp"; id: string } {
  const parsed = parseOwnedCredentialRef(ref)
  if (!parsed) throw new Error("Invalid canonical credential reference")
  return parsed
}

/** Validate scope+kind+id against the strict owned-ref rules; throws on an invalid id. */
function strictOwnedKey(scope: "global" | "project", kind: "provider" | "mcp", id: string): string {
  const key = secretKey(scope, kind, id)
  if (!parseSecretKey(key)) throw new TypeError(`Invalid credential id: ${JSON.stringify(id)}`)
  return key
}

/** Validate and store a value under the exact opaque reference it came from. */
export async function restoreCredentialRef(adapter: SecretAdapter, ref: string, value: string): Promise<void> {
  strictOwnedRef(ref)
  await adapter.store(ref.slice("secret:".length), value)
}

export async function removeCredentialRef(adapter: SecretAdapter, ref: string): Promise<void> {
  strictOwnedRef(ref)
  await adapter.delete(ref.slice("secret:".length))
}

/**
 * VS Code SecretStorage adapter interface for testability.
 * Production uses the real VS Code SecretStorage; tests inject an in-memory map.
 */
export interface SecretAdapter {
  /** Store a secret value under the given key. */
  store(key: string, value: string): Promise<void>
  /** Retrieve a secret value by key. Returns undefined if not found. */
  retrieve(key: string): Promise<string | undefined>
  /** Delete a secret by key. */
  delete(key: string): Promise<void>
  /** List all keys matching a prefix. */
  keys(prefix?: string): Promise<readonly string[]>
}

/**
 * Create a SecretAdapter backed by real VS Code SecretStorage.
 */
export function createVscodeSecretAdapter(ctx: ExtensionContext): SecretAdapter {
  const ss = ctx.secrets
  return {
    store: (key, value) => Promise.resolve(ss.store(key, value)),
    retrieve: (key) => Promise.resolve(ss.get(key)),
    delete: (key) => Promise.resolve(ss.delete(key)),
    keys: async (prefix?) => {
      const all = await Promise.resolve(ss.keys())
      if (!prefix) return all
      return all.filter((k) => k.startsWith(prefix))
    },
  }
}

/**
 * Create an in-memory SecretAdapter for testing.
 */
export function createMemorySecretAdapter(): SecretAdapter & { readonly store_: Map<string, string> } {
  const store_ = new Map<string, string>()
  return {
    store_,
    store: async (key, value) => { store_.set(key, value) },
    retrieve: async (key) => store_.get(key),
    delete: async (key) => { store_.delete(key) },
    keys: async (prefix?) => {
      const all = [...store_.keys()]
      if (!prefix) return all
      return all.filter((k) => k.startsWith(prefix))
    },
  }
}

/**
 * Store a credential value in SecretStorage and return the opaque ref.
 * If value is undefined or empty, deletes any existing credential and returns undefined.
 * Throws on an id that cannot form a strict owned ref.
 */
export async function storeCredential(
  adapter: SecretAdapter,
  scope: "global" | "project",
  kind: "provider" | "mcp",
  id: string,
  value: string | undefined,
): Promise<string | undefined> {
  const key = strictOwnedKey(scope, kind, id)
  if (!value || value.length === 0) {
    await adapter.delete(key)
    return undefined
  }
  await adapter.store(key, value)
  return `secret:${key}`
}

/**
 * Retrieve the plaintext credential for an opaque ref.
 * Returns undefined if the ref is not an exact owned ref or the secret is not found.
 */
export async function retrieveCredential(
  adapter: SecretAdapter,
  ref: string,
): Promise<string | undefined> {
  if (!parseOwnedCredentialRef(ref)) return undefined
  const key = ref.slice("secret:".length)
  return adapter.retrieve(key)
}

/**
 * Remove all credentials owned by this service for a given scope+kind+id.
 * Called after canonical commit to clean up replaced/removed credentials.
 * Throws on an id that cannot form a strict owned ref.
 */
export async function removeCredential(
  adapter: SecretAdapter,
  scope: "global" | "project",
  kind: "provider" | "mcp",
  id: string,
): Promise<void> {
  const key = strictOwnedKey(scope, kind, id)
  await adapter.delete(key)
}

/**
 * Check whether a credential ref exists in SecretStorage.
 * Returns true only for an exact owned ref that has a stored secret, false otherwise.
 * Never exposes the actual secret value.
 */
export async function hasCredential(
  adapter: SecretAdapter,
  ref: string,
): Promise<boolean> {
  if (!parseOwnedCredentialRef(ref)) return false
  const key = ref.slice("secret:".length)
  const val = await adapter.retrieve(key)
  return val !== undefined
}

/**
 * Extract all exact owned credential refs from a config value.
 * Returns a flat list of `secret:*` strings found at any nesting depth.
 * Arbitrary non-owned `secret:*` strings are not returned.
 */
export function extractCredentialRefs(value: unknown): string[] {
  const refs: string[] = []
  if (typeof value === "string" && parseOwnedCredentialRef(value)) {
    refs.push(value)
  }
  if (Array.isArray(value)) {
    for (const el of value) refs.push(...extractCredentialRefs(el))
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const v of Object.values(value as Record<string, unknown>)) {
      refs.push(...extractCredentialRefs(v))
    }
  }
  return refs
}

/**
 * Scan SecretStorage for all credential keys matching a scope prefix
 * and return the set of IDs that have stored secrets.
 */
export async function listStoredCredentialIds(
  adapter: SecretAdapter,
  scope: "global" | "project",
  kind: "provider" | "mcp",
): Promise<Set<string>> {
  const prefix = `${SECRET_PREFIX}.${scope}.${kind}.`
  const keys = await adapter.keys(prefix)
  const ids = new Set<string>()
  for (const key of keys) {
    const parsed = parseSecretKey(key)
    if (parsed) ids.add(parsed.id)
  }
  return ids
}
