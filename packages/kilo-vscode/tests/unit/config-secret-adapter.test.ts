/**
 * P4.1 SecretStorage adapter tests.
 *
 * Tests credential storage, retrieval, cleanup, and ref extraction
 * using the in-memory adapter (no VS Code API needed).
 */

import { describe, expect, it } from "bun:test"
import {
  createMemorySecretAdapter,
  storeCredential,
  retrieveCredential,
  removeCredential,
  hasCredential,
  restoreCredentialRef,
  removeCredentialRef,
  extractCredentialRefs,
  listStoredCredentialIds,
  secretKey,
  parseSecretKey,
} from "../../src/config/secret-adapter"

describe("secretKey / parseSecretKey", () => {
  it("formats a valid key from components", () => {
    expect(secretKey("global", "provider", "openai")).toBe("kilo.credentials.global.provider.openai")
    expect(secretKey("project", "mcp", "my-server")).toBe("kilo.credentials.project.mcp.my-server")
  })

  it("round-trips through parseSecretKey", () => {
    const key = secretKey("global", "provider", "openai")
    const parsed = parseSecretKey(key)
    expect(parsed).toEqual({ scope: "global", kind: "provider", id: "openai" })
  })

  it("returns null for non-kilo keys", () => {
    expect(parseSecretKey("other.key.here")).toBeNull()
    expect(parseSecretKey("kilo.credentials")).toBeNull()
    expect(parseSecretKey("kilo.credentials.invalid")).toBeNull()
  })

  it("handles IDs with dots", () => {
    const key = secretKey("global", "provider", "my.custom.provider")
    const parsed = parseSecretKey(key)
    expect(parsed).toEqual({ scope: "global", kind: "provider", id: "my.custom.provider" })
  })
})

describe("storeCredential / retrieveCredential", () => {
  it("stores and retrieves a credential", async () => {
    const adapter = createMemorySecretAdapter()
    const ref = await storeCredential(adapter, "global", "provider", "openai", "sk-123")
    expect(ref).toBe("secret:kilo.credentials.global.provider.openai")

    const value = await retrieveCredential(adapter, ref!)
    expect(value).toBe("sk-123")
  })

  it("returns undefined for empty value and deletes existing", async () => {
    const adapter = createMemorySecretAdapter()
    await storeCredential(adapter, "global", "provider", "openai", "sk-123")
    const ref = await storeCredential(adapter, "global", "provider", "openai", "")
    expect(ref).toBeUndefined()

    const value = await retrieveCredential(adapter, "secret:kilo.credentials.global.provider.openai")
    expect(value).toBeUndefined()
  })

  it("returns undefined for non-secret refs", async () => {
    const adapter = createMemorySecretAdapter()
    const value = await retrieveCredential(adapter, "plain-text-key")
    expect(value).toBeUndefined()
  })
})

describe("removeCredential", () => {
  it("removes a stored credential", async () => {
    const adapter = createMemorySecretAdapter()
    await storeCredential(adapter, "global", "provider", "openai", "sk-123")
    await removeCredential(adapter, "global", "provider", "openai")

    const value = await retrieveCredential(adapter, "secret:kilo.credentials.global.provider.openai")
    expect(value).toBeUndefined()
  })
})

describe("hasCredential", () => {
  it("returns true for stored credential", async () => {
    const adapter = createMemorySecretAdapter()
    await storeCredential(adapter, "global", "provider", "openai", "sk-123")
    expect(await hasCredential(adapter, "secret:kilo.credentials.global.provider.openai")).toBe(true)
  })

  it("returns false for missing credential", async () => {
    const adapter = createMemorySecretAdapter()
    expect(await hasCredential(adapter, "secret:kilo.credentials.global.provider.openai")).toBe(false)
  })

  it("returns false for non-secret refs", async () => {
    const adapter = createMemorySecretAdapter()
    expect(await hasCredential(adapter, "plain-text")).toBe(false)
  })
})

describe("extractCredentialRefs", () => {
  it("extracts secret refs from nested objects", () => {
    const value = {
      provider: {
        openai: { apiKey: "secret:kilo.credentials.global.provider.openai" },
        anthropic: { api_key: "secret:kilo.credentials.global.provider.anthropic" },
      },
    }
    const refs = extractCredentialRefs(value)
    expect(refs).toEqual([
      "secret:kilo.credentials.global.provider.openai",
      "secret:kilo.credentials.global.provider.anthropic",
    ])
  })

  it("extracts refs from arrays", () => {
    const value = ["secret:kilo.credentials.global.mcp.a", "plain"]
    const refs = extractCredentialRefs(value)
    expect(refs).toEqual(["secret:kilo.credentials.global.mcp.a"])
  })

  it("returns empty for no refs", () => {
    expect(extractCredentialRefs({ model: "openai/gpt-4" })).toEqual([])
    expect(extractCredentialRefs("not-a-ref")).toEqual([])
  })
})

describe("listStoredCredentialIds", () => {
  it("lists stored provider IDs for a scope", async () => {
    const adapter = createMemorySecretAdapter()
    await storeCredential(adapter, "global", "provider", "openai", "sk-1")
    await storeCredential(adapter, "global", "provider", "anthropic", "sk-2")
    await storeCredential(adapter, "project", "provider", "openai", "sk-3")

    const globalIds = await listStoredCredentialIds(adapter, "global", "provider")
    expect(globalIds).toEqual(new Set(["openai", "anthropic"]))

    const projectIds = await listStoredCredentialIds(adapter, "project", "provider")
    expect(projectIds).toEqual(new Set(["openai"]))
  })

  it("returns empty set when no credentials stored", async () => {
    const adapter = createMemorySecretAdapter()
    const ids = await listStoredCredentialIds(adapter, "global", "mcp")
    expect(ids.size).toBe(0)
  })
})

// ── Strict owned-ref enforcement (P4.1 audit closure) ────────────────

describe("strict owned-ref enforcement", () => {
  const malformedRefs = [
    "secret:kilo.credentials.global.provider.", // empty id
    "secret:kilo.credentials.global.provider..", // delimiter-only
    "secret:kilo.credentials.global.provider..openai", // leading empty segment
    "secret:kilo.credentials.global.provider.openai.", // trailing empty segment
    "secret:kilo.credentials.global.provider.openai..x", // repeated dot
  ]
  const nonOwnedRefs = [
    "secret:openai-key", // arbitrary secret ref
    "secret:random", // arbitrary secret ref
    "secret:kilo.credentials.workspace.provider.openai", // wrong scope
    "secret:kilo.credentials.global.other.openai", // wrong kind
    "secret:kilo.credentials.global.mcp.openai", // mcp kind in provider position
    "secret:kilo.credentials.global.provider.other", // different provider id
    "secret:kilo.credentials.project.provider.openai", // different scope
    "kilo.credentials.global.provider.openai", // missing secret: prefix
  ]

  it("parseSecretKey rejects empty-ID and repeated-dot keys", () => {
    for (const key of [
      "kilo.credentials.global.provider.",
      "kilo.credentials.global.provider..",
      "kilo.credentials.global.provider..openai",
      "kilo.credentials.global.provider.openai.",
      "kilo.credentials.global.provider.openai..x",
    ]) {
      expect(parseSecretKey(key)).toBeNull()
    }
  })

  it("retrieve/has return absent for empty-ID and delimiter-only refs", async () => {
    const adapter = createMemorySecretAdapter()
    for (const ref of malformedRefs) {
      expect(await retrieveCredential(adapter, ref)).toBeUndefined()
      expect(await hasCredential(adapter, ref)).toBe(false)
    }
  })

  it("restore/remove reject empty-ID and delimiter-only refs", async () => {
    const adapter = createMemorySecretAdapter()
    for (const ref of malformedRefs) {
      await expect(restoreCredentialRef(adapter, ref, "v")).rejects.toThrow()
      await expect(removeCredentialRef(adapter, ref)).rejects.toThrow()
    }
    expect(adapter.store_.size).toBe(0)
  })

  it("retrieve/has return absent for arbitrary secret refs and wrong scope/kind/id", async () => {
    const adapter = createMemorySecretAdapter()
    for (const ref of nonOwnedRefs) {
      expect(await retrieveCredential(adapter, ref)).toBeUndefined()
      expect(await hasCredential(adapter, ref)).toBe(false)
    }
  })

  it("restore/remove reject arbitrary secret refs", async () => {
    const adapter = createMemorySecretAdapter()
    for (const ref of ["secret:openai-key", "secret:random"]) {
      await expect(restoreCredentialRef(adapter, ref, "v")).rejects.toThrow()
      await expect(removeCredentialRef(adapter, ref)).rejects.toThrow()
    }
    expect(adapter.store_.size).toBe(0)
  })

  it("exact owned refs succeed for read/has/restore/delete", async () => {
    const adapter = createMemorySecretAdapter()
    const ref = "secret:kilo.credentials.global.mcp.filesystem"
    await restoreCredentialRef(adapter, ref, "mcp-secret")
    expect(await hasCredential(adapter, ref)).toBe(true)
    expect(await retrieveCredential(adapter, ref)).toBe("mcp-secret")
    await removeCredentialRef(adapter, ref)
    expect(await hasCredential(adapter, ref)).toBe(false)
  })

  it("storeCredential/removeCredential reject ids that cannot form an owned ref", async () => {
    const adapter = createMemorySecretAdapter()
    for (const id of ["", ".", "..", ".openai", "openai.", "openai..x"]) {
      await expect(storeCredential(adapter, "global", "provider", id, "v")).rejects.toThrow()
      await expect(removeCredential(adapter, "global", "provider", id)).rejects.toThrow()
    }
    expect(adapter.store_.size).toBe(0)
  })

  it("storeCredential/removeCredential accept ids with interior dots", async () => {
    const adapter = createMemorySecretAdapter()
    const ref = await storeCredential(adapter, "global", "provider", "my.custom.provider", "sk")
    expect(ref).toBe("secret:kilo.credentials.global.provider.my.custom.provider")
    expect(await retrieveCredential(adapter, ref!)).toBe("sk")
    await removeCredential(adapter, "global", "provider", "my.custom.provider")
    expect(await hasCredential(adapter, ref!)).toBe(false)
  })

  it("extractCredentialRefs returns only strict owned refs", () => {
    const value = {
      ok: "secret:kilo.credentials.global.provider.openai",
      bad: "secret:random",
      empty: "secret:kilo.credentials.global.provider.",
      arr: ["secret:kilo.credentials.project.mcp.filesystem", "secret:other"],
    }
    expect(extractCredentialRefs(value)).toEqual([
      "secret:kilo.credentials.global.provider.openai",
      "secret:kilo.credentials.project.mcp.filesystem",
    ])
  })
})
