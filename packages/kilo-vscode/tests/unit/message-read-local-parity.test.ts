import { describe, expect, it } from "bun:test"
import * as Core from "@opencode-ai/core/session/message-read"
import * as Local from "../../src/private-worker/message-read"

function userInfo(id: string, time: number, extra?: Record<string, unknown>) {
  return {
    id,
    sessionID: "ses_1",
    role: "user",
    time: { created: time },
    agent: "a",
    model: { providerID: "p", modelID: "m" },
    ...(extra ?? {}),
  }
}

function assistantInfo(id: string, time: number) {
  return {
    id,
    sessionID: "ses_1",
    role: "assistant",
    time: { created: time },
    parentID: "msg_p0",
    modelID: "m",
    providerID: "p",
    mode: "build",
    agent: "a",
    path: { cwd: "/tmp", root: "/tmp" },
    cost: 1,
    tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
  }
}

function textPart(id: string, mid: string, extra?: Record<string, unknown>) {
  return { id, sessionID: "ses_1", messageID: mid, type: "text", text: "hi", ...(extra ?? {}) }
}

function toolPart() {
  return {
    id: "prt_t1",
    sessionID: "ses_1",
    messageID: "msg_1",
    type: "tool",
    callID: "c1",
    tool: "edit",
    state: { status: "completed", input: {}, output: "ok", title: "t", metadata: {}, time: { start: 0, end: 1 } },
  }
}

function parity(fn: (mod: typeof Core) => unknown): { coreThrows: boolean; localThrows: boolean; coreErr?: string; localErr?: string } {
  let coreThrows = false
  let localThrows = false
  let coreErr = ""
  let localErr = ""
  try {
    fn(Core)
  } catch (e) {
    coreThrows = true
    coreErr = (e as Error).message
  }
  try {
    fn(Local as unknown as typeof Core)
  } catch (e) {
    localThrows = true
    localErr = (e as Error).message
  }
  return { coreThrows, localThrows, coreErr, localErr }
}

describe("vscode-local message-read parity", () => {
  it("cursor roundtrips identically", () => {
    const enc = Local.encodeMessageCursor({ id: "msg_abc", time: 123 })
    expect(Core.decodeMessageCursor(enc)).toEqual({ id: "msg_abc", time: 123 })
    expect(Local.decodeMessageCursor(Core.encodeMessageCursor({ id: "msg_abc", time: 123 }))).toEqual({
      id: "msg_abc",
      time: 123,
    })
  })

  it("cursor rejects the same malformed inputs", () => {
    const bad: unknown[] = [
      "",
      "not-base64!!!",
      "a".repeat(Core.MESSAGE_CURSOR_MAX_LENGTH + 1),
      Core.encodeMessageCursor({ id: "bad", time: 1 }),
      Core.encodeMessageCursor({ id: "msg_1", time: -1 }),
      Core.encodeMessageCursor({ id: "msg_1", time: 8640000000000001 }),
      Buffer.from(JSON.stringify({ id: "msg_1" }), "utf8").toString("base64url"),
      Buffer.from(JSON.stringify({ id: "msg_1", time: 1, extra: 1 }), "utf8").toString("base64url"),
      Buffer.from(JSON.stringify({ time: 1 }), "utf8").toString("base64url"),
      Buffer.from(JSON.stringify(["x"]), "utf8").toString("base64url"),
      Buffer.from("not-json", "utf8").toString("base64url"),
      123,
      null,
    ]
    for (const v of bad) {
      const r = parity((m) => m.decodeMessageCursor(v))
      expect(r.coreThrows).toBe(true)
      expect(r.localThrows).toBe(true)
    }
    const fracCore = Core.decodeMessageCursor(Core.encodeMessageCursor({ id: "msg_1", time: 1.5 }))
    const fracLocal = Local.decodeMessageCursor(Local.encodeMessageCursor({ id: "msg_1", time: 1.5 }))
    expect(fracCore).toEqual({ id: "msg_1", time: 1.5 })
    expect(fracLocal).toEqual({ id: "msg_1", time: 1.5 })
    expect(Core.isStrictCursorTime(1.5)).toBe(false)
    expect(Local.isStrictCursorTime(1.5)).toBe(false)
    expect(Core.isStrictCursorTime(1)).toBe(true)
    expect(Local.isStrictCursorTime(1)).toBe(true)
  })

  it("validates real info/part shapes identically and preserves legacy extras", () => {
    const validInfos: unknown[] = [
      userInfo("msg_1", 7),
      assistantInfo("msg_a1", 100),
      userInfo("msg_legacy", 7, { variant: "legacy-user-variant" }),
    ]
    for (const info of validInfos) {
      const r = parity((m) => m.validateInfo(info))
      expect([JSON.stringify(info), r.coreThrows, r.localThrows].join("|")).toBe([JSON.stringify(info), false, false].join("|"))
    }
    const keptLocal = Local.validateInfo(userInfo("msg_legacy", 7, { variant: "legacy-user-variant" })) as unknown as Record<string, unknown>
    expect(keptLocal.variant).toBe("legacy-user-variant")
    const keptCore = Core.validateInfo(userInfo("msg_legacy", 7, { variant: "legacy-user-variant" }) as never) as unknown as Record<string, unknown>
    expect(keptCore.variant).toBe("legacy-user-variant")

    const validParts: unknown[] = [
      textPart("prt_1", "msg_1"),
      toolPart(),
      { id: "prt_r1", sessionID: "ses_1", messageID: "msg_1", type: "reasoning", text: "r", time: { start: 0 } },
      { id: "prt_f1", sessionID: "ses_1", messageID: "msg_1", type: "file", mime: "text/plain", url: "file:///a" },
      { ...textPart("prt_legacy", "msg_legacy"), legacyNote: "keep" },
    ]
    for (const p of validParts) {
      const r = parity((m) => m.validatePart(p))
      expect([JSON.stringify(p), r.coreThrows, r.localThrows].join("|")).toBe([JSON.stringify(p), false, false].join("|"))
    }
    const keptPart = Local.validatePart({ ...textPart("prt_legacy", "msg_legacy"), legacyNote: "keep" }) as unknown as Record<string, unknown>
    expect(keptPart.legacyNote).toBe("keep")
  })

  it("rejects the same malformed info/part payloads", () => {
    const badInfos: unknown[] = [
      { role: "user" },
      { id: "bad", sessionID: "ses_1", role: "user" },
      { id: "msg_1", sessionID: "bad", role: "user", time: { created: 1 }, agent: "a", model: { providerID: "p", modelID: "m" } },
      { ...userInfo("msg_1", 1), role: "system" },
      { ...userInfo("msg_1", 1), time: { created: -1 } },
      { ...userInfo("msg_1", 1), agent: 123 },
      null,
      [],
    ]
    for (const bad of badInfos) {
      const r = parity((m) => m.validateInfo(bad))
      expect(r.coreThrows).toBe(true)
      expect(r.localThrows).toBe(true)
    }
    const badParts: unknown[] = [
      { type: "text" },
      { id: "bad", sessionID: "ses_1", messageID: "msg_1", type: "text", text: "hi" },
      { id: "prt_1", sessionID: "ses_1", messageID: "msg_1", type: "text" },
      { id: "prt_1", sessionID: "ses_1", messageID: "msg_1", type: "text", text: 123 },
      { id: "prt_1", sessionID: "ses_1", messageID: "msg_1", type: "nope" },
      { id: "prt_1", sessionID: "ses_1", messageID: "msg_1", type: "tool", callID: "c", tool: "edit", state: { status: "bogus", input: {} } },
      null,
    ]
    for (const bad of badParts) {
      const r = parity((m) => m.validatePart(bad))
      expect(r.coreThrows).toBe(true)
      expect(r.localThrows).toBe(true)
    }
  })

  it("enforces identical ASC page and cursor-anchor invariants including empty/large boundaries", () => {
    const msg = (id: string, time: number) =>
      ({
        info: userInfo(id, time),
        parts: [],
      }) as unknown as { info: { id: string; time: { created: number } }; parts: never[] }
    const ok = [msg("msg_a", 100), msg("msg_b", 100), msg("msg_c", 200)]
    const cursor = Local.encodeMessageCursor({ id: "msg_a", time: 100 })
    const cases: Array<{ messages: unknown[]; limit: number; nextCursor: string | undefined; expectThrow: boolean }> = [
      { messages: ok, limit: 3, nextCursor: cursor, expectThrow: false },
      { messages: ok, limit: 3, nextCursor: undefined, expectThrow: false },
      { messages: [], limit: 10, nextCursor: undefined, expectThrow: false },
      { messages: [msg("msg_b", 200), msg("msg_a", 100)], limit: 2, nextCursor: undefined, expectThrow: true },
      { messages: [msg("msg_b", 100), msg("msg_a", 100)], limit: 2, nextCursor: undefined, expectThrow: true },
      { messages: [msg("msg_a", 100)], limit: 2, nextCursor: Local.encodeMessageCursor({ id: "msg_a", time: 100 }), expectThrow: true },
      { messages: [], limit: 2, nextCursor: Local.encodeMessageCursor({ id: "msg_a", time: 100 }), expectThrow: true },
      { messages: ok, limit: 2, nextCursor: undefined, expectThrow: true },
      { messages: ok.slice(0, 2), limit: 2, nextCursor: Local.encodeMessageCursor({ id: "msg_zzz", time: 100 }), expectThrow: true },
      { messages: ok.slice(0, 2), limit: 2, nextCursor: Local.encodeMessageCursor({ id: "msg_a", time: 999 }), expectThrow: true },
      {
        messages: Array.from({ length: 100 }, (_, i) => msg(`msg_${String(i).padStart(3, "0")}`, i)),
        limit: 100,
        nextCursor: Local.encodeMessageCursor({ id: "msg_000", time: 0 }),
        expectThrow: false,
      },
      {
        messages: Array.from({ length: 101 }, (_, i) => msg(`msg_${String(i).padStart(3, "0")}`, i)),
        limit: 100,
        nextCursor: undefined,
        expectThrow: true,
      },
    ]
    for (const c of cases) {
      const coreThrows = (() => {
        try {
          Core.assertFoundMessagePage(c.messages as never, c.limit, c.nextCursor)
          return false
        } catch {
          return true
        }
      })()
      const localThrows = (() => {
        try {
          Local.assertFoundMessagePage(c.messages as never, c.limit, c.nextCursor)
          return false
        } catch {
          return true
        }
      })()
      expect(coreThrows).toBe(c.expectThrow)
      expect(localThrows).toBe(c.expectThrow)
    }
  })
})
