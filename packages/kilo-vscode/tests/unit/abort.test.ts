import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import type { KiloClient } from "@kilocode/sdk/v2/client"
import {
  abortSession,
  fixtureAbortAttemptCount,
  fixtureAbortAttempts,
  fixtureAbortAttemptsReset,
  SessionAbort,
} from "../../src/kilo-provider/abort"

function client(calls: unknown[], fail = false) {
  return {
    session: {
      abort: async (params: unknown, opts: unknown) => {
        calls.push({ type: "abort", params, opts })
        if (fail) throw new Error("abort failed")
        return { data: true }
      },
    },
  } as unknown as KiloClient
}

describe("SessionAbort", () => {
  it("stops the active owner and current mapped directory", async () => {
    const calls: unknown[] = []
    const aborts = new SessionAbort()
    aborts.observe("session_1", "busy", "/repo")

    expect(await aborts.stop(client(calls), "session_1", "/repo/worktree")).toBe(true)
    expect(calls).toEqual([
      {
        type: "abort",
        params: { sessionID: "session_1", directory: "/repo" },
        opts: { throwOnError: true },
      },
      {
        type: "abort",
        params: { sessionID: "session_1", directory: "/repo/worktree" },
        opts: { throwOnError: true },
      },
    ])
  })

  it("forgets an owner when its instance becomes idle", async () => {
    const calls: unknown[] = []
    const aborts = new SessionAbort()
    aborts.observe("session_1", "busy", "/repo")
    aborts.observe("session_1", "idle", "/repo")

    expect(await aborts.stop(client(calls), "session_1", "/repo/worktree")).toBe(false)
    expect(calls).toEqual([
      {
        type: "abort",
        params: { sessionID: "session_1", directory: "/repo/worktree" },
        opts: { throwOnError: true },
      },
    ])
  })

  it("deduplicates equivalent directory paths", async () => {
    const calls: unknown[] = []
    const aborts = new SessionAbort()
    aborts.observe("session_1", "busy", "/repo/worktree")

    expect(await aborts.stop(client(calls), "session_1", "/repo/worktree/.")).toBe(true)
    expect(calls).toHaveLength(1)
  })
})

describe("abortSession", () => {
  it("calls session.abort with the session id and directory", async () => {
    const calls: unknown[] = []

    await abortSession({ client: client(calls), sessionID: "session_1", dir: "/repo" })

    expect(calls).toEqual([
      {
        type: "abort",
        params: { sessionID: "session_1", directory: "/repo" },
        opts: { throwOnError: true },
      },
    ])
  })

  it("rejects when the abort request fails", async () => {
    const calls: unknown[] = []

    await expect(abortSession({ client: client(calls, true), sessionID: "session_1", dir: "/repo" })).rejects.toThrow(
      "abort failed",
    )

    expect(calls).toEqual([
      {
        type: "abort",
        params: { sessionID: "session_1", directory: "/repo" },
        opts: { throwOnError: true },
      },
    ])
  })
})

describe("abort fixture recorder", () => {
  let original: string | undefined
  beforeEach(() => {
    original = process.env.KILO_E2E_FIXTURE
  })
  afterEach(() => {
    process.env.KILO_E2E_FIXTURE = "1"
    fixtureAbortAttemptsReset()
    if (original === undefined) delete process.env.KILO_E2E_FIXTURE
    else process.env.KILO_E2E_FIXTURE = original
  })

  it("records successful receipt with identity and timing", async () => {
    process.env.KILO_E2E_FIXTURE = "1"
    fixtureAbortAttemptsReset()
    const calls: unknown[] = []

    await abortSession({ client: client(calls), sessionID: "session_1", dir: "/repo" })

    expect(calls).toEqual([
      {
        type: "abort",
        params: { sessionID: "session_1", directory: "/repo" },
        opts: { throwOnError: true },
      },
    ])
    const entries = fixtureAbortAttempts()
    expect(entries).toHaveLength(1)
    const entry = entries[0]!
    expect(entry.sessionID).toBe("session_1")
    expect(entry.directory).toBe("/repo")
    expect(entry.ok).toBe(true)
    expect(entry.attempt).toBe(1)
    expect(entry.data).toBe(true)
    expect(entry.startedAt).toBeGreaterThan(0)
    expect(entry.endedAt).toBeGreaterThanOrEqual(entry.startedAt)
    expect(entry.durationMs).toBeGreaterThanOrEqual(0)
    expect(fixtureAbortAttemptCount("session_1")).toBe(1)
    expect(fixtureAbortAttemptCount()).toBe(1)
  })

  it("records thrown SDK error without changing rejection", async () => {
    process.env.KILO_E2E_FIXTURE = "1"
    fixtureAbortAttemptsReset()
    const calls: unknown[] = []

    await expect(abortSession({ client: client(calls, true), sessionID: "session_1", dir: "/repo" })).rejects.toThrow(
      "abort failed",
    )

    const entries = fixtureAbortAttempts()
    expect(entries).toHaveLength(1)
    expect(entries[0]!.ok).toBe(false)
    expect(entries[0]!.sessionID).toBe("session_1")
    expect(entries[0]!.attempt).toBe(1)
    expect(entries[0]!.error).toContain("abort failed")
    expect(fixtureAbortAttemptCount("session_1")).toBe(1)
  })

  it("tracks unambiguous per-session call count across fan-out", async () => {
    process.env.KILO_E2E_FIXTURE = "1"
    fixtureAbortAttemptsReset()
    const calls: unknown[] = []
    const aborts = new SessionAbort()
    aborts.observe("session_1", "busy", "/repo")
    aborts.observe("session_2", "busy", "/other")

    expect(await aborts.stop(client(calls), "session_1", "/repo/worktree")).toBe(true)
    expect(await aborts.stop(client(calls), "session_2", "/other")).toBe(true)

    expect(fixtureAbortAttemptCount("session_1")).toBe(2)
    expect(fixtureAbortAttemptCount("session_2")).toBe(1)
    expect(fixtureAbortAttemptCount()).toBe(3)
    const entries = fixtureAbortAttempts()
    expect(entries.filter((entry) => entry.sessionID === "session_1").map((entry) => entry.attempt)).toEqual([1, 2])
    expect(entries.filter((entry) => entry.sessionID === "session_2").map((entry) => entry.attempt)).toEqual([1])
  })

  it("records nothing when fixture mode is disabled", async () => {
    delete process.env.KILO_E2E_FIXTURE
    const calls: unknown[] = []

    await abortSession({ client: client(calls), sessionID: "session_1", dir: "/repo" })
    await expect(abortSession({ client: client(calls, true), sessionID: "session_2", dir: "/repo" })).rejects.toThrow()

    expect(() => fixtureAbortAttempts()).toThrow()
    expect(() => fixtureAbortAttemptCount()).toThrow()
    expect(() => fixtureAbortAttemptsReset()).toThrow()
    process.env.KILO_E2E_FIXTURE = "1"
    expect(fixtureAbortAttempts()).toEqual([])
    expect(fixtureAbortAttemptCount()).toBe(0)
  })

  it("bounds retained records and per-session counts to the limit", async () => {
    process.env.KILO_E2E_FIXTURE = "1"
    fixtureAbortAttemptsReset()
    const calls: unknown[] = []

    for (let i = 0; i < 55; i++) {
      await abortSession({ client: client(calls), sessionID: "session_bounded", dir: `/repo/${i}` })
    }

    const entries = fixtureAbortAttempts()
    expect(entries).toHaveLength(50)
    expect(fixtureAbortAttemptCount()).toBe(50)
    expect(fixtureAbortAttemptCount("session_bounded")).toBe(50)
    expect(entries[0]!.attempt).toBe(6)
    expect(entries[entries.length - 1]!.attempt).toBe(55)
  })

  it("bounds distinct session identities to retained records", async () => {
    process.env.KILO_E2E_FIXTURE = "1"
    fixtureAbortAttemptsReset()
    const calls: unknown[] = []

    for (let i = 0; i < 60; i++) {
      await abortSession({ client: client(calls), sessionID: `session_${i}`, dir: "/repo" })
    }

    const entries = fixtureAbortAttempts()
    expect(entries).toHaveLength(50)
    expect(fixtureAbortAttemptCount()).toBe(50)
    const ids = new Set(entries.map((entry) => entry.sessionID))
    expect(ids.size).toBeLessThanOrEqual(50)
    expect(fixtureAbortAttemptCount("session_0")).toBe(0)
    expect(fixtureAbortAttemptCount("session_59")).toBe(1)
  })

  it("stores only safe name/message for thrown objects with secret fields", async () => {
    process.env.KILO_E2E_FIXTURE = "1"
    fixtureAbortAttemptsReset()
    const secret = "sk-secret-token-123"
    const throwing = {
      session: {
        abort: async () => {
          // eslint-disable-next-line no-throw-literal
          throw { name: "AbortError", message: "boom", token: secret, apiKey: secret, password: secret }
        },
      },
    } as unknown as KiloClient

    await expect(abortSession({ client: throwing, sessionID: "session_1", dir: "/repo" })).rejects.toEqual(
      expect.objectContaining({ message: "boom" }),
    )

    const entries = fixtureAbortAttempts()
    expect(entries).toHaveLength(1)
    expect(entries[0]!.ok).toBe(false)
    expect(entries[0]!.error).toBe("AbortError: boom")
    expect(entries[0]!.error).not.toContain(secret)
    expect(JSON.stringify(entries[0])).not.toContain(secret)
  })

  it("truncates long error messages and keeps only numeric status", async () => {
    process.env.KILO_E2E_FIXTURE = "1"
    fixtureAbortAttemptsReset()
    const long = `x`.repeat(600)
    const throwing = {
      session: {
        abort: async () => {
          const err = new Error(long) as Error & { response: { status: "500" } }
          err.response = { status: "500" } as unknown as { status: number }
          throw err
        },
      },
    } as unknown as KiloClient

    await expect(abortSession({ client: throwing, sessionID: "session_1", dir: "/repo" })).rejects.toThrow()

    const entries = fixtureAbortAttempts()
    expect(entries).toHaveLength(1)
    expect(entries[0]!.error!.length).toBeLessThanOrEqual(500)
    expect(entries[0]!.status).toBeUndefined()
  })

  it("returns isolated copies from the reader", async () => {
    process.env.KILO_E2E_FIXTURE = "1"
    fixtureAbortAttemptsReset()
    const calls: unknown[] = []

    await abortSession({ client: client(calls), sessionID: "session_1", dir: "/repo" })

    const first = fixtureAbortAttempts()
    first[0]!.sessionID = "mutated"
    first.push({ sessionID: "fake", directory: "/fake", startedAt: 0, endedAt: 0, durationMs: 0, ok: true, attempt: 99 })

    const second = fixtureAbortAttempts()
    expect(second).toHaveLength(1)
    expect(second[0]!.sessionID).toBe("session_1")
    expect(fixtureAbortAttemptCount()).toBe(1)
  })

  it("records mixed fan-out failures without changing SDK args or return", async () => {
    process.env.KILO_E2E_FIXTURE = "1"
    fixtureAbortAttemptsReset()
    const calls: unknown[] = []
    const mixed = {
      session: {
        abort: async (params: unknown, opts: unknown) => {
          calls.push({ type: "abort", params, opts })
          if ((params as { directory: string }).directory === "/repo/bad") throw new Error("bad dir failed")
          return { data: true }
        },
      },
    } as unknown as KiloClient
    const aborts = new SessionAbort()
    aborts.observe("session_1", "busy", "/repo/good")
    aborts.observe("session_1", "busy", "/repo/bad")

    expect(await aborts.stop(mixed, "session_1", "/repo/fallback")).toBe(false)
    expect(calls).toEqual([
      { type: "abort", params: { sessionID: "session_1", directory: "/repo/good" }, opts: { throwOnError: true } },
      { type: "abort", params: { sessionID: "session_1", directory: "/repo/bad" }, opts: { throwOnError: true } },
      { type: "abort", params: { sessionID: "session_1", directory: "/repo/fallback" }, opts: { throwOnError: true } },
    ])
    const entries = fixtureAbortAttempts()
    expect(entries).toHaveLength(3)
    expect(entries.filter((entry) => entry.ok)).toHaveLength(2)
    expect(entries.filter((entry) => !entry.ok)).toHaveLength(1)
    expect(fixtureAbortAttemptCount("session_1")).toBe(3)
    expect(entries.map((entry) => entry.attempt).sort((a, b) => a - b)).toEqual([1, 2, 3])
  })

  it("numbers concurrent same-session attempts without duplicates", async () => {
    process.env.KILO_E2E_FIXTURE = "1"
    fixtureAbortAttemptsReset()
    const calls: unknown[] = []

    await Promise.all([
      abortSession({ client: client(calls), sessionID: "session_1", dir: "/repo/a" }),
      abortSession({ client: client(calls), sessionID: "session_1", dir: "/repo/b" }),
      abortSession({ client: client(calls), sessionID: "session_1", dir: "/repo/c" }),
    ])

    expect(calls).toEqual([
      { type: "abort", params: { sessionID: "session_1", directory: "/repo/a" }, opts: { throwOnError: true } },
      { type: "abort", params: { sessionID: "session_1", directory: "/repo/b" }, opts: { throwOnError: true } },
      { type: "abort", params: { sessionID: "session_1", directory: "/repo/c" }, opts: { throwOnError: true } },
    ])
    const entries = fixtureAbortAttempts()
    expect(entries).toHaveLength(3)
    expect(entries.map((entry) => entry.attempt).sort((a, b) => a - b)).toEqual([1, 2, 3])
    expect(fixtureAbortAttemptCount("session_1")).toBe(3)
  })

  it("captures generated SDK cause.status without exposing cause.body", async () => {
    process.env.KILO_E2E_FIXTURE = "1"
    fixtureAbortAttemptsReset()
    const secret = "sk-cause-secret-456"
    const throwing = {
      session: {
        abort: async () => {
          throw new Error("abort failed", { cause: { body: { token: secret }, status: 503 } })
        },
      },
    } as unknown as KiloClient

    await expect(abortSession({ client: throwing, sessionID: "session_1", dir: "/repo" })).rejects.toThrow()

    const entries = fixtureAbortAttempts()
    expect(entries).toHaveLength(1)
    expect(entries[0]!.ok).toBe(false)
    expect(entries[0]!.status).toBe(503)
    expect(entries[0]!.error).not.toContain(secret)
    expect(JSON.stringify(entries[0])).not.toContain(secret)
  })

  it("bounds huge error name/message without unbounded concatenation", async () => {
    process.env.KILO_E2E_FIXTURE = "1"
    fixtureAbortAttemptsReset()
    const throwing = {
      session: {
        abort: async () => {
          const err = new Error("m".repeat(20000))
          err.name = "N".repeat(20000)
          throw err
        },
      },
    } as unknown as KiloClient

    await expect(abortSession({ client: throwing, sessionID: "session_1", dir: "/repo" })).rejects.toThrow()

    const entries = fixtureAbortAttempts()
    expect(entries).toHaveLength(1)
    expect(entries[0]!.ok).toBe(false)
    expect(entries[0]!.error!.length).toBeLessThanOrEqual(500)
  })

  it("keeps long common-prefix session identities separately counted and numbered", async () => {
    process.env.KILO_E2E_FIXTURE = "1"
    fixtureAbortAttemptsReset()
    const calls: unknown[] = []
    const prefix = "s".repeat(500)
    const idA = `${prefix}A${"x".repeat(100)}`
    const idB = `${prefix}B${"y".repeat(100)}`

    await abortSession({ client: client(calls), sessionID: idA, dir: "/repo" })
    await abortSession({ client: client(calls), sessionID: idB, dir: "/repo" })

    expect(calls).toEqual([
      { type: "abort", params: { sessionID: idA, directory: "/repo" }, opts: { throwOnError: true } },
      { type: "abort", params: { sessionID: idB, directory: "/repo" }, opts: { throwOnError: true } },
    ])
    const entries = fixtureAbortAttempts()
    expect(entries).toHaveLength(2)
    expect(entries[0]!.sessionID).toBe(prefix)
    expect(entries[1]!.sessionID).toBe(prefix)
    expect(entries[0]!.sessionID.length).toBeLessThanOrEqual(500)
    expect(fixtureAbortAttemptCount(idA)).toBe(1)
    expect(fixtureAbortAttemptCount(idB)).toBe(1)
    expect(fixtureAbortAttemptCount()).toBe(2)
    expect(entries.map((entry) => entry.attempt)).toEqual([1, 1])
  })

  it("separates the demonstrated 32-bit collision class (shared 500-char prefix)", async () => {
    process.env.KILO_E2E_FIXTURE = "1"
    fixtureAbortAttemptsReset()
    const calls: unknown[] = []
    // Equivalent of the demonstrated pair: two distinct 506-character
    // production-shaped IDs sharing the first 500 chars. Under the prior
    // single 32-bit FNV-1a discriminator both hashed to d2d80105 and were
    // counted as one session; the dual-hash key must keep them separate.
    const prefix = `ses_${"s".repeat(496)}`
    expect(prefix).toHaveLength(500)
    const idA = `${prefix}aGGqwc`
    const idB = `${prefix}W3vNTp`
    expect(idA).toHaveLength(506)
    expect(idB).toHaveLength(506)

    await abortSession({ client: client(calls), sessionID: idA, dir: "/repo" })
    await abortSession({ client: client(calls), sessionID: idB, dir: "/repo" })

    expect(calls).toEqual([
      { type: "abort", params: { sessionID: idA, directory: "/repo" }, opts: { throwOnError: true } },
      { type: "abort", params: { sessionID: idB, directory: "/repo" }, opts: { throwOnError: true } },
    ])
    const entries = fixtureAbortAttempts()
    expect(entries).toHaveLength(2)
    expect(entries[0]!.sessionID).toBe(prefix)
    expect(entries[1]!.sessionID).toBe(prefix)
    expect(entries[0]!.sessionID.length).toBeLessThanOrEqual(500)
    expect(JSON.stringify(entries)).not.toContain("aGGqwc")
    expect(JSON.stringify(entries)).not.toContain("W3vNTp")
    expect(fixtureAbortAttemptCount(idA)).toBe(1)
    expect(fixtureAbortAttemptCount(idB)).toBe(1)
    expect(fixtureAbortAttemptCount()).toBe(2)
    expect(entries.map((entry) => entry.attempt)).toEqual([1, 1])
  })
})
