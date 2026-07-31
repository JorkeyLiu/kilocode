import { describe, expect, it } from "bun:test"
import {
  resolveMessagePrefs,
  recomputeRecovered,
  resolveValidVariant,
  recoveryVisible,
} from "../../webview-ui/src/context/session-recovery"
import type { Message, ModelSelection } from "../../webview-ui/src/types/messages"

const names = new Set(["code", "plan"])

function userMsg(
  id: string,
  model?: { providerID: string; modelID: string; variant?: string },
  time?: { created: number },
): Message {
  return {
    id,
    sessionID: "session-a",
    role: "user",
    createdAt: new Date().toISOString(),
    model,
    time: time ?? { created: Date.now() },
  }
}

function assistantMsg(id: string, agent?: string): Message {
  return {
    id,
    sessionID: "session-a",
    role: "assistant",
    createdAt: new Date().toISOString(),
    agent,
    time: { created: Date.now() },
  }
}

const claude: ModelSelection = { providerID: "anthropic", modelID: "claude-sonnet-4" }
const gpt: ModelSelection = { providerID: "openai", modelID: "gpt-4.1" }

// ---------------------------------------------------------------------------
// LOCK-001: No raw message ID comparison as chronology
// ---------------------------------------------------------------------------

describe("recomputeRecovered — store order is chronology (LOCK-001)", () => {
  it("uses array order, not lexicographic ID comparison", () => {
    // Non-lexicographic IDs: "z" comes before "a" alphabetically but later in array
    const messages = [
      userMsg("z", { providerID: "anthropic", modelID: "claude-sonnet-4" }),
      userMsg("a", { providerID: "openai", modelID: "gpt-4.1" }),
    ]
    const prefs = recomputeRecovered(messages, undefined, names)
    // Array order: "a" is newer despite lexicographically smaller
    expect(prefs.model).toEqual(gpt)
  })

  it("recomputes from full visible array on every call", () => {
    const messages = [
      userMsg("msg_001", { providerID: "anthropic", modelID: "claude-sonnet-4" }),
      userMsg("msg_002", { providerID: "openai", modelID: "gpt-4.1" }),
    ]
    const prefs = recomputeRecovered(messages, undefined, names)
    expect(prefs.model).toEqual(gpt)
  })

  it("clears model when no user message has a model", () => {
    const messages = [userMsg("msg_001"), userMsg("msg_002")]
    const prefs = recomputeRecovered(messages, undefined, names)
    expect(prefs.model).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// LOCK-002: Authoritative full arrays replace recovered model exactly
// ---------------------------------------------------------------------------

describe("recomputeRecovered — authoritative replacement (LOCK-002)", () => {
  it("newest user message by array order becomes recovered model", () => {
    const messages = [
      userMsg("msg_001", { providerID: "anthropic", modelID: "claude-sonnet-4" }),
      userMsg("msg_002", { providerID: "openai", modelID: "gpt-4.1" }),
    ]
    const prefs = recomputeRecovered(messages, undefined, names)
    expect(prefs.model).toEqual(gpt)
  })

  it("clears model when all user messages are removed", () => {
    const messages: Message[] = []
    const prefs = recomputeRecovered(messages, undefined, names)
    expect(prefs.model).toBeUndefined()
  })

  it("recovers agent from assistant message", () => {
    const messages = [
      assistantMsg("msg_001", "plan"),
      userMsg("msg_002", { providerID: "anthropic", modelID: "claude-sonnet-4" }),
    ]
    const prefs = recomputeRecovered(messages, undefined, names)
    expect(prefs.agent).toBe("plan")
    expect(prefs.model).toEqual(claude)
  })

  it("ignores agent not in valid names set", () => {
    const messages = [
      assistantMsg("msg_001", "unknown-agent"),
      userMsg("msg_002", { providerID: "anthropic", modelID: "claude-sonnet-4" }),
    ]
    const prefs = recomputeRecovered(messages, undefined, names)
    expect(prefs.agent).toBeUndefined()
    expect(prefs.model).toEqual(claude)
  })
})

// ---------------------------------------------------------------------------
// LOCK-003: Stale/out-of-order events must not overwrite newer state
// ---------------------------------------------------------------------------

describe("recomputeRecovered — no stale overwrite (LOCK-003)", () => {
  it("always returns the newest from the authoritative array", () => {
    // Simulate stale event: message from older state
    const staleMessages = [
      userMsg("msg_001", { providerID: "anthropic", modelID: "claude-sonnet-4" }),
    ]
    const freshMessages = [
      userMsg("msg_001", { providerID: "anthropic", modelID: "claude-sonnet-4" }),
      userMsg("msg_002", { providerID: "openai", modelID: "gpt-4.1" }),
    ]
    // Stale call returns older model
    const stalePrefs = recomputeRecovered(staleMessages, undefined, names)
    expect(stalePrefs.model).toEqual(claude)

    // Fresh call returns newer model — this is what the store should use
    const freshPrefs = recomputeRecovered(freshMessages, undefined, names)
    expect(freshPrefs.model).toEqual(gpt)

    // The production code always calls with the authoritative array,
    // so stale snapshots can never overwrite.
  })

  it("custom non-sortable IDs resolve correctly by array order", () => {
    const messages = [
      userMsg("custom_id_alpha", { providerID: "anthropic", modelID: "claude-sonnet-4" }),
      userMsg("custom_id_beta", { providerID: "openai", modelID: "gpt-4.1" }),
    ]
    const prefs = recomputeRecovered(messages, undefined, names)
    // beta is later in array despite alphabetical ordering
    expect(prefs.model).toEqual(gpt)
  })
})

// ---------------------------------------------------------------------------
// LOCK-004: Revert/unrevert visibility uses existing session-queue utility
// ---------------------------------------------------------------------------

describe("recomputeRecovered — revert boundary (LOCK-004)", () => {
  it("excludes reverted messages from recovery source", () => {
    const messages = [
      userMsg("msg_001", { providerID: "anthropic", modelID: "claude-sonnet-4" }),
      userMsg("msg_002", { providerID: "openai", modelID: "gpt-4.1" }),
    ]
    // Revert at msg_002 — only msg_001 is visible
    const prefs = recomputeRecovered(messages, { messageID: "msg_002" }, names)
    expect(prefs.model).toEqual(claude)
    // msg_002 is excluded even though it's later in the array
  })

  it("unrevert (no boundary) restores access to all messages", () => {
    const messages = [
      userMsg("msg_001", { providerID: "anthropic", modelID: "claude-sonnet-4" }),
      userMsg("msg_002", { providerID: "openai", modelID: "gpt-4.1" }),
    ]
    // No revert boundary — all messages visible
    const prefs = recomputeRecovered(messages, undefined, names)
    expect(prefs.model).toEqual(gpt)
  })

  it("revert with partID shows partial message (boundary user message visible)", () => {
    const messages = [
      userMsg("msg_001", { providerID: "anthropic", modelID: "claude-sonnet-4" }),
      userMsg("msg_002", { providerID: "openai", modelID: "gpt-4.1" }),
    ]
    // Revert at msg_002 with partID — msg_002 is visible (partial)
    // per visibleMessage: `id === revert.messageID && !!revert.partID`
    const prefs = recomputeRecovered(messages, { messageID: "msg_002", partID: "part_1" }, names)
    expect(prefs.model).toEqual(gpt)
  })

  it("handles revert when no user messages remain visible", () => {
    const messages = [
      userMsg("msg_001", { providerID: "anthropic", modelID: "claude-sonnet-4" }),
    ]
    // Revert at msg_001 — no user messages visible
    const prefs = recomputeRecovered(messages, { messageID: "msg_001" }, names)
    expect(prefs.model).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// LOCK-005: Recovery bookkeeping updates regardless of explicit override
// ---------------------------------------------------------------------------

describe("recomputeRecovered — independent of explicit override (LOCK-005)", () => {
  it("returns newest model regardless of explicit override context", () => {
    // LOCK-005: recovery bookkeeping always follows newest user message
    // regardless of explicit override; explicit affects precedence only.
    const messages = [
      userMsg("msg_001", { providerID: "anthropic", modelID: "claude-sonnet-4" }),
      userMsg("msg_002", { providerID: "openai", modelID: "gpt-4.1" }),
    ]
    const prefs = recomputeRecovered(messages, undefined, names)
    expect(prefs.model).toEqual(gpt)
    // resolveMessagePrefs doesn't know about explicit overrides —
    // it just scans visible messages. The resolution chain
    // (explicit > recovered > normal) decides precedence.
  })
})

// ---------------------------------------------------------------------------
// LOCK-006: Production transition logic testable via pure helpers
// ---------------------------------------------------------------------------

describe("recomputeRecovered — message lifecycle transitions (LOCK-006)", () => {
  it("full replace: messagesLoaded replaces array exactly", () => {
    const messages = [
      userMsg("msg_001", { providerID: "anthropic", modelID: "claude-sonnet-4" }),
      userMsg("msg_002", { providerID: "openai", modelID: "gpt-4.1" }),
      userMsg("msg_003", { providerID: "anthropic", modelID: "claude-sonnet-4" }),
    ]
    const prefs = recomputeRecovered(messages, undefined, names)
    expect(prefs.model).toEqual(claude) // msg_003 is newest
  })

  it("delete current source: newest remaining becomes source", () => {
    const messages = [
      userMsg("msg_001", { providerID: "anthropic", modelID: "claude-sonnet-4" }),
      userMsg("msg_002", { providerID: "openai", modelID: "gpt-4.1" }),
    ]
    // Remove msg_002 (current source)
    const afterDelete = messages.filter((m) => m.id !== "msg_002")
    const prefs = recomputeRecovered(afterDelete, undefined, names)
    expect(prefs.model).toEqual(claude) // msg_001 is now newest
  })

  it("delete non-source: source preserved", () => {
    const messages = [
      userMsg("msg_001", { providerID: "anthropic", modelID: "claude-sonnet-4" }),
      userMsg("msg_002", { providerID: "openai", modelID: "gpt-4.1" }),
    ]
    // Remove msg_001 (not the source)
    const afterDelete = messages.filter((m) => m.id !== "msg_001")
    const prefs = recomputeRecovered(afterDelete, undefined, names)
    expect(prefs.model).toEqual(gpt) // msg_002 still source
  })

  it("revert: visible messages exclude reverted", () => {
    const messages = [
      userMsg("msg_001", { providerID: "anthropic", modelID: "claude-sonnet-4" }),
      userMsg("msg_002", { providerID: "openai", modelID: "gpt-4.1" }),
      userMsg("msg_003", { providerID: "anthropic", modelID: "claude-sonnet-4" }),
    ]
    // Revert at msg_003
    const prefs = recomputeRecovered(messages, { messageID: "msg_003" }, names)
    expect(prefs.model).toEqual(gpt) // msg_002 is newest visible
  })

  it("unrevert: all messages become visible again", () => {
    const messages = [
      userMsg("msg_001", { providerID: "anthropic", modelID: "claude-sonnet-4" }),
      userMsg("msg_002", { providerID: "openai", modelID: "gpt-4.1" }),
    ]
    // No revert boundary
    const prefs = recomputeRecovered(messages, undefined, names)
    expect(prefs.model).toEqual(gpt) // msg_002 is newest
  })

  it("no-source clear: empty messages clears recovery", () => {
    const prefs = recomputeRecovered([], undefined, names)
    expect(prefs.model).toBeUndefined()
  })

  it("incremental messageCreated appends to authoritative array", () => {
    // Before: one user message
    const before = [userMsg("msg_001", { providerID: "anthropic", modelID: "claude-sonnet-4" })]
    const prefsBefore = recomputeRecovered(before, undefined, names)
    expect(prefsBefore.model).toEqual(claude)

    // After: append new message (simulating messageCreated)
    const after = [
      ...before,
      userMsg("msg_002", { providerID: "openai", modelID: "gpt-4.1" }),
    ]
    const prefsAfter = recomputeRecovered(after, undefined, names)
    expect(prefsAfter.model).toEqual(gpt)
  })
})

// ---------------------------------------------------------------------------
// LOCK-007: Subagent variant display validates against supported variants
// ---------------------------------------------------------------------------

describe("resolveValidVariant — variant validation (LOCK-007)", () => {
  it("returns configured value when in supported list", () => {
    const result = resolveValidVariant("thinking", ["thinking", "streaming"])
    expect(result).toBe("thinking")
  })

  it("returns undefined when configured value not in supported list", () => {
    const result = resolveValidVariant("invalid", ["thinking", "streaming"])
    expect(result).toBeUndefined()
  })

  it("returns undefined when no supported variants", () => {
    const result = resolveValidVariant("thinking", [])
    expect(result).toBeUndefined()
  })

  it("returns undefined for null/undefined configured value", () => {
    expect(resolveValidVariant(null, ["thinking"])).toBeUndefined()
    expect(resolveValidVariant(undefined, ["thinking"])).toBeUndefined()
  })

  it("returns undefined for empty string configured value", () => {
    expect(resolveValidVariant("", ["thinking"])).toBeUndefined()
  })

  it("default path: valid override > valid global > unset", () => {
    const supported = ["thinking", "streaming"]
    // Case 1: valid override
    const override = "streaming"
    const globalV = "thinking"
    const result1 = resolveValidVariant(override, supported) ?? resolveValidVariant(globalV, supported)
    expect(result1).toBe("streaming")

    // Case 2: invalid override, valid global
    const result2 = resolveValidVariant("invalid", supported) ?? resolveValidVariant(globalV, supported)
    expect(result2).toBe("thinking")

    // Case 3: both invalid
    const result3 = resolveValidVariant("invalid", supported) ?? resolveValidVariant("also-invalid", supported)
    expect(result3).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Variant recovery from message model field
// ---------------------------------------------------------------------------

describe("resolveMessagePrefs — variant recovery", () => {
  it("returns variant from newest user message with model", () => {
    const messages = [
      userMsg("msg_001", { providerID: "anthropic", modelID: "claude-sonnet-4", variant: "thinking" }),
      userMsg("msg_002", { providerID: "openai", modelID: "gpt-4.1", variant: "streaming" }),
    ]
    const prefs = resolveMessagePrefs(messages, names)
    expect(prefs.variant).toBe("streaming")
  })

  it("returns undefined variant when no user message has a variant", () => {
    const messages = [
      userMsg("msg_001", { providerID: "anthropic", modelID: "claude-sonnet-4" }),
    ]
    const prefs = resolveMessagePrefs(messages, names)
    expect(prefs.variant).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// recoveryVisible — index-based revert boundary (non-sortable ID safe)
// ---------------------------------------------------------------------------

describe("recoveryVisible — index-based revert boundary", () => {
  it("returns all messages when no revert", () => {
    const messages = [userMsg("a"), userMsg("b"), userMsg("c")]
    expect(recoveryVisible(messages, undefined)).toEqual(messages)
  })

  it("excludes boundary and after when full revert (no partID)", () => {
    const a = userMsg("a")
    const b = userMsg("b")
    const c = userMsg("c")
    const messages = [a, b, c]
    // Revert at b — only a visible
    expect(recoveryVisible(messages, { messageID: "b" })).toEqual([a])
  })

  it("includes boundary when partial revert (has partID)", () => {
    const a = userMsg("a")
    const b = userMsg("b")
    const c = userMsg("c")
    const messages = [a, b, c]
    // Revert at b with partID — a and b visible
    expect(recoveryVisible(messages, { messageID: "b", partID: "p1" })).toEqual([a, b])
  })

  it("returns all messages when boundary not found", () => {
    const a = userMsg("a")
    const b = userMsg("b")
    const messages = [a, b]
    // Boundary "z" not in array — all visible
    expect(recoveryVisible(messages, { messageID: "z" })).toEqual(messages)
  })

  it("revert at first message — nothing visible (full)", () => {
    const a = userMsg("a")
    const b = userMsg("b")
    const messages = [a, b]
    expect(recoveryVisible(messages, { messageID: "a" })).toEqual([])
  })

  it("revert at last message — all but last visible", () => {
    const a = userMsg("a")
    const b = userMsg("b")
    const messages = [a, b]
    expect(recoveryVisible(messages, { messageID: "b" })).toEqual([a])
  })

  it("custom non-sortable IDs resolve correctly by identity", () => {
    const a = userMsg("uuid-abc")
    const b = userMsg("uuid-xyz")
    const c = userMsg("uuid-def")
    const messages = [a, b, c]
    // Revert at uuid-xyz — only uuid-abc visible (identity, not sort order)
    expect(recoveryVisible(messages, { messageID: "uuid-xyz" })).toEqual([a])
  })

  it("non-sortable IDs: revert at later array position excludes correctly", () => {
    const a = userMsg("zzz")
    const b = userMsg("aaa")
    const c = userMsg("mmm")
    const messages = [a, b, c]
    // Revert at aaa (position 1) — only zzz visible
    // Even though "aaa" < "zzz" lexicographically, index-based: aaa is at index 1
    expect(recoveryVisible(messages, { messageID: "aaa" })).toEqual([a])
  })

  it("unrevert (null revert) restores all messages", () => {
    const a = userMsg("a")
    const b = userMsg("b")
    const messages = [a, b]
    expect(recoveryVisible(messages, null)).toEqual(messages)
  })
})

// ---------------------------------------------------------------------------
// recomputeRecovered with non-sortable IDs — revert/unrevert
// ---------------------------------------------------------------------------

describe("recomputeRecovered — non-sortable custom-ID revert/unrevert", () => {
  it("revert with custom IDs uses identity, not lexicographic", () => {
    const messages = [
      userMsg("zzz-first", { providerID: "anthropic", modelID: "claude-sonnet-4" }),
      userMsg("aaa-second", { providerID: "openai", modelID: "gpt-4.1" }),
    ]
    // Revert at aaa-second (index 1) — only zzz-first visible
    const prefs = recomputeRecovered(messages, { messageID: "aaa-second" }, names)
    expect(prefs.model).toEqual(claude)
  })

  it("unrevert with custom IDs restores all messages", () => {
    const messages = [
      userMsg("zzz-first", { providerID: "anthropic", modelID: "claude-sonnet-4" }),
      userMsg("aaa-second", { providerID: "openai", modelID: "gpt-4.1" }),
    ]
    // No revert — all visible
    const prefs = recomputeRecovered(messages, undefined, names)
    expect(prefs.model).toEqual(gpt)
  })

  it("partial revert with custom IDs includes boundary", () => {
    const messages = [
      userMsg("zzz-first", { providerID: "anthropic", modelID: "claude-sonnet-4" }),
      userMsg("aaa-second", { providerID: "openai", modelID: "gpt-4.1" }),
    ]
    // Partial revert at aaa-second — both visible (boundary included)
    const prefs = recomputeRecovered(messages, { messageID: "aaa-second", partID: "p1" }, names)
    expect(prefs.model).toEqual(gpt)
  })

  it("three messages: revert at middle custom ID excludes middle and last", () => {
    const messages = [
      userMsg("uuid-001", { providerID: "anthropic", modelID: "claude-sonnet-4" }),
      userMsg("uuid-002", { providerID: "openai", modelID: "gpt-4.1" }),
      userMsg("uuid-003", { providerID: "anthropic", modelID: "claude-sonnet-4" }),
    ]
    // Revert at uuid-002 — only uuid-001 visible
    const prefs = recomputeRecovered(messages, { messageID: "uuid-002" }, names)
    expect(prefs.model).toEqual(claude)
  })

  it("revert at non-existent custom ID returns all messages", () => {
    const messages = [
      userMsg("uuid-001", { providerID: "anthropic", modelID: "claude-sonnet-4" }),
      userMsg("uuid-002", { providerID: "openai", modelID: "gpt-4.1" }),
    ]
    // Boundary not found — all visible
    const prefs = recomputeRecovered(messages, { messageID: "uuid-nonexistent" }, names)
    expect(prefs.model).toEqual(gpt)
  })
})
