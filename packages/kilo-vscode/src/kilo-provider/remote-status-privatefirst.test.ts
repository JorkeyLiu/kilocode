import { describe, expect, test } from "bun:test"
import {
  attemptRemoteStatusPrivate,
  buildRemoteStatusIdentity,
  buildRemoteStatusReq,
  fetchRemoteStatusPrivateFirst,
  parseRemoteStatusResult,
} from "./remote-status-privatefirst"
import { canonicalRemoteStatusOpId } from "../services/cli-backend/serve-private-remote-status"

const DIR = "/tmp"

function okFor(r: ReturnType<typeof buildRemoteStatusReq>, enabled = true, connected = false) {
  return {
    v: 1,
    requestId: r.requestId,
    opId: r.opId,
    op: "remote/status",
    idempotencyKey: r.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: 1 },
    accepted: true,
    data: { status: { enabled, connected } },
  }
}

function terminalFor(r: ReturnType<typeof buildRemoteStatusReq>, code = "validation.failed") {
  return {
    v: 1,
    requestId: r.requestId,
    opId: r.opId,
    op: "remote/status",
    idempotencyKey: r.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time: 1, failure: { code, message: "m", retryable: false } },
    accepted: false,
    failure: { code, message: "m", retryable: false },
  }
}

function retryableFor(r: ReturnType<typeof buildRemoteStatusReq>) {
  return {
    v: 1,
    requestId: r.requestId,
    opId: r.opId,
    op: "remote/status",
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

function ambiguousFor(r: ReturnType<typeof buildRemoteStatusReq>) {
  return {
    v: 1,
    requestId: r.requestId,
    opId: r.opId,
    op: "remote/status",
    idempotencyKey: r.idempotencyKey,
    status: "ambiguous",
    outcome: { type: "ambiguous", time: 1 },
    accepted: false,
    transportUnknown: true,
  }
}

function connWith(build: (r: ReturnType<typeof buildRemoteStatusReq>) => unknown, seen?: unknown[]) {
  return {
    isPrivateAvailable: () => true,
    privateRemoteStatusOutcomeWithHandle: (q: ReturnType<typeof buildRemoteStatusReq>) => {
      seen?.push(q)
      return {
        id: 1,
        promise: Promise.resolve({ kind: "valid", result: build(q) }),
        cancel: () => true,
      }
    },
  }
}

describe("remote-status private-first", () => {
  test("identity binds canonical remote-status tuple", () => {
    const { opId, idempotencyKey, requestId } = buildRemoteStatusIdentity()
    expect(opId).toBe(idempotencyKey)
    expect(opId.startsWith("remote-status:")).toBeTrue()
    const token = opId.split(":")[1]!
    expect(canonicalRemoteStatusOpId(token)).toBe(opId)
    expect(typeof requestId).toBe("string")
  })

  test("succeeded accepted returns ok with the two process-global booleans", () => {
    const r = buildRemoteStatusReq(DIR)
    const parsed = parseRemoteStatusResult(okFor(r, true, false), r)
    expect(parsed).toEqual({ kind: "ok", state: { enabled: true, connected: false } })
  })

  test("routing identity is directory-only; payload never binds directory", () => {
    const r = buildRemoteStatusReq(DIR)
    expect(r.context.directory).toBe(DIR)
    expect(r.payload).toEqual({})
    const parsed = parseRemoteStatusResult(okFor(r, false, true), r)
    expect(parsed).toEqual({ kind: "ok", state: { enabled: false, connected: true } })
  })

  test("terminal failed closes without SDK", async () => {
    for (const code of ["validation.failed", "internal"]) {
      const r = buildRemoteStatusReq(DIR)
      const out = await attemptRemoteStatusPrivate(connWith((q) => terminalFor(q, code)) as never, r)
      expect(out.kind).toBe("terminal")
      if (out.kind === "terminal") expect(out.code).toBe(code)
    }
  })

  test("unavailable/ambiguous/invalid/transport/timeout are fallback-eligible", async () => {
    const bad = buildRemoteStatusReq(DIR)
    const off = await attemptRemoteStatusPrivate({ isPrivateAvailable: () => false } as never, bad)
    expect(off.kind).toBe("fallback")

    const r2 = buildRemoteStatusReq(DIR)
    const vague = await attemptRemoteStatusPrivate(connWith((q) => ambiguousFor(q)) as never, r2)
    expect(vague.kind).toBe("fallback")

    const r3 = buildRemoteStatusReq(DIR)
    const invalid = await attemptRemoteStatusPrivate(
      {
        isPrivateAvailable: () => true,
        privateRemoteStatusOutcomeWithHandle: () => ({
          id: 3,
          promise: Promise.resolve({ kind: "invalid", detail: "bad" }),
          cancel: () => true,
        }),
      } as never,
      r3,
    )
    expect(invalid.kind).toBe("fallback")

    const r4 = buildRemoteStatusReq(DIR)
    const broken = await attemptRemoteStatusPrivate(
      {
        isPrivateAvailable: () => true,
        privateRemoteStatusOutcomeWithHandle: () => ({
          id: 4,
          promise: Promise.reject(new Error("Private peer unavailable")),
          cancel: () => true,
        }),
      } as never,
      r4,
    )
    expect(broken.kind).toBe("fallback")

    const r5 = buildRemoteStatusReq(DIR)
    const slow = await attemptRemoteStatusPrivate(
      {
        isPrivateAvailable: () => true,
        privateRemoteStatusOutcomeWithHandle: () => ({
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
    const r = buildRemoteStatusReq(DIR)
    const out = await attemptRemoteStatusPrivate(connWith((q) => retryableFor(q)) as never, r)
    expect(out.kind).toBe("fallback")
  })

  test("timeout exact-cancels the pending", async () => {
    const r = buildRemoteStatusReq(DIR)
    let cancelled: string | undefined
    let cancelledId = 0
    const out = await attemptRemoteStatusPrivate(
      {
        isPrivateAvailable: () => true,
        privateRemoteStatusOutcomeWithHandle: () => ({
          id: 7,
          promise: new Promise(() => {}),
          cancel: (msg?: string) => {
            cancelled = msg
            cancelledId = 7
            return true
          },
        }),
      } as never,
      r,
      10,
    )
    expect(out).toEqual({ kind: "fallback", reason: "timeout" })
    expect(cancelled).toContain(r.opId)
    expect(cancelledId).toBe(7)
  })

  test("fetch returns private result with zero SDK calls", async () => {
    let sdk = 0
    const client = {
      remote: {
        status: () => {
          sdk += 1
          return Promise.resolve({ data: { enabled: false, connected: false } })
        },
      },
    }
    const out = await fetchRemoteStatusPrivateFirst({
      connection: connWith((q) => okFor(q, true, true)) as never,
      client: client as never,
      directory: DIR,
    })
    expect(sdk).toBe(0)
    expect(out).toEqual({ kind: "ok", state: { enabled: true, connected: true }, via: "private" })
  })

  test("fetch exposes terminal with zero SDK calls", async () => {
    let sdk = 0
    const client = {
      remote: {
        status: () => {
          sdk += 1
          return Promise.resolve({ data: { enabled: false, connected: false } })
        },
      },
    }
    const out = await fetchRemoteStatusPrivateFirst({
      connection: connWith((q) => terminalFor(q)) as never,
      client: client as never,
      directory: DIR,
    })
    expect(sdk).toBe(0)
    expect(out.kind).toBe("terminal")
  })

  test("fetch falls back exactly once with the same routing identity", async () => {
    const seen: unknown[] = []
    const privSeen: unknown[] = []
    const client = {
      remote: {
        status: (args: unknown) => {
          seen.push(args)
          return Promise.resolve({ data: { enabled: true, connected: false } })
        },
      },
    }
    const out = await fetchRemoteStatusPrivateFirst({
      connection: connWith((q) => ambiguousFor(q), privSeen) as never,
      client: client as never,
      directory: DIR,
    })
    expect(seen).toEqual([{ directory: DIR }])
    expect((privSeen[0] as { context: { directory: string } }).context.directory).toBe(DIR)
    expect(out).toEqual({ kind: "ok", state: { enabled: true, connected: false }, via: "sdk" })
  })

  test("fetch treats SDK failure and malformed SDK data as unavailable", async () => {
    const failing = { remote: { status: () => Promise.reject(new Error("down")) } }
    const lost = await fetchRemoteStatusPrivateFirst({
      connection: { isPrivateAvailable: () => false } as never,
      client: failing as never,
      directory: DIR,
    })
    expect(lost.kind).toBe("unavailable")

    const malformed = { remote: { status: () => Promise.resolve({ data: { enabled: "yes" } }) } }
    const bad = await fetchRemoteStatusPrivateFirst({
      connection: { isPrivateAvailable: () => false } as never,
      client: malformed as never,
      directory: DIR,
    })
    expect(bad.kind).toBe("unavailable")
  })

  test("status read never retries: one private attempt plus at most one SDK", async () => {
    let priv = 0
    let sdk = 0
    const out = await fetchRemoteStatusPrivateFirst({
      connection: {
        isPrivateAvailable: () => true,
        privateRemoteStatusOutcomeWithHandle: () => {
          priv += 1
          return {
            id: 1,
            promise: Promise.resolve({ kind: "invalid", detail: "bad" }),
            cancel: () => true,
          }
        },
      } as never,
      client: {
        remote: {
          status: () => {
            sdk += 1
            return Promise.resolve({ data: { enabled: false, connected: false } })
          },
        },
      } as never,
      directory: DIR,
    })
    expect(priv).toBe(1)
    expect(sdk).toBe(1)
    expect(out.kind).toBe("ok")
  })
})
