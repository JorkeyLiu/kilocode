import { describe, expect, test } from "bun:test"

// vscode mock is provided by the shared preload (tests/setup/vscode-mock.ts)
const { KiloProvider } = await import("../../src/KiloProvider")

type FetchFn = (this: unknown) => Promise<void>

const fetchAndSendSkills = KiloProvider.prototype["fetchAndSendSkills"] as unknown as FetchFn

function okResult(r: { requestId: string; opId: string; idempotencyKey: string }, skills: unknown[] = [{ name: "demo", description: "d", location: "builtin" }]) {
  return {
    v: 1,
    requestId: r.requestId,
    opId: r.opId,
    op: "skill/list",
    idempotencyKey: r.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: 1 },
    accepted: true,
    data: { skills },
  }
}

function failedResult(r: { requestId: string; opId: string; idempotencyKey: string }, code = "validation.failed") {
  return {
    v: 1,
    requestId: r.requestId,
    opId: r.opId,
    op: "skill/list",
    idempotencyKey: r.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time: 1, failure: { code, message: "m", retryable: false } },
    accepted: false,
    failure: { code, message: "m", retryable: false },
  }
}

function ambiguousResult(r: { requestId: string; opId: string; idempotencyKey: string }) {
  return {
    v: 1,
    requestId: r.requestId,
    opId: r.opId,
    op: "skill/list",
    idempotencyKey: r.idempotencyKey,
    status: "ambiguous",
    outcome: { type: "ambiguous", time: 1 },
    accepted: false,
    transportUnknown: true,
  }
}

function stub(opts: {
  conn: unknown
  sdkData?: unknown[]
  sdkImpl?: (args: { directory: string }) => Promise<{ data: unknown }>
}) {
  const posted: unknown[] = []
  let sdkCalls = 0
  let sdkDir: string | null = null
  const self = {
    connectionService: opts.conn,
    client: {
      app: {
        skills: async (args: { directory: string }) => {
          sdkCalls += 1
          sdkDir = args.directory
          if (opts.sdkImpl) return opts.sdkImpl(args)
          return { data: opts.sdkData ?? [] }
        },
      },
    },
    getWorkspaceDirectory: () => "/repo",
    cachedSkillsMessage: null as unknown,
    postMessage: (msg: unknown) => {
      posted.push(msg)
    },
  }
  return { self, posted, sdk: () => sdkCalls, sdkDir: () => sdkDir }
}

function okConnection(skills: unknown[] = [{ name: "demo", description: "d", location: "builtin" }]) {
  return {
    isPrivateAvailable: () => true,
    privateSkillListOutcomeWithHandle: (r: { requestId: string; opId: string; idempotencyKey: string }) => ({
      id: 1,
      promise: Promise.resolve({ kind: "valid", result: okResult(r, skills) }),
      cancel: () => true,
    }),
  }
}

describe("settings skills refresh is private-first", () => {
  test("private success posts safe projection with zero SDK and caches", async () => {
    const ordered = [
      { name: "b", description: "second", location: "builtin" },
      { name: "a", location: "/repo/.kilo/skills/a/SKILL.md" },
    ]
    const s = stub({ conn: okConnection(ordered) })
    await fetchAndSendSkills.call(s.self)
    expect(s.sdk()).toBe(0)
    expect(s.posted).toHaveLength(1)
    expect(s.posted[0]).toEqual({ type: "skillsLoaded", skills: ordered })
    expect(s.self.cachedSkillsMessage).toEqual({ type: "skillsLoaded", skills: ordered })
    expect(JSON.stringify(s.posted[0]).includes("content")).toBeFalse()
  })

  test("private empty success is authoritative with zero SDK", async () => {
    const s = stub({ conn: okConnection([]) })
    await fetchAndSendSkills.call(s.self)
    expect(s.sdk()).toBe(0)
    expect(s.posted).toEqual([{ type: "skillsLoaded", skills: [] }])
    expect(s.self.cachedSkillsMessage).toEqual({ type: "skillsLoaded", skills: [] })
  })

  test("failed/ambiguous/invalid/unavailable/transport/timeout each take exactly one same-directory SDK fallback", async () => {
    const sdkSkills = [{ name: "sdk", description: "d", location: "/repo/sdk/SKILL.md", content: "secret" }]
    const cases: Array<{ label: string; conn: unknown }> = [
      {
        label: "failed",
        conn: {
          isPrivateAvailable: () => true,
          privateSkillListOutcomeWithHandle: (r: { requestId: string; opId: string; idempotencyKey: string }) => ({
            id: 1,
            promise: Promise.resolve({ kind: "valid", result: failedResult(r) }),
            cancel: () => true,
          }),
        },
      },
      {
        label: "ambiguous",
        conn: {
          isPrivateAvailable: () => true,
          privateSkillListOutcomeWithHandle: (r: { requestId: string; opId: string; idempotencyKey: string }) => ({
            id: 1,
            promise: Promise.resolve({ kind: "valid", result: ambiguousResult(r) }),
            cancel: () => true,
          }),
        },
      },
      {
        label: "invalid",
        conn: {
          isPrivateAvailable: () => true,
          privateSkillListOutcomeWithHandle: () => ({
            id: 1,
            promise: Promise.resolve({ kind: "invalid", detail: "bad" }),
            cancel: () => true,
          }),
        },
      },
      {
        label: "unavailable",
        conn: {
          isPrivateAvailable: () => false,
          privateSkillListOutcomeWithHandle: () => {
            throw new Error("must not be called")
          },
        },
      },
      {
        label: "transport",
        conn: {
          isPrivateAvailable: () => true,
          privateSkillListOutcomeWithHandle: () => ({
            id: 1,
            promise: Promise.reject(new Error("Private peer unavailable")),
            cancel: () => true,
          }),
        },
      },
      {
        label: "timeout",
        conn: {
          isPrivateAvailable: () => true,
          privateSkillListOutcomeWithHandle: () => ({
            id: 1,
            promise: new Promise(() => {}),
            cancel: () => true,
          }),
        },
      },
    ]
    for (const c of cases) {
      const s = stub({ conn: c.conn, sdkData: sdkSkills as unknown[] })
      await fetchAndSendSkills.call(s.self)
      expect(s.sdk()).toBe(1)
      expect(s.sdkDir()).toBe("/repo")
      expect(s.posted).toHaveLength(1)
      const msg = s.posted[0] as { type: string; skills: unknown[] }
      expect(msg.type).toBe("skillsLoaded")
      // SDK content is projected away; location is preserved.
      expect(msg.skills).toEqual([{ name: "sdk", description: "d", location: "/repo/sdk/SKILL.md" }])
      expect(s.self.cachedSkillsMessage).toEqual(msg)
      expect(JSON.stringify(msg).includes("secret")).toBeFalse()
      expect(JSON.stringify(msg).includes("content")).toBeFalse()
    }
  })

  test("timeout cancels the pending private read by opId then falls back once", async () => {
    let cancelled: string | undefined
    let privateCalls = 0
    const conn = {
      isPrivateAvailable: () => true,
      privateSkillListOutcomeWithHandle: () => {
        privateCalls += 1
        return {
          id: 9,
          promise: new Promise(() => {}),
          cancel: (msg?: string) => {
            cancelled = msg
            return true
          },
        }
      },
    }
    const s = stub({ conn, sdkData: [] })
    await fetchAndSendSkills.call(s.self)
    expect(privateCalls).toBe(1)
    expect(cancelled).toContain("skill-list:")
    expect(s.sdk()).toBe(1)
  })

  test("epoch/closed transport maps to fallback with single SDK and no double calls", async () => {
    let privateCalls = 0
    const conn = {
      isPrivateAvailable: () => true,
      privateSkillListOutcomeWithHandle: () => {
        privateCalls += 1
        return {
          id: 1,
          promise: Promise.reject(new Error("Private peer closed")),
          cancel: () => true,
        }
      },
    }
    const s = stub({ conn, sdkData: [{ name: "sdk", location: "builtin", content: "x" }] as unknown[] })
    await fetchAndSendSkills.call(s.self)
    expect(privateCalls).toBe(1)
    expect(s.sdk()).toBe(1)
    expect(s.posted).toEqual([{ type: "skillsLoaded", skills: [{ name: "sdk", location: "builtin" }] }])
  })

  test("no client posts cached message and touches neither private nor SDK", async () => {
    const cached = { type: "skillsLoaded", skills: [{ name: "cached", location: "builtin" }] }
    const posted: unknown[] = []
    const self = {
      connectionService: okConnection(),
      client: null,
      getWorkspaceDirectory: () => "/repo",
      cachedSkillsMessage: cached,
      postMessage: (msg: unknown) => {
        posted.push(msg)
      },
    }
    await fetchAndSendSkills.call(self)
    expect(posted).toEqual([cached])
  })

  test("SDK retry semantics preserved on fallback", async () => {
    let sdkCalls = 0
    const conn = {
      isPrivateAvailable: () => false,
      privateSkillListOutcomeWithHandle: () => {
        throw new Error("must not be called")
      },
    }
    const posted: unknown[] = []
    const self = {
      connectionService: conn,
      client: {
        app: {
          skills: async () => {
            sdkCalls += 1
            if (sdkCalls < 3) throw new Error("load failed: transient")
            return { data: [{ name: "sdk", location: "builtin" }] }
          },
        },
      },
      getWorkspaceDirectory: () => "/repo",
      cachedSkillsMessage: null as unknown,
      postMessage: (msg: unknown) => {
        posted.push(msg)
      },
    }
    await fetchAndSendSkills.call(self)
    expect(sdkCalls).toBe(3)
    expect(posted).toEqual([{ type: "skillsLoaded", skills: [{ name: "sdk", location: "builtin" }] }])
  })
})
