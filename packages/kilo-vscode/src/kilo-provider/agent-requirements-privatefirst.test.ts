import { describe, expect, test } from "bun:test"
import {
  attemptAgentRequirementsPrivate,
  buildAgentRequirementsIdentity,
  parseAgentRequirementsResult,
} from "./agent-requirements-privatefirst"
import { canonicalAgentRequirementsOpId } from "../services/cli-backend/serve-private-agent-requirements-contract"

const AGENT = "code"
const DIR = "/tmp"

function payload() {
  return {
    agent: AGENT,
    directory: DIR,
    enabled: true,
    state: "ready",
    skills: [{ name: "skill-a", status: "ready" }],
    mcps: [{ name: "mcp-a", status: "ready" }],
    vscode_extensions: [{ name: "Ext A", id: "publisher.ext-a" }],
  }
}

function req() {
  const { opId, idempotencyKey, requestId } = buildAgentRequirementsIdentity(AGENT)
  return {
    v: 1 as const,
    requestId,
    opId,
    op: "agent/requirements" as const,
    idempotencyKey,
    context: { directory: DIR, agent: AGENT },
    payload: {},
  }
}

function okFor(r: ReturnType<typeof req>) {
  return {
    v: 1,
    requestId: r.requestId,
    opId: r.opId,
    op: "agent/requirements",
    idempotencyKey: r.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: 1 },
    accepted: true,
    data: { requirements: payload() },
  }
}

function terminalFor(r: ReturnType<typeof req>, code = "validation.failed") {
  return {
    v: 1,
    requestId: r.requestId,
    opId: r.opId,
    op: "agent/requirements",
    idempotencyKey: r.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time: 1, failure: { code, message: "m", retryable: false } },
    accepted: false,
    failure: { code, message: "m", retryable: false },
  }
}

function retryableFor(r: ReturnType<typeof req>) {
  return {
    v: 1,
    requestId: r.requestId,
    opId: r.opId,
    op: "agent/requirements",
    idempotencyKey: r.idempotencyKey,
    status: "failed",
    outcome: {
      type: "failed",
      time: 1,
      failure: { code: "InstanceUnavailableDuringConfigRebuild", message: "busy", retryable: true },
    },
    accepted: false,
    failure: { code: "InstanceUnavailableDuringConfigRebuild", message: "busy", retryable: true },
  }
}

function ambiguousFor(r: ReturnType<typeof req>) {
  return {
    v: 1,
    requestId: r.requestId,
    opId: r.opId,
    op: "agent/requirements",
    idempotencyKey: r.idempotencyKey,
    status: "ambiguous",
    outcome: { type: "ambiguous", time: 1 },
    accepted: false,
    transportUnknown: true,
  }
}

describe("agent requirements private-first", () => {
  test("identity binds canonical agent-requirements tuple", () => {
    const { opId, idempotencyKey, requestId } = buildAgentRequirementsIdentity(AGENT)
    expect(opId).toBe(idempotencyKey)
    expect(opId.startsWith(`agent-requirements:${AGENT}:`)).toBeTrue()
    const token = opId.split(":")[2]!
    expect(canonicalAgentRequirementsOpId(AGENT, token)).toBe(opId)
    expect(typeof requestId).toBe("string")
  })

  test("succeeded accepted returns ok with identical shape", () => {
    const r = req()
    const parsed = parseAgentRequirementsResult(okFor(r), r)
    expect(parsed.kind).toBe("ok")
    if (parsed.kind === "ok") expect(parsed.requirements).toEqual(payload())
  })

  test("state:error succeeded stays ok (authoritative domain payload)", () => {
    const r = req()
    const err = { ...okFor(r), data: { requirements: { ...payload(), state: "error" } } }
    const parsed = parseAgentRequirementsResult(err, r)
    expect(parsed.kind).toBe("ok")
  })

  test("terminal failed closes without SDK", async () => {
    for (const code of ["validation.failed", "scope_mismatch", "internal"]) {
      const r = req()
      const connection = {
        isPrivateAvailable: () => true,
        privateAgentRequirementsOutcomeWithHandle: (q: typeof r) => ({
          id: 1,
          promise: Promise.resolve({ kind: "valid", result: terminalFor(q, code) }),
          cancel: () => true,
        }),
      }
      const out = await attemptAgentRequirementsPrivate(connection as never, r)
      expect(out).toEqual({ kind: "terminal" })
    }
  })

  test("unavailable/ambiguous/invalid/transport/timeout are fallback-eligible", async () => {
    const cases: Array<{ conn: unknown; r: ReturnType<typeof req> }> = []
    const r1 = req()
    cases.push({
      r: r1,
      conn: {
        isPrivateAvailable: () => false,
        privateAgentRequirementsOutcomeWithHandle: () => {
          throw new Error("must not be called")
        },
      },
    })
    const r2 = req()
    cases.push({
      r: r2,
      conn: {
        isPrivateAvailable: () => true,
        privateAgentRequirementsOutcomeWithHandle: (q: typeof r2) => ({
          id: 2,
          promise: Promise.resolve({ kind: "valid", result: ambiguousFor(q) }),
          cancel: () => true,
        }),
      },
    })
    const r3 = req()
    cases.push({
      r: r3,
      conn: {
        isPrivateAvailable: () => true,
        privateAgentRequirementsOutcomeWithHandle: () => ({
          id: 3,
          promise: Promise.resolve({ kind: "invalid", detail: "bad" }),
          cancel: () => true,
        }),
      },
    })
    const r4 = req()
    cases.push({
      r: r4,
      conn: {
        isPrivateAvailable: () => true,
        privateAgentRequirementsOutcomeWithHandle: () => ({
          id: 4,
          promise: Promise.reject(new Error("Private peer unavailable")),
          cancel: () => true,
        }),
      },
    })
    const r5 = req()
    cases.push({
      r: r5,
      conn: {
        isPrivateAvailable: () => true,
        privateAgentRequirementsOutcomeWithHandle: () => ({
          id: 5,
          promise: new Promise(() => {}),
          cancel: () => true,
        }),
      },
    })
    for (const [i, c] of cases.entries()) {
      const out = await attemptAgentRequirementsPrivate(c.conn as never, c.r, i === 4 ? 10 : 50)
      expect(out.kind).toBe("fallback")
    }
  })

  test("retryable failed falls back", async () => {
    const r = req()
    const connection = {
      isPrivateAvailable: () => true,
      privateAgentRequirementsOutcomeWithHandle: (q: typeof r) => ({
        id: 6,
        promise: Promise.resolve({ kind: "valid", result: retryableFor(q) }),
        cancel: () => true,
      }),
    }
    const out = await attemptAgentRequirementsPrivate(connection as never, r)
    expect(out.kind).toBe("fallback")
  })

  test("timeout exact-cancels the pending", async () => {
    const r = req()
    let cancelled: string | undefined
    const connection = {
      isPrivateAvailable: () => true,
      getPrivatePeer: () => null,
      getPrivateEpoch: () => 1,
      privateAgentRequirementsOutcomeWithHandle: () => ({
        id: 7,
        promise: new Promise(() => {}),
        cancel: (msg?: string) => {
          cancelled = msg
          return true
        },
      }),
    }
    const out = await attemptAgentRequirementsPrivate(connection as never, r, 10)
    expect(out).toEqual({ kind: "fallback", reason: "timeout" })
    expect(cancelled).toContain(r.opId)
  })
})
