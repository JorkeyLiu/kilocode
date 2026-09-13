import { describe, expect, test } from "bun:test"
import {
  attemptOrganizationSetPrivate,
  buildOrganizationSetReq,
  parseOrganizationSetResult,
  setOrganizationPrivateFirst,
} from "./organization-set-privatefirst"
import { canonicalOrganizationSetOpId } from "../services/cli-backend/serve-private-organization-set-contract"

const DIR = "/tmp"

function okRawFor(req: ReturnType<typeof buildOrganizationSetReq>) {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: req.op,
    idempotencyKey: req.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: 1 },
    accepted: true,
    data: { updated: true },
  }
}

function terminalFor(req: ReturnType<typeof buildOrganizationSetReq>, code = "unauthorized") {
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

function retryableFor(req: ReturnType<typeof buildOrganizationSetReq>) {
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

function ambiguousFor(req: ReturnType<typeof buildOrganizationSetReq>) {
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

function connWith(build: (r: ReturnType<typeof buildOrganizationSetReq>) => unknown, seen?: { n: number; cancel: number }) {
  return {
    isPrivateAvailable: () => true,
    privateOrganizationSetOutcomeWithHandle: (q: ReturnType<typeof buildOrganizationSetReq>) => {
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

function sdkClient(seen: { n: number; organizationId?: unknown }) {
  return {
    kilo: {
      organization: {
        set: async (params?: unknown) => {
          seen.n += 1
          seen.organizationId = (params as { organizationId?: unknown } | undefined)?.organizationId
          return { data: true }
        },
      },
    },
  }
}

describe("organization-set private-first", () => {
  test("identity binds single-token tuple with stable organizationId (string and null)", () => {
    const req = buildOrganizationSetReq("org-1", DIR)
    expect(req.opId).toBe(req.idempotencyKey)
    expect(req.opId.startsWith("organization-set:")).toBeTrue()
    const token = req.opId.split(":")[1]!
    expect(canonicalOrganizationSetOpId(token)).toBe(req.opId)
    expect(req.payload.organizationId).toBe("org-1")
    const nullReq = buildOrganizationSetReq(null, DIR)
    expect(nullReq.payload.organizationId).toBeNull()
    expect(nullReq.opId.startsWith("organization-set:")).toBeTrue()
  })

  test("private success returns with zero SDK", async () => {
    const req = buildOrganizationSetReq("org-1", DIR)
    expect(parseOrganizationSetResult(okRawFor(req), req)).toEqual({ kind: "ok" })
    const seen = { n: 0 }
    const out = await setOrganizationPrivateFirst({
      connection: connWith((q) => okRawFor(q)) as never,
      client: sdkClient(seen) as never,
      organizationId: "org-1",
      directory: DIR,
    })
    expect(out).toEqual({ kind: "ok", via: "private" })
    expect(seen.n).toBe(0)
  })

  test("terminal (unauthorized and internal) closes with zero SDK", async () => {
    for (const code of ["unauthorized", "internal", "validation.failed"]) {
      const seen = { n: 0 }
      const out = await setOrganizationPrivateFirst({
        connection: connWith((q) => terminalFor(q, code)) as never,
        client: sdkClient(seen) as never,
        organizationId: "org-1",
        directory: DIR,
      })
      expect(out).toEqual({ kind: "terminal", code })
      expect(seen.n).toBe(0)
    }
  })

  for (const reason of ["unavailable", "invalid", "ambiguous", "retryable", "closed"] as const) {
    test(`${reason} takes exactly one same-identity SDK fallback`, async () => {
      for (const organizationId of ["org-1", null] as const) {
        const seen = { n: 0, organizationId: undefined as unknown }
        let conn: unknown
        if (reason === "unavailable") conn = { isPrivateAvailable: () => false }
        else if (reason === "invalid") conn = connWith((q) => ({ garbled: true, requestId: q.requestId }))
        else if (reason === "ambiguous") conn = connWith((q) => ambiguousFor(q))
        else if (reason === "retryable") conn = connWith((q) => retryableFor(q))
        else
          conn = {
            isPrivateAvailable: () => true,
            privateOrganizationSetOutcomeWithHandle: () => {
              throw new Error("Private peer unavailable")
            },
          }
        const out = await setOrganizationPrivateFirst({
          connection: conn as never,
          client: sdkClient(seen) as never,
          organizationId,
          directory: DIR,
        })
        expect(seen.n).toBe(1)
        expect(seen.organizationId).toBe(organizationId)
        expect(out).toEqual({ kind: "ok", via: "sdk" })
      }
    })
  }

  test("timeout takes exactly one same-identity SDK fallback", async () => {
    for (const organizationId of ["org-1", null] as const) {
      const seen = { n: 0, organizationId: undefined as unknown }
      const conn = {
        isPrivateAvailable: () => true,
        privateOrganizationSetOutcomeWithHandle: () => ({
          id: 9,
          promise: new Promise(() => {}),
          cancel: () => true,
        }),
      }
      const out = await setOrganizationPrivateFirst({
        connection: conn as never,
        client: sdkClient(seen) as never,
        organizationId,
        directory: DIR,
      })
      expect(seen.n).toBe(1)
      expect(seen.organizationId).toBe(organizationId)
      expect(out).toEqual({ kind: "ok", via: "sdk" })
    }
  }, 15000)

  test("timeout exact-cancels the pending by id", async () => {
    const req = buildOrganizationSetReq("org-1", DIR)
    let cancelled: string | null = null
    const conn = {
      isPrivateAvailable: () => true,
      privateOrganizationSetOutcomeWithHandle: () => ({
        id: 42,
        promise: new Promise(() => {}),
        cancel: (msg?: string) => {
          cancelled = msg ?? ""
          return true
        },
      }),
    }
    const out = await attemptOrganizationSetPrivate(conn as never, req, 20)
    expect(out).toEqual({ kind: "fallback", reason: "timeout" })
    expect(cancelled ?? "").toContain("organization-set timeout")
    expect(cancelled ?? "").toContain(req.opId)
  })

  test("settled success survives post-response epoch drift", async () => {
    const req = buildOrganizationSetReq("org-1", DIR)
    const raw = okRawFor(req)
    const { wrapOrganizationSetOutcomeForOwner } = await import("../services/cli-backend/serve-private-organization-set")
    const wrapped = wrapOrganizationSetOutcomeForOwner(
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
      expect(parseOrganizationSetResult(outcome.result, req)).toEqual({ kind: "ok" })
    }
  })

  test("settled nonretryable terminal survives post-response epoch drift", async () => {
    const req = buildOrganizationSetReq("org-1", DIR)
    const raw = terminalFor(req, "unauthorized")
    const { wrapOrganizationSetOutcomeForOwner } = await import("../services/cli-backend/serve-private-organization-set")
    const wrapped = wrapOrganizationSetOutcomeForOwner(
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
      expect(parseOrganizationSetResult(outcome.result, req)).toEqual({ kind: "terminal", code: "unauthorized" })
    }
  })

  test("unsettled drift remains ambiguous for fallback", async () => {
    const { wrapOrganizationSetOutcomeForOwner } = await import("../services/cli-backend/serve-private-organization-set")
    for (const build of [
      (req: ReturnType<typeof buildOrganizationSetReq>) => ambiguousFor(req),
      (req: ReturnType<typeof buildOrganizationSetReq>) => retryableFor(req),
      (req: ReturnType<typeof buildOrganizationSetReq>) => ({ garbled: true }) as unknown as never,
    ]) {
      const req = buildOrganizationSetReq("org-1", DIR)
      const raw = build(req) as never
      const wrapped = wrapOrganizationSetOutcomeForOwner(
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
        expect(parseOrganizationSetResult(outcome.result, req).kind).toBe("fallback")
      }
    }
  })
})
