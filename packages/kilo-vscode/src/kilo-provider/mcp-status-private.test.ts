import { describe, expect, test } from "bun:test"
import {
  attemptMcpStatusPrivate,
  buildMcpStatusIdentity,
  buildMcpStatusReq,
  fetchMcpStatusPrivate,
  parseMcpStatusResult,
} from "./mcp-status-private"
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

describe("mcp-status private authority", () => {
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

  test("terminal failed remains terminal with zero SDK", async () => {
    for (const code of ["validation.failed", "scope_mismatch", "internal"]) {
      const r = buildMcpStatusReq(DIR)
      const out = await attemptMcpStatusPrivate(connWith((q) => terminalFor(q, code)) as never, r)
      expect(out).toEqual({ kind: "terminal" })
    }
  })

  test("unavailable/missing-capability/invalid/ambiguous/transport/timeout are explicit unavailable", async () => {
    const bad = buildMcpStatusReq(DIR)
    const off = await attemptMcpStatusPrivate({ isPrivateAvailable: () => false } as never, bad)
    expect(off).toEqual({ kind: "unavailable", reason: "unavailable" })

    const missing = await attemptMcpStatusPrivate(
      { isPrivateAvailable: () => true, getPrivatePeer: () => null, getPrivateEpoch: () => 1 } as never,
      buildMcpStatusReq(DIR),
    )
    expect(missing).toEqual({ kind: "unavailable", reason: "missing-capability" })

    const r2 = buildMcpStatusReq(DIR)
    const vague = await attemptMcpStatusPrivate(connWith((q) => ambiguousFor(q)) as never, r2)
    expect(vague).toEqual({ kind: "unavailable", reason: "transportUnknown" })

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
    expect(invalid).toEqual({ kind: "unavailable", reason: "invalid" })

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
    expect(broken).toEqual({ kind: "unavailable", reason: "transport" })

    const closed = await attemptMcpStatusPrivate(
      {
        isPrivateAvailable: () => true,
        privateMcpStatusOutcomeWithHandle: () => ({
          id: 44,
          promise: Promise.reject(new Error("Peer closed")),
          cancel: () => true,
        }),
      } as never,
      buildMcpStatusReq(DIR),
    )
    expect(closed).toEqual({ kind: "unavailable", reason: "transport" })

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
    expect(slow).toEqual({ kind: "unavailable", reason: "timeout" })
  })

  test("retryable config-convergence fence returns explicit unavailable with zero SDK", async () => {
    const r = buildMcpStatusReq(DIR)
    const out = await attemptMcpStatusPrivate(connWith((q) => retryableFor(q)) as never, r)
    expect(out).toEqual({ kind: "unavailable", reason: "InstanceUnavailableDuringConfigRebuild" })
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
    expect(out).toEqual({ kind: "unavailable", reason: "timeout" })
    expect(cancelled).toContain(r.opId)
  })

  test("settled terminal returns terminal", async () => {
    const r = buildMcpStatusReq(DIR)
    const out = await attemptMcpStatusPrivate(connWith((q) => terminalFor(q, "validation.failed")) as never, r)
    expect(out).toEqual({ kind: "terminal" })
  })

  test("fetch returns private ok with no client dependency", async () => {
    const out = await fetchMcpStatusPrivate({
      connection: connWith((q) => okFor(q)) as never,
      directory: DIR,
    })
    expect(out.kind).toBe("ok")
    if (out.kind === "ok") expect(out.status).toEqual({ docs: { status: "connected" } })
  })

  test("fetch exposes terminal with no client dependency", async () => {
    const out = await fetchMcpStatusPrivate({
      connection: connWith((q) => terminalFor(q)) as never,
      directory: DIR,
    })
    expect(out).toEqual({ kind: "terminal" })
  })

  test("fetch maps fast non-terminal private outcomes to unavailable with zero SDK", async () => {
    // Timeout/exact-cancel stays covered by the dedicated attempt-level tests
    // above ("explicit unavailable" with 10ms + "timeout exact-cancels"), so
    // this matrix stays fast and never waits on the 3s production default.
    const cases: Array<{ name: string; conn: unknown }> = [
      { name: "unavailable", conn: { isPrivateAvailable: () => false } },
      {
        name: "missing-capability",
        conn: { isPrivateAvailable: () => true, getPrivatePeer: () => null, getPrivateEpoch: () => 1 },
      },
      { name: "retryable-fence", conn: connWith((q) => retryableFor(q)) },
      { name: "ambiguous", conn: connWith((q) => ambiguousFor(q)) },
      {
        name: "invalid",
        conn: {
          isPrivateAvailable: () => true,
          privateMcpStatusOutcomeWithHandle: () => ({
            id: 9,
            promise: Promise.resolve({ kind: "invalid", detail: "bad" }),
            cancel: () => true,
          }),
        },
      },
      {
        name: "transport",
        conn: {
          isPrivateAvailable: () => true,
          privateMcpStatusOutcomeWithHandle: () => ({
            id: 10,
            promise: Promise.reject(new Error("Private peer unavailable")),
            cancel: () => true,
          }),
        },
      },
      {
        name: "closed",
        conn: {
          isPrivateAvailable: () => true,
          privateMcpStatusOutcomeWithHandle: () => ({
            id: 11,
            promise: Promise.reject(new Error("Peer closed")),
            cancel: () => true,
          }),
        },
      },
    ]
    for (const c of cases) {
      const out = await fetchMcpStatusPrivate({ connection: c.conn as never, directory: DIR })
      expect(out, c.name).toEqual({ kind: "unavailable" })
    }
  })

  test("shared helper has no SDK status surface", async () => {
    const mod = (await import("./mcp-status-private")) as Record<string, unknown>
    expect("coerceSdkStatus" in mod).toBeFalse()
    expect("fetchMcpStatusPrivateFirst" in mod).toBeFalse()
    expect(typeof mod.fetchMcpStatusPrivate).toBe("function")
  })
})
