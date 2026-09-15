import { describe, expect, test } from "bun:test"
import {
  attemptSandboxSetPrivate,
  buildSandboxSetReq,
  parseSandboxSetResult,
  setSandboxPrivateFirst,
} from "./sandbox-set-privatefirst"
import { canonicalSandboxSetOpId } from "../services/cli-backend/serve-private-sandbox-set-contract"

const DIR = "/tmp"
const SID = "ses_abc123"

function okRawFor(req: ReturnType<typeof buildSandboxSetReq>, enabled = true) {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: req.op,
    idempotencyKey: req.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: 1 },
    accepted: true,
    data: { status: { directory: DIR, enabled, available: true, version: 3 } },
  }
}

function terminalFor(req: ReturnType<typeof buildSandboxSetReq>, code = "session.busy") {
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

function retryableFor(req: ReturnType<typeof buildSandboxSetReq>) {
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

function ambiguousFor(req: ReturnType<typeof buildSandboxSetReq>) {
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

function connWith(build: (r: ReturnType<typeof buildSandboxSetReq>) => unknown, seen?: { n: number; cancel: number }) {
  return {
    isPrivateAvailable: () => true,
    privateSandboxSetOutcomeWithHandle: (q: ReturnType<typeof buildSandboxSetReq>) => {
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

describe("sandbox-set private-first", () => {
  test("identity binds canonical tuple with target", () => {
    const req = buildSandboxSetReq(SID, DIR, true)
    expect(req.opId).toBe(req.idempotencyKey)
    expect(req.opId.startsWith("sandbox-set:")).toBeTrue()
    expect(req.payload).toEqual({ enabled: true, sessionId: SID })
    expect(req.context).toEqual({ directory: DIR, sessionId: SID })
    const token = req.opId.split(":")[2]!
    expect(canonicalSandboxSetOpId(SID, token)).toBe(req.opId)
  })

  test("private success returns owner status with zero SDK", async () => {
    const req = buildSandboxSetReq(SID, DIR, true)
    const parsed = parseSandboxSetResult(okRawFor(req, true), req)
    expect(parsed.kind).toBe("ok")
    let sdk = 0
    const client = { sandbox: { set: async () => { sdk += 1; return { data: { directory: DIR, enabled: false, available: true, version: 9 } } } } }
    const out = await setSandboxPrivateFirst({
      connection: connWith((q) => okRawFor(q, true)) as never,
      client: client as never,
      sessionId: SID,
      directory: DIR,
      enabled: true,
    })
    expect(out.kind).toBe("ok")
    if (out.kind === "ok") {
      expect(out.via).toBe("private")
      expect(out.status.enabled).toBe(true)
    }
    expect(sdk).toBe(0)
  })

  test("terminal closes with zero SDK", async () => {
    let sdk = 0
    const client = { sandbox: { set: async () => { sdk += 1; return { data: { directory: DIR, enabled: true, available: true, version: 1 } } } } }
    const out = await setSandboxPrivateFirst({
      connection: connWith((q) => terminalFor(q, "session.busy")) as never,
      client: client as never,
      sessionId: SID,
      directory: DIR,
      enabled: true,
    })
    expect(out).toEqual({ kind: "terminal", code: "session.busy" })
    expect(sdk).toBe(0)
  })

  for (const reason of ["unavailable", "invalid", "ambiguous", "closed", "timeout", "transport", "retryable"] as const) {
    test(`${reason} takes exactly one same-target SDK fallback`, async () => {
      let sdk = 0
      let seen: { sessionID?: unknown; directory?: unknown; enabled?: unknown } | null = null
      const client = {
        sandbox: {
          set: async (p: { sessionID: string; directory: string; enabled: boolean }) => {
            sdk += 1
            seen = p
            return { data: { directory: DIR, enabled: p.enabled, available: true, version: 4 } }
          },
        },
      }
      let conn: unknown
      if (reason === "unavailable") conn = { isPrivateAvailable: () => false }
      else if (reason === "invalid") conn = connWith((q) => ({ garbled: true, requestId: q.requestId }))
      else if (reason === "ambiguous") conn = connWith((q) => ambiguousFor(q))
      else if (reason === "retryable") conn = connWith((q) => retryableFor(q))
      else if (reason === "closed")
        conn = { isPrivateAvailable: () => true, privateSandboxSetOutcomeWithHandle: () => { throw new Error("Private peer unavailable") } }
      else if (reason === "transport")
        conn = { isPrivateAvailable: () => true, privateSandboxSetOutcomeWithHandle: () => { throw new Error("transport boom") } }
      else
        conn = { isPrivateAvailable: () => true, privateSandboxSetOutcomeWithHandle: () => ({ id: 9, promise: new Promise(() => {}), cancel: () => true }) }
      const out = await setSandboxPrivateFirst({
        connection: conn as never,
        client: client as never,
        sessionId: SID,
        directory: DIR,
        enabled: false,
      })
      expect(sdk).toBe(1)
      expect(seen).toEqual({ sessionID: SID, directory: DIR, enabled: false })
      expect(out.kind).toBe("ok")
      if (out.kind === "ok") {
        expect(out.via).toBe("sdk")
        expect(out.status.enabled).toBe(false)
      }
    })
  }

  test("malformed result falls back to same-target SDK", async () => {
    let sdk = 0
    const client = { sandbox: { set: async (p: { enabled: boolean }) => { sdk += 1; return { data: { directory: DIR, enabled: p.enabled, available: true, version: 5 } } } } }
    const out = await setSandboxPrivateFirst({
      connection: connWith(() => ({ v: 1, status: "succeeded", accepted: true })) as never,
      client: client as never,
      sessionId: SID,
      directory: DIR,
      enabled: true,
    })
    expect(sdk).toBe(1)
    expect(out.kind).toBe("ok")
  })

  test("capability-missing takes exactly one same-target SDK fallback", async () => {
    let sdk = 0
    const client = { sandbox: { set: async (p: { enabled: boolean }) => { sdk += 1; return { data: { directory: DIR, enabled: p.enabled, available: true, version: 6 } } } } }
    const conn = {
      isPrivateAvailable: () => true,
      privateSandboxSetOutcomeWithHandle: () => { throw new Error("Private peer missing sandbox/set capability") },
    }
    const out = await setSandboxPrivateFirst({ connection: conn as never, client: client as never, sessionId: SID, directory: DIR, enabled: true })
    expect(sdk).toBe(1)
    expect(out.kind).toBe("ok")
  })

  test("no duplicate private call per logical action", async () => {
    const seen = { n: 0, cancel: 0 }
    let sdk = 0
    const client = { sandbox: { set: async () => { sdk += 1; return { data: { directory: DIR, enabled: true, available: true, version: 1 } } } } }
    const out = await setSandboxPrivateFirst({
      connection: connWith((q) => okRawFor(q, true), seen) as never,
      client: client as never,
      sessionId: SID,
      directory: DIR,
      enabled: true,
    })
    expect(seen.n).toBe(1)
    expect(sdk).toBe(0)
    expect(out.kind).toBe("ok")
  })

  test("timeout exact-cancels then falls back once", async () => {
    let cancelled = 0
    const conn = {
      isPrivateAvailable: () => true,
      privateSandboxSetOutcomeWithHandle: () => ({ id: 11, promise: new Promise(() => {}), cancel: () => { cancelled += 1; return true } }),
    }
    let sdk = 0
    const client = { sandbox: { set: async (p: { enabled: boolean }) => { sdk += 1; return { data: { directory: DIR, enabled: p.enabled, available: true, version: 2 } } } } }
    const out = await setSandboxPrivateFirst({ connection: conn as never, client: client as never, sessionId: SID, directory: DIR, enabled: true })
    expect(cancelled).toBe(1)
    expect(sdk).toBe(1)
    expect(out.kind).toBe("ok")
  })

  test("attempt helper maps transportUnknown to fallback", async () => {
    const req = buildSandboxSetReq(SID, DIR, false)
    const out = parseSandboxSetResult({ status: "ambiguous", transportUnknown: true }, req)
    expect(out).toEqual({ kind: "fallback", reason: expect.anything() })
    void attemptSandboxSetPrivate
  })

  test("generic async peer rejection is ambiguous, never terminal", async () => {
    const { requestSandboxSetOutcome } = await import(
      "../services/cli-backend/serve-private-sandbox-set"
    )
    const req = buildSandboxSetReq(SID, DIR, true)
    let attempts = 0
    const raw = {
      requestWithId: () => {
        attempts += 1
        return { id: 7, promise: Promise.reject(new Error("transport boom")) as Promise<unknown> }
      },
    }
    const host = {
      isStale: () => false,
      isClosed: () => false,
      failInfo: () => ({ code: "internal", msg: "transport boom" }),
    }
    const handle = requestSandboxSetOutcome(raw, host, () => () => true, req)
    const outcome = await handle.promise
    expect(attempts).toBe(1)
    expect(outcome.kind).toBe("valid")
    if (outcome.kind !== "valid") return
    expect(outcome.result.status).toBe("ambiguous")
    expect((outcome.result as { transportUnknown?: unknown }).transportUnknown).toBe(true)
    expect(outcome.result.requestId).toBe(req.requestId)
    expect(outcome.result.opId).toBe(req.opId)
    expect(outcome.result.idempotencyKey).toBe(req.idempotencyKey)
    const rec = outcome.result as { failure?: { retryable?: unknown } }
    expect(rec.failure?.retryable).not.toBe(false)
    expect(parseSandboxSetResult(outcome.result, req).kind).toBe("fallback")
  })

  test("closed-like async rejection is ambiguous, never terminal", async () => {
    const { requestSandboxSetOutcome } = await import(
      "../services/cli-backend/serve-private-sandbox-set"
    )
    const req = buildSandboxSetReq(SID, DIR, false)
    const raw = {
      requestWithId: () => ({
        id: 8,
        promise: Promise.reject(new Error("Peer closed")) as Promise<unknown>,
      }),
    }
    const host = {
      isStale: () => false,
      isClosed: () => true,
      failInfo: () => ({ code: "-32603", msg: "Peer closed" }),
    }
    const outcome = await requestSandboxSetOutcome(raw, host, () => () => true, req).promise
    expect(outcome.kind).toBe("valid")
    if (outcome.kind !== "valid") return
    expect(outcome.result.status).toBe("ambiguous")
    expect((outcome.result as { failure?: unknown }).failure).toBeUndefined()
  })

  test("generic async rejection takes exactly one same-target SDK fallback", async () => {
    const { requestSandboxSetOutcome } = await import(
      "../services/cli-backend/serve-private-sandbox-set"
    )
    let privateAttempts = 0
    const conn = {
      isPrivateAvailable: () => true,
      privateSandboxSetOutcomeWithHandle: (q: ReturnType<typeof buildSandboxSetReq>) => {
        privateAttempts += 1
        const raw = {
          requestWithId: () => ({
            id: 21,
            promise: Promise.reject(new Error("transport boom")) as Promise<unknown>,
          }),
        }
        const host = {
          isStale: () => false,
          isClosed: () => false,
          failInfo: () => ({ code: "internal", msg: "transport boom" }),
        }
        return requestSandboxSetOutcome(raw, host, () => () => true, q)
      },
    }
    let sdk = 0
    let seen: { sessionID?: unknown; directory?: unknown; enabled?: unknown } | null = null
    const client = {
      sandbox: {
        set: async (p: { sessionID: string; directory: string; enabled: boolean }) => {
          sdk += 1
          seen = p
          return { data: { directory: DIR, enabled: p.enabled, available: true, version: 7 } }
        },
      },
    }
    const out = await setSandboxPrivateFirst({
      connection: conn as never,
      client: client as never,
      sessionId: SID,
      directory: DIR,
      enabled: true,
    })
    expect(privateAttempts).toBe(1)
    expect(sdk).toBe(1)
    expect(seen).toEqual({ sessionID: SID, directory: DIR, enabled: true })
    expect(out.kind).toBe("ok")
    if (out.kind === "ok") expect(out.via).toBe("sdk")
    expect(privateAttempts).toBe(1)
    expect(sdk).toBe(1)
  })
})
