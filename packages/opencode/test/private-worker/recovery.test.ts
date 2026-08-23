import { describe, it, expect } from "bun:test"
import {
  RECOVERY_VERSION,
  OP_KINDS,
  OWNERS,
  SCOPES,
  PROVENANCES,
  LAYERS,
  TERMINATIONS,
  create,
  charge,
  terminate,
  snapshot,
  parseOpId,
  validateRecord,
  isTerminated,
  isBudgetExhausted,
  type RecoveryRecord,
} from "../../src/private-worker/recovery"

function promptOp() {
  return { opId: "prompt:msg1", opKind: "prompt" as const }
}
function providerOp() {
  return { opId: "provider:assistant1:0", opKind: "provider" as const }
}
function toolOp() {
  return { opId: "tool:assistant1:callA", opKind: "tool" as const }
}
function permissionOp() {
  return { opId: "permission:req1", opKind: "permission" as const }
}
function taskOp() {
  return { opId: "task:ses1", opKind: "task" as const }
}
function taskOp2() {
  return { opId: "task:ses1:callB", opKind: "task" as const }
}

describe("R13 closed sets", () => {
  it("exact membership", () => {
    expect(RECOVERY_VERSION).toBe("1.0")
    expect([...OP_KINDS]).toEqual(["prompt", "provider", "tool", "permission", "task"])
    expect([...OWNERS]).toEqual(["runtime"])
    expect([...SCOPES]).toEqual(["operation"])
    expect([...PROVENANCES]).toEqual(["runtime", "user", "offline-restore"])
    expect([...LAYERS]).toEqual(["semantic", "sdk", "provider", "transport", "task"])
    expect([...TERMINATIONS]).toEqual(["budget-exhausted", "non-retryable", "replay-unsafe", "cancelled", "completed"])
  })
})

describe("R13 five R11 identity forms", () => {
  it("all five kinds create and validate", () => {
    const ops = [promptOp(), providerOp(), toolOp(), permissionOp(), taskOp(), taskOp2()]
    for (const op of ops) {
      const rec = create({ opId: op.opId, opKind: op.opKind, limit: 3 })
      expect(rec.opId).toBe(op.opId)
      expect(rec.opKind).toBe(op.opKind)
      expect(rec.owner).toBe("runtime")
      expect(rec.scope).toBe("operation")
      expect(rec.version).toBe("1.0")
      validateRecord(rec)
      const parsed = parseOpId(op.opId)
      expect(parsed.kind).toBe(op.opKind)
    }
  })

  it("rejects mismatched opId/opKind", () => {
    expect(() => create({ opId: "prompt:msg1", opKind: "tool", limit: 1 })).toThrow(TypeError)
    expect(() => create({ opId: "provider:assistant1:0", opKind: "prompt", limit: 1 })).toThrow(TypeError)
  })

  it("rejects invalid opId forms", () => {
    expect(() => create({ opId: "prompt:", opKind: "prompt", limit: 1 })).toThrow(TypeError)
    expect(() => create({ opId: "provider:assistant1:bad", opKind: "provider", limit: 1 })).toThrow(TypeError)
    expect(() => create({ opId: "tool:onlyone", opKind: "tool", limit: 1 })).toThrow(TypeError)
    expect(() => create({ opId: "permission:", opKind: "permission", limit: 1 })).toThrow(TypeError)
    expect(() => create({ opId: "task:", opKind: "task", limit: 1 })).toThrow(TypeError)
    expect(() => create({ opId: "prompt:msg:extra", opKind: "prompt", limit: 1 })).toThrow(TypeError)
    expect(() => create({ opId: "bad:seg", opKind: "prompt" as unknown as typeof OP_KINDS[number], limit: 1 })).toThrow(TypeError)
  })

  it("rejects extra fields and invalid limit", () => {
    expect(() => create({ opId: "prompt:msg1", opKind: "prompt", limit: 1.5 })).toThrow(TypeError)
    expect(() => create({ opId: "prompt:msg1", opKind: "prompt", limit: -1 })).toThrow(TypeError)
    expect(() => create({ opId: "prompt:msg1", opKind: "prompt", limit: NaN })).toThrow(TypeError)
    expect(() => create({ opId: "prompt:msg1", opKind: "prompt", limit: 1, extra: 1 } as unknown as Parameters<typeof create>[0])).toThrow(TypeError)
  })
})

describe("R13 immutable/idempotent charging", () => {
  it("charge increments consumed exactly once and is immutable", () => {
    const rec = create({ opId: "prompt:msgA", opKind: "prompt", limit: 3 })
    const charged = charge(rec, { id: "a1", time: 100, provenance: "runtime", layer: "semantic" })
    expect(charged.consumed).toBe(1)
    expect(charged.attempts.length).toBe(1)
    expect(rec.consumed).toBe(0)
    expect(rec.attempts.length).toBe(0)
    // original not mutated
    expect(rec.nextAt).toBeUndefined()
    // frozen
    expect(Object.isFrozen(charged)).toBe(true)
    expect(Object.isFrozen(charged.attempts)).toBe(true)
  })

  it("idempotent duplicate returns same accounting without extra consume", () => {
    const rec = create({ opId: "prompt:msgA", opKind: "prompt", limit: 3 })
    const c1 = charge(rec, { id: "a1", time: 100, provenance: "runtime", layer: "semantic" })
    const c2 = charge(c1, { id: "a1", time: 100, provenance: "runtime", layer: "semantic" })
    expect(c2).toBe(c1)
    expect(c2.consumed).toBe(1)
    expect(c2.attempts.length).toBe(1)
  })

  it("conflicting duplicate rejects", () => {
    const rec = create({ opId: "prompt:msgA", opKind: "prompt", limit: 3 })
    const c1 = charge(rec, { id: "a1", time: 100, provenance: "runtime", layer: "semantic" })
    expect(() => charge(c1, { id: "a1", time: 101, provenance: "runtime", layer: "semantic" })).toThrow(TypeError)
    expect(() => charge(c1, { id: "a1", time: 100, provenance: "user", layer: "semantic" })).toThrow(TypeError)
    expect(() => charge(c1, { id: "a1", time: 100, provenance: "runtime", layer: "provider" })).toThrow(TypeError)
  })

  it("nextAt conflict on same id rejects", () => {
    const rec = create({ opId: "prompt:msgA", opKind: "prompt", limit: 3 })
    const c1 = charge(rec, { id: "a1", time: 100, provenance: "runtime", layer: "semantic", nextAt: 200, replaySafe: true })
    expect(() => charge(c1, { id: "a1", time: 100, provenance: "runtime", layer: "semantic" })).toThrow(TypeError)
  })

  it("charge validates closed provenance/layer", () => {
    const rec = create({ opId: "prompt:msgA", opKind: "prompt", limit: 3 })
    expect(() => charge(rec, { id: "a1", time: 100, provenance: "bad" as unknown as typeof PROVENANCES[number], layer: "semantic" })).toThrow(TypeError)
    expect(() => charge(rec, { id: "a1", time: 100, provenance: "runtime", layer: "bad" as unknown as typeof LAYERS[number] })).toThrow(TypeError)
  })
})

describe("R13 nested low-level visibility and shared consumption", () => {
  it("semantic and nested attempts share one budget and are visible", () => {
    const rec = create({ opId: "provider:assistant1:0", opKind: "provider", limit: 5 })
    const c1 = charge(rec, { id: "s1", time: 10, provenance: "runtime", layer: "semantic" })
    const c2 = charge(c1, { id: "sdk1", time: 11, provenance: "runtime", layer: "sdk" })
    const c3 = charge(c2, { id: "prov1", time: 12, provenance: "runtime", layer: "provider" })
    const c4 = charge(c3, { id: "trans1", time: 13, provenance: "runtime", layer: "transport" })
    const c5 = charge(c4, { id: "task1", time: 14, provenance: "runtime", layer: "task" })
    expect(c5.consumed).toBe(5)
    expect(c5.attempts.map((a) => a.layer)).toEqual(["semantic", "sdk", "provider", "transport", "task"])
    // all provenances visible, nested flag implicit via layer !== semantic
    expect(c5.attempts.every((a) => typeof a.id === "string")).toBe(true)
  })

  it("budget enforcement applies across layers", () => {
    const rec = create({ opId: "prompt:msgB", opKind: "prompt", limit: 2 })
    const c1 = charge(rec, { id: "s1", time: 1, provenance: "runtime", layer: "semantic" })
    const c2 = charge(c1, { id: "sdk1", time: 2, provenance: "runtime", layer: "sdk" })
    expect(c2.consumed).toBe(2)
    expect(() => charge(c2, { id: "x", time: 3, provenance: "runtime", layer: "provider" })).toThrow(TypeError)
  })
})

describe("R13 provenance", () => {
  it("runtime/user/offline-restore all accepted and preserved", () => {
    const rec = create({ opId: "prompt:msgC", opKind: "prompt", limit: 5 })
    const c1 = charge(rec, { id: "a1", time: 1, provenance: "runtime", layer: "semantic" })
    const c2 = charge(c1, { id: "a2", time: 2, provenance: "user", layer: "semantic" })
    const c3 = charge(c2, { id: "a3", time: 3, provenance: "offline-restore", layer: "semantic" })
    expect(c3.attempts.map((a) => a.provenance)).toEqual(["runtime", "user", "offline-restore"])
    const snap = snapshot(c3)
    expect(snap.attempts.map((a) => a.provenance)).toEqual(["runtime", "user", "offline-restore"])
  })
})

describe("R13 occurrence-vs-nextAt", () => {
  it("time preserved verbatim, nextAt must be >= time", () => {
    const rec = create({ opId: "prompt:msgD", opKind: "prompt", limit: 3 })
    const c1 = charge(rec, { id: "a1", time: 123.5, provenance: "runtime", layer: "semantic", nextAt: 200, replaySafe: true })
    expect(c1.attempts[0]!.time).toBe(123.5)
    expect(c1.nextAt).toBe(200)
    expect(c1.attempts[0]!.nextAt).toBe(200)
    expect(() => charge(c1, { id: "a2", time: 300, provenance: "runtime", layer: "semantic", nextAt: 299, replaySafe: true })).toThrow(TypeError)
    expect(() => charge(c1, { id: "a2", time: NaN, provenance: "runtime", layer: "semantic" })).toThrow(TypeError)
  })

  it("nextAt requires explicit replaySafe", () => {
    const rec = create({ opId: "prompt:msgD", opKind: "prompt", limit: 3 })
    expect(() => charge(rec, { id: "a1", time: 100, provenance: "runtime", layer: "semantic", nextAt: 200 })).toThrow(TypeError)
    expect(() => charge(rec, { id: "a1", time: 100, provenance: "runtime", layer: "semantic", nextAt: 200, replaySafe: false })).toThrow(TypeError)
  })

  it("charge without nextAt clears previous nextAt", () => {
    const rec = create({ opId: "prompt:msgE", opKind: "prompt", limit: 3 })
    const c1 = charge(rec, { id: "a1", time: 10, provenance: "runtime", layer: "semantic", nextAt: 20, replaySafe: true })
    expect(c1.nextAt).toBe(20)
    const c2 = charge(c1, { id: "a2", time: 21, provenance: "runtime", layer: "semantic" })
    expect(c2.nextAt).toBeUndefined()
  })

  it("no clock embedded: caller supplies times", () => {
    const src = awaitReadFile()
    expect(src).not.toContain("Date.now")
    expect(src).not.toContain("setTimeout")
    expect(src).not.toContain("setInterval")
  })
})

describe("R13 unsafe replay termination", () => {
  it("replay-unsafe termination clears nextAt and prevents further charge", () => {
    const rec = create({ opId: "prompt:msgF", opKind: "prompt", limit: 5 })
    const c1 = charge(rec, { id: "a1", time: 10, provenance: "runtime", layer: "semantic", nextAt: 20, replaySafe: true })
    expect(c1.nextAt).toBe(20)
    const t = terminate(c1, { reason: "replay-unsafe", time: 15 })
    expect(t.terminated!.reason).toBe("replay-unsafe")
    expect(t.nextAt).toBeUndefined()
    expect(() => charge(t, { id: "a2", time: 30, provenance: "runtime", layer: "semantic" })).toThrow(TypeError)
  })

  it("termination is required for unsafe replay; charge with unsafe nextAt is rejected not auto-terminated", () => {
    const rec = create({ opId: "prompt:msgF", opKind: "prompt", limit: 5 })
    expect(() => charge(rec, { id: "a1", time: 10, provenance: "runtime", layer: "semantic", nextAt: 20, replaySafe: false })).toThrow(TypeError)
    // must explicitly terminate
    const t = terminate(rec, { reason: "replay-unsafe", time: 11 })
    expect(t.terminated!.reason).toBe("replay-unsafe")
  })
})

describe("R13 budget exhaustion/no overrun", () => {
  it("limit=0: any charge is budget exhausted and consumed stays 0", () => {
    const rec = create({ opId: "prompt:msgZero", opKind: "prompt", limit: 0 })
    expect(rec.consumed).toBe(0)
    expect(isBudgetExhausted(rec)).toBe(true)
    expect(() => charge(rec, { id: "a1", time: 1, provenance: "runtime", layer: "semantic" })).toThrow(TypeError)
    // still 0
    validateRecord(rec)
    expect(rec.consumed).toBe(0)
    // termination with budget-exhausted is explicit
    const t = terminate(rec, { reason: "budget-exhausted", time: 2 })
    expect(t.terminated!.reason).toBe("budget-exhausted")
    expect(t.consumed).toBe(0)
  })

  it("charge reaching limit succeeds, next charge fails budget exhausted", () => {
    const rec = create({ opId: "prompt:msgLim", opKind: "prompt", limit: 2 })
    const c1 = charge(rec, { id: "a1", time: 1, provenance: "runtime", layer: "semantic" })
    expect(c1.consumed).toBe(1)
    expect(isBudgetExhausted(c1)).toBe(false)
    const c2 = charge(c1, { id: "a2", time: 2, provenance: "runtime", layer: "sdk" })
    expect(c2.consumed).toBe(2)
    expect(isBudgetExhausted(c2)).toBe(true)
    expect(() => charge(c2, { id: "a3", time: 3, provenance: "runtime", layer: "provider" })).toThrow(TypeError)
    expect(c2.consumed).toBe(2)
    // after exhaustion, terminate with budget-exhausted clears nextAt
    const cWithNext = charge(create({ opId: "prompt:msgLim2", opKind: "prompt", limit: 1 }), { id: "a1", time: 1, provenance: "runtime", layer: "semantic", nextAt: 10, replaySafe: true })
    const t = terminate(cWithNext, { reason: "budget-exhausted", time: 2 })
    expect(t.nextAt).toBeUndefined()
  })

  it("no overrun: consumed never exceeds limit", () => {
    const rec = create({ opId: "prompt:msgOver", opKind: "prompt", limit: 1 })
    const c1 = charge(rec, { id: "a1", time: 1, provenance: "runtime", layer: "semantic" })
    expect(c1.consumed).toBe(1)
    expect(() => charge(c1, { id: "a2", time: 2, provenance: "runtime", layer: "semantic" })).toThrow(TypeError)
    expect(() => charge(c1, { id: "a2", time: 2, provenance: "user", layer: "task" })).toThrow(TypeError)
    validateRecord(c1)
  })
})

describe("R13 explicit terminal reasons", () => {
  it("all five termination reasons work", () => {
    for (const reason of TERMINATIONS) {
      const rec = create({ opId: "prompt:term", opKind: "prompt", limit: 3 })
      const t = terminate(rec, { reason, time: 99 })
      expect(t.terminated!.reason).toBe(reason)
      expect(t.terminated!.time).toBe(99)
      expect(isTerminated(t)).toBe(true)
    }
  })

  it("terminate clears nextAt", () => {
    const rec = create({ opId: "prompt:term2", opKind: "prompt", limit: 3 })
    const c1 = charge(rec, { id: "a1", time: 10, provenance: "runtime", layer: "semantic", nextAt: 20, replaySafe: true })
    const t = terminate(c1, { reason: "cancelled", time: 15 })
    expect(t.nextAt).toBeUndefined()
    expect(t.terminated!.reason).toBe("cancelled")
  })

  it("terminate is idempotent for same reason/time, rejects conflicting", () => {
    const rec = create({ opId: "prompt:term3", opKind: "prompt", limit: 3 })
    const t1 = terminate(rec, { reason: "completed", time: 5 })
    const t2 = terminate(t1, { reason: "completed", time: 5 })
    expect(t2).toBe(t1)
    expect(() => terminate(t1, { reason: "cancelled", time: 5 })).toThrow(TypeError)
    expect(() => terminate(t1, { reason: "completed", time: 6 })).toThrow(TypeError)
  })

  it("terminated record prevents charge and second terminate with different reason", () => {
    const rec = create({ opId: "prompt:term4", opKind: "prompt", limit: 3 })
    const t = terminate(rec, { reason: "non-retryable", time: 1 })
    expect(() => charge(t, { id: "a1", time: 2, provenance: "runtime", layer: "semantic" })).toThrow(TypeError)
    expect(() => terminate(t, { reason: "completed", time: 2 })).toThrow(TypeError)
  })

  it("closed termination set", () => {
    const rec = create({ opId: "prompt:term5", opKind: "prompt", limit: 3 })
    expect(() => terminate(rec, { reason: "bad" as unknown as typeof TERMINATIONS[number], time: 1 })).toThrow(TypeError)
  })
})

describe("R13 no timer/retry constants/DB imports", () => {
  it("no retry algorithm/delay constants or DB imports in module", () => {
    const src = awaitReadFile()
    expect(src).not.toContain("setTimeout")
    expect(src).not.toContain("setInterval")
    expect(src).not.toContain("SessionRetry")
    expect(src).not.toContain("Retry-After")
    expect(src).not.toContain("Storage")
    expect(src).not.toContain("Database")
    // ensure no production import wiring beyond type-free pure module (allow no import)
    // check that file does not import runtime DB or SessionRetry constants
    expect(src).not.toContain("import {")
    expect(src).not.toContain("from \"@/\"")
  })
})

describe("R13 derived projection only", () => {
  it("snapshot is derived, exposes nested attempts/provenance, remains in-memory, no second store", () => {
    const rec = create({ opId: "prompt:snap", opKind: "prompt", limit: 5 })
    const c1 = charge(rec, { id: "a1", time: 10, provenance: "user", layer: "sdk" })
    const c2 = charge(c1, { id: "a2", time: 11, provenance: "offline-restore", layer: "provider" })
    const snap = snapshot(c2)
    expect(snap.opId).toBe("prompt:snap")
    expect(snap.limit).toBe(5)
    expect(snap.consumed).toBe(2)
    expect(snap.remaining).toBe(3)
    expect(snap.attempts.length).toBe(2)
    expect(snap.attempts.map((a) => a.layer)).toEqual(["sdk", "provider"])
    expect(snap.attempts.map((a) => a.provenance)).toEqual(["user", "offline-restore"])
    // derived: not same reference as record.attempts array
    expect(snap.attempts).not.toBe(c2.attempts)
    // mutation of snapshot does not affect record
    const snapMut = snap as unknown as Record<string, unknown>
    expect(() => {
      ;(snapMut["consumed"] as number) = 999
    }).toThrow()
    expect(c2.consumed).toBe(2)
    // snapshot reflects termination/nextAt
    const c3 = charge(c2, { id: "a3", time: 12, provenance: "runtime", layer: "task", nextAt: 20, replaySafe: true })
    const snap2 = snapshot(c3)
    expect(snap2.nextAt).toBe(20)
    const t = terminate(c3, { reason: "completed", time: 13 })
    const snap3 = snapshot(t)
    expect(snap3.terminated!.reason).toBe("completed")
    expect(snap3.nextAt).toBeUndefined()
    // no persistence: snapshot is plain object, not stored
    expect(Object.isFrozen(snap3)).toBe(true)
  })

  it("snapshot content is accounting facts only, no extra store", () => {
    const rec = create({ opId: "prompt:snap2", opKind: "prompt", limit: 2 })
    const snap = snapshot(rec)
    const keys = Object.keys(snap).sort()
    expect(keys).toEqual(["attempts", "consumed", "limit", "opId", "opKind", "owner", "remaining", "scope", "version"])
    const rec2 = charge(rec, { id: "a1", time: 1, provenance: "runtime", layer: "semantic", nextAt: 5, replaySafe: true })
    const snap2 = snapshot(rec2)
    expect(Object.keys(snap2).sort()).toEqual(["attempts", "consumed", "limit", "nextAt", "opId", "opKind", "owner", "remaining", "scope", "version"])
  })
})

describe("R13 deep immutability for externally supplied valid mutable records", () => {
  it("charge deep-freezes returned record and attempts, original mutable unchanged, mutation throws", () => {
    const external: RecoveryRecord = {
      version: "1.0",
      opId: "prompt:msgMutable",
      opKind: "prompt",
      owner: "runtime",
      scope: "operation",
      limit: 3,
      consumed: 2,
      attempts: [
        { id: "a1", time: 1, provenance: "runtime", layer: "semantic" },
        { id: "a2", time: 2, provenance: "user", layer: "sdk" },
      ],
    }
    validateRecord(external)
    expect(Object.isFrozen(external)).toBe(false)
    expect(Object.isFrozen(external.attempts)).toBe(false)
    expect(Object.isFrozen(external.attempts[0]!)).toBe(false)
    const charged = charge(external, { id: "a3", time: 3, provenance: "runtime", layer: "provider" })
    expect(Object.isFrozen(charged)).toBe(true)
    expect(Object.isFrozen(charged.attempts)).toBe(true)
    for (const a of charged.attempts) expect(Object.isFrozen(a)).toBe(true)
    expect(charged.consumed).toBe(3)
    expect(charged.attempts.length).toBe(3)
    expect(external.consumed).toBe(2)
    expect(external.attempts.length).toBe(2)
    expect(() => {
      ;(charged as unknown as Record<string, unknown>)["consumed"] = 999
    }).toThrow()
    expect(() => {
      ;(charged.attempts as unknown as RecoveryRecord["attempts"] & unknown[]).push({ id: "x", time: 4, provenance: "runtime", layer: "task" })
    }).toThrow()
    expect(() => {
      ;(charged.attempts[0] as unknown as Record<string, unknown>)["time"] = 999
    }).toThrow()
    ;(external.attempts[0] as unknown as Record<string, unknown>)["time"] = 999
    expect(charged.attempts[0]!.time).toBe(1)
    const external2: RecoveryRecord = {
      version: "1.0",
      opId: "prompt:msgMutable2",
      opKind: "prompt",
      owner: "runtime",
      scope: "operation",
      limit: 3,
      consumed: 1,
      attempts: [{ id: "a1", time: 10, provenance: "runtime", layer: "semantic" }],
    }
    validateRecord(external2)
    const same = charge(external2, { id: "a1", time: 10, provenance: "runtime", layer: "semantic" })
    expect(Object.isFrozen(same)).toBe(true)
    expect(Object.isFrozen(same.attempts)).toBe(true)
    expect(Object.isFrozen(same.attempts[0]!)).toBe(true)
    expect(same).not.toBe(external2)
    expect(same.attempts[0]!.time).toBe(10)
    ;(external2.attempts[0] as unknown as Record<string, unknown>)["time"] = 777
    expect(same.attempts[0]!.time).toBe(10)
  })

  it("terminate deep-freezes returned record and attempts, original mutable unchanged, mutation throws", () => {
    const external: RecoveryRecord = {
      version: "1.0",
      opId: "prompt:msgTerm",
      opKind: "prompt",
      owner: "runtime",
      scope: "operation",
      limit: 3,
      consumed: 1,
      attempts: [{ id: "a1", time: 5, provenance: "runtime", layer: "semantic" }],
    }
    validateRecord(external)
    expect(Object.isFrozen(external)).toBe(false)
    const terminated = terminate(external, { reason: "completed", time: 99 })
    expect(Object.isFrozen(terminated)).toBe(true)
    expect(Object.isFrozen(terminated.attempts)).toBe(true)
    for (const a of terminated.attempts) expect(Object.isFrozen(a)).toBe(true)
    expect(terminated.terminated).toBeDefined()
    expect(Object.isFrozen(terminated.terminated!)).toBe(true)
    expect(terminated.terminated!.reason).toBe("completed")
    expect(terminated.nextAt).toBeUndefined()
    expect(external.terminated).toBeUndefined()
    expect(external.attempts.length).toBe(1)
    expect(() => {
      ;(terminated as unknown as Record<string, unknown>)["limit"] = 999
    }).toThrow()
    expect(() => {
      ;(terminated.attempts as unknown as RecoveryRecord["attempts"] & unknown[]).push({ id: "x", time: 6, provenance: "runtime", layer: "task" })
    }).toThrow()
    expect(() => {
      ;(terminated.attempts[0] as unknown as Record<string, unknown>)["id"] = "evil"
    }).toThrow()
    expect(() => {
      ;(terminated.terminated as unknown as Record<string, unknown>)["reason"] = "cancelled"
    }).toThrow()
    ;(external.attempts[0] as unknown as Record<string, unknown>)["time"] = 12345
    expect(terminated.attempts[0]!.time).toBe(5)
    const externalWithNext: RecoveryRecord = {
      version: "1.0",
      opId: "prompt:msgNext",
      opKind: "prompt",
      owner: "runtime",
      scope: "operation",
      limit: 3,
      consumed: 1,
      attempts: [{ id: "a1", time: 10, provenance: "runtime", layer: "semantic", nextAt: 20 }],
      nextAt: 20,
    }
    validateRecord(externalWithNext)
    const terminated2 = terminate(externalWithNext, { reason: "cancelled", time: 30 })
    expect(terminated2.nextAt).toBeUndefined()
    expect(Object.isFrozen(terminated2)).toBe(true)
    expect(Object.isFrozen(terminated2.attempts)).toBe(true)
    expect(Object.isFrozen(terminated2.attempts[0]!)).toBe(true)
    expect(externalWithNext.nextAt).toBe(20)
  })
})

function awaitReadFile(): string {
  // read source without importing production; use Bun.file if available else fallback
  // This helper runs in test environment, reading the file synchronously via Bun
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require("fs")
  const p = require("path")
  const file = p.join(__dirname, "../../src/private-worker/recovery.ts")
  return fs.readFileSync(file, "utf8")
}
