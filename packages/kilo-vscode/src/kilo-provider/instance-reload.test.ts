import { describe, expect, it } from "bun:test"
import {
  isReloadConflictError,
  RELOAD_CONFLICT_WARNING,
  RELOAD_FAILED_ERROR,
  requestInstanceReload,
} from "./instance-reload"
import { buildInstanceReloadReq } from "./instance-reload-privatefirst"

function conflictError() {
  return { response: { status: 409 } }
}

function failedError() {
  return { response: { status: 500 } }
}

function okConn(seen?: { n: number }) {
  return {
    isPrivateAvailable: () => true,
    privateInstanceReloadOutcomeWithHandle: (q: ReturnType<typeof buildInstanceReloadReq>) => {
      if (seen) seen.n += 1
      return {
        id: 1,
        promise: Promise.resolve({
          kind: "valid",
          result: {
            v: 1,
            requestId: q.requestId,
            opId: q.opId,
            op: q.op,
            idempotencyKey: q.idempotencyKey,
            status: "succeeded",
            outcome: { type: "succeeded", time: 1 },
            accepted: true,
            data: { reloaded: true },
          },
        }),
        cancel: () => true,
      }
    },
  }
}

function terminalConn(code: string, seen?: { n: number }) {
  return {
    isPrivateAvailable: () => true,
    privateInstanceReloadOutcomeWithHandle: (q: ReturnType<typeof buildInstanceReloadReq>) => {
      if (seen) seen.n += 1
      return {
        id: 2,
        promise: Promise.resolve({
          kind: "valid",
          result: {
            v: 1,
            requestId: q.requestId,
            opId: q.opId,
            op: q.op,
            idempotencyKey: q.idempotencyKey,
            status: "failed",
            outcome: { type: "failed", time: 1, failure: { code, message: "m", retryable: false } },
            accepted: false,
            failure: { code, message: "m", retryable: false },
          },
        }),
        cancel: () => true,
      }
    },
  }
}

function sdkClient(calls: unknown[], impl?: () => Promise<unknown> | unknown) {
  return {
    instance: {
      reload: async (...args: unknown[]) => {
        calls.push(args)
        if (impl) return impl()
        return { data: {} }
      },
    },
  }
}

describe("requestInstanceReload private-first", () => {
  it("valid private success returns succeeded with zero SDK", async () => {
    const calls: unknown[] = []
    const outcome = await requestInstanceReload({
      connection: okConn() as never,
      client: sdkClient(calls) as never,
      directory: "/workspace/wt-s1",
    })
    expect(outcome).toEqual({ kind: "succeeded" })
    expect(calls.length).toBe(0)
  })

  it("validated terminal conflict closes with zero SDK and the existing conflict shape", async () => {
    const calls: unknown[] = []
    const outcome = await requestInstanceReload({
      connection: terminalConn("conflict") as never,
      client: sdkClient(calls) as never,
      directory: "/workspace",
    })
    expect(outcome.kind).toBe("conflict")
    expect(calls.length).toBe(0)
  })

  it("validated terminal validation/scope/internal closes with zero SDK and the existing failed shape", async () => {
    for (const code of ["validation.failed", "scope_mismatch", "internal"]) {
      const calls: unknown[] = []
      const outcome = await requestInstanceReload({
        connection: terminalConn(code) as never,
        client: sdkClient(calls) as never,
        directory: "/workspace",
      })
      expect(outcome.kind).toBe("failed")
      expect(calls.length).toBe(0)
    }
  })

  it("retryable fence takes exactly one same-directory SDK fallback with no retry", async () => {
    const calls: unknown[] = []
    const conn = {
      isPrivateAvailable: () => true,
      privateInstanceReloadOutcomeWithHandle: (q: ReturnType<typeof buildInstanceReloadReq>) => ({
        id: 3,
        promise: Promise.resolve({
          kind: "valid",
          result: {
            v: 1,
            requestId: q.requestId,
            opId: q.opId,
            op: q.op,
            idempotencyKey: q.idempotencyKey,
            status: "failed",
            outcome: {
              type: "failed",
              time: 1,
              failure: { code: "InstanceUnavailableDuringConfigRebuild", message: "busy", retryable: true },
            },
            accepted: false,
            failure: { code: "InstanceUnavailableDuringConfigRebuild", message: "busy", retryable: true },
          },
        }),
        cancel: () => true,
      }),
    }
    const outcome = await requestInstanceReload({
      connection: conn as never,
      client: sdkClient(calls) as never,
      directory: "/workspace/wt-s1",
    })
    expect(outcome).toEqual({ kind: "succeeded" })
    expect(calls.length).toBe(1)
    expect(calls[0]).toEqual([{ directory: "/workspace/wt-s1" }, { throwOnError: true }])
  })

  it("unavailable/invalid/ambiguous/transport/timeout takes exactly one SDK fallback", async () => {
    const cases: Array<{ name: string; conn: unknown }> = [
      { name: "unavailable", conn: { isPrivateAvailable: () => false } },
      {
        name: "invalid",
        conn: {
          isPrivateAvailable: () => true,
          privateInstanceReloadOutcomeWithHandle: () => ({
            id: 4,
            promise: Promise.resolve({ kind: "invalid", detail: "bad" }),
            cancel: () => true,
          }),
        },
      },
      {
        name: "ambiguous",
        conn: {
          isPrivateAvailable: () => true,
          privateInstanceReloadOutcomeWithHandle: (q: ReturnType<typeof buildInstanceReloadReq>) => ({
            id: 5,
            promise: Promise.resolve({
              kind: "valid",
              result: {
                v: 1,
                requestId: q.requestId,
                opId: q.opId,
                op: q.op,
                idempotencyKey: q.idempotencyKey,
                status: "ambiguous",
                outcome: { type: "ambiguous", time: 1 },
                accepted: false,
                transportUnknown: true,
              },
            }),
            cancel: () => true,
          }),
        },
      },
      {
        name: "transport",
        conn: {
          isPrivateAvailable: () => true,
          privateInstanceReloadOutcomeWithHandle: () => {
            throw new Error("Private peer unavailable")
          },
        },
      },
      {
        name: "timeout",
        conn: {
          isPrivateAvailable: () => true,
          privateInstanceReloadOutcomeWithHandle: () => ({
            id: 6,
            promise: new Promise(() => {}),
            cancel: () => true,
          }),
        },
      },
    ]
    for (const c of cases) {
      const calls: unknown[] = []
      const outcome = await requestInstanceReload({
        connection: c.conn as never,
        client: sdkClient(calls) as never,
        directory: "/workspace",
      })
      expect(outcome).toEqual({ kind: "succeeded" })
      expect(calls.length).toBe(1)
    }
  }, 15000)

  it("SDK fallback maps a 409 throw to conflict and retains the cause", async () => {
    const cause = conflictError()
    const calls: unknown[] = []
    const outcome = await requestInstanceReload({
      connection: { isPrivateAvailable: () => false } as never,
      client: sdkClient(calls, async () => {
        throw cause
      }) as never,
      directory: "/workspace",
    })
    expect(outcome).toEqual({ kind: "conflict", cause })
    expect(calls.length).toBe(1)
  })

  it("SDK fallback maps a non-409 error to failed and retains the cause", async () => {
    const cause = failedError()
    const calls: unknown[] = []
    const outcome = await requestInstanceReload({
      connection: { isPrivateAvailable: () => false } as never,
      client: sdkClient(calls, async () => {
        throw cause
      }) as never,
      directory: "/workspace",
    })
    expect(outcome).toEqual({ kind: "failed", cause })
    expect(calls.length).toBe(1)
  })

  it("mutation identity uses instance-reload:<token> with opId===idempotencyKey and empty payload", async () => {
    let seen: ReturnType<typeof buildInstanceReloadReq> | null = null
    const conn = {
      isPrivateAvailable: () => true,
      privateInstanceReloadOutcomeWithHandle: (q: ReturnType<typeof buildInstanceReloadReq>) => {
        seen = q
        return {
          id: 7,
          promise: Promise.resolve({
            kind: "valid",
            result: {
              v: 1,
              requestId: q.requestId,
              opId: q.opId,
              op: q.op,
              idempotencyKey: q.idempotencyKey,
              status: "succeeded",
              outcome: { type: "succeeded", time: 1 },
              accepted: true,
              data: { reloaded: true },
            },
          }),
          cancel: () => true,
        }
      },
    }
    const calls: unknown[] = []
    await requestInstanceReload({ connection: conn as never, client: sdkClient(calls) as never, directory: "/workspace" })
    expect(seen).not.toBeNull()
    expect(seen!.opId.startsWith("instance-reload:")).toBeTrue()
    expect(seen!.idempotencyKey).toBe(seen!.opId)
    expect(seen!.context.directory).toBe("/workspace")
    expect(seen!.payload).toEqual({})
    expect(calls.length).toBe(0)
  })

  it("keeps 409 detection inside the helper", () => {
    expect(isReloadConflictError({ response: { status: 409 } })).toBe(true)
    expect(isReloadConflictError({ response: { status: 500 } })).toBe(false)
    expect(isReloadConflictError(new Error("boom"))).toBe(false)
    expect(isReloadConflictError(null)).toBe(false)
  })

  it("shares one user-facing copy for both call sites", () => {
    expect(RELOAD_CONFLICT_WARNING).toBe(
      "Cannot reload while a session is running. Wait for it to finish or abort it first.",
    )
    expect(RELOAD_FAILED_ERROR).toBe("Reload failed. See extension logs for details.")
  })
})
