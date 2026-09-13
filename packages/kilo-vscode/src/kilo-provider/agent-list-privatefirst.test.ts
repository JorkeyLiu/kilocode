import { describe, expect, test } from "bun:test"
import {
  attemptAgentListPrivate,
  buildAgentListReq,
  fetchAgentsPrivateFirst,
  parseAgentListResult,
} from "./agent-list-privatefirst"
import { validateAgentListContractRequest } from "../services/cli-backend/serve-private-agent-list-contract"

function entry(name = "code", overrides: Record<string, unknown> = {}) {
  return {
    name,
    mode: "primary",
    permission: [{ permission: "edit", pattern: "*", action: "allow" }],
    options: {},
    ...overrides,
  }
}

function fullEntries(): unknown[] {
  return [
    entry("code", { description: "default", color: "#FF5733", model: { modelID: "m1", providerID: "p1" } }),
    entry("plan", { mode: "primary", hidden: true }),
    entry("sub", { mode: "subagent", prompt: "sys", requirements: { skills: ["s1"] }, steps: 5 }),
  ]
}

function req() {
  return buildAgentListReq("/tmp/agentlist")
}

function okFor(r: ReturnType<typeof req>, agents: unknown[] = fullEntries()) {
  return {
    v: 1,
    requestId: r.requestId,
    op: "agent/list",
    status: "succeeded",
    outcome: { type: "succeeded", time: 1 },
    accepted: true,
    data: { agents },
  }
}

function failedFor(r: ReturnType<typeof req>, code: string, message: string, retryable: boolean) {
  const failure = { code, message, retryable }
  return {
    v: 1,
    requestId: r.requestId,
    op: "agent/list",
    status: "failed",
    outcome: { type: "failed", time: 1, failure },
    accepted: false,
    failure,
  }
}

function ambiguousFor(r: ReturnType<typeof req>) {
  return {
    v: 1,
    requestId: r.requestId,
    op: "agent/list",
    status: "ambiguous",
    outcome: { type: "ambiguous", time: 1 },
    accepted: false,
    transportUnknown: true,
  }
}

function connFor(result: (q: ReturnType<typeof req>) => unknown, id = 1) {
  return {
    isPrivateAvailable: () => true,
    privateAgentListOutcomeWithHandle: (q: ReturnType<typeof req>) => ({
      id,
      promise: Promise.resolve({ kind: "valid", result: result(q) }),
      cancel: () => true,
    }),
  }
}

describe("agent-list private-first", () => {
  test("request is requestId-only with strict context/payload", () => {
    const r = req()
    expect(r.v).toBe(1)
    expect(r.op).toBe("agent/list")
    expect(typeof r.requestId).toBe("string")
    expect((r as Record<string, unknown>).opId).toBeUndefined()
    expect((r as Record<string, unknown>).idempotencyKey).toBeUndefined()
    expect(() => validateAgentListContractRequest(r)).not.toThrow()
    expect(() => validateAgentListContractRequest({ ...r, opId: "x" })).toThrow()
    expect(() => validateAgentListContractRequest({ ...r, payload: { f: 1 } })).toThrow()
  })

  test("succeeded accepted parses ok preserving carrier order including empty", () => {
    const r = req()
    const ordered = [entry("b"), entry("a", { description: "first" })]
    const parsed = parseAgentListResult(okFor(r, ordered), r)
    expect(parsed.kind).toBe("ok")
    if (parsed.kind === "ok") expect(parsed.agents).toEqual(ordered)
    const empty = parseAgentListResult(okFor(r, []), r)
    expect(empty.kind).toBe("ok")
    if (empty.kind === "ok") expect(empty.agents).toEqual([])
  })

  test("validated terminal closes with zero SDK", async () => {
    for (const [code, message] of [
      ["validation.failed", "invalid agent-list request"],
      ["scope_mismatch", "directory mismatch"],
      ["internal", "internal error"],
    ] as const) {
      let sdk = 0
      const out = await fetchAgentsPrivateFirst({
        connection: connFor((q) => failedFor(q, code, message, false)) as never,
        client: { app: { agents: async () => { sdk += 1; return { data: [] } } } } as never,
        directory: "/tmp/agentlist-terminal",
      })
      expect(out.kind).toBe("terminal")
      expect(sdk).toBe(0)
    }
  })

  test("retryable fence is fallback-eligible", async () => {
    const r = req()
    const out = await attemptAgentListPrivate(
      connFor((q) => failedFor(q, "InstanceUnavailableDuringConfigRebuild", "Instance is unavailable during config rebuild; no active runtime for this request", true)) as never,
      r,
    )
    expect(out.kind).toBe("fallback")
  })

  test("unavailable/invalid/ambiguous/transport/closed/timeout are fallback-eligible", async () => {
    const r1 = req()
    expect((await attemptAgentListPrivate({ isPrivateAvailable: () => false } as never, r1)).kind).toBe("fallback")

    const r2 = req()
    expect((await attemptAgentListPrivate(connFor((q) => ambiguousFor(q)) as never, r2)).kind).toBe("fallback")

    const r3 = req()
    const invalid = {
      isPrivateAvailable: () => true,
      privateAgentListOutcomeWithHandle: () => ({
        id: 3,
        promise: Promise.resolve({ kind: "invalid", detail: "bad" }),
        cancel: () => true,
      }),
    }
    expect((await attemptAgentListPrivate(invalid as never, r3)).kind).toBe("fallback")

    const r4 = req()
    const transport = {
      isPrivateAvailable: () => true,
      privateAgentListOutcomeWithHandle: () => ({
        id: 4,
        promise: Promise.reject(new Error("Private peer unavailable")),
        cancel: () => true,
      }),
    }
    expect((await attemptAgentListPrivate(transport as never, r4)).kind).toBe("fallback")

    const r5 = req()
    const hanging = {
      isPrivateAvailable: () => true,
      privateAgentListOutcomeWithHandle: () => ({
        id: 5,
        promise: new Promise(() => {}),
        cancel: () => true,
      }),
    }
    expect((await attemptAgentListPrivate(hanging as never, r5, 10)).kind).toBe("fallback")
  })

  test("timeout exact-cancels the pending by id", async () => {
    const r = req()
    const cancelled: unknown[] = []
    const hanging = {
      isPrivateAvailable: () => true,
      privateAgentListOutcomeWithHandle: () => ({
        id: 42,
        promise: new Promise(() => {}),
        cancel: (msg?: string) => {
          cancelled.push(msg)
          return true
        },
      }),
    }
    const out = await attemptAgentListPrivate(hanging as never, r, 10)
    expect(out).toEqual({ kind: "fallback", reason: "timeout" })
    expect(cancelled.length).toBe(1)
    expect(String(cancelled[0]).includes(r.requestId)).toBeTrue()
  })

  test("private success incl empty returns zero SDK with full wire and no credentials", async () => {
    for (const ordered of [fullEntries(), []]) {
      let sdk = 0
      const client = { app: { agents: async () => { sdk += 1; return { data: [] } } } } as never
      const conn = connFor((q) => okFor(q, ordered))
      const out = await fetchAgentsPrivateFirst({ connection: conn as never, client, directory: "/tmp/agentlist-ok" })
      expect(out.kind).toBe("ok")
      if (out.kind === "ok") {
        expect(out.via).toBe("private")
        expect(out.agents).toEqual(ordered)
      }
      expect(sdk).toBe(0)
      expect(JSON.stringify(out).includes("apiKey")).toBeFalse()
      expect(JSON.stringify(out).includes("credential")).toBeFalse()
    }
  })

  test("fallback outcomes take exactly one SDK with full-wire coercion", async () => {
    const cases: Array<{ label: string; conn: unknown; dir: string }> = [
      { label: "retryable", conn: connFor((q) => failedFor(q, "InstanceUnavailableDuringConfigRebuild", "Instance is unavailable during config rebuild; no active runtime for this request", true)), dir: "/tmp/agentlist-fb-retry" },
      { label: "unavailable", conn: { isPrivateAvailable: () => false }, dir: "/tmp/agentlist-fb-unavail" },
      { label: "ambiguous", conn: connFor((q) => ambiguousFor(q)), dir: "/tmp/agentlist-fb-amb" },
    ]
    for (const c of cases) {
      let sdk = 0
      const client = {
        app: {
          agents: async (args: { directory: string }) => {
            sdk += 1
            expect(args.directory).toBe(c.dir)
            return { data: fullEntries() }
          },
        },
      } as never
      const out = await fetchAgentsPrivateFirst({ connection: c.conn as never, client, directory: c.dir })
      expect(out.kind).toBe("ok")
      if (out.kind === "ok") {
        expect(out.via).toBe("sdk")
        expect(out.agents).toEqual(fullEntries())
      }
      expect(sdk).toBe(1)
    }
  })

  test("helper never retries SDK internally", async () => {
    let sdk = 0
    const client = {
      app: {
        agents: async () => {
          sdk += 1
          throw new Error("load failed: transient boom")
        },
      },
    } as never
    const conn = { isPrivateAvailable: () => false } as never
    const out = await fetchAgentsPrivateFirst({ connection: conn, client, directory: "/tmp/agentlist-noretry" })
    expect(out.kind).toBe("unavailable")
    expect(sdk).toBe(1)
  })

  test("invalid SDK wire returns unavailable with zero throw", async () => {
    const client = { app: { agents: async () => ({ data: [{ name: "", mode: "x" }] }) } } as never
    const conn = { isPrivateAvailable: () => false } as never
    const out = await fetchAgentsPrivateFirst({ connection: conn, client, directory: "/tmp/agentlist-badwire" })
    expect(out.kind).toBe("unavailable")
  })
})
