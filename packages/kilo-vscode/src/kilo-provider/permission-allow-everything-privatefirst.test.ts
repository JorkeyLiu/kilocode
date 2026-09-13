import { describe, expect, test } from "bun:test"
import {
  ALLOW_EVERYTHING_TIMEOUT_MS,
  allowEverythingPermissionPrivateFirst,
  buildPermissionAllowEverythingReq,
  setAllowEverythingPrivateFirst,
} from "./permission-allow-everything-privatefirst"
import { canonicalPermissionAllowEverythingOpId } from "../services/cli-backend/serve-private-permission-allow-everything-contract"

const DIR = "/workspace/allow-everything"
const SES = "ses_root00000000000000001"
const PID = "per_test00000000000000001"

function terminalFor(req: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    kind: "terminal",
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    idempotencyKey: req.idempotencyKey,
    accepted: true,
    terminal: true,
    enable: (req.payload as Record<string, unknown>).enable,
    ...extra,
  }
}

function failureFor(req: Record<string, unknown>, code = "internal") {
  return {
    kind: "terminal-failure",
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    idempotencyKey: req.idempotencyKey,
    accepted: false,
    terminal: true,
    failure: { code, retryable: false, time: 1 },
    sideEffect: false,
  }
}

function vagueFor(req: Record<string, unknown>) {
  return {
    kind: "ambiguous",
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    idempotencyKey: req.idempotencyKey,
    accepted: false,
    terminal: false,
    transportUnknown: true,
  }
}

describe("permission allow-everything private-first", () => {
  test("identity binds the allow-everything tuple and validators accept it", () => {
    const r = buildPermissionAllowEverythingReq(DIR, true, SES, PID)
    expect(r.op).toBe("permission/allow-everything")
    expect(r.opId).toBe(r.idempotencyKey)
    expect(r.opId.startsWith("permission-allow-everything:")).toBeTrue()
    const token = r.opId.split(":")[1]!
    expect(canonicalPermissionAllowEverythingOpId(token)).toBe(r.opId)
    expect(r.context).toEqual({ directory: DIR, sessionID: SES, requestID: PID })
    expect(r.payload).toEqual({ enable: true })
    expect(ALLOW_EVERYTHING_TIMEOUT_MS).toBe(3000)
  })

  test("private terminal uses zero SDK", async () => {
    const calls: unknown[] = []
    const conn = {
      isPrivateAvailable: () => true,
      privatePermissionAllowEverythingWithHandle: (req: Record<string, unknown>) => ({
        id: 1,
        promise: Promise.resolve(terminalFor(req, { sessionID: SES, requestID: PID })),
        cancel: () => true,
      }),
    }
    const client = {
      permission: {
        allowEverything: async (args: unknown) => {
          calls.push(args)
          return { data: true }
        },
      },
    }
    const out = await setAllowEverythingPrivateFirst({ connection: conn as never, client: client as never, directory: DIR, enable: true, sessionID: SES, requestID: PID })
    expect(out).toEqual({ kind: "ok" })
    expect(calls).toHaveLength(0)
  })

  test("private terminal-failure closes with zero SDK", async () => {
    const calls: unknown[] = []
    const conn = {
      isPrivateAvailable: () => true,
      privatePermissionAllowEverythingWithHandle: (req: Record<string, unknown>) => ({
        id: 1,
        promise: Promise.resolve(failureFor(req, "scope_mismatch")),
        cancel: () => true,
      }),
    }
    const client = {
      permission: {
        allowEverything: async (args: unknown) => {
          calls.push(args)
          return { data: true }
        },
      },
    }
    const out = await setAllowEverythingPrivateFirst({ connection: conn as never, client: client as never, directory: DIR, enable: false })
    expect(out.kind).toBe("error")
    expect(calls).toHaveLength(0)
  })

  test("ambiguous falls back to exactly one same-tuple SDK call", async () => {
    const seen: unknown[] = []
    const conn = {
      isPrivateAvailable: () => true,
      privatePermissionAllowEverythingWithHandle: (req: Record<string, unknown>) => ({
        id: 1,
        promise: Promise.resolve(vagueFor(req)),
        cancel: () => true,
      }),
    }
    const client = {
      permission: {
        allowEverything: async (args: unknown) => {
          seen.push(args)
          return { data: true }
        },
      },
    }
    const out = await setAllowEverythingPrivateFirst({ connection: conn as never, client: client as never, directory: DIR, enable: true, sessionID: SES })
    expect(out).toEqual({ kind: "ok" })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toEqual({ directory: DIR, enable: true, sessionID: SES })
  })

  test("private unavailable falls back to exactly one SDK call with request scope preserved", async () => {
    const seen: unknown[] = []
    const client = {
      permission: {
        allowEverything: async (args: unknown) => {
          seen.push(args)
          return { data: true }
        },
      },
    }
    const out = await setAllowEverythingPrivateFirst({ connection: null, client: client as never, directory: DIR, enable: false, requestID: PID })
    expect(out).toEqual({ kind: "ok" })
    expect(seen).toEqual([{ directory: DIR, enable: false, requestID: PID }])
  })

  test("timeout cancels the exact pending and falls back once", async () => {
    const cancelled: string[] = []
    const seen: unknown[] = []
    const conn = {
      isPrivateAvailable: () => true,
      privatePermissionAllowEverythingWithHandle: (req: Record<string, unknown>) => ({
        id: 9,
        promise: Promise.reject(new Error("private allow-everything timeout after 3000ms")),
        cancel: (msg?: string) => {
          cancelled.push(String(msg))
          expect(String(msg).includes(String(req.opId))).toBeTrue()
          return true
        },
      }),
    }
    const attempt = await allowEverythingPermissionPrivateFirst({ connection: conn as never, directory: DIR, enable: true })
    expect(attempt.outcome).toEqual({ kind: "fallback", reason: "timeout" })
    expect(cancelled).toHaveLength(1)
    const client = {
      permission: {
        allowEverything: async (args: unknown) => {
          seen.push(args)
          return { data: true }
        },
      },
    }
    const settled = await setAllowEverythingPrivateFirst({
      connection: {
        isPrivateAvailable: () => true,
        privatePermissionAllowEverythingWithHandle: (req: Record<string, unknown>) => ({
          id: 9,
          promise: Promise.reject(new Error("private allow-everything timeout after 3000ms")),
          cancel: () => true,
        }),
      } as never,
      client: client as never,
      directory: DIR,
      enable: true,
    })
    expect(settled).toEqual({ kind: "ok" })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toEqual({ directory: DIR, enable: true })
  })
})
