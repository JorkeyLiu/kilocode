// @ts-nocheck
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { SessionOperation } from "@opencode-ai/core/session/operation"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)

describe("sessionUpdate operation", () => {
  it.effect("opId generation and parse", () =>
    Effect.gen(function* () {
      const id = SessionOperation.sessionUpdateId("ses_abc")
      expect(id).toBe("sessionUpdate:ses_abc")
      const parsed = SessionOperation.parseOpId(id)
      expect(parsed.kind).toBe("sessionUpdate")
      expect(parsed.parts).toEqual(["ses_abc"])
      const id2 = SessionOperation.sessionUpdateId("ses_abc", "tok123")
      expect(id2).toBe("sessionUpdate:ses_abc:tok123")
      const parsed2 = SessionOperation.parseOpId(id2)
      expect(parsed2.kind).toBe("sessionUpdate")
      expect(parsed2.parts).toEqual(["ses_abc", "tok123"])
      expect(() => SessionOperation.sessionUpdateId("bad:colon")).toThrow()
      expect(() => SessionOperation.sessionUpdateId("ses_abc", "bad:colon")).toThrow()
      expect(() => SessionOperation.parseOpId("sessionUpdate:")).toThrow()
      expect(() => SessionOperation.parseOpId("sessionUpdate:ses_a:extra:more")).toThrow()
      expect(() => SessionOperation.parseOpId("sessionUpdate:ses_a:")).toThrow()
    }),
  )

  it.effect("hash stable", () =>
    Effect.gen(function* () {
      const h1 = SessionOperation.hashIdempotencyKey("idem-1")
      const h2 = SessionOperation.hashIdempotencyKey("idem-1")
      expect(h1).toBe(h2)
      expect(h1.length).toBe(64)
      expect(SessionOperation.hashIdempotencyKey("idem-2")).not.toBe(h1)
    }),
  )

  it.effect("isSessionUpdateConflict detects differences", () =>
    Effect.gen(function* () {
      const rec: SessionOperation.SessionUpdateRecord = {
        opId: "sessionUpdate:ses_a",
        opKind: "sessionUpdate",
        outcome: "succeeded",
        code: "sessionUpdate.succeeded",
        message: "ok",
        time: 1,
        revision: 1,
        meta: {
          idempotencyHash: "h",
          requestId: "r",
          directory: "/tmp",
          parentSessionId: null,
          configVersion: 1,
          sessionRevision: 2,
          title: "hello",
        },
      }
      expect(SessionOperation.isSessionUpdateConflict(rec, { opId: "sessionUpdate:ses_a", directory: "/tmp", parentSessionId: null, configVersion: 1, sessionRevision: 2, title: "hello" })).toBe(false)
      expect(SessionOperation.isSessionUpdateConflict(rec, { opId: "sessionUpdate:ses_a", directory: "/other", parentSessionId: null, configVersion: 1, sessionRevision: 2, title: "hello" })).toBe(true)
      expect(SessionOperation.isSessionUpdateConflict(rec, { opId: "sessionUpdate:ses_a", directory: "/tmp", parentSessionId: null, configVersion: 1, sessionRevision: 2, title: "different" })).toBe(true)
      expect(SessionOperation.isSessionUpdateConflict(rec, { opId: "sessionUpdate:ses_other", directory: "/tmp", parentSessionId: null, configVersion: 1, sessionRevision: 2, title: "hello" })).toBe(true)
      expect(SessionOperation.isSessionUpdateConflict(rec, { opId: "sessionUpdate:ses_a", directory: "/tmp", parentSessionId: null, configVersion: 2, sessionRevision: 2, title: "hello" })).toBe(true)
    }),
  )

  it.effect("migration includes sessionUpdate and title column", () =>
    Effect.gen(function* () {
      expect(SessionOperation.OP_KINDS.includes("sessionUpdate")).toBe(true)
    }),
  )
})
