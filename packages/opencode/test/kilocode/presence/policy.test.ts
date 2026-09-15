import { describe, expect, test } from "bun:test"
import {
  CLI_SESSION_PREFIX,
  MAX_CONTEXT_LENGTH,
  MAX_SESSION_ID_LENGTH,
  cliSessionContext,
  platformContext,
} from "../../../src/kilocode/presence/context"
import {
  attachedUnion,
  dedupe,
  desiredContexts,
  expiredViewerIds,
  nextExpiryDeadline,
  reconcileContexts,
  validateSnapshot,
  visibleUnion,
  type ViewerState,
} from "../../../src/kilocode/presence/policy"

const UUID = "00000000-0000-4000-8000-000000000000"

describe("presence context builders", () => {
  test("platformContext maps a platform to its presence context", () => {
    expect(platformContext("cli")).toBe("/presence/cli")
    expect(platformContext("vscode")).toBe("/presence/vscode")
  })

  test("cliSessionContext prefixes the session id", () => {
    expect(cliSessionContext("ses_123")).toBe("/presence/cli-session/ses_123")
  })

  test("CLI_SESSION_PREFIX is 22 chars and the budget derivation holds", () => {
    expect(CLI_SESSION_PREFIX.length).toBe(22)
    expect(MAX_CONTEXT_LENGTH - CLI_SESSION_PREFIX.length).toBe(MAX_SESSION_ID_LENGTH)
    expect(MAX_SESSION_ID_LENGTH).toBe(234)
  })

  test("session id budget lands exactly on the 256-char context limit", () => {
    expect(cliSessionContext("x".repeat(234)).length).toBe(256)
    expect(cliSessionContext("x".repeat(235)).length).toBe(257)
  })
})

describe("dedupe", () => {
  test("preserves first-seen order and drops duplicates", () => {
    expect(dedupe(["a", "b", "a", "c", "b"])).toEqual(["a", "b", "c"])
    expect(dedupe([])).toEqual([])
    expect(dedupe(["x", "x"])).toEqual(["x"])
  })
})

describe("validateSnapshot", () => {
  test("accepts a well-formed snapshot and dedupes arrays", () => {
    const r = validateSnapshot({
      viewer: { id: UUID, active: true, sequence: 1 },
      attached: ["ses_s1", "ses_s1", "ses_s2"],
      visible: ["ses_v1", "ses_v1"],
    })
    expect(r).toEqual({ ok: true, viewer: { id: UUID, active: true, sequence: 1 }, attached: ["ses_s1", "ses_s2"], visible: ["ses_v1"] })
  })

  test("missing viewer yields missing_viewer", () => {
    expect(validateSnapshot({})).toEqual({ ok: false, error: { kind: "missing_viewer" } })
    expect(validateSnapshot({ viewer: undefined })).toEqual({ ok: false, error: { kind: "missing_viewer" } })
  })

  test("non-UUID viewer id yields bad_viewer_id", () => {
    expect(validateSnapshot({ viewer: { id: "not-a-uuid", sequence: 1 } })).toEqual({ ok: false, error: { kind: "bad_viewer_id" } })
    expect(validateSnapshot({ viewer: { id: "", sequence: 1 } })).toEqual({ ok: false, error: { kind: "bad_viewer_id" } })
  })

  test("UUID with an invalid variant nibble yields bad_viewer_id", () => {
    expect(validateSnapshot({ viewer: { id: "11111111-1111-1111-1111-111111111111", sequence: 1 } })).toEqual({
      ok: false,
      error: { kind: "bad_viewer_id" },
    })
  })

  test("missing sequence yields missing_sequence", () => {
    expect(validateSnapshot({ viewer: { id: UUID } })).toEqual({ ok: false, error: { kind: "missing_sequence" } })
    expect(validateSnapshot({ viewer: { id: UUID, active: true } })).toEqual({ ok: false, error: { kind: "missing_sequence" } })
  })

  test("non-integer or negative sequence yields bad_sequence", () => {
    expect(validateSnapshot({ viewer: { id: UUID, sequence: -1 } })).toEqual({ ok: false, error: { kind: "bad_sequence" } })
    expect(validateSnapshot({ viewer: { id: UUID, sequence: 1.5 } })).toEqual({ ok: false, error: { kind: "bad_sequence" } })
    expect(validateSnapshot({ viewer: { id: UUID, sequence: "1" } })).toEqual({ ok: false, error: { kind: "bad_sequence" } })
    expect(validateSnapshot({ viewer: { id: UUID, sequence: Number.MAX_SAFE_INTEGER + 1 } })).toEqual({
      ok: false,
      error: { kind: "bad_sequence" },
    })
  })

  test("zero sequence is accepted", () => {
    const r = validateSnapshot({ viewer: { id: UUID, sequence: 0 }, attached: [], visible: [] })
    expect(r).toEqual({ ok: true, viewer: { id: UUID, active: false, sequence: 0 }, attached: [], visible: [] })
  })

  test("session id missing the ses prefix yields bad_session_id", () => {
    expect(validateSnapshot({ viewer: { id: UUID, sequence: 1 }, attached: ["no-prefix"] })).toEqual({
      ok: false,
      error: { kind: "bad_session_id", id: "no-prefix" },
    })
  })

  test("attached over the per-viewer cap yields attached_too_many", () => {
    const attached = Array.from({ length: 1001 }, (_, i) => `ses_${i}`)
    expect(validateSnapshot({ viewer: { id: UUID, sequence: 1 }, attached })).toEqual({
      ok: false,
      error: { kind: "attached_too_many" },
    })
  })

  test("visible over the per-viewer cap yields visible_too_many", () => {
    const visible = Array.from({ length: 200 }, (_, i) => `ses_${i}`)
    expect(validateSnapshot({ viewer: { id: UUID, sequence: 1 }, visible })).toEqual({
      ok: false,
      error: { kind: "visible_too_many" },
    })
  })

  test("oversized session id yields bad_session_id with the offending id", () => {
    const long = "ses_" + "x".repeat(231)
    expect(validateSnapshot({ viewer: { id: UUID, sequence: 1 }, attached: [long] })).toEqual({
      ok: false,
      error: { kind: "bad_session_id", id: long },
    })
  })

  test("active is coerced strictly to a boolean", () => {
    const t = validateSnapshot({ viewer: { id: UUID, active: true, sequence: 1 }, attached: [], visible: [] })
    expect(t.ok && t.viewer.active).toBe(true)
    const str = validateSnapshot({ viewer: { id: UUID, active: "true", sequence: 1 }, attached: [], visible: [] })
    expect(str.ok && str.viewer.active).toBe(false)
  })

  test("non-array attached and visible coerce to empty arrays", () => {
    expect(validateSnapshot({ viewer: { id: UUID, sequence: 2 }, attached: null, visible: 42 })).toEqual({
      ok: true,
      viewer: { id: UUID, active: false, sequence: 2 },
      attached: [],
      visible: [],
    })
  })
})

describe("attachedUnion", () => {
  test("unions attached across viewers including inactive ones", () => {
    const viewers: ViewerState[] = [
      { id: "u1", active: true, sequence: 1, attached: ["a", "b"], visible: [], lastSeen: 0 },
      { id: "u2", active: false, sequence: 1, attached: ["b", "c"], visible: [], lastSeen: 0 },
    ]
    expect(attachedUnion(viewers)).toEqual(["a", "b", "c"])
  })
})

describe("visibleUnion", () => {
  test("only active viewers contribute, deduped and capped at 199", () => {
    const ids = Array.from({ length: 201 }, (_, i) => `s${String(i).padStart(4, "0")}`)
    const viewers: ViewerState[] = [
      { id: "u1", active: true, sequence: 1, attached: [], visible: ids, lastSeen: 0 },
      { id: "u2", active: false, sequence: 1, attached: [], visible: ["z_hidden"], lastSeen: 0 },
    ]
    const r = visibleUnion(viewers)
    expect(r.ids.length).toBe(199)
    expect(r.omitted).toBe(2)
    expect(r.ids).not.toContain("z_hidden")
    const sorted = [...ids].sort()
    expect(r.ids).toEqual(sorted.slice(0, 199))
  })
})

describe("expiredViewerIds", () => {
  test("expires at exactly lastSeen + TTL and not one ms earlier", () => {
    const now = 1_000_000
    const viewers: ViewerState[] = [
      { id: "expired", active: true, sequence: 1, attached: [], visible: [], lastSeen: now - 120_000 },
      { id: "alive", active: true, sequence: 1, attached: [], visible: [], lastSeen: now - 119_999 },
    ]
    expect(expiredViewerIds(viewers, now)).toEqual(["expired"])
  })
})

describe("nextExpiryDeadline", () => {
  test("returns the earliest future deadline", () => {
    const now = 1_000_000
    const viewers: ViewerState[] = [
      { id: "a", active: true, sequence: 1, attached: [], visible: [], lastSeen: now - 50_000 },
      { id: "b", active: true, sequence: 1, attached: [], visible: [], lastSeen: now - 10_000 },
    ]
    expect(nextExpiryDeadline(viewers, now)).toBe(now + 70_000)
  })

  test("returns undefined when all viewers are expired", () => {
    const now = 1_000_000
    const viewers: ViewerState[] = [
      { id: "a", active: true, sequence: 1, attached: [], visible: [], lastSeen: now - 120_000 },
    ]
    expect(nextExpiryDeadline(viewers, now)).toBeUndefined()
  })

  test("returns undefined for no viewers", () => {
    expect(nextExpiryDeadline([], 0)).toBeUndefined()
  })
})

describe("reconcileContexts", () => {
  test("removals are prev minus next, additions are next minus prev", () => {
    const prev = new Set(["a", "b", "c"])
    const next = new Set(["b", "c", "d"])
    expect(reconcileContexts(prev, next)).toEqual({ remove: ["a"], add: ["d"] })
  })
})

describe("desiredContexts", () => {
  test("active includes platform context plus each visible session context", () => {
    const ctx = desiredContexts("cli", true, ["s1", "s2"])
    expect(ctx.size).toBe(3)
    expect(ctx.has("/presence/cli")).toBe(true)
    expect(ctx.has("/presence/cli-session/s1")).toBe(true)
    expect(ctx.has("/presence/cli-session/s2")).toBe(true)
  })

  test("inactive omits platform context but keeps session contexts", () => {
    const ctx = desiredContexts("vscode", false, ["s1"])
    expect(ctx.size).toBe(1)
    expect(ctx.has("/presence/vscode")).toBe(false)
    expect(ctx.has("/presence/cli-session/s1")).toBe(true)
  })
})
