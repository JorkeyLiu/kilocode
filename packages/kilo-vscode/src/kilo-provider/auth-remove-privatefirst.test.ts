import { describe, expect, test } from "bun:test"
import {
  attemptAuthRemovePrivate,
  buildAuthRemoveReq,
  parseAuthRemoveResult,
  removeAuthPrivateFirst,
} from "./auth-remove-privatefirst"
import { canonicalAuthRemoveOpId } from "../services/cli-backend/serve-private-auth-remove-contract"

const DIR = "/tmp"
const PROVIDER = "kilo"

function okRawFor(req: ReturnType<typeof buildAuthRemoveReq>) {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: req.op,
    idempotencyKey: req.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: 1 },
    accepted: true,
    data: { removed: true },
  }
}

function terminalFor(req: ReturnType<typeof buildAuthRemoveReq>, code = "internal") {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: req.op,
    idempotencyKey: req.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time: 1, failure: { code, message: "m", retryable: false } },
    accepted: false,
    failure: { code, message: "m", retryable: false },
  }
}

function retryableFor(req: ReturnType<typeof buildAuthRemoveReq>) {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: req.op,
    idempotencyKey: req.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time: 1, failure: { code: "internal", message: "busy", retryable: true } },
    accepted: false,
    failure: { code: "internal", message: "busy", retryable: true },
  }
}

function ambiguousFor(req: ReturnType<typeof buildAuthRemoveReq>) {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: req.op,
    idempotencyKey: req.idempotencyKey,
    status: "ambiguous",
    outcome: { type: "ambiguous", time: 1 },
    accepted: false,
    transportUnknown: true,
  }
}

function connWith(build: (r: ReturnType<typeof buildAuthRemoveReq>) => unknown, seen?: { n: number; cancel: number }) {
  return {
    isPrivateAvailable: () => true,
    privateAuthRemoveOutcomeWithHandle: (q: ReturnType<typeof buildAuthRemoveReq>) => {
      if (seen) seen.n += 1
      return {
        id: 7,
        promise: Promise.resolve({ kind: "valid", result: build(q) }),
        cancel: () => {
          if (seen) seen.cancel += 1
          return true
        },
      }
    },
  }
}

function sdkClient(seen: { n: number; providerID?: unknown }) {
  return {
    auth: {
      remove: async (params?: unknown) => {
        seen.n += 1
        seen.providerID = (params as { providerID?: unknown } | undefined)?.providerID
        return { data: true }
      },
    },
  }
}

describe("auth-remove private-first", () => {
  test("identity binds single-token tuple with stable providerID", () => {
    const req = buildAuthRemoveReq(PROVIDER, DIR)
    expect(req.opId).toBe(req.idempotencyKey)
    expect(req.opId.startsWith("auth-remove:")).toBeTrue()
    const token = req.opId.split(":")[1]!
    expect(canonicalAuthRemoveOpId(token)).toBe(req.opId)
    expect(req.payload.providerID).toBe(PROVIDER)
  })

  test("private success returns with zero SDK", async () => {
    const req = buildAuthRemoveReq(PROVIDER, DIR)
    expect(parseAuthRemoveResult(okRawFor(req), req)).toEqual({ kind: "ok" })
    const seen = { n: 0 }
    const out = await removeAuthPrivateFirst({
      connection: connWith((q) => okRawFor(q)) as never,
      client: sdkClient(seen) as never,
      providerID: PROVIDER,
      directory: DIR,
    })
    expect(out).toEqual({ kind: "ok", via: "private" })
    expect(seen.n).toBe(0)
  })

  test("terminal closes with zero SDK", async () => {
    const seen = { n: 0 }
    const out = await removeAuthPrivateFirst({
      connection: connWith((q) => terminalFor(q, "internal")) as never,
      client: sdkClient(seen) as never,
      providerID: PROVIDER,
      directory: DIR,
    })
    expect(out).toEqual({ kind: "terminal", code: "internal" })
    expect(seen.n).toBe(0)
  })

  for (const reason of ["unavailable", "invalid", "ambiguous", "retryable", "closed", "timeout"] as const) {
    test(`${reason} takes exactly one same-identity SDK fallback`, async () => {
      const seen = { n: 0, providerID: undefined as unknown }
      let conn: unknown
      if (reason === "unavailable") conn = { isPrivateAvailable: () => false }
      else if (reason === "invalid") conn = connWith((q) => ({ garbled: true, requestId: q.requestId }))
      else if (reason === "ambiguous") conn = connWith((q) => ambiguousFor(q))
      else if (reason === "retryable") conn = connWith((q) => retryableFor(q))
      else if (reason === "closed")
        conn = {
          isPrivateAvailable: () => true,
          privateAuthRemoveOutcomeWithHandle: () => {
            throw new Error("Private peer unavailable")
          },
        }
      else
        conn = {
          isPrivateAvailable: () => true,
          privateAuthRemoveOutcomeWithHandle: () => ({
            id: 9,
            promise: new Promise(() => {}),
            cancel: () => true,
          }),
        }
      const out = await removeAuthPrivateFirst({
        connection: conn as never,
        client: sdkClient(seen) as never,
        providerID: PROVIDER,
        directory: DIR,
      })
      expect(seen.n).toBe(1)
      expect(seen.providerID).toBe(PROVIDER)
      expect(out).toEqual({ kind: "ok", via: "sdk" })
    })
  }

  test("timeout exact-cancels the pending by id", async () => {
    const req = buildAuthRemoveReq(PROVIDER, DIR)
    let cancelled: string | null = null
    const conn = {
      isPrivateAvailable: () => true,
      privateAuthRemoveOutcomeWithHandle: () => ({
        id: 42,
        promise: new Promise(() => {}),
        cancel: (msg?: string) => {
          cancelled = msg ?? ""
          return true
        },
      }),
    }
    const out = await attemptAuthRemovePrivate(conn as never, req, 20)
    expect(out).toEqual({ kind: "fallback", reason: "timeout" })
    expect(cancelled ?? "").toContain("auth-remove timeout")
    expect(cancelled ?? "").toContain(req.opId)
  })

  test("settled success survives post-response epoch drift", async () => {
    const req = buildAuthRemoveReq(PROVIDER, DIR)
    const raw = okRawFor(req)
    const { wrapAuthRemoveOutcomeForOwner } = await import("../services/cli-backend/serve-private-auth-remove")
    const wrapped = wrapAuthRemoveOutcomeForOwner(
      { epochAtCall: 1, isCurrent: () => false, invalidate: () => {} },
      () => true,
      () => {},
      { id: 1, promise: Promise.resolve({ kind: "valid" as const, result: raw }) },
      req,
    )
    const outcome = await wrapped.promise
    expect(outcome.kind).toBe("valid")
    if (outcome.kind === "valid") {
      expect(outcome.result.status).toBe("succeeded")
      expect(parseAuthRemoveResult(outcome.result, req)).toEqual({ kind: "ok" })
    }
  })

  test("settled nonretryable terminal survives post-response epoch drift", async () => {
    const req = buildAuthRemoveReq(PROVIDER, DIR)
    const raw = terminalFor(req, "internal")
    const { wrapAuthRemoveOutcomeForOwner } = await import("../services/cli-backend/serve-private-auth-remove")
    const wrapped = wrapAuthRemoveOutcomeForOwner(
      { epochAtCall: 1, isCurrent: () => false, invalidate: () => {} },
      () => true,
      () => {},
      { id: 2, promise: Promise.resolve({ kind: "valid" as const, result: raw }) },
      req,
    )
    const outcome = await wrapped.promise
    expect(outcome.kind).toBe("valid")
    if (outcome.kind === "valid") {
      expect(outcome.result.status).toBe("failed")
      expect(parseAuthRemoveResult(outcome.result, req)).toEqual({ kind: "terminal", code: "internal" })
    }
  })

  test("unsettled drift remains ambiguous for fallback", async () => {
    const { wrapAuthRemoveOutcomeForOwner } = await import("../services/cli-backend/serve-private-auth-remove")
    for (const build of [
      (req: ReturnType<typeof buildAuthRemoveReq>) => ambiguousFor(req),
      (req: ReturnType<typeof buildAuthRemoveReq>) => retryableFor(req),
      (req: ReturnType<typeof buildAuthRemoveReq>) => ({ garbled: true }) as unknown as never,
    ]) {
      const req = buildAuthRemoveReq(PROVIDER, DIR)
      const raw = build(req) as never
      const wrapped = wrapAuthRemoveOutcomeForOwner(
        { epochAtCall: 1, isCurrent: () => false, invalidate: () => {} },
        () => true,
        () => {},
        {
          id: 3,
          promise: Promise.resolve(
            (raw as { status?: unknown }).status === undefined
              ? ({ kind: "invalid", detail: "bad" }) as never
              : ({ kind: "valid", result: raw }) as never,
          ),
        },
        req,
      )
      const outcome = await wrapped.promise
      expect(outcome.kind).toBe("valid")
      if (outcome.kind === "valid") {
        expect(outcome.result.status).toBe("ambiguous")
        expect(parseAuthRemoveResult(outcome.result, req).kind).toBe("fallback")
      }
    }
  })
})
