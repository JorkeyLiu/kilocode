import { describe, expect, test } from "bun:test"
import {
  attemptMcpStatusPrivate,
  buildMcpStatusIdentity,
  buildMcpStatusReq,
  fetchMcpStatusPrivateFirst,
  parseMcpStatusResult,
} from "./mcp-status-privatefirst"
import { canonicalMcpStatusOpId } from "../services/cli-backend/serve-private-mcp-status-contract"

const DIR = "/tmp"

function okFor(r: ReturnType<typeof buildMcpStatusReq>) {
  return {
    v: 1,
    requestId: r.requestId,
    opId: r.opId,
    op: "mcp/status",
    idempotencyKey: r.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: 1 },
    accepted: true,
    data: { status: { docs: { status: "connected" } } },
  }
}

function terminalFor(r: ReturnType<typeof buildMcpStatusReq>, code = "validation.failed") {
  return {
    v: 1,
    requestId: r.requestId,
    opId: r.opId,
    op: "mcp/status",
    idempotencyKey: r.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time: 1, failure: { code, message: "m", retryable: false } },
    accepted: false,
    failure: { code, message: "m", retryable: false },
  }
}

function retryableFor(r: ReturnType<typeof buildMcpStatusReq>) {
  return {
    v: 1,
    requestId: r.requestId,
    opId: r.opId,
    op: "mcp/status",
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

function ambiguousFor(r: ReturnType<typeof buildMcpStatusReq>) {
  return {
    v: 1,
    requestId: r.requestId,
    opId: r.opId,
    op: "mcp/status",
    idempotencyKey: r.idempotencyKey,
    status: "ambiguous",
    outcome: { type: "ambiguous", time: 1 },
    accepted: false,
    transportUnknown: true,
  }
}

function connWith(build: (r: ReturnType<typeof buildMcpStatusReq>) => unknown) {
  return {
    isPrivateAvailable: () => true,
    privateMcpStatusOutcomeWithHandle: (q: ReturnType<typeof buildMcpStatusReq>) => ({
      id: 1,
      promise: Promise.resolve({ kind: "valid", result: build(q) }),
      cancel: () => true,
    }),
  }
}

describe("mcp-status private-first", () => {
  test("identity binds canonical mcp-status tuple", () => {
    const { opId, idempotencyKey, requestId } = buildMcpStatusIdentity()
    expect(opId).toBe(idempotencyKey)
    expect(opId.startsWith("mcp-status:")).toBeTrue()
    const token = opId.split(":")[1]!
    expect(canonicalMcpStatusOpId(token)).toBe(opId)
    expect(typeof requestId).toBe("string")
  })

  test("succeeded accepted returns ok with the five-state map", () => {
    const r = buildMcpStatusReq(DIR)
    const parsed = parseMcpStatusResult(okFor(r), r)
    expect(parsed.kind).toBe("ok")
    if (parsed.kind === "ok") expect(parsed.status).toEqual({ docs: { status: "connected" } })
  })

  test("all five states stay ok as authoritative payload", () => {
    const r = buildMcpStatusReq(DIR)
    const map = {
      a: { status: "connected" },
      b: { status: "disabled" },
      c: { status: "failed", error: "boom" },
      d: { status: "needs_auth" },
      e: { status: "needs_client_registration", error: "reg" },
    }
    const parsed = parseMcpStatusResult({ ...okFor(r), data: { status: map } }, r)
    expect(parsed.kind).toBe("ok")
    if (parsed.kind === "ok") expect(parsed.status).toEqual(map)
  })

  test("terminal failed closes without SDK", async () => {
    for (const code of ["validation.failed", "scope_mismatch", "internal"]) {
      const r = buildMcpStatusReq(DIR)
      const out = await attemptMcpStatusPrivate(connWith((q) => terminalFor(q, code)) as never, r)
      expect(out).toEqual({ kind: "terminal" })
    }
  })

  test("unavailable/ambiguous/invalid/transport/timeout are fallback-eligible", async () => {
    const bad = buildMcpStatusReq(DIR)
    const off = await attemptMcpStatusPrivate({ isPrivateAvailable: () => false } as never, bad)
    expect(off.kind).toBe("fallback")

    const r2 = buildMcpStatusReq(DIR)
    const vague = await attemptMcpStatusPrivate(connWith((q) => ambiguousFor(q)) as never, r2)
    expect(vague.kind).toBe("fallback")

    const r3 = buildMcpStatusReq(DIR)
    const invalid = await attemptMcpStatusPrivate(
      {
        isPrivateAvailable: () => true,
        privateMcpStatusOutcomeWithHandle: () => ({
          id: 3,
          promise: Promise.resolve({ kind: "invalid", detail: "bad" }),
          cancel: () => true,
        }),
      } as never,
      r3,
    )
    expect(invalid.kind).toBe("fallback")

    const r4 = buildMcpStatusReq(DIR)
    const broken = await attemptMcpStatusPrivate(
      {
        isPrivateAvailable: () => true,
        privateMcpStatusOutcomeWithHandle: () => ({
          id: 4,
          promise: Promise.reject(new Error("Private peer unavailable")),
          cancel: () => true,
        }),
      } as never,
      r4,
    )
    expect(broken.kind).toBe("fallback")

    const r5 = buildMcpStatusReq(DIR)
    const slow = await attemptMcpStatusPrivate(
      {
        isPrivateAvailable: () => true,
        privateMcpStatusOutcomeWithHandle: () => ({
          id: 5,
          promise: new Promise(() => {}),
          cancel: () => true,
        }),
      } as never,
      r5,
      10,
    )
    expect(slow).toEqual({ kind: "fallback", reason: "timeout" })
  })

  test("retryable failed falls back", async () => {
    const r = buildMcpStatusReq(DIR)
    const out = await attemptMcpStatusPrivate(connWith((q) => retryableFor(q)) as never, r)
    expect(out.kind).toBe("fallback")
  })

  test("timeout exact-cancels the pending", async () => {
    const r = buildMcpStatusReq(DIR)
    let cancelled: string | undefined
    const out = await attemptMcpStatusPrivate(
      {
        isPrivateAvailable: () => true,
        getPrivatePeer: () => null,
        getPrivateEpoch: () => 1,
        privateMcpStatusOutcomeWithHandle: () => ({
          id: 7,
          promise: new Promise(() => {}),
          cancel: (msg?: string) => {
            cancelled = msg
            return true
          },
        }),
      } as never,
      r,
      10,
    )
    expect(out).toEqual({ kind: "fallback", reason: "timeout" })
    expect(cancelled).toContain(r.opId)
  })

  test("fetch returns private result with zero SDK calls", async () => {
    let sdk = 0
    const client = {
      mcp: {
        status: () => {
          sdk += 1
          return Promise.resolve({ data: {} })
        },
      },
    }
    const out = await fetchMcpStatusPrivateFirst({
      connection: connWith((q) => okFor(q)) as never,
      client: client as never,
      directory: DIR,
    })
    expect(sdk).toBe(0)
    expect(out.kind).toBe("ok")
    if (out.kind === "ok") {
      expect(out.via).toBe("private")
      expect(out.status).toEqual({ docs: { status: "connected" } })
    }
  })

  test("fetch exposes terminal with zero SDK calls", async () => {
    let sdk = 0
    const client = {
      mcp: {
        status: () => {
          sdk += 1
          return Promise.resolve({ data: {} })
        },
      },
    }
    const out = await fetchMcpStatusPrivateFirst({
      connection: connWith((q) => terminalFor(q)) as never,
      client: client as never,
      directory: DIR,
    })
    expect(sdk).toBe(0)
    expect(out).toEqual({ kind: "terminal" })
  })

  test("fetch falls back exactly once with the same directory", async () => {
    const seen: unknown[] = []
    const client = {
      mcp: {
        status: (args: unknown) => {
          seen.push(args)
          return Promise.resolve({ data: { docs: { status: "disabled" } } })
        },
      },
    }
    const out = await fetchMcpStatusPrivateFirst({
      connection: { isPrivateAvailable: () => false } as never,
      client: client as never,
      directory: DIR,
    })
    expect(seen).toEqual([{ directory: DIR }])
    expect(out.kind).toBe("ok")
    if (out.kind === "ok") {
      expect(out.via).toBe("sdk")
      expect(out.status).toEqual({ docs: { status: "disabled" } })
    }
  })

  test("fetch treats SDK failure and malformed SDK data as unavailable", async () => {
    const failing = { mcp: { status: () => Promise.reject(new Error("down")) } }
    const lost = await fetchMcpStatusPrivateFirst({
      connection: { isPrivateAvailable: () => false } as never,
      client: failing as never,
      directory: DIR,
    })
    expect(lost).toEqual({ kind: "unavailable" })

    const malformed = { mcp: { status: () => Promise.resolve({ data: { docs: { status: "nope" } } }) } }
    const bad = await fetchMcpStatusPrivateFirst({
      connection: { isPrivateAvailable: () => false } as never,
      client: malformed as never,
      directory: DIR,
    })
    expect(bad).toEqual({ kind: "unavailable" })
  })
})
