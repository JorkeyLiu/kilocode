import { describe, expect, it } from "bun:test"
import {
  MAX_MESSAGE_PATCH_SIZE,
  MESSAGE_CURSOR_MAX_LENGTH,
  assertFoundMessagePage,
  decodeMessageCursor,
  encodeMessageCursor,
  isStrictCursorTime,
  projectMessageInfo,
  projectMessagePart,
  stripMessageMetadata,
  stripPartMetadata,
  validateInfo,
  validatePart,
} from "../../src/session/message-read"
import type { SessionV1 } from "../../src/v1/session"

function toolPart(meta: Record<string, unknown>): SessionV1.Part {
  return {
    id: "prt_1" as never,
    sessionID: "ses_1" as never,
    messageID: "msg_1" as never,
    type: "tool",
    callID: "c1",
    tool: "edit",
    state: { status: "completed", input: {}, output: "ok", title: "edit", metadata: meta as never, time: { start: 0, end: 1 } },
  } as unknown as SessionV1.Part
}

describe("core message-read", () => {
  it("owns 256KiB cap", () => {
    expect(MAX_MESSAGE_PATCH_SIZE).toBe(256 * 1024)
  })

  it("cursor roundtrips", () => {
    const enc = encodeMessageCursor({ id: "msg_abc", time: 123 })
    expect(decodeMessageCursor(enc)).toEqual({ id: "msg_abc", time: 123 })
  })

  it("cursor rejects strict invalids (base shared codec stays finite-tolerant for legacy MessageV2)", () => {
    const bad: unknown[] = [
      "",
      "not-base64!!!",
      "a".repeat(MESSAGE_CURSOR_MAX_LENGTH + 1),
      encodeMessageCursor({ id: "bad", time: 1 }),
      encodeMessageCursor({ id: "msg_1", time: -1 }),
      encodeMessageCursor({ id: "msg_1", time: 8640000000000001 }),
      Buffer.from(JSON.stringify({ id: "msg_1" }), "utf8").toString("base64url"),
      Buffer.from(JSON.stringify({ id: "msg_1", time: 1, extra: 1 }), "utf8").toString("base64url"),
      Buffer.from(JSON.stringify({ time: 1 }), "utf8").toString("base64url"),
      Buffer.from(JSON.stringify(["x"]), "utf8").toString("base64url"),
      Buffer.from("not-json", "utf8").toString("base64url"),
      123,
      null,
    ]
    for (const v of bad) expect(() => decodeMessageCursor(v)).toThrow()
    // legacy fractional still decodes at shared layer; wire enforces integer via isStrictCursorTime
    expect(decodeMessageCursor(encodeMessageCursor({ id: "msg_1", time: 1.5 }))).toEqual({ id: "msg_1", time: 1.5 })
    expect(isStrictCursorTime(1.5)).toBe(false)
    expect(isStrictCursorTime(1)).toBe(true)
  })

  it("strips tool diff/filediff/files/results and caps patches", () => {
    const small = "small-patch"
    const big = "x".repeat(MAX_MESSAGE_PATCH_SIZE + 1)
    const exact = "x".repeat(MAX_MESSAGE_PATCH_SIZE)
    const p = toolPart({
      diff: "drop",
      filediff: { file: "a", patch: small, before: "b", after: "a", additions: 1, deletions: 1 },
      files: [{ path: "a", patch: small, before: "b", after: "a" }],
      results: [{ filediff: { file: "a", patch: small, before: "b", after: "a" } }],
    })
    const out = stripPartMetadata(p) as Extract<SessionV1.Part, { type: "tool" }>
    const meta = (out.state as { status: "completed"; metadata: Record<string, unknown> }).metadata
    expect(meta.diff).toBeUndefined()
    expect((meta.filediff as Record<string, unknown>).patch).toBe(small)
    expect((meta.filediff as Record<string, unknown>).before).toBeUndefined()
    expect(((meta.files as Record<string, unknown>[])[0] as Record<string, unknown>).patch).toBe(small)
    expect((((meta.results as Record<string, unknown>[])[0] as Record<string, unknown>).filediff as Record<string, unknown>).patch).toBe(small)

    const capped = stripPartMetadata(toolPart({ filediff: { file: "a", patch: big, additions: 1, deletions: 1 } })) as Extract<SessionV1.Part, { type: "tool" }>
    expect(((capped.state as { metadata: Record<string, unknown> }).metadata.filediff as Record<string, unknown>).patch).toBeUndefined()

    const kept = stripPartMetadata(toolPart({ filediff: { file: "a", patch: exact, additions: 1, deletions: 1 } })) as Extract<SessionV1.Part, { type: "tool" }>
    expect(((kept.state as { metadata: Record<string, unknown> }).metadata.filediff as Record<string, unknown>).patch).toBe(exact)
  })

  it("strips oversized user summary diffs only", () => {
    const small = "p".repeat(10)
    const big = "x".repeat(MAX_MESSAGE_PATCH_SIZE + 1)
    const info = {
      id: "msg_1",
      sessionID: "ses_1",
      role: "user",
      time: { created: 1 },
      agent: "a",
      model: { providerID: "p", modelID: "m" },
      summary: { diffs: [{ file: "a", patch: small, additions: 1, deletions: 1 }, { file: "b", patch: big, additions: 1, deletions: 1 }] },
    } as unknown as SessionV1.Info
    const out = stripMessageMetadata(info) as SessionV1.User
    expect(out.summary!.diffs[0]!.patch).toBe(small)
    expect(out.summary!.diffs[1]!.patch).toBe("")
  })

  it("validates without dropping legacy top-level extras; malformed still throws", () => {
    const legacy = {
      id: "msg_legacy",
      sessionID: "ses_1",
      role: "user",
      time: { created: 7 },
      agent: "a",
      model: { providerID: "p", modelID: "m" },
      variant: "legacy-user-variant",
    } as unknown as SessionV1.Info
    const kept = validateInfo(legacy)
    expect((kept as unknown as Record<string, unknown>).variant).toBe("legacy-user-variant")
    const projected = projectMessageInfo(
      { role: "user", time: { created: 7 }, agent: "a", model: { providerID: "p", modelID: "m" }, variant: "legacy-user-variant" },
      { id: "msg_legacy", sessionID: "ses_1" },
    )
    expect((projected as unknown as Record<string, unknown>).variant).toBe("legacy-user-variant")
    const legacyPart = {
      id: "prt_legacy",
      sessionID: "ses_1",
      messageID: "msg_legacy",
      type: "text",
      text: "hi",
      legacyNote: "keep",
    } as unknown as SessionV1.Part
    expect((validatePart(legacyPart) as unknown as Record<string, unknown>).legacyNote).toBe("keep")
    expect(() =>
      projectMessagePart({ type: "text", text: "hi", legacyNote: "keep" }, { id: "prt_legacy", sessionID: "ses_1", messageID: "msg_legacy" }),
    ).not.toThrow()
    const outPart = projectMessagePart({ type: "text", text: "hi", legacyNote: "keep" }, { id: "prt_legacy", sessionID: "ses_1", messageID: "msg_legacy" })
    expect((outPart as unknown as Record<string, unknown>).legacyNote).toBe("keep")
    for (const bad of [{ role: "user" }, { id: "bad", sessionID: "ses_1", role: "user" }, { type: "text" }]) {
      const throwsInfo = (() => {
        try {
          validateInfo(bad)
          return false
        } catch {
          return true
        }
      })()
      expect(throwsInfo || (() => {
        try {
          validatePart(bad)
          return false
        } catch {
          return true
        }
      })()).toBe(true)
    }
    expect(() => validateInfo({ role: "user" })).toThrow()
    expect(() => validatePart({ type: "text" })).toThrow()
  })

  it("enforces ASC page order and cursor anchor invariants", () => {
    const msg = (id: string, time: number) =>
      ({
        info: { id, sessionID: "ses_1", role: "user", time: { created: time }, agent: "a", model: { providerID: "p", modelID: "m" } },
        parts: [],
      }) as unknown as { info: SessionV1.Info; parts: SessionV1.Part[] }
    const ok = [msg("msg_a", 100), msg("msg_b", 100), msg("msg_c", 200)]
    const cursor = encodeMessageCursor({ id: "msg_a", time: 100 })
    expect(() => assertFoundMessagePage(ok, 3, cursor)).not.toThrow()
    expect(() => assertFoundMessagePage(ok, 3, undefined)).not.toThrow()
    expect(() => assertFoundMessagePage([msg("msg_b", 200), msg("msg_a", 100)], 2, undefined)).toThrow()
    expect(() => assertFoundMessagePage([msg("msg_b", 100), msg("msg_a", 100)], 2, undefined)).toThrow()
    expect(() => assertFoundMessagePage([msg("msg_a", 100)], 2, encodeMessageCursor({ id: "msg_a", time: 100 }))).toThrow()
    expect(() => assertFoundMessagePage([], 2, encodeMessageCursor({ id: "msg_a", time: 100 }))).toThrow()
    expect(() => assertFoundMessagePage(ok, 2, undefined)).toThrow()
    expect(() => assertFoundMessagePage(ok.slice(0, 2), 2, encodeMessageCursor({ id: "msg_zzz", time: 100 }))).toThrow()
    expect(() => assertFoundMessagePage(ok.slice(0, 2), 2, encodeMessageCursor({ id: "msg_a", time: 999 }))).toThrow()
  })
})
