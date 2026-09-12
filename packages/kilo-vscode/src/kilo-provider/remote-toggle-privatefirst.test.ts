import { describe, expect, test } from "bun:test"
import {
  attemptRemoteTogglePrivate,
  buildRemoteToggleReq,
  fetchRemoteTogglePrivateFirst,
  parseRemoteToggleResult,
} from "./remote-toggle-privatefirst"
import { canonicalRemoteDisableOpId, canonicalRemoteEnableOpId } from "../services/cli-backend/serve-private-remote-toggle-contract"

const DIR = "/tmp"

function okFor(action: "enable" | "disable", token = "t1", enabled = true, connected = true) {
  const req = buildRemoteToggleReq(action, DIR)
  void token
  return {
    req,
    raw: {
      v: 1,
      requestId: req.requestId,
      opId: req.opId,
      op: req.op,
      idempotencyKey: req.idempotencyKey,
      status: "succeeded",
      outcome: { type: "succeeded", time: 1 },
      accepted: true,
      data: { status: { enabled, connected } },
    },
  }
}

function terminalFor(req: ReturnType<typeof buildRemoteToggleReq>, code = "auth.missing") {
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

function retryableFor(req: ReturnType<typeof buildRemoteToggleReq>) {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: req.op,
    idempotencyKey: req.idempotencyKey,
    status: "failed",
    outcome: {
      type: "failed",
      time: 1,
      failure: { code: "auth.unverified", message: "busy", retryable: true },
    },
    accepted: false,
    failure: { code: "auth.unverified", message: "busy", retryable: true },
  }
}

function ambiguousFor(req: ReturnType<typeof buildRemoteToggleReq>) {
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

function okRawFor(req: ReturnType<typeof buildRemoteToggleReq>, enabled = true, connected = true) {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: req.op,
    idempotencyKey: req.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: 1 },
    accepted: true,
    data: { status: { enabled, connected } },
  }
}

function connWith(build: (r: ReturnType<typeof buildRemoteToggleReq>) => unknown, seen?: { n: number; cancel: number }) {
  return {
    isPrivateAvailable: () => true,
    privateRemoteToggleOutcomeWithHandle: (q: ReturnType<typeof buildRemoteToggleReq>) => {
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

describe("remote-toggle private-first", () => {
  for (const action of ["enable", "disable"] as const) {
    test(`${action}: identity binds canonical tuple`, () => {
      const req = buildRemoteToggleReq(action, DIR)
      expect(req.opId).toBe(req.idempotencyKey)
      const prefix = action === "enable" ? "remote-enable:" : "remote-disable:"
      expect(req.opId.startsWith(prefix)).toBeTrue()
      const token = req.opId.split(":")[1]!
      const canonical = action === "enable" ? canonicalRemoteEnableOpId(token) : canonicalRemoteDisableOpId(token)
      expect(canonical).toBe(req.opId)
    })

    test(`${action}: private success returns owner status with zero SDK`, async () => {
      const req = buildRemoteToggleReq(action, DIR)
      const raw = okRawFor(req, true, true)
      const parsed = parseRemoteToggleResult(raw, req)
      expect(parsed).toEqual({ kind: "ok", state: { enabled: true, connected: true } })
      let sdk = 0
      const client = {
        remote: {
          enable: async () => {
            sdk += 1
            return { data: { enabled: false, connected: false } }
          },
          disable: async () => {
            sdk += 1
            return { data: { enabled: false, connected: false } }
          },
        },
      }
      const out = await fetchRemoteTogglePrivateFirst({
        connection: connWith((q) => okRawFor(q, true, true)) as never,
        client: client as never,
        directory: DIR,
        action,
      })
      expect(out.kind).toBe("ok")
      if (out.kind === "ok") {
        expect(out.via).toBe("private")
        expect(out.state).toEqual({ enabled: true, connected: true })
      }
      expect(sdk).toBe(0)
    })

    test(`${action}: terminal closes with zero SDK`, async () => {
      let sdk = 0
      const client = {
        remote: {
          enable: async () => {
            sdk += 1
            return { data: { enabled: true, connected: true } }
          },
          disable: async () => {
            sdk += 1
            return { data: { enabled: true, connected: true } }
          },
        },
      }
      const out = await fetchRemoteTogglePrivateFirst({
        connection: connWith((q) => terminalFor(q, "auth.missing")) as never,
        client: client as never,
        directory: DIR,
        action,
      })
      expect(out).toEqual({ kind: "terminal", code: "auth.missing" })
      expect(sdk).toBe(0)
    })

    for (const reason of ["unavailable", "invalid", "ambiguous", "closed"] as const) {
      test(`${action}: ${reason} takes exactly one same-action SDK fallback`, async () => {
        let sdk = 0
        let sdkAction: string | null = null
        const client = {
          remote: {
            enable: async () => {
              sdk += 1
              sdkAction = "enable"
              return { data: { enabled: true, connected: false } }
            },
            disable: async () => {
              sdk += 1
              sdkAction = "disable"
              return { data: { enabled: false, connected: false } }
            },
          },
        }
        let conn: unknown
        if (reason === "unavailable") conn = { isPrivateAvailable: () => false }
        else if (reason === "invalid")
          conn = connWith((q) => ({ garbled: true, requestId: q.requestId }))
        else if (reason === "ambiguous") conn = connWith((q) => ambiguousFor(q))
        else if (reason === "closed")
          conn = {
            isPrivateAvailable: () => true,
            privateRemoteToggleOutcomeWithHandle: () => {
              throw new Error("Private peer unavailable")
            },
          }
        else
          conn = {
            isPrivateAvailable: () => true,
            privateRemoteToggleOutcomeWithHandle: () => ({
              id: 9,
              promise: new Promise(() => {}),
              cancel: () => true,
            }),
          }
        const out = await fetchRemoteTogglePrivateFirst({
          connection: conn as never,
          client: client as never,
          directory: DIR,
          action,
        })
        expect(sdk).toBe(1)
        expect(sdkAction).toBe(action)
        expect(out.kind).toBe("ok")
      })
    }

    test(`${action}: retryable failure falls back exactly once`, async () => {
      let sdk = 0
      const client = {
        remote: {
          enable: async () => {
            sdk += 1
            return { data: { enabled: true, connected: false } }
          },
          disable: async () => {
            sdk += 1
            return { data: { enabled: false, connected: false } }
          },
        },
      }
      const out = await fetchRemoteTogglePrivateFirst({
        connection: connWith((q) => retryableFor(q)) as never,
        client: client as never,
        directory: DIR,
        action,
      })
      expect(sdk).toBe(1)
      expect(out.kind).toBe("ok")
    })
  }

  test("timeout exact-cancels the pending by id", async () => {
    const req = buildRemoteToggleReq("enable", DIR)
    let cancelled: string | null = null
    const conn = {
      isPrivateAvailable: () => true,
      privateRemoteToggleOutcomeWithHandle: () => ({
        id: 42,
        promise: new Promise(() => {}),
        cancel: (msg?: string) => {
          cancelled = msg ?? ""
          return true
        },
      }),
    }
    const out = await attemptRemoteTogglePrivate(conn as never, req, 20)
    expect(out).toEqual({ kind: "fallback", reason: "timeout" })
    expect(cancelled ?? "").toContain("remote-toggle timeout")
    expect(cancelled ?? "").toContain(req.opId)
  })

  test("settled success survives post-response epoch drift", async () => {
    const req = buildRemoteToggleReq("disable", DIR)
    const raw = okRawFor(req, false, false)
    const { wrapRemoteToggleOutcomeForOwner } = await import(
      "../services/cli-backend/serve-private-remote-toggle"
    )
    const wrapped = wrapRemoteToggleOutcomeForOwner(
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
      expect(parseRemoteToggleResult(outcome.result, req)).toEqual({
        kind: "ok",
        state: { enabled: false, connected: false },
      })
    }
  })

  test("settled nonretryable terminal survives post-response epoch drift", async () => {
    const req = buildRemoteToggleReq("enable", DIR)
    const raw = terminalFor(req, "auth.missing")
    const { wrapRemoteToggleOutcomeForOwner } = await import(
      "../services/cli-backend/serve-private-remote-toggle"
    )
    const wrapped = wrapRemoteToggleOutcomeForOwner(
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
      expect(parseRemoteToggleResult(outcome.result, req)).toEqual({ kind: "terminal", code: "auth.missing" })
    }
  })

  test("unsettled drift remains ambiguous for fallback", async () => {
    const { wrapRemoteToggleOutcomeForOwner } = await import(
      "../services/cli-backend/serve-private-remote-toggle"
    )
    for (const build of [
      (req: ReturnType<typeof buildRemoteToggleReq>) => ambiguousFor(req),
      (req: ReturnType<typeof buildRemoteToggleReq>) => retryableFor(req),
      (req: ReturnType<typeof buildRemoteToggleReq>) => ({ garbled: true }) as unknown as never,
    ]) {
      const req = buildRemoteToggleReq("disable", DIR)
      const raw = build(req) as never
      const wrapped = wrapRemoteToggleOutcomeForOwner(
        { epochAtCall: 1, isCurrent: () => false, invalidate: () => {} },
        () => true,
        () => {},
        {
          id: 3,
          promise: Promise.resolve(
            // Malformed wire resolves as invalid and must not survive drift.
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
        expect(parseRemoteToggleResult(outcome.result, req).kind).toBe("fallback")
      }
    }
  })
})
