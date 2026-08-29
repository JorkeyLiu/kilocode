import { describe, it, expect } from "bun:test"
import {
  FAILURE_ENVELOPE_VERSION,
  OP_KINDS,
  OUTCOMES,
  CANCEL_SOURCES,
  DOMAINS,
  TIERS,
  FIELD_TIERS,
  normalize,
  classify,
  isTerminal,
  redact,
  select,
  buildPanelEnvelope,
  normalizeRecord,
  type FailureRecord,
} from "../../src/private-worker/failure"

function makeErr(msg: string, name?: string, extra?: Record<string, unknown>): Error {
  const e = new Error(msg)
  if (name) e.name = name
  if (extra) {
    for (const k of Object.keys(extra)) (e as unknown as Record<string, unknown>)[k] = extra[k]
  }
  return e
}

describe("R12 closed sets", () => {
  it("exact membership", () => {
    expect([...OP_KINDS]).toEqual(["prompt", "provider", "tool", "permission", "task"])
    expect([...OUTCOMES]).toEqual(["succeeded", "failed", "ambiguous", "in-flight", "superseded", "abandoned"])
    expect([...CANCEL_SOURCES]).toEqual(["user_stop", "steering", "timeout", "network_disconnect", "unknown"])
    expect([...DOMAINS]).toEqual(["provider", "session", "tool", "permission", "worker", "transport"])
    expect([...TIERS]).toEqual(["durable", "diagnostic", "panel-visible"])
  })

  it("normalize throws TypeError on invalid opKind", () => {
    expect(() =>
      normalize({
        opId: "a",
        opKind: "bad" as unknown as typeof OP_KINDS[number],
        domain: "provider",
        time: 1,
        outcome: "succeeded",
      }),
    ).toThrow(TypeError)
  })

  it("throws on invalid domain", () => {
    expect(() =>
      normalize({
        opId: "a",
        opKind: "prompt",
        domain: "bad" as unknown as typeof DOMAINS[number],
        time: 1,
        outcome: "succeeded",
      }),
    ).toThrow(TypeError)
  })

  it("throws on invalid cancel source", () => {
    expect(() =>
      normalize({
        opId: "a",
        opKind: "prompt",
        domain: "provider",
        time: 1,
        cancel: "bad" as unknown as typeof CANCEL_SOURCES[number],
      }),
    ).toThrow(TypeError)
  })

  it("throws on invalid explicit outcome", () => {
    expect(() =>
      normalize({
        opId: "a",
        opKind: "prompt",
        domain: "provider",
        time: 1,
        outcome: "bad" as unknown as typeof OUTCOMES[number],
      }),
    ).toThrow(TypeError)
  })

  it("throws on empty opId", () => {
    expect(() =>
      normalize({
        opId: "",
        opKind: "prompt",
        domain: "provider",
        time: 1,
        outcome: "succeeded",
      }),
    ).toThrow(TypeError)
  })

  it("throws on non-finite time", () => {
    for (const t of [NaN, Infinity, -Infinity]) {
      expect(() =>
        normalize({
          opId: "a",
          opKind: "prompt",
          domain: "provider",
          time: t,
          outcome: "succeeded",
        }),
      ).toThrow(TypeError)
    }
    expect(() =>
      normalize({
        opId: "a",
        opKind: "prompt",
        domain: "provider",
        time: "1" as unknown as number,
        outcome: "succeeded",
      }),
    ).toThrow(TypeError)
  })

  it("throws on non-string input.message", () => {
    expect(() =>
      normalize({
        opId: "a",
        opKind: "prompt",
        domain: "provider",
        time: 1,
        outcome: "succeeded",
        message: 123 as unknown as string,
      }),
    ).toThrow(TypeError)
  })

  it("throws when outcome missing without cancel/error", () => {
    expect(() =>
      normalize({
        opId: "a",
        opKind: "prompt",
        domain: "provider",
        time: 1,
      } as unknown as Parameters<typeof normalize>[0]),
    ).toThrow(TypeError)
  })
})

describe("R12 classification", () => {
  it("each domain with unknown error → <domain>.unknown", () => {
    const unk = makeErr("something random")
    expect(classify("transport", unk)).toBe("transport.unknown")
    expect(classify("provider", unk)).toBe("provider.unknown")
    expect(classify("session", unk)).toBe("session.unknown")
    expect(classify("tool", "oops")).toBe("tool.unknown")
    expect(classify("permission", unk)).toBe("permission.unknown")
    expect(classify("worker", unk)).toBe("worker.unknown")
  })

  it("provider 401 → provider.auth, 500 → provider.http, timeout → provider.timeout", () => {
    expect(classify("provider", makeErr("x", undefined, { status: 401 }))).toBe("provider.auth")
    expect(classify("provider", makeErr("x", undefined, { status: 403 }))).toBe("provider.auth")
    expect(classify("provider", makeErr("timeout exceeded"))).toBe("provider.timeout")
    expect(classify("provider", makeErr("timed out"))).toBe("provider.timeout")
    expect(classify("provider", makeErr("x", undefined, { status: 500 }))).toBe("provider.http")
    expect(classify("provider", makeErr("x", undefined, { statusCode: 502 }))).toBe("provider.http")
    expect(classify("provider", makeErr("x", undefined, { status: 404 }))).toBe("provider.http")
  })

  it("transport EOF → transport.eof, frame → transport.frame, protocol → transport.protocol", () => {
    expect(classify("transport", makeErr("EOF"))).toBe("transport.eof")
    expect(classify("transport", makeErr("end of file"))).toBe("transport.eof")
    expect(classify("transport", makeErr("stdin closed"))).toBe("transport.eof")
    expect(classify("transport", makeErr("frame error"))).toBe("transport.frame")
    expect(classify("transport", makeErr("json-rpc error"))).toBe("transport.protocol")
    expect(classify("transport", makeErr("protocol mismatch"))).toBe("transport.protocol")
    expect(classify("transport", makeErr("invalid request"))).toBe("transport.protocol")
  })

  it("session AbortError → session.aborted, permission denied → permission.denied, worker crash → worker.crash, no error → unknown", () => {
    expect(classify("session", makeErr("aborted", "AbortError"))).toBe("session.aborted")
    expect(classify("session", makeErr("operation aborted"))).toBe("session.aborted")
    expect(classify("permission", makeErr("denied by policy"))).toBe("permission.denied")
    expect(classify("worker", makeErr("crash"))).toBe("worker.crash")
    expect(classify("worker", makeErr("process exited"))).toBe("worker.crash")
    expect(classify("worker", makeErr("spawn failed"))).toBe("worker.crash")
    expect(classify("provider", null)).toBe("unknown")
    expect(classify("session", undefined)).toBe("unknown")
  })

  it("tool Error → tool.failed, non-Error → tool.unknown", () => {
    expect(classify("tool", makeErr("fail"))).toBe("tool.failed")
    expect(classify("tool", "string err")).toBe("tool.unknown")
  })
})

describe("R12 normalization boundary", () => {
  it("error input → outcome failed, caps, time preserved, message wins", () => {
    const longDetail = "b".repeat(1500)
    const err = makeErr(longDetail)
    err.name = "Error"
    err.stack = "s".repeat(3000)
    const rec = normalize({ opId: "op1", opKind: "prompt", domain: "provider", time: 12345, error: err })
    expect(rec.outcome).toBe("failed")
    expect(rec.time).toBe(12345)
    expect(rec.message.length).toBeLessThanOrEqual(501)
    expect(rec.message.endsWith("…")).toBe(true)
    expect(rec.detail!.length).toBeLessThanOrEqual(1001)
    expect(rec.stack!.length).toBeLessThanOrEqual(2001)
    expect(rec.detail).toBeDefined()
    expect(rec.stack).toBeDefined()
  })

  it("input.message wins over error.message", () => {
    const err = makeErr("error msg")
    const rec = normalize({ opId: "op2", opKind: "prompt", domain: "provider", time: 1, error: err, message: "input wins" })
    expect(rec.message).toBe("input wins")
  })

  it("time preserved verbatim", () => {
    const t = 9876543210.5
    const rec = normalize({ opId: "op3", opKind: "task", domain: "session", time: t, outcome: "succeeded" })
    expect(rec.time).toBe(t)
  })

  it("message capped at 500 chars with ellipsis", () => {
    const msg = "x".repeat(501)
    const rec = normalize({ opId: "op4", opKind: "prompt", domain: "provider", time: 1, error: makeErr(msg) })
    expect(rec.message.length).toBeLessThanOrEqual(501)
    expect(rec.message.endsWith("…")).toBe(true)
    const exact500 = "y".repeat(500)
    const rec2 = normalize({ opId: "op5", opKind: "prompt", domain: "provider", time: 1, error: makeErr(exact500) })
    expect(rec2.message.length).toBe(500)
    expect(rec2.message.endsWith("…")).toBe(false)
  })

  it("detail capped at 1000, stack capped at 2000", () => {
    const err = makeErr("a".repeat(2000))
    err.stack = "s".repeat(3000)
    const rec = normalize({ opId: "op6", opKind: "prompt", domain: "provider", time: 1, error: err })
    expect(rec.detail!.length).toBeLessThanOrEqual(1001)
    expect(rec.stack!.length).toBeLessThanOrEqual(2001)
  })

  it("detail includes status suffix when numeric status present", () => {
    const err = makeErr("boom", undefined, { status: 500 })
    const rec = normalize({ opId: "op7", opKind: "prompt", domain: "provider", time: 1, error: err })
    expect(rec.detail).toContain("status=500")
    expect(rec.code).toBe("provider.http")
  })
})

describe("R12 recovery separation", () => {
  it("output contains ONLY schema keys", () => {
    const input = {
      opId: "opR",
      opKind: "prompt",
      domain: "provider",
      time: 1,
      error: makeErr("x"),
      retryAfter: 100,
      attempt: 2,
    } as unknown as Parameters<typeof normalize>[0] & { retryAfter: number; attempt: number }
    const rec = normalize(input)
    const allowed = new Set(["opId", "opKind", "outcome", "code", "message", "time", "cancel", "detail", "stack"])
    for (const k of Object.keys(rec)) expect(allowed.has(k)).toBe(true)
    expect((rec as unknown as Record<string, unknown>)["retryAfter"]).toBeUndefined()
    expect((rec as unknown as Record<string, unknown>)["attempt"]).toBeUndefined()
  })
})

describe("R12 redaction", () => {
  it("object secrets redacted, keep preserved", () => {
    const obj = { apiKey: "sk-123", nested: { token: "t", Authorization: "Bearer x" }, keep: "v" }
    const out = redact(obj) as Record<string, unknown>
    expect(out["apiKey"]).toBe("[redacted]")
    expect((out["nested"] as Record<string, unknown>)["token"]).toBe("[redacted]")
    expect((out["nested"] as Record<string, unknown>)["Authorization"]).toBe("[redacted]")
    expect(out["keep"]).toBe("v")
  })

  it("string scrub", () => {
    const s = "failed apiKey=sk-123 token: abc password=secret123 keep=ok"
    const out = redact(s) as string
    expect(out).not.toContain("sk-123")
    expect(out).not.toContain("abc")
    expect(out).not.toContain("secret123")
    expect(out).toContain("apiKey=[redacted]")
    expect(out).toContain("token=[redacted]")
    expect(out).toContain("password=[redacted]")
  })

  it("cyclic object does not throw", () => {
    const o: Record<string, unknown> = {}
    o["self"] = o
    expect(() => redact(o)).not.toThrow()
    const out = redact(o) as Record<string, unknown>
    expect(out["self"]).toBe("[truncated]")
  })

  it("depth cap 8", () => {
    let deep: unknown = "leaf"
    for (let i = 0; i < 10; i++) deep = { a: deep }
    const out = redact(deep) as Record<string, unknown>
    expect(JSON.stringify(out)).toContain("[truncated]")
  })

  it("normalize redacts message and detail", () => {
    const err = makeErr("apiKey=sk-123")
    const rec = normalize({ opId: "opR2", opKind: "prompt", domain: "provider", time: 1, error: err })
    expect(rec.message).not.toContain("sk-123")
    expect(rec.message).toContain("[redacted]")
    expect(rec.detail).not.toContain("sk-123")
  })

  it("stack secrets redacted", () => {
    const err = makeErr("benign message")
    err.stack = "Error: benign message\n    at foo token=abc123 apiKey=sk-999"
    const rec = normalize({ opId: "opStack", opKind: "provider", domain: "provider", time: 1, error: err })
    expect(rec.stack).not.toContain("abc123")
    expect(rec.stack).not.toContain("sk-999")
    expect(rec.stack).toContain("[redacted]")
  })
})

describe("R12 tiers", () => {
  it("FIELD_TIERS has exactly one entry per keyof FailureRecord", () => {
    const expected: (keyof FailureRecord)[] = ["opId", "opKind", "outcome", "code", "message", "time", "cancel", "detail", "stack"]
    expect(Object.keys(FIELD_TIERS).sort()).toEqual(expected.sort())
    expect(FIELD_TIERS["opId"]).toBe("panel-visible")
    expect(FIELD_TIERS["opKind"]).toBe("durable")
    expect(FIELD_TIERS["outcome"]).toBe("panel-visible")
    expect(FIELD_TIERS["code"]).toBe("panel-visible")
    expect(FIELD_TIERS["message"]).toBe("panel-visible")
    expect(FIELD_TIERS["time"]).toBe("durable")
    expect(FIELD_TIERS["cancel"]).toBe("panel-visible")
    expect(FIELD_TIERS["detail"]).toBe("diagnostic")
    expect(FIELD_TIERS["stack"]).toBe("diagnostic")
  })

  it("select(project) contains only panel-visible fields", () => {
    const rec: FailureRecord = {
      opId: "id",
      opKind: "prompt",
      outcome: "failed",
      code: "provider.unknown",
      message: "m",
      time: 1,
      cancel: { source: "user_stop" },
      detail: "d",
      stack: "s",
    }
    const proj = select(rec, "project")
    expect(new Set(Object.keys(proj))).toEqual(new Set(["opId", "outcome", "code", "message", "cancel"]))
    expect((proj as Record<string, unknown>)["detail"]).toBeUndefined()
    expect((proj as Record<string, unknown>)["stack"]).toBeUndefined()
    expect((proj as Record<string, unknown>)["opKind"]).toBeUndefined()
    expect((proj as Record<string, unknown>)["time"]).toBeUndefined()
  })

  it("select(project) without cancel omits cancel", () => {
    const rec: FailureRecord = { opId: "id", opKind: "prompt", outcome: "failed", code: "c", message: "m", time: 1 }
    const proj = select(rec, "project")
    expect("cancel" in proj).toBe(false)
  })

  it("select(diagnose) contains diagnostic+panel but not durable", () => {
    const rec: FailureRecord = {
      opId: "id",
      opKind: "prompt",
      outcome: "failed",
      code: "c",
      message: "m",
      time: 1,
      detail: "d",
      stack: "s",
    }
    const diag = select(rec, "diagnose")
    expect(Object.keys(diag).sort()).toEqual(["code", "detail", "message", "opId", "outcome", "stack"].sort())
    expect((diag as Record<string, unknown>)["opKind"]).toBeUndefined()
    expect((diag as Record<string, unknown>)["time"]).toBeUndefined()
  })

  it("select(persist) equals full record minus absent optionals", () => {
    const rec: FailureRecord = {
      opId: "id",
      opKind: "prompt",
      outcome: "failed",
      code: "c",
      message: "m",
      time: 1,
      detail: "d",
      stack: "s",
    }
    const p = select(rec, "persist")
    expect(p).toEqual(rec)
  })

  it("select returns new object", () => {
    const rec: FailureRecord = { opId: "id", opKind: "prompt", outcome: "failed", code: "c", message: "m", time: 1 }
    const proj = select(rec, "project") as Record<string, unknown>
    proj["message"] = "mutated"
    expect(rec.message).toBe("m")
  })
})

describe("R12 cancellation provenance", () => {
  it("all five CANCEL_SOURCES produce abandoned", () => {
    for (const src of CANCEL_SOURCES) {
      const rec = normalize({ opId: "opC", opKind: "prompt", domain: "provider", time: 1, cancel: src })
      expect(rec.outcome).toBe("abandoned")
      expect(rec.cancel).toEqual({ source: src })
    }
  })

  it("cancel present with error present still yields abandoned + cancel", () => {
    const rec = normalize({ opId: "opC2", opKind: "prompt", domain: "provider", time: 1, error: makeErr("boom"), cancel: "timeout" })
    expect(rec.outcome).toBe("abandoned")
    expect(rec.cancel).toEqual({ source: "timeout" })
  })

  it("distinguishes user_stop vs timeout", () => {
    const r1 = normalize({ opId: "opC3", opKind: "prompt", domain: "provider", time: 1, cancel: "user_stop" })
    const r2 = normalize({ opId: "opC4", opKind: "prompt", domain: "provider", time: 1, cancel: "timeout" })
    expect(r1.cancel!.source).toBe("user_stop")
    expect(r2.cancel!.source).toBe("timeout")
    expect(r1.cancel!.source).not.toBe(r2.cancel!.source)
  })
})

describe("R12 envelope", () => {
  it("version === 1.0 and payload is project-tier plain object", () => {
    const norm = normalize({ opId: "id2", opKind: "prompt", domain: "provider", time: 1, error: makeErr("apiKey=sk-123") })
    const env = buildPanelEnvelope(norm)
    expect(env.version).toBe("1.0")
    expect(env.version).toBe(FAILURE_ENVELOPE_VERSION)
    expect(typeof env.payload).toBe("object")
    expect(env.payload["detail"]).toBeUndefined()
    expect(env.payload["stack"]).toBeUndefined()
    expect(env.payload["opKind"]).toBeUndefined()
    expect(env.payload["time"]).toBeUndefined()
    expect(env.payload["opId"]).toBe(norm.opId)
    expect(env.payload["outcome"]).toBe(norm.outcome)
    expect(env.payload["code"]).toBe(norm.code)
    expect((env.payload["message"] as string)).not.toContain("sk-123")
    expect((env.payload["message"] as string)).toContain("[redacted]")
    const expectedKeys = new Set(["opId", "outcome", "code", "message"])
    expect(new Set(Object.keys(env.payload))).toEqual(expectedKeys)
  })

  it("envelope payload with cancel includes cancel", () => {
    const rec = normalize({ opId: "id", opKind: "prompt", domain: "provider", time: 1, cancel: "user_stop" })
    const env = buildPanelEnvelope(rec)
    expect(env.payload["cancel"]).toEqual({ source: "user_stop" })
  })

  it("direct raw caller-supplied record is normalized before projection — secrets scrubbed, caps, tier (P4-G7 regression)", () => {
    const raw: FailureRecord = {
      opId: "prompt:raw1",
      opKind: "prompt",
      outcome: "failed",
      code: "provider.unknown",
      message: `leak apiKey=sk-123456 token=abc123 password=secret123 credential=mycred ${"x".repeat(600)}`,
      time: 42,
      detail: `detail password=superSecret ${"y".repeat(1500)}`,
      stack: `stack token=stackSecret ${"z".repeat(3000)}`,
      cancel: { source: "timeout" },
    }
    const env = buildPanelEnvelope(raw)
    expect(env.version).toBe(FAILURE_ENVELOPE_VERSION)
    const msg = env.payload["message"] as string
    expect(msg).not.toContain("sk-123456")
    expect(msg).not.toContain("abc123")
    expect(msg).not.toContain("secret123")
    expect(msg).not.toContain("mycred")
    expect(msg).toContain("apiKey=[redacted]")
    expect(msg).toContain("token=[redacted]")
    expect(msg).toContain("password=[redacted]")
    expect(msg).toContain("credential=[redacted]")
    expect(msg.length).toBeLessThanOrEqual(501)
    expect(msg.endsWith("…")).toBe(true)
    expect(env.payload["detail"]).toBeUndefined()
    expect(env.payload["stack"]).toBeUndefined()
    expect(env.payload["opKind"]).toBeUndefined()
    expect(env.payload["time"]).toBeUndefined()
    expect(env.payload["opId"]).toBe(raw.opId)
    expect(env.payload["code"]).toBe(raw.code)
    expect(env.payload["outcome"]).toBe(raw.outcome)
    expect(env.payload["cancel"]).toEqual({ source: "timeout" })
    const normalized = normalizeRecord(raw)
    expect(normalized.message).toBe(msg)
    expect(normalized.detail).not.toContain("superSecret")
    expect(normalized.stack).not.toContain("stackSecret")
    expect(normalized.detail!.length).toBeLessThanOrEqual(1001)
    expect(normalized.stack!.length).toBeLessThanOrEqual(2001)
    expect(normalized.opId).toBe(raw.opId)
    expect(normalized.opKind).toBe(raw.opKind)
    expect(normalized.code).toBe(raw.code)
    expect(normalized.outcome).toBe(raw.outcome)
    expect(normalized.time).toBe(raw.time)
    const twice = normalizeRecord(normalized)
    expect(twice).toEqual(normalized)
    const env2 = buildPanelEnvelope(normalized)
    expect(env2.payload["message"]).toBe(msg)
  })

  it("direct raw quoted and bearer forms are scrubbed before projection — quoted/bearer regression", () => {
    const raw: FailureRecord = {
      opId: "prompt:raw-quoted-bearer",
      opKind: "prompt",
      outcome: "failed",
      code: "provider.unknown",
      message: `quoted apiKey="sk-live" secret: 'raw-secret' password="double-quoted" credential='single-quoted' bearer authorization: Bearer sk-bearer-secret and authorization=BearerXYZ tail`,
      time: 99,
      detail: `detail token="quoted-token" authorization: Bearer quoted-bearer-detail`,
      stack: `stack authorization: Bearer "tok-secret" secret='stack-quoted'`,
    }
    const env = buildPanelEnvelope(raw)
    expect(env.version).toBe(FAILURE_ENVELOPE_VERSION)
    const msg = env.payload["message"] as string
    expect(msg).not.toContain("sk-live")
    expect(msg).not.toContain("raw-secret")
    expect(msg).not.toContain("double-quoted")
    expect(msg).not.toContain("single-quoted")
    expect(msg).not.toContain("sk-bearer-secret")
    expect(msg).not.toContain("BearerXYZ")
    expect(msg).not.toContain("Bearer")
    expect(msg).toContain("apiKey=[redacted]")
    expect(msg).toContain("secret=[redacted]")
    expect(msg).toContain("password=[redacted]")
    expect(msg).toContain("credential=[redacted]")
    expect(msg).toContain("authorization=[redacted]")
    expect(env.payload["detail"]).toBeUndefined()
    expect(env.payload["stack"]).toBeUndefined()
    const normalized = normalizeRecord(raw)
    expect(normalized.message).toBe(msg)
    expect(normalized.detail).not.toContain("quoted-token")
    expect(normalized.detail).not.toContain("quoted-bearer-detail")
    expect(normalized.detail).toContain("[redacted]")
    expect(normalized.stack).not.toContain("tok-secret")
    expect(normalized.stack).not.toContain("stack-quoted")
    expect(normalized.stack).toContain("[redacted]")
    expect(normalized.stack).not.toContain("Bearer")
    const twice = normalizeRecord(normalized)
    expect(twice).toEqual(normalized)
    expect(buildPanelEnvelope(normalized).payload["message"]).toBe(msg)
    const redacted: FailureRecord = {
      opId: raw.opId,
      opKind: raw.opKind,
      outcome: raw.outcome,
      code: raw.code,
      message: `quoted apiKey=[redacted] secret=[redacted] password=[redacted] credential=[redacted] bearer authorization=[redacted] and authorization=[redacted] tail`,
      time: raw.time,
    }
    const envRedacted = buildPanelEnvelope(redacted)
    expect(envRedacted.payload["message"]).toBe(`quoted apiKey=[redacted] secret=[redacted] password=[redacted] credential=[redacted] bearer authorization=[redacted] and authorization=[redacted] tail`)
    expect(normalizeRecord(redacted).message).toBe(redacted.message)
  })

  it("escaped quoted and bearer values are fully redacted without suffix leak via envelope", () => {
    const raw: FailureRecord = {
      opId: "prompt:raw-escaped",
      opKind: "prompt",
      outcome: "failed",
      code: "provider.unknown",
      message: `prefix secret="foo\\"bar-secret" tail`,
      time: 100,
      detail: `detail secret='a\\'b-secret' tail2`,
      stack: `stack authorization: Bearer "tok\\"en-secret" tail3`,
    }
    const env = buildPanelEnvelope(raw)
    const msg = env.payload["message"] as string
    expect(msg).toBe(`prefix secret=[redacted] tail`)
    expect(msg).not.toContain("bar-secret")
    expect(msg).not.toContain("foo")
    const normalized = normalizeRecord(raw)
    expect(normalized.detail).toBe(`detail secret=[redacted] tail2`)
    expect(normalized.detail).not.toContain("b-secret")
    expect(normalized.stack).toBe(`stack authorization=[redacted] tail3`)
    expect(normalized.stack).not.toContain("tok")
    expect(normalized.stack).not.toContain("en-secret")
    expect(normalized.stack).not.toContain("Bearer")
    const raw2: FailureRecord = {
      opId: "prompt:raw-escaped-bearer-single",
      opKind: "prompt",
      outcome: "failed",
      code: "c",
      message: `msg authorization: Bearer 'tok\\'en-secret' tail`,
      time: 101,
    }
    const env2 = buildPanelEnvelope(raw2)
    expect(env2.payload["message"]).toBe(`msg authorization=[redacted] tail`)
    expect((env2.payload["message"] as string)).not.toContain("tok")
  })

  it("JSON-encoded quoted secret keys/values are scrubbed via envelope — direct raw JSON regression", () => {
    const raw: FailureRecord = {
      opId: "prompt:raw-json",
      opKind: "prompt",
      outcome: "failed",
      code: "provider.unknown",
      message: `prefix {"apiKey":"sk-json"} tail`,
      time: 102,
      detail: `detail {"token":"tok-json"} and {"password":"pass-json"}`,
      stack: `stack {"credential":"cred-json"} tail`,
    }
    const env = buildPanelEnvelope(raw)
    const msg = env.payload["message"] as string
    expect(msg).not.toContain("sk-json")
    expect(msg).not.toContain(`{"apiKey"`)
    expect(msg).toContain("apiKey=[redacted]")
    expect(msg).toContain("prefix")
    expect(msg).toContain("tail")
    const normalized = normalizeRecord(raw)
    expect(normalized.message).toBe(msg)
    expect(normalized.detail).not.toContain("tok-json")
    expect(normalized.detail).not.toContain("pass-json")
    expect(normalized.detail).toContain("token=[redacted]")
    expect(normalized.detail).toContain("password=[redacted]")
    expect(normalized.stack).not.toContain("cred-json")
    expect(normalized.stack).toContain("credential=[redacted]")
    const twice = normalizeRecord(normalized)
    expect(twice).toEqual(normalized)
    expect(buildPanelEnvelope(normalized).payload["message"]).toBe(msg)
    const rawEsc: FailureRecord = {
      opId: "prompt:raw-json-escaped",
      opKind: "prompt",
      outcome: "failed",
      code: "provider.unknown",
      message: `prefix {"secret":"foo\\"bar-secret"} tail`,
      time: 103,
      detail: `detail {"apiKey":"a\\"b-secret"} tail2`,
      stack: `stack {"token":"tok\\"en-secret"} tail3`,
    }
    const envEsc = buildPanelEnvelope(rawEsc)
    expect((envEsc.payload["message"] as string)).not.toContain("bar-secret")
    expect((envEsc.payload["message"] as string)).not.toContain("foo")
    expect((envEsc.payload["message"] as string)).toBe(`prefix {secret=[redacted]} tail`)
    const normEsc = normalizeRecord(rawEsc)
    expect(normEsc.detail).toBe(`detail {apiKey=[redacted]} tail2`)
    expect(normEsc.detail).not.toContain("b-secret")
    expect(normEsc.stack).toBe(`stack {token=[redacted]} tail3`)
    expect(normEsc.stack).not.toContain("en-secret")
  })

  it("Unicode-escaped JSON secret keys are scrubbed via envelope — direct raw unicode regression", () => {
    const raw: FailureRecord = {
      opId: "prompt:raw-unicode",
      opKind: "prompt",
      outcome: "failed",
      code: "provider.unknown",
      message: `prefix {"api\\u004bey":"sk-unicode-key"} tail`,
      time: 104,
      detail: `detail {"sec\\u0072et":"detail-unicode-secret"} tail2`,
      stack: `stack {"token":"stack-unicode-token"} tail3`,
    }
    const env = buildPanelEnvelope(raw)
    const msg = env.payload["message"] as string
    expect(msg).not.toContain("sk-unicode-key")
    expect(msg).not.toContain("\\u004b")
    expect(msg).not.toContain("api\\u004b")
    expect(msg).toContain("apiKey=[redacted]")
    expect(msg).toContain("prefix")
    expect(msg).toContain("tail")
    const normalized = normalizeRecord(raw)
    expect(normalized.message).toBe(msg)
    expect(normalized.detail).not.toContain("detail-unicode-secret")
    expect(normalized.detail).toContain("secret=[redacted]")
    expect(normalized.detail).toContain("tail2")
    expect(normalized.stack).not.toContain("stack-unicode-token")
    expect(normalized.stack).toContain("token=[redacted]")
    const twice = normalizeRecord(normalized)
    expect(twice).toEqual(normalized)
    expect(buildPanelEnvelope(normalized).payload["message"]).toBe(msg)
    const rawNonSecret: FailureRecord = {
      opId: "prompt:raw-unicode-nonsecret",
      opKind: "prompt",
      outcome: "failed",
      code: "provider.unknown",
      message: `prefix {"not\\u0053ecret":"keep-me"} tail`,
      time: 105,
    }
    const envNon = buildPanelEnvelope(rawNonSecret)
    expect((envNon.payload["message"] as string)).toContain("keep-me")
    expect((envNon.payload["message"] as string)).toContain("not\\u0053ecret")
    expect((envNon.payload["message"] as string)).not.toContain("[redacted]")
  })

  it("Unicode-escaped JSON secret key with escaped quoted value is scrubbed via envelope — unicode escaped value regression", () => {
    const raw: FailureRecord = {
      opId: "prompt:raw-unicode-escaped",
      opKind: "prompt",
      outcome: "failed",
      code: "provider.unknown",
      message: `prefix {"api\\u004bey":"foo\\"bar-escaped"} tail`,
      time: 106,
      detail: `detail {"api\\u004bey":"a\\"b-escaped-detail"} tail2`,
      stack: `stack {"sec\\u0072et":"tok\\"en-escaped"} tail3`,
    }
    const env = buildPanelEnvelope(raw)
    const msg = env.payload["message"] as string
    expect(msg).toBe(`prefix {apiKey=[redacted]} tail`)
    expect(msg).not.toContain("foo")
    expect(msg).not.toContain("bar-escaped")
    expect(msg).not.toContain("\\u004b")
    const normalized = normalizeRecord(raw)
    expect(normalized.message).toBe(msg)
    expect(normalized.detail).toBe(`detail {apiKey=[redacted]} tail2`)
    expect(normalized.detail).not.toContain("b-escaped-detail")
    expect(normalized.stack).toBe(`stack {secret=[redacted]} tail3`)
    expect(normalized.stack).not.toContain("en-escaped")
    const twice = normalizeRecord(normalized)
    expect(twice).toEqual(normalized)
    expect(buildPanelEnvelope(normalized).payload["message"]).toBe(msg)
  })

  it("malformed escaped JSON keys preserve backslash and do not spuriously redact via envelope — narrow P4-G7 correction", () => {
    const rawApi: FailureRecord = {
      opId: "prompt:raw-malformed-api",
      opKind: "prompt",
      outcome: "failed",
      code: "provider.unknown",
      message: `prefix {"api\\key":"keep-me"} tail`,
      time: 200,
    }
    expect(() => buildPanelEnvelope(rawApi)).not.toThrow()
    const envApi = buildPanelEnvelope(rawApi)
    expect(envApi.payload["message"]).toBe(`prefix {"api\\key":"keep-me"} tail`)
    expect((envApi.payload["message"] as string)).not.toContain("[redacted]")
    expect(normalizeRecord(rawApi).message).toBe(`prefix {"api\\key":"keep-me"} tail`)

    const rawSecret: FailureRecord = {
      opId: "prompt:raw-malformed-secret",
      opKind: "prompt",
      outcome: "failed",
      code: "provider.unknown",
      message: `prefix {"se\\cret":"keep-me"} tail`,
      time: 201,
    }
    expect(() => buildPanelEnvelope(rawSecret)).not.toThrow()
    const envSecret = buildPanelEnvelope(rawSecret)
    expect(envSecret.payload["message"]).toBe(`prefix {"se\\cret":"keep-me"} tail`)
    expect((envSecret.payload["message"] as string)).not.toContain("[redacted]")
    expect(normalizeRecord(rawSecret).message).toBe(`prefix {"se\\cret":"keep-me"} tail`)

    const rawTrailing: FailureRecord = {
      opId: "prompt:raw-trailing-bs",
      opKind: "prompt",
      outcome: "failed",
      code: "provider.unknown",
      message: `prefix {"hello":"keep-me"} tail\\`,
      time: 202,
    }
    expect(() => buildPanelEnvelope(rawTrailing)).not.toThrow()
    expect(buildPanelEnvelope(rawTrailing).payload["message"]).toBe(`prefix {"hello":"keep-me"} tail\\`)
    expect(normalizeRecord(rawTrailing).message).toBe(`prefix {"hello":"keep-me"} tail\\`)

    const rawValid: FailureRecord = {
      opId: "prompt:raw-valid-unicode",
      opKind: "prompt",
      outcome: "failed",
      code: "provider.unknown",
      message: `prefix {"api\\u004bey":"secret"} tail`,
      time: 203,
    }
    const envValid = buildPanelEnvelope(rawValid)
    expect((envValid.payload["message"] as string)).toContain("apiKey=[redacted]")
    expect((envValid.payload["message"] as string)).not.toContain("secret")
    expect((envValid.payload["message"] as string)).not.toContain("\\u004b")
    expect(normalizeRecord(rawValid).message).toContain("apiKey=[redacted]")
  })

  it("adjacent malformed escapes preserve verbatim and do not redact even when decoded looks secret — P4-G7 final blocker", () => {
    const cases: Array<{ msg: string; time: number }> = [
      { msg: `prefix {"secret\\q":"keep-secret-q"} tail`, time: 210 },
      { msg: `prefix {"x\\secret":"keep-x-secret"} tail`, time: 211 },
      { msg: `prefix {"secret\\u00":"keep-trunc-u"} tail`, time: 212 },
      { msg: `prefix {"x\\password":"keep-x-password"} tail`, time: 213 },
      { msg: `prefix {"secret\\u00zz":"keep-bad-u"} tail`, time: 214 },
      { msg: `prefix {"api\\u004":"keep-trunc-api"} tail`, time: 215 },
    ]
    for (const c of cases) {
      const raw: FailureRecord = {
        opId: `prompt:raw-adjacent-${c.time}`,
        opKind: "prompt",
        outcome: "failed",
        code: "provider.unknown",
        message: c.msg,
        time: c.time,
      }
      expect(() => buildPanelEnvelope(raw)).not.toThrow()
      const env = buildPanelEnvelope(raw)
      expect(env.payload["message"]).toBe(c.msg)
      expect((env.payload["message"] as string)).not.toContain("[redacted]")
      expect(normalizeRecord(raw).message).toBe(c.msg)
      expect(() => redact(c.msg)).not.toThrow()
      expect(redact(c.msg) as string).toBe(c.msg)
    }
    const valid: FailureRecord = {
      opId: "prompt:valid-adjacent-unicode",
      opKind: "prompt",
      outcome: "failed",
      code: "provider.unknown",
      message: `prefix {"api\\u004bey":"should-redact"} tail`,
      time: 216,
    }
    const envValid = buildPanelEnvelope(valid)
    expect((envValid.payload["message"] as string)).toContain("apiKey=[redacted]")
    expect((envValid.payload["message"] as string)).not.toContain("should-redact")
    expect((envValid.payload["message"] as string)).not.toContain("\\u004b")
    expect(normalizeRecord(valid).message).toContain("apiKey=[redacted]")
  })
})

describe("R12 isTerminal", () => {
  it("true for succeeded/failed/ambiguous/superseded/abandoned", () => {
    expect(isTerminal("succeeded")).toBe(true)
    expect(isTerminal("failed")).toBe(true)
    expect(isTerminal("ambiguous")).toBe(true)
    expect(isTerminal("superseded")).toBe(true)
    expect(isTerminal("abandoned")).toBe(true)
  })
  it("false for in-flight", () => {
    expect(isTerminal("in-flight")).toBe(false)
  })
})
