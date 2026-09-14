import { describe, expect, test } from "bun:test"
import {
  attemptBackgroundStopSessionPrivate,
  buildBackgroundStopSessionReq,
  parseBackgroundStopSessionResult,
  stopSessionProcessesPrivateFirst,
} from "./background-process-stop-session-privatefirst"
import { canonicalBackgroundStopSessionOpId } from "../services/cli-backend/serve-private-background-process-stop-session-contract"

const DIR = "/tmp"
const SID = "ses_ffffffffffffffffffffffff"

function okRawFor(req: ReturnType<typeof buildBackgroundStopSessionReq>) {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: req.op,
    idempotencyKey: req.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: 1 },
    accepted: true,
    data: { stopped: true },
  }
}

function terminalFor(req: ReturnType<typeof buildBackgroundStopSessionReq>, code = "internal") {
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

function retryableFor(req: ReturnType<typeof buildBackgroundStopSessionReq>) {
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
      failure: { code: "InstanceUnavailableDuringConfigRebuild", message: "busy", retryable: true },
    },
    accepted: false,
    failure: { code: "InstanceUnavailableDuringConfigRebuild", message: "busy", retryable: true },
  }
}

function ambiguousFor(req: ReturnType<typeof buildBackgroundStopSessionReq>) {
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

function connWith(
  build: (r: ReturnType<typeof buildBackgroundStopSessionReq>) => unknown,
  seen?: { n: number; cancel: number },
) {
  return {
    isPrivateAvailable: () => true,
    privateBackgroundStopSessionOutcomeWithHandle: (q: ReturnType<typeof buildBackgroundStopSessionReq>) => {
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

function sdkClient(seen: { n: number; sessionID?: unknown; directory?: unknown }) {
  return {
    backgroundProcess: {
      stopSession: async (params: { sessionID: string; directory: string }) => {
        seen.n += 1
        seen.sessionID = params.sessionID
        seen.directory = params.directory
        return true
      },
    },
  }
}

describe("background stop-session private-first", () => {
  test("identity binds opaque single-token tuple with session+directory in context", () => {
    const req = buildBackgroundStopSessionReq(SID, DIR)
    expect(req.opId).toBe(req.idempotencyKey)
    expect(req.opId.startsWith("background-process-stop-session:")).toBeTrue()
    const token = req.opId.split(":")[1]!
    expect(canonicalBackgroundStopSessionOpId(token)).toBe(req.opId)
    expect(req.context.sessionId).toBe(SID)
    expect(req.context.directory).toBe(DIR)
    expect(req.opId.includes(SID)).toBeFalse()
  })

  test("private success returns with zero SDK", async () => {
    const req = buildBackgroundStopSessionReq(SID, DIR)
    expect(parseBackgroundStopSessionResult(okRawFor(req), req)).toEqual({ kind: "ok" })
    const seen = { n: 0 }
    const out = await stopSessionProcessesPrivateFirst({
      connection: connWith((q) => okRawFor(q)) as never,
      client: sdkClient(seen) as never,
      sessionId: SID,
      directory: DIR,
    })
    expect(out).toEqual({ kind: "ok", via: "private" })
    expect(seen.n).toBe(0)
  })

  test("terminal closes with zero SDK", async () => {
    const seen = { n: 0 }
    const out = await stopSessionProcessesPrivateFirst({
      connection: connWith((q) => terminalFor(q, "internal")) as never,
      client: sdkClient(seen) as never,
      sessionId: SID,
      directory: DIR,
    })
    expect(out).toEqual({ kind: "terminal", code: "internal" })
    expect(seen.n).toBe(0)
  })

  for (const reason of ["unavailable", "invalid", "ambiguous", "retryable", "closed", "timeout"] as const) {
    test(`${reason} takes exactly one same-identity SDK fallback`, async () => {
      const seen = { n: 0, sessionID: undefined as unknown, directory: undefined as unknown }
      let conn: unknown
      if (reason === "unavailable") conn = { isPrivateAvailable: () => false }
      else if (reason === "invalid") conn = connWith((q) => ({ garbled: true, requestId: q.requestId }))
      else if (reason === "ambiguous") conn = connWith((q) => ambiguousFor(q))
      else if (reason === "retryable") conn = connWith((q) => retryableFor(q))
      else if (reason === "closed")
        conn = {
          isPrivateAvailable: () => true,
          privateBackgroundStopSessionOutcomeWithHandle: () => {
            throw new Error("Private peer unavailable")
          },
        }
      else
        conn = {
          isPrivateAvailable: () => true,
          privateBackgroundStopSessionOutcomeWithHandle: () => ({
            id: 9,
            promise: new Promise(() => {}),
            cancel: () => true,
          }),
        }
      const out = await stopSessionProcessesPrivateFirst({
        connection: conn as never,
        client: sdkClient(seen) as never,
        sessionId: SID,
        directory: DIR,
      })
      expect(seen.n).toBe(1)
      expect(seen.sessionID).toBe(SID)
      expect(seen.directory).toBe(DIR)
      expect(out).toEqual({ kind: "ok", via: "sdk" })
    })
  }

  test("timeout exact-cancels the pending by id with opaque opId only", async () => {
    const req = buildBackgroundStopSessionReq(SID, DIR)
    let cancelled: string | null = null
    const conn = {
      isPrivateAvailable: () => true,
      privateBackgroundStopSessionOutcomeWithHandle: () => ({
        id: 42,
        promise: new Promise(() => {}),
        cancel: (msg?: string) => {
          cancelled = msg ?? ""
          return true
        },
      }),
    }
    const out = await attemptBackgroundStopSessionPrivate(conn as never, req, 20)
    expect(out).toEqual({ kind: "fallback", reason: "timeout" })
    expect(cancelled ?? "").toContain("background-stop-session timeout")
    expect(cancelled ?? "").toContain(req.opId)
    expect(cancelled ?? "").not.toContain(SID)
  })

  test("settled success survives post-response epoch drift", async () => {
    const req = buildBackgroundStopSessionReq(SID, DIR)
    const raw = okRawFor(req)
    const { wrapBackgroundStopSessionOutcomeForOwner } = await import(
      "../services/cli-backend/serve-private-background-process-stop-session"
    )
    const wrapped = wrapBackgroundStopSessionOutcomeForOwner(
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
      expect(parseBackgroundStopSessionResult(outcome.result, req)).toEqual({ kind: "ok" })
    }
  })

  test("settled nonretryable terminal survives post-response epoch drift", async () => {
    const req = buildBackgroundStopSessionReq(SID, DIR)
    const raw = terminalFor(req, "internal")
    const { wrapBackgroundStopSessionOutcomeForOwner } = await import(
      "../services/cli-backend/serve-private-background-process-stop-session"
    )
    const wrapped = wrapBackgroundStopSessionOutcomeForOwner(
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
      expect(parseBackgroundStopSessionResult(outcome.result, req)).toEqual({ kind: "terminal", code: "internal" })
    }
  })

  test("unsettled drift remains ambiguous for fallback", async () => {
    const { wrapBackgroundStopSessionOutcomeForOwner } = await import(
      "../services/cli-backend/serve-private-background-process-stop-session"
    )
    for (const build of [
      (req: ReturnType<typeof buildBackgroundStopSessionReq>) => ambiguousFor(req),
      (req: ReturnType<typeof buildBackgroundStopSessionReq>) => retryableFor(req),
      (req: ReturnType<typeof buildBackgroundStopSessionReq>) => ({ garbled: true }) as unknown as never,
    ]) {
      const req = buildBackgroundStopSessionReq(SID, DIR)
      const raw = build(req) as never
      const wrapped = wrapBackgroundStopSessionOutcomeForOwner(
        { epochAtCall: 1, isCurrent: () => false, invalidate: () => {} },
        () => true,
        () => {},
        {
          id: 3,
          promise: Promise.resolve(
            (raw as { status?: unknown }).status === undefined
              ? ({ kind: "invalid", detail: "bad" } as never)
              : ({ kind: "valid", result: raw } as never),
          ),
        },
        req,
      )
      const outcome = await wrapped.promise
      expect(outcome.kind).toBe("valid")
      if (outcome.kind === "valid") {
        expect(outcome.result.status).toBe("ambiguous")
        expect(parseBackgroundStopSessionResult(outcome.result, req).kind).toBe("fallback")
      }
    }
  })

  test("SDK fallback rejection throws the same error without extra warn", async () => {
    const warns: unknown[][] = []
    const orig = console.warn
    console.warn = (...args: unknown[]) => {
      warns.push(args)
    }
    try {
      const err = new Error("sdk stop failed")
      const seen = { n: 0 }
      const client = {
        backgroundProcess: {
          stopSession: async () => {
            seen.n += 1
            throw err
          },
        },
      }
      let thrown: unknown = null
      try {
        await stopSessionProcessesPrivateFirst({
          connection: { isPrivateAvailable: () => false } as never,
          client: client as never,
          sessionId: SID,
          directory: DIR,
        })
      } catch (e) {
        thrown = e
      }
      expect(thrown).toBe(err)
      expect(seen.n).toBe(1)
      expect(warns).toHaveLength(0)
    } finally {
      console.warn = orig
    }
  })

  test("SDK fallback rejection after private fallback warns once with opaque opId only", async () => {
    const warns: unknown[][] = []
    const orig = console.warn
    console.warn = (...args: unknown[]) => {
      warns.push(args)
    }
    try {
      const err = new Error("sdk stop failed")
      const client = {
        backgroundProcess: {
          stopSession: async () => {
            throw err
          },
        },
      }
      let thrown: unknown = null
      try {
        await stopSessionProcessesPrivateFirst({
          connection: connWith((q) => retryableFor(q)) as never,
          client: client as never,
          sessionId: SID,
          directory: DIR,
        })
      } catch (e) {
        thrown = e
      }
      expect(thrown).toBe(err)
      expect(warns).toHaveLength(1)
      expect(JSON.stringify(warns)).not.toContain(SID)
      expect(JSON.stringify(warns)).not.toContain(DIR)
    } finally {
      console.warn = orig
    }
  })
})
