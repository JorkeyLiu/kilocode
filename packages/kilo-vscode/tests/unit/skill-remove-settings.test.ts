import { describe, expect, test } from "bun:test"

// vscode mock is provided by the shared preload (tests/setup/vscode-mock.ts)
const { KiloProvider } = await import("../../src/KiloProvider")

type RemoveFn = (this: unknown, location: string) => Promise<boolean>

const removeSkillViaCli = KiloProvider.prototype["removeSkillViaCli"] as unknown as RemoveFn

function okResult(r: { requestId: string; opId: string; idempotencyKey: string }) {
  return {
    v: 1,
    requestId: r.requestId,
    opId: r.opId,
    op: "skill/remove",
    idempotencyKey: r.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: 1 },
    accepted: true,
    data: { removed: true },
  }
}

function failedResult(r: { requestId: string; opId: string; idempotencyKey: string }, code: string) {
  return {
    v: 1,
    requestId: r.requestId,
    opId: r.opId,
    op: "skill/remove",
    idempotencyKey: r.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time: 1, failure: { code, message: "m", retryable: false } },
    accepted: false,
    failure: { code, message: "m", retryable: false },
  }
}

function stub(conn: unknown) {
  const calls: string[] = []
  let cleared = false
  let sdkUsed = false
  const self = {
    connectionService: conn,
    // SDK trap: the private-only path must never touch the SDK mutation.
    client: {
      kilocode: {
        removeSkill: async () => {
          sdkUsed = true
          return { data: true }
        },
      },
    },
    getWorkspaceDirectory: () => "/repo",
    cachedSkillsMessage: { type: "skillsLoaded" } as unknown,
    cachedCommandsMessage: null as unknown,
    clearCommandsCache() {
      ;(self as { cachedCommandsMessage: unknown }).cachedCommandsMessage = null
    },
    async fetchAndSendSkills() {
      calls.push("skills")
    },
    async fetchAndSendCommands() {
      calls.push("commands")
    },
    requirements: {
      clear() {
        cleared = true
      },
    },
  }
  return { self, calls, sdk: () => sdkUsed, cleared: () => cleared }
}

function okConnection() {
  return {
    isPrivateAvailable: () => true,
    privateSkillRemoveOutcomeWithHandle: (r: { requestId: string; opId: string; idempotencyKey: string }) => ({
      id: 1,
      promise: Promise.resolve({ kind: "valid", result: okResult(r) }),
      cancel: () => true,
    }),
  }
}

function failedConnection(code: string) {
  return {
    isPrivateAvailable: () => true,
    privateSkillRemoveOutcomeWithHandle: (r: { requestId: string; opId: string; idempotencyKey: string }) => ({
      id: 2,
      promise: Promise.resolve({ kind: "valid", result: failedResult(r, code) }),
      cancel: () => true,
    }),
  }
}

describe("settings skill removal is private-only", () => {
  test("private success refreshes and clears without SDK", async () => {
    const s = stub(okConnection())
    const out = await removeSkillViaCli.call(s.self, "/repo/.kilo/skills/demo/SKILL.md")
    expect(out).toBe(true)
    expect(s.calls).toEqual(["skills", "commands"])
    expect(s.cleared()).toBe(true)
    expect(s.sdk()).toBe(false)
  })

  test("actionable failures refresh without SDK and keep requirements", async () => {
    for (const code of ["skill.builtin", "skill.url", "skill.not_found"]) {
      const s = stub(failedConnection(code))
      const out = await removeSkillViaCli.call(s.self, "/repo/.kilo/skills/demo/SKILL.md")
      expect(out).toBe(false)
      expect(s.calls).toEqual(["skills", "commands"])
      expect(s.cleared()).toBe(false)
      expect(s.sdk()).toBe(false)
    }
  })

  test("unavailable private closes with refresh and no SDK", async () => {
    const s = stub({
      isPrivateAvailable: () => false,
      privateSkillRemoveOutcomeWithHandle: () => {
        throw new Error("must not be called")
      },
    })
    const out = await removeSkillViaCli.call(s.self, "/repo/.kilo/skills/demo/SKILL.md")
    expect(out).toBe(false)
    expect(s.calls).toEqual(["skills", "commands"])
    expect(s.sdk()).toBe(false)
  })
})
