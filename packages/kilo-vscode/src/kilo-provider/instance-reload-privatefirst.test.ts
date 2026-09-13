import { describe, expect, test } from "bun:test"
import {
  attemptInstanceReloadPrivate,
  buildInstanceReloadReq,
  parseInstanceReloadResult,
} from "./instance-reload-privatefirst"
import { canonicalInstanceReloadOpId } from "../services/cli-backend/serve-private-instance-reload-contract"

const DIR = "/tmp"

function okRawFor(req: ReturnType<typeof buildInstanceReloadReq>) {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: req.op,
    idempotencyKey: req.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: 1 },
    accepted: true,
    data: { reloaded: true },
  }
}

function terminalFor(req: ReturnType<typeof buildInstanceReloadReq>, code = "conflict") {
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

function retryableFor(req: ReturnType<typeof buildInstanceReloadReq>) {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: req.op,
    idempotencyKey: req.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time: 1, failure: { code: "InstanceUnavailableDuringConfigRebuild", message: "busy", retryable: true } },
    accepted: false,
    failure: { code: "InstanceUnavailableDuringConfigRebuild", message: "busy", retryable: true },
  }
}

function ambiguousFor(req: ReturnType<typeof buildInstanceReloadReq>) {
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

function connWith(build: (r: ReturnType<typeof buildInstanceReloadReq>) => unknown, seen?: { n: number; cancel: number }) {
  return {
    isPrivateAvailable: () => true,
    privateInstanceReloadOutcomeWithHandle: (q: ReturnType<typeof buildInstanceReloadReq>) => {
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

describe("instance-reload private-first attempt", () => {
  test("identity binds instance-reload:<token> with requestId and canonical routing", () => {
    const req = buildInstanceReloadReq(DIR)
    expect(req.opId).toBe(req.idempotencyKey)
    expect(req.opId.startsWith("instance-reload:")).toBeTrue()
    const token = req.opId.split(":")[1]!
    expect(canonicalInstanceReloadOpId(token)).toBe(req.opId)
    expect(req.context.directory).toBe(DIR)
    expect(req.payload).toEqual({})
    const ws = buildInstanceReloadReq(DIR, "ws-1")
    expect(ws.context.workspace).toBe("ws-1")
  })

  test("private success parses to ok", async () => {
    const req = buildInstanceReloadReq(DIR)
    expect(parseInstanceReloadResult(okRawFor(req), req)).toEqual({ kind: "ok" })
    const out = await attemptInstanceReloadPrivate(connWith((q) => okRawFor(q)) as never, req)
    expect(out).toEqual({ kind: "ok" })
  })

  test("terminal conflict and validation/scope/internal parse to terminal", async () => {
    for (const code of ["conflict", "validation.failed", "scope_mismatch", "internal"]) {
      const req = buildInstanceReloadReq(DIR)
      expect(parseInstanceReloadResult(terminalFor(req, code), req)).toEqual({ kind: "terminal", code })
      const out = await attemptInstanceReloadPrivate(connWith((q) => terminalFor(q, code)) as never, req)
      expect(out).toEqual({ kind: "terminal", code })
    }
  })

  test("retryable fence parses to fallback", async () => {
    const req = buildInstanceReloadReq(DIR)
    expect(parseInstanceReloadResult(retryableFor(req), req).kind).toBe("fallback")
  })

  for (const reason of ["unavailable", "invalid", "ambiguous", "retryable", "closed"] as const) {
    test(`${reason} parses to fallback`, async () => {
      const req = buildInstanceReloadReq(DIR)
      let conn: unknown
      if (reason === "unavailable") conn = { isPrivateAvailable: () => false }
      else if (reason === "invalid") conn = connWith((q) => ({ garbled: true, requestId: q.requestId }))
      else if (reason === "ambiguous") conn = connWith((q) => ambiguousFor(q))
      else if (reason === "retryable") conn = connWith((q) => retryableFor(q))
      else
        conn = {
          isPrivateAvailable: () => true,
          privateInstanceReloadOutcomeWithHandle: () => {
            throw new Error("Private peer unavailable")
          },
        }
      const out = await attemptInstanceReloadPrivate(conn as never, req)
      expect(out.kind).toBe("fallback")
    })
  }

  test("timeout exact-cancels the pending by id", async () => {
    const req = buildInstanceReloadReq(DIR)
    let cancelled: string | null = null
    const conn = {
      isPrivateAvailable: () => true,
      privateInstanceReloadOutcomeWithHandle: () => ({
        id: 42,
        promise: new Promise(() => {}),
        cancel: (msg?: string) => {
          cancelled = msg ?? ""
          return true
        },
      }),
    }
    const out = await attemptInstanceReloadPrivate(conn as never, req, 20)
    expect(out).toEqual({ kind: "fallback", reason: "timeout" })
    expect(cancelled ?? "").toContain("instance-reload timeout")
    expect(cancelled ?? "").toContain(req.opId)
  })

  test("settled success survives post-response epoch drift", async () => {
    const req = buildInstanceReloadReq(DIR)
    const raw = okRawFor(req)
    const { wrapInstanceReloadOutcomeForOwner } = await import("../services/cli-backend/serve-private-instance-reload")
    const wrapped = wrapInstanceReloadOutcomeForOwner(
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
      expect(parseInstanceReloadResult(outcome.result, req)).toEqual({ kind: "ok" })
    }
  })

  test("settled nonretryable terminal survives post-response epoch drift", async () => {
    const req = buildInstanceReloadReq(DIR)
    const raw = terminalFor(req, "conflict")
    const { wrapInstanceReloadOutcomeForOwner } = await import("../services/cli-backend/serve-private-instance-reload")
    const wrapped = wrapInstanceReloadOutcomeForOwner(
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
      expect(parseInstanceReloadResult(outcome.result, req)).toEqual({ kind: "terminal", code: "conflict" })
    }
  })

  test("unsettled drift remains ambiguous for fallback", async () => {
    const { wrapInstanceReloadOutcomeForOwner } = await import("../services/cli-backend/serve-private-instance-reload")
    for (const build of [
      (req: ReturnType<typeof buildInstanceReloadReq>) => ambiguousFor(req),
      (req: ReturnType<typeof buildInstanceReloadReq>) => retryableFor(req),
      (req: ReturnType<typeof buildInstanceReloadReq>) => ({ garbled: true }) as unknown as never,
    ]) {
      const req = buildInstanceReloadReq(DIR)
      const raw = build(req) as never
      const wrapped = wrapInstanceReloadOutcomeForOwner(
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
        expect(parseInstanceReloadResult(outcome.result, req).kind).toBe("fallback")
      }
    }
  })
})
