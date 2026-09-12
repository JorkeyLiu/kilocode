import { describe, expect, test } from "bun:test"
import {
  attemptMcpConnectPrivate,
  attemptMcpDisconnectPrivate,
  buildMcpConnectReq,
  buildMcpDisconnectReq,
  mcpConnectionFailureMessage,
} from "./mcp-connection-privatefirst"
import { canonicalMcpConnectOpId, canonicalMcpDisconnectOpId } from "../services/cli-backend/serve-private-mcp-connection-contract"

const DIR = "/repo"

function okConnectFor(r: ReturnType<typeof buildMcpConnectReq>) {
  return {
    v: 1,
    requestId: r.requestId,
    opId: r.opId,
    op: "mcp/connect",
    idempotencyKey: r.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: 1 },
    accepted: true,
    data: { connected: true },
  }
}

function okDisconnectFor(r: ReturnType<typeof buildMcpDisconnectReq>) {
  return {
    v: 1,
    requestId: r.requestId,
    opId: r.opId,
    op: "mcp/disconnect",
    idempotencyKey: r.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: 1 },
    accepted: true,
    data: { disconnected: true },
  }
}

function failedFor(r: { requestId: string; opId: string; idempotencyKey: string }, op: string, code = "mcp.not_found", retryable = false) {
  const failure = { code, message: "m", retryable }
  return {
    v: 1,
    requestId: r.requestId,
    opId: r.opId,
    op,
    idempotencyKey: r.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time: 1, failure: { ...failure } },
    accepted: false,
    failure: { ...failure },
  }
}

function ambiguousFor(r: { requestId: string; opId: string; idempotencyKey: string }, op: string) {
  return {
    v: 1,
    requestId: r.requestId,
    opId: r.opId,
    op,
    idempotencyKey: r.idempotencyKey,
    status: "ambiguous",
    outcome: { type: "ambiguous", time: 1 },
    accepted: false,
    transportUnknown: true,
  }
}

describe("mcp connect/disconnect private-only (once, no SDK)", () => {
  test("identity binds fresh per-op tuples with directory and name", () => {
    const c = buildMcpConnectReq(DIR, "demo")
    expect(c.opId).toBe(c.idempotencyKey)
    expect(c.opId.startsWith("mcp-connect:")).toBeTrue()
    expect(canonicalMcpConnectOpId(c.opId.split(":")[1]!)).toBe(c.opId)
    expect(c.context.directory).toBe(DIR)
    expect(c.payload.name).toBe("demo")
    const d = buildMcpDisconnectReq(DIR, "demo")
    expect(d.opId.startsWith("mcp-disconnect:")).toBeTrue()
    expect(canonicalMcpDisconnectOpId(d.opId.split(":")[1]!)).toBe(d.opId)
    expect(d.opId).not.toBe(c.opId)
  })

  test("succeeded accepted resolves ok with exactly one private call and zero SDK", async () => {
    {
      const r = buildMcpConnectReq(DIR, "demo")
      let connectCalls = 0
      let disconnectCalls = 0
      const seen: typeof r[] = []
      const connection = {
        isPrivateAvailable: () => true,
        privateMcpConnectOutcomeWithHandle: (q: typeof r) => {
          connectCalls += 1
          if (connectCalls > 1) throw new Error("private connect must be called exactly once")
          seen.push(q)
          return {
            id: 1,
            promise: Promise.resolve({ kind: "valid", result: okConnectFor(q) }),
            cancel: () => true,
          }
        },
        privateMcpDisconnectOutcomeWithHandle: (_q: ReturnType<typeof buildMcpDisconnectReq>) => {
          disconnectCalls += 1
          throw new Error("connect path must not touch disconnect")
        },
      }
      // No client/SDK object is passed or reachable on this path.
      const out = await attemptMcpConnectPrivate(connection as never, r)
      expect(out).toEqual({ kind: "ok" })
      expect(connectCalls).toBe(1)
      expect(disconnectCalls).toBe(0)
      expect(seen).toHaveLength(1)
      expect(seen[0]!.requestId).toBe(r.requestId)
      expect(seen[0]!.opId).toBe(r.opId)
      expect(seen[0]!.idempotencyKey).toBe(r.idempotencyKey)
      expect(seen[0]!.op).toBe("mcp/connect")
      expect(seen[0]!.opId).toBe(seen[0]!.idempotencyKey)
      expect(() => (connection.privateMcpConnectOutcomeWithHandle as (q: typeof r) => unknown)(r)).toThrow()
    }
    {
      const r = buildMcpDisconnectReq(DIR, "demo")
      let connectCalls = 0
      let disconnectCalls = 0
      const seen: typeof r[] = []
      const connection = {
        isPrivateAvailable: () => true,
        privateMcpConnectOutcomeWithHandle: (_q: ReturnType<typeof buildMcpConnectReq>) => {
          connectCalls += 1
          throw new Error("disconnect path must not touch connect")
        },
        privateMcpDisconnectOutcomeWithHandle: (q: typeof r) => {
          disconnectCalls += 1
          if (disconnectCalls > 1) throw new Error("private disconnect must be called exactly once")
          seen.push(q)
          return {
            id: 1,
            promise: Promise.resolve({ kind: "valid", result: okDisconnectFor(q) }),
            cancel: () => true,
          }
        },
      }
      // No client/SDK object is passed or reachable on this path.
      const out = await attemptMcpDisconnectPrivate(connection as never, r)
      expect(out).toEqual({ kind: "ok" })
      expect(disconnectCalls).toBe(1)
      expect(connectCalls).toBe(0)
      expect(seen).toHaveLength(1)
      expect(seen[0]!.requestId).toBe(r.requestId)
      expect(seen[0]!.opId).toBe(r.opId)
      expect(seen[0]!.idempotencyKey).toBe(r.idempotencyKey)
      expect(seen[0]!.op).toBe("mcp/disconnect")
      expect(seen[0]!.opId).toBe(seen[0]!.idempotencyKey)
      expect(() => (connection.privateMcpDisconnectOutcomeWithHandle as (q: typeof r) => unknown)(r)).toThrow()
    }
  })

  test("terminal failures preserve codes with zero SDK", async () => {
    for (const code of ["mcp.not_found", "validation.failed", "scope_mismatch", "internal"]) {
      const r = buildMcpConnectReq(DIR, "demo")
      const connection = {
        isPrivateAvailable: () => true,
        privateMcpConnectOutcomeWithHandle: (q: typeof r) => ({
          id: 1,
          promise: Promise.resolve({ kind: "valid", result: failedFor(q, "mcp/connect", code) }),
          cancel: () => true,
        }),
      }
      expect(await attemptMcpConnectPrivate(connection as never, r)).toEqual({ kind: "failed", code })
      const d = buildMcpDisconnectReq(DIR, "demo")
      const dconn = {
        isPrivateAvailable: () => true,
        privateMcpDisconnectOutcomeWithHandle: (q: typeof d) => ({
          id: 1,
          promise: Promise.resolve({ kind: "valid", result: failedFor(q, "mcp/disconnect", code) }),
          cancel: () => true,
        }),
      }
      expect(await attemptMcpDisconnectPrivate(dconn as never, d)).toEqual({ kind: "failed", code })
    }
  })

  test("retryable fence failure closes without a mutation signal and without retry", async () => {
    const r = buildMcpConnectReq(DIR, "demo")
    let calls = 0
    const connection = {
      isPrivateAvailable: () => true,
      privateMcpConnectOutcomeWithHandle: (q: typeof r) => {
        calls += 1
        return {
          id: 2,
          promise: Promise.resolve({
            kind: "valid",
            result: failedFor(q, "mcp/connect", "InstanceUnavailableDuringConfigRebuild", true),
          }),
          cancel: () => true,
        }
      },
    }
    expect(await attemptMcpConnectPrivate(connection as never, r)).toEqual({
      kind: "closed",
      reason: "InstanceUnavailableDuringConfigRebuild",
    })
    expect(calls).toBe(1)
  })

  test("unavailable/ambiguous/invalid/transport close with no second call", async () => {
    const r1 = buildMcpConnectReq(DIR, "demo")
    const unavailable = {
      isPrivateAvailable: () => false,
      privateMcpConnectOutcomeWithHandle: () => {
        throw new Error("must not be called")
      },
    }
    expect(await attemptMcpConnectPrivate(unavailable as never, r1)).toEqual({ kind: "closed", reason: "unavailable" })

    const r2 = buildMcpDisconnectReq(DIR, "demo")
    const ambiguous = {
      isPrivateAvailable: () => true,
      privateMcpDisconnectOutcomeWithHandle: (q: typeof r2) => ({
        id: 2,
        promise: Promise.resolve({ kind: "valid", result: ambiguousFor(q, "mcp/disconnect") }),
        cancel: () => true,
      }),
    }
    expect(await attemptMcpDisconnectPrivate(ambiguous as never, r2)).toEqual({ kind: "closed", reason: "ambiguous" })

    const r3 = buildMcpConnectReq(DIR, "demo")
    const invalid = {
      isPrivateAvailable: () => true,
      privateMcpConnectOutcomeWithHandle: () => ({
        id: 3,
        promise: Promise.resolve({ kind: "invalid", detail: "bad" }),
        cancel: () => true,
      }),
    }
    expect(await attemptMcpConnectPrivate(invalid as never, r3)).toEqual({ kind: "closed", reason: "invalid" })

    const r4 = buildMcpConnectReq(DIR, "demo")
    const transport = {
      isPrivateAvailable: () => true,
      privateMcpConnectOutcomeWithHandle: () => ({
        id: 4,
        promise: Promise.reject(new Error("Private peer unavailable")),
        cancel: () => true,
      }),
    }
    expect(await attemptMcpConnectPrivate(transport as never, r4)).toEqual({ kind: "closed", reason: "transport" })
  })

  test("timeout exact-cancels the pending with the opId and never retries", async () => {
    const r = buildMcpDisconnectReq(DIR, "demo")
    let cancelled: string | undefined
    let calls = 0
    const connection = {
      isPrivateAvailable: () => true,
      getPrivatePeer: () => null,
      getPrivateEpoch: () => 1,
      privateMcpDisconnectOutcomeWithHandle: () => {
        calls += 1
        return {
          id: 7,
          promise: new Promise(() => {}),
          cancel: (msg?: string) => {
            cancelled = msg
            return true
          },
        }
      },
    }
    expect(await attemptMcpDisconnectPrivate(connection as never, r, 10)).toEqual({ kind: "closed", reason: "timeout" })
    expect(calls).toBe(1)
    expect(cancelled).toContain(r.opId)
  })

  test("missing capability closes as transport with a single attempt", async () => {
    const r = buildMcpConnectReq(DIR, "demo")
    const connection = {
      isPrivateAvailable: () => true,
      getPrivatePeer: () => null,
      getPrivateEpoch: () => 1,
      privateMcpConnectOutcomeWithHandle: () => {
        throw new Error("Private peer missing mcp/connect capability")
      },
    }
    expect(await attemptMcpConnectPrivate(connection as never, r)).toEqual({ kind: "closed", reason: "transport" })
  })

  test("invalid request closes without touching the peer", async () => {
    const r = { ...buildMcpConnectReq(DIR, "demo"), payload: { name: "" } }
    const connection = {
      isPrivateAvailable: () => true,
      privateMcpConnectOutcomeWithHandle: () => {
        throw new Error("must not be called")
      },
    }
    expect(await attemptMcpConnectPrivate(connection as never, r as never)).toEqual({ kind: "closed", reason: "invalid" })
  })

  test("owner drift maps invalid wire to ambiguous without a second call", async () => {
    const { mcpConnectOutcomeForOwner } =
      await import("../services/cli-backend/serve-private-mcp-connection-owner")
    const r = buildMcpConnectReq(DIR, "demo")
    let calls = 0
    const innerPeer = {
      isAvailable: () => true,
      hasCapability: () => true,
      privateMcpConnectOutcomeWithHandle: () => {
        calls += 1
        return { id: 3, promise: Promise.resolve({ kind: "invalid", detail: "bad" }), cancel: () => true }
      },
    }
    let current: unknown = innerPeer
    const svc = {
      isPrivateAvailable: () => true,
      getPrivatePeer: () => current as never,
      getPrivateEpoch: () => 1,
      invalidatePrivatePeerOnObserverTimeout: () => {},
    }
    const handle = mcpConnectOutcomeForOwner(svc as never, r)
    current = null
    const out = await handle.promise
    expect(calls).toBe(1)
    expect(out.kind).toBe("valid")
    if (out.kind === "valid") expect(out.result.status).toBe("ambiguous")
  })

  test("unknown Error with URL/token/path closes as fixed internal without leaking", async () => {
    const secret = "https://mcp.example.com/sensitive?token=tok-abc-123"
    const secretPath = "/tmp/secret-mcp-path-xyz"
    for (const raw of [
      new Error(`connect ${secret} failed at ${secretPath} env=SECRET_ENV command="mcp-secret-cmd"`),
      `boom ${secret} ${secretPath}`,
    ]) {
      const r = buildMcpConnectReq(DIR, "demo")
      let calls = 0
      const connection = {
        isPrivateAvailable: () => true,
        privateMcpConnectOutcomeWithHandle: () => {
          calls += 1
          if (calls > 1) throw new Error("must be called exactly once")
          return { id: 1, promise: Promise.reject(raw), cancel: () => true }
        },
      }
      const out = await attemptMcpConnectPrivate(connection as never, r)
      expect(out).toEqual({ kind: "closed", reason: "internal" })
      expect(calls).toBe(1)
      expect(JSON.stringify(out)).not.toContain("tok-abc-123")
      expect(JSON.stringify(out)).not.toContain("mcp.example.com")
      expect(JSON.stringify(out)).not.toContain(secretPath)
      expect(mcpConnectionFailureMessage((out as { reason: string }).reason)).toBe("internal error")
    }
  })

  test("unknown failure code and unknown closed reason normalize to fixed generic without echo", async () => {
    const secretCode = "mcp.evil-leak?token=tok-xyz-999&url=https://mcp.example.com/secret"
    const r = buildMcpConnectReq(DIR, "demo")
    const unknownFailed = {
      isPrivateAvailable: () => true,
      privateMcpConnectOutcomeWithHandle: (q: typeof r) => ({
        id: 1,
        promise: Promise.resolve({ kind: "valid", result: failedFor(q, "mcp/connect", secretCode) }),
        cancel: () => true,
      }),
    }
    const out = await attemptMcpConnectPrivate(unknownFailed as never, r)
    expect(out).toEqual({ kind: "failed", code: "internal" })
    expect(JSON.stringify(out)).not.toContain("tok-xyz-999")
    expect(JSON.stringify(out)).not.toContain("mcp.example.com")

    const retryableUnknown = {
      isPrivateAvailable: () => true,
      privateMcpConnectOutcomeWithHandle: (q: typeof r) => ({
        id: 1,
        promise: Promise.resolve({ kind: "valid", result: failedFor(q, "mcp/connect", secretCode, true) }),
        cancel: () => true,
      }),
    }
    const closed = await attemptMcpConnectPrivate(retryableUnknown as never, r)
    expect(closed).toEqual({ kind: "closed", reason: "internal" })
    expect(JSON.stringify(closed)).not.toContain("tok-xyz-999")

    expect(mcpConnectionFailureMessage(secretCode)).toBe("internal error")
    expect(mcpConnectionFailureMessage(secretCode)).not.toContain("tok-xyz-999")
    expect(mcpConnectionFailureMessage("definitely-unknown")).toBe("internal error")
  })

  test("known fixed reasons keep user-understandable mapping", () => {
    expect(mcpConnectionFailureMessage("mcp.not_found")).toBe("MCP server not found")
    expect(mcpConnectionFailureMessage("validation.failed")).toBe("invalid MCP connection request")
    expect(mcpConnectionFailureMessage("scope_mismatch")).toBe("directory mismatch")
    expect(mcpConnectionFailureMessage("InstanceUnavailableDuringConfigRebuild")).toBe("backend is rebuilding; retry shortly")
    expect(mcpConnectionFailureMessage("internal")).toBe("internal error")
    expect(mcpConnectionFailureMessage("unavailable")).toBe("backend unavailable")
    expect(mcpConnectionFailureMessage("ambiguous")).toBe("result ambiguous")
    expect(mcpConnectionFailureMessage("invalid")).toBe("invalid response")
    expect(mcpConnectionFailureMessage("transport")).toBe("transport error")
    expect(mcpConnectionFailureMessage("timeout")).toBe("operation timed out")
  })
})
