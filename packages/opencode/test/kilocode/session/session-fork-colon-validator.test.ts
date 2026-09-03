// @ts-nocheck
import { describe, expect, test } from "bun:test"
import { SessionOperation } from "@opencode-ai/core/session/operation"
import { validateRequest } from "../../../src/kilocode/session/session-fork-dispatch"

const dir = "/tmp/kilo-fork-colon-validator"

function req(sessionId: string, opId: string, idempotencyKey: string, extra?: Record<string, unknown>) {
  return {
    v: 1 as const,
    requestId: "req-colon",
    opId,
    op: "session/fork" as const,
    idempotencyKey,
    context: { directory: dir, sessionId, parentSessionId: null },
    payload: {},
    ...(extra ?? {}),
  }
}

describe("fork colon SessionID validator parity", () => {
  test("valid colon SessionID tokenless identity passes", () => {
    const sid = "ses:colon:id"
    const opId = `fork:${sid}`
    const out = validateRequest(req(sid, opId, opId))
    expect(out.opId).toBe(opId)
    const parsed = SessionOperation.parseForkOpIdForSession(opId, sid)
    expect(parsed.sessionId).toBe(sid)
    expect(parsed.token).toBeUndefined()
  })

  test("valid colon SessionID tokenized identity passes", () => {
    const sid = "ses:colon:id"
    const opId = `fork:${sid}:tok123`
    const out = validateRequest(req(sid, opId, opId))
    expect(out.opId).toBe(opId)
    const parsed = SessionOperation.parseForkOpIdForSession(opId, sid)
    expect(parsed.token).toBe("tok123")
  })

  test("plain SessionID tokenless and tokenized still pass", () => {
    const sid = "ses_plain123"
    const bare = `fork:${sid}`
    expect(() => validateRequest(req(sid, bare, bare))).not.toThrow()
    const tok = `fork:${sid}:tok`
    expect(() => validateRequest(req(sid, tok, tok))).not.toThrow()
  })

  test("idempotency mismatch rejected", () => {
    const sid = "ses:colon:id"
    const opId = `fork:${sid}:tokA`
    const bad = `fork:${sid}:tokB`
    expect(() => validateRequest(req(sid, opId, bad))).toThrow()
  })

  test("wrong session binding rejected", () => {
    const sid = "ses:colon:id"
    const other = "ses:colon:other"
    const opId = `fork:${other}:tok`
    expect(() => validateRequest(req(sid, opId, opId))).toThrow()
  })

  test("malformed token cases rejected", () => {
    const sid = "ses:colon:id"
    const empty = `fork:${sid}:`
    expect(() => validateRequest(req(sid, empty, empty))).toThrow()
    const colonTok = `fork:${sid}:bad:token`
    expect(() => validateRequest(req(sid, colonTok, colonTok))).toThrow()
    const extra = `fork:${sid}:tok:extra`
    expect(() => validateRequest(req(sid, extra, extra))).toThrow()
    const plainColon = "fork:ses_plain:bad:token"
    expect(() => validateRequest(req("ses_plain", plainColon, plainColon))).toThrow()
  })

  test("bound parser rejects non-fork kind and preserves strict token rule", () => {
    expect(() => SessionOperation.parseForkOpIdForSession("prompt:ses_x", "ses_x")).toThrow()
    expect(() => SessionOperation.parseForkOpIdForSession("fork:ses_x:bad:tok", "ses_x")).toThrow()
    expect(SessionOperation.parseForkOpIdForSession("fork:ses_x:tok", "ses_x").token).toBe("tok")
  })
})
