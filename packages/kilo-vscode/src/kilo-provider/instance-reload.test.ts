import { describe, expect, it } from "bun:test"
import {
  isReloadConflictError,
  RELOAD_CONFLICT_WARNING,
  RELOAD_FAILED_ERROR,
  requestInstanceReload,
} from "./instance-reload"

function conflictError() {
  return { response: { status: 409 } }
}

function failedError() {
  return { response: { status: 500 } }
}

describe("requestInstanceReload", () => {
  it("calls instance.reload exactly once with the explicit directory and throwOnError", async () => {
    const calls: unknown[] = []
    const client = {
      instance: {
        reload: async (...args: unknown[]) => {
          calls.push(args)
          return { data: {} }
        },
      },
    }
    const outcome = await requestInstanceReload({ client, directory: "/workspace/wt-s1" })
    expect(outcome).toEqual({ kind: "succeeded" })
    expect(calls.length).toBe(1)
    expect(calls[0]).toEqual([{ directory: "/workspace/wt-s1" }, { throwOnError: true }])
  })

  it("maps a 409 throw to conflict and retains the cause for logs", async () => {
    const cause = conflictError()
    const client = {
      instance: {
        reload: async () => {
          throw cause
        },
      },
    }
    const outcome = await requestInstanceReload({ client, directory: "/workspace" })
    expect(outcome).toEqual({ kind: "conflict", cause })
  })

  it("maps a non-409 SDK error to failed and retains the cause for logs", async () => {
    const cause = failedError()
    const client = {
      instance: {
        reload: async () => {
          throw cause
        },
      },
    }
    const outcome = await requestInstanceReload({ client, directory: "/workspace" })
    expect(outcome).toEqual({ kind: "failed", cause })
  })

  it("maps a transport throw without a response shape to failed", async () => {
    const cause = new Error("socket hang up")
    let calls = 0
    const client = {
      instance: {
        reload: async () => {
          calls += 1
          throw cause
        },
      },
    }
    const outcome = await requestInstanceReload({ client, directory: "/workspace" })
    expect(outcome).toEqual({ kind: "failed", cause })
    expect(calls).toBe(1)
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
