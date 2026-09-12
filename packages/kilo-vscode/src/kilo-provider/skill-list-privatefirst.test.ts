import { describe, expect, test } from "bun:test"
import {
  attemptSkillListPrivate,
  buildSkillListPrivateIdentity,
  buildSkillListPrivateReq,
  parseSkillListPrivateResult,
} from "./skill-list-privatefirst"
import { canonicalSkillListOpId } from "../services/cli-backend/serve-private-skill-list-contract"
import { loadSkills } from "./skills"

function entries() {
  return [
    { name: "demo", description: "demo skill", location: "builtin" },
    { name: "review", location: "/repo/.kilo/skills/review/SKILL.md" },
  ]
}

function req() {
  return buildSkillListPrivateReq("/tmp/skilllist")
}

function okFor(r: ReturnType<typeof req>, skills: unknown[] = entries()) {
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

function failedFor(r: ReturnType<typeof req>, code = "validation.failed") {
  return {
    v: 1,
    requestId: r.requestId,
    opId: r.opId,
    op: "skill/list",
    idempotencyKey: r.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time: 1, failure: { code, message: "bad", retryable: false } },
    accepted: false,
    failure: { code, message: "bad", retryable: false },
  }
}

function retryableFor(r: ReturnType<typeof req>) {
  return {
    v: 1,
    requestId: r.requestId,
    opId: r.opId,
    op: "skill/list",
    idempotencyKey: r.idempotencyKey,
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

function ambiguousFor(r: ReturnType<typeof req>) {
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

function connFor(result: (q: ReturnType<typeof req>) => unknown, id = 1) {
  return {
    isPrivateAvailable: () => true,
    privateSkillListOutcomeWithHandle: (q: ReturnType<typeof req>) => ({
      id,
      promise: Promise.resolve({ kind: "valid", result: result(q) }),
      cancel: () => true,
    }),
  }
}

describe("skill-list private-first", () => {
  test("identity binds canonical skill-list tuple", () => {
    const { opId, idempotencyKey, requestId } = buildSkillListPrivateIdentity()
    expect(opId).toBe(idempotencyKey)
    expect(opId.startsWith("skill-list:")).toBeTrue()
    const token = opId.split(":")[1]!
    expect(canonicalSkillListOpId(token)).toBe(opId)
    expect(typeof requestId).toBe("string")
  })

  test("succeeded accepted parses ok preserving carrier order including empty", () => {
    const r = req()
    const ordered = [
      { name: "b", location: "builtin" },
      { name: "a", description: "first", location: "builtin" },
    ]
    const parsed = parseSkillListPrivateResult(okFor(r, ordered), r)
    expect(parsed.kind).toBe("ok")
    if (parsed.kind === "ok") expect(parsed.skills).toEqual(ordered)
    const empty = parseSkillListPrivateResult(okFor(r, []), r)
    expect(empty.kind).toBe("ok")
    if (empty.kind === "ok") expect(empty.skills).toEqual([])
  })

  test("every failed result is fallback-eligible with no terminal", async () => {
    for (const code of ["validation.failed", "scope_mismatch", "internal", "InstanceUnavailableDuringConfigRebuild"]) {
      const r = req()
      const out = await attemptSkillListPrivate(connFor((q) => failedFor(q, code)) as never, r)
      expect(out.kind).toBe("fallback")
    }
    const r = req()
    expect((await attemptSkillListPrivate(connFor((q) => retryableFor(q)) as never, r)).kind).toBe("fallback")
  })

  test("unavailable/failed/ambiguous/invalid/transport/closed/timeout are fallback-eligible", async () => {
    const r1 = req()
    const unavailable = {
      isPrivateAvailable: () => false,
      privateSkillListOutcomeWithHandle: () => {
        throw new Error("must not be called")
      },
    }
    expect((await attemptSkillListPrivate(unavailable as never, r1)).kind).toBe("fallback")

    const r2 = req()
    const ambiguous = connFor((q) => ambiguousFor(q))
    expect((await attemptSkillListPrivate(ambiguous as never, r2)).kind).toBe("fallback")

    const r3 = req()
    const invalid = {
      isPrivateAvailable: () => true,
      privateSkillListOutcomeWithHandle: () => ({
        id: 3,
        promise: Promise.resolve({ kind: "invalid", detail: "bad" }),
        cancel: () => true,
      }),
    }
    expect((await attemptSkillListPrivate(invalid as never, r3)).kind).toBe("fallback")

    const r4 = req()
    const transport = {
      isPrivateAvailable: () => true,
      privateSkillListOutcomeWithHandle: () => ({
        id: 4,
        promise: Promise.reject(new Error("Private peer unavailable")),
        cancel: () => true,
      }),
    }
    expect((await attemptSkillListPrivate(transport as never, r4)).kind).toBe("fallback")

    const r5 = req()
    const hanging = {
      isPrivateAvailable: () => true,
      privateSkillListOutcomeWithHandle: () => ({
        id: 5,
        promise: new Promise(() => {}),
        cancel: () => true,
      }),
    }
    expect((await attemptSkillListPrivate(hanging as never, r5, 10)).kind).toBe("fallback")

    // Transport-synthesized failed (fixed redacted message) falls back, never terminal.
    const r6 = req()
    const transportFailed = connFor((q) => ({
      v: 1,
      requestId: q.requestId,
      opId: q.opId,
      op: "skill/list",
      idempotencyKey: q.idempotencyKey,
      status: "failed",
      outcome: {
        type: "failed",
        time: 1,
        failure: { code: "-32603", message: "private skill-list transport failed", retryable: false },
      },
      accepted: false,
      failure: { code: "-32603", message: "private skill-list transport failed", retryable: false },
    }))
    expect((await attemptSkillListPrivate(transportFailed as never, r6)).kind).toBe("fallback")
  })

  test("timeout exact-cancels the pending by id", async () => {
    const r = req()
    let cancelled: unknown[] = []
    const hanging = {
      isPrivateAvailable: () => true,
      privateSkillListOutcomeWithHandle: () => ({
        id: 42,
        promise: new Promise(() => {}),
        cancel: (msg?: string) => {
          cancelled.push(msg)
          return true
        },
      }),
    }
    const out = await attemptSkillListPrivate(hanging as never, r, 10)
    expect(out).toEqual({ kind: "fallback", reason: "timeout" })
    expect(cancelled.length).toBe(1)
    expect(String(cancelled[0]).includes(r.opId)).toBeTrue()
  })

  test("private success incl empty returns zero SDK with exact safe shape/order and no content", async () => {
    for (const ordered of [
      [
        { name: "b", description: "second", location: "builtin" },
        { name: "review", location: "/repo/.kilo/skills/review/SKILL.md" },
      ],
      [],
    ]) {
      let sdkCalls = 0
      const client = {
        app: {
          skills: async () => {
            sdkCalls += 1
            return { data: entries() }
          },
        },
      } as never
      const conn = connFor((q) => okFor(q, ordered))
      const message = (await loadSkills(client, "/tmp/skilllist-ok", conn)) as {
        type: string
        skills: unknown[]
      }
      expect(message.type).toBe("skillsLoaded")
      expect(message.skills).toEqual(ordered)
      expect(sdkCalls).toBe(0)
      expect(JSON.stringify(message).includes("content")).toBeFalse()
    }
  })

  test("failed/unavailable/invalid/ambiguous/transport/timeout take exactly one SDK fallback with safe projection", async () => {
    const cases: Array<{ label: string; conn: unknown; r: string }> = []
    cases.push({ label: "failed", conn: connFor((q) => failedFor(q, "validation.failed")), r: "/tmp/skilllist-fb-failed" })
    cases.push({ label: "retryable", conn: connFor((q) => retryableFor(q)), r: "/tmp/skilllist-fb-retryable" })
    cases.push({
      label: "unavailable",
      conn: {
        isPrivateAvailable: () => false,
        privateSkillListOutcomeWithHandle: () => {
          throw new Error("must not be called")
        },
      },
      r: "/tmp/skilllist-fb-unavailable",
    })
    cases.push({
      label: "invalid",
      conn: {
        isPrivateAvailable: () => true,
        privateSkillListOutcomeWithHandle: () => ({
          id: 1,
          promise: Promise.resolve({ kind: "invalid", detail: "bad" }),
          cancel: () => true,
        }),
      },
      r: "/tmp/skilllist-fb-invalid",
    })
    cases.push({ label: "ambiguous", conn: connFor((q) => ambiguousFor(q)), r: "/tmp/skilllist-fb-ambiguous" })
    cases.push({
      label: "transport",
      conn: {
        isPrivateAvailable: () => true,
        privateSkillListOutcomeWithHandle: () => ({
          id: 1,
          promise: Promise.reject(new Error("Private peer unavailable")),
          cancel: () => true,
        }),
      },
      r: "/tmp/skilllist-fb-transport",
    })
    cases.push({
      label: "timeout",
      conn: {
        isPrivateAvailable: () => true,
        privateSkillListOutcomeWithHandle: () => ({
          id: 1,
          promise: new Promise(() => {}),
          cancel: () => true,
        }),
      },
      r: "/tmp/skilllist-fb-timeout",
    })
    for (const c of cases) {
      let sdkCalls = 0
      const client = {
        app: {
          skills: async (args: { directory: string }) => {
            sdkCalls += 1
            expect(args.directory).toBe(c.r)
            return { data: entries().map((e) => ({ ...e, content: "secret body", extra: 1 })) }
          },
        },
      } as never
      const message = (await loadSkills(client, c.r, c.conn)) as { type: string; skills: unknown[] }
      expect(message.type).toBe("skillsLoaded")
      expect(message.skills).toEqual(entries())
      expect(sdkCalls).toBe(1)
      expect(JSON.stringify(message).includes("secret body")).toBeFalse()
      expect(JSON.stringify(message).includes("content")).toBeFalse()
    }
  })

  test("SDK retry behavior preserved on fallback", async () => {
    let sdkCalls = 0
    const client = {
      app: {
        skills: async () => {
          sdkCalls += 1
          if (sdkCalls < 3) throw new Error("load failed: transient boom")
          return { data: entries() }
        },
      },
    } as never
    const conn = {
      isPrivateAvailable: () => false,
      privateSkillListOutcomeWithHandle: () => {
        throw new Error("must not be called")
      },
    }
    const message = (await loadSkills(client, "/tmp/skilllist-retry", conn)) as { skills: unknown[] }
    expect(message.skills).toEqual(entries())
    expect(sdkCalls).toBe(3)
  })

  test("SDK result projected to safe shape before return with location preserved", async () => {
    const client = {
      app: {
        skills: async () => ({
          data: [{ name: "demo", description: "d", location: "/repo/skill/SKILL.md", content: "body", file: "bytes" }],
        }),
      },
    } as never
    const conn = {
      isPrivateAvailable: () => false,
      privateSkillListOutcomeWithHandle: () => {
        throw new Error("must not be called")
      },
    }
    const message = (await loadSkills(client, "/tmp/skilllist-projection", conn)) as { skills: unknown[] }
    expect(message.skills).toEqual([{ name: "demo", description: "d", location: "/repo/skill/SKILL.md" }])
  })
})
