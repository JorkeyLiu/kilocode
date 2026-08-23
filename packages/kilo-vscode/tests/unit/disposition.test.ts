import { describe, it, expect } from "bun:test"
import {
  DISPOSITION_VERSION,
  OP_KINDS,
  OUTCOMES,
  PROVENANCES,
  create,
  apply,
  validateRecord,
  parseOpId,
  isTerminal,
  type DispositionRecord,
} from "../../src/private-worker/disposition"

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

describe("R14 closed sets", () => {
  it("exact membership", () => {
    expect(DISPOSITION_VERSION).toBe("1.0")
    expect([...OP_KINDS]).toEqual(["prompt", "provider", "tool", "permission", "task"])
    expect([...OUTCOMES]).toEqual(["succeeded", "failed", "ambiguous", "in-flight", "superseded", "abandoned"])
    expect([...PROVENANCES]).toEqual(["worker-crash"])
  })

  it("isTerminal true for succeeded/failed/ambiguous/superseded/abandoned, false for in-flight", () => {
    expect(isTerminal("succeeded")).toBe(true)
    expect(isTerminal("failed")).toBe(true)
    expect(isTerminal("ambiguous")).toBe(true)
    expect(isTerminal("superseded")).toBe(true)
    expect(isTerminal("abandoned")).toBe(true)
    expect(isTerminal("in-flight")).toBe(false)
  })
})

describe("R14 five R11 identity forms", () => {
  it("all five kinds create and validate", () => {
    const ops = [promptOp(), providerOp(), toolOp(), permissionOp(), taskOp(), taskOp2()]
    for (const op of ops) {
      const rec = create({ opId: op.opId, opKind: op.opKind, occurrenceTime: 10, receiptTime: 20, crashId: "crash-1" })
      expect(rec.opId).toBe(op.opId)
      expect(rec.opKind).toBe(op.opKind)
      expect(rec.outcome).toBe("in-flight")
      expect(rec.version).toBe("1.0")
      validateRecord(rec)
      const parsed = parseOpId(op.opId)
      expect(parsed.kind).toBe(op.opKind)
    }
  })

  it("rejects mismatched opId/opKind", () => {
    expect(() => create({ opId: "prompt:msg1", opKind: "tool", occurrenceTime: 1, receiptTime: 2, crashId: "c1" })).toThrow(TypeError)
    expect(() => create({ opId: "provider:assistant1:0", opKind: "prompt", occurrenceTime: 1, receiptTime: 2, crashId: "c1" })).toThrow(TypeError)
  })

  it("rejects invalid opId forms", () => {
    expect(() => create({ opId: "prompt:", opKind: "prompt", occurrenceTime: 1, receiptTime: 2, crashId: "c1" })).toThrow(TypeError)
    expect(() => create({ opId: "provider:assistant1:bad", opKind: "provider", occurrenceTime: 1, receiptTime: 2, crashId: "c1" })).toThrow(TypeError)
    expect(() => create({ opId: "tool:onlyone", opKind: "tool", occurrenceTime: 1, receiptTime: 2, crashId: "c1" })).toThrow(TypeError)
    expect(() => create({ opId: "permission:", opKind: "permission", occurrenceTime: 1, receiptTime: 2, crashId: "c1" })).toThrow(TypeError)
    expect(() => create({ opId: "task:", opKind: "task", occurrenceTime: 1, receiptTime: 2, crashId: "c1" })).toThrow(TypeError)
    expect(() => create({ opId: "prompt:msg:extra", opKind: "prompt", occurrenceTime: 1, receiptTime: 2, crashId: "c1" })).toThrow(TypeError)
    expect(() => create({ opId: "bad:seg", opKind: "prompt" as unknown as typeof OP_KINDS[number], occurrenceTime: 1, receiptTime: 2, crashId: "c1" })).toThrow(TypeError)
  })

  it("rejects extra fields and invalid times", () => {
    expect(() => create({ opId: "prompt:msg1", opKind: "prompt", occurrenceTime: NaN, receiptTime: 2, crashId: "c1" })).toThrow(TypeError)
    expect(() => create({ opId: "prompt:msg1", opKind: "prompt", occurrenceTime: 1, receiptTime: NaN, crashId: "c1" })).toThrow(TypeError)
    expect(() => create({ opId: "prompt:msg1", opKind: "prompt", occurrenceTime: 10, receiptTime: 5, crashId: "c1" })).toThrow(TypeError)
    expect(() => create({ opId: "prompt:msg1", opKind: "prompt", occurrenceTime: 1, receiptTime: 2, crashId: "" })).toThrow(TypeError)
    expect(() => create({ opId: "prompt:msg1", opKind: "prompt", occurrenceTime: 1, receiptTime: 2, crashId: "c1", extra: 1 } as unknown as Parameters<typeof create>[0])).toThrow(TypeError)
  })

  it("create rejects direct terminal outcome and non-worker-crash provenance", () => {
    for (const outcome of ["succeeded", "failed", "ambiguous", "superseded", "abandoned"] as const) {
      expect(() => create({ opId: "prompt:msg1", opKind: "prompt", occurrenceTime: 1, receiptTime: 2, crashId: "c1", outcome } as unknown as Parameters<typeof create>[0])).toThrow(TypeError)
    }
    expect(() => create({ opId: "prompt:msg1", opKind: "prompt", occurrenceTime: 1, receiptTime: 2, crashId: "c1", outcome: "in-flight" })).not.toThrow()
    const rec = create({ opId: "prompt:msg1", opKind: "prompt", occurrenceTime: 1, receiptTime: 2, crashId: "c1", outcome: "in-flight" })
    expect(rec.outcome).toBe("in-flight")
    expect(rec.provenance).toBe("worker-crash")
  })
})

describe("R14 crash provenance, cleanup, occurrence vs receipt, no silent replay", () => {
  it("provenance must be worker-crash", () => {
    const rec = create({ opId: "prompt:msg1", opKind: "prompt", occurrenceTime: 100, receiptTime: 110, crashId: "crash-1" })
    expect(rec.provenance).toBe("worker-crash")
    expect(() => validateRecord({ ...rec, provenance: "bad" as unknown as typeof PROVENANCES[number] } as unknown as DispositionRecord)).toThrow(TypeError)
    expect(() => apply(rec, { opId: "prompt:msg1", opKind: "prompt", outcome: "failed", occurrenceTime: 100, receiptTime: 110, crashId: "crash-1", cleanup: { released: true }, provenance: "bad" as unknown as typeof PROVENANCES[number] })).toThrow(TypeError)
  })

  it("cleanup fact required and preserved", () => {
    const rec = create({ opId: "prompt:msg1", opKind: "prompt", occurrenceTime: 10, receiptTime: 20, crashId: "c1" })
    expect(rec.cleanup).toEqual({ released: false })
    const applied = apply(rec, { opId: "prompt:msg1", opKind: "prompt", outcome: "failed", occurrenceTime: 10, receiptTime: 20, crashId: "c1", cleanup: { released: true } })
    expect(applied.cleanup).toEqual({ released: true })
    const notReleased = apply(rec, { opId: "prompt:msg1", opKind: "prompt", outcome: "ambiguous", occurrenceTime: 11, receiptTime: 21, crashId: "c1", cleanup: { released: false } })
    expect(notReleased.cleanup).toEqual({ released: false })
    expect(() => apply(rec, { opId: "prompt:msg1", opKind: "prompt", outcome: "ambiguous", occurrenceTime: 11, receiptTime: 21, crashId: "c2", cleanup: { released: false } })).toThrow(TypeError)
    expect(() => apply(rec, { opId: "prompt:msg1", opKind: "prompt", outcome: "failed", occurrenceTime: 10, receiptTime: 20, crashId: "c1", cleanup: { released: "yes" } as unknown as { released: boolean } })).toThrow(TypeError)
    expect(() => apply(rec, { opId: "prompt:msg1", opKind: "prompt", outcome: "failed", occurrenceTime: 10, receiptTime: 20, crashId: "c1", cleanup: { released: true, extra: 1 } as unknown as { released: boolean } })).toThrow(TypeError)
  })

  it("occurrenceTime distinct from receiptTime, both caller-supplied, receipt >= occurrence", () => {
    const rec = create({ opId: "prompt:msg2", opKind: "prompt", occurrenceTime: 123.5, receiptTime: 200, crashId: "crash-occ" })
    expect(rec.occurrenceTime).toBe(123.5)
    expect(rec.receiptTime).toBe(200)
    const applied = apply(rec, { opId: "prompt:msg2", opKind: "prompt", outcome: "abandoned", occurrenceTime: 123.5, receiptTime: 250, crashId: "crash-occ", cleanup: { released: true } })
    expect(applied.occurrenceTime).toBe(123.5)
    expect(applied.receiptTime).toBe(250)
    expect(applied.occurrenceTime).not.toBe(applied.receiptTime)
    expect(() => apply(rec, { opId: "prompt:msg2", opKind: "prompt", outcome: "failed", occurrenceTime: 300, receiptTime: 299, crashId: "c1", cleanup: { released: true } })).toThrow(TypeError)
    expect(() => create({ opId: "prompt:msg2", opKind: "prompt", occurrenceTime: 50, receiptTime: 40, crashId: "c1" })).toThrow(TypeError)
  })

  it("no silent replay: replayed is always false and rejects true", () => {
    const rec = create({ opId: "prompt:msg3", opKind: "prompt", occurrenceTime: 1, receiptTime: 2, crashId: "c1" })
    expect(rec.replayed).toBe(false)
    const applied = apply(rec, { opId: "prompt:msg3", opKind: "prompt", outcome: "failed", occurrenceTime: 1, receiptTime: 2, crashId: "c1", cleanup: { released: true } })
    expect(applied.replayed).toBe(false)
    expect(() => apply(rec, { opId: "prompt:msg3", opKind: "prompt", outcome: "failed", occurrenceTime: 1, receiptTime: 2, crashId: "c1", cleanup: { released: true }, replayed: true as unknown as false })).toThrow(TypeError)
    const badRec = { ...rec, replayed: true } as unknown as DispositionRecord
    expect(() => validateRecord(badRec)).toThrow(TypeError)
  })

  it("no clock embedded: caller supplies times", () => {
    const src = awaitReadFile()
    expect(src).not.toContain("Date.now")
    expect(src).not.toContain("setTimeout")
    expect(src).not.toContain("setInterval")
  })
})

describe("R14 idempotency and conflicting disposition", () => {
  it("same crash event replay is idempotent (same facts return same record)", () => {
    const rec = create({ opId: "prompt:msgA", opKind: "prompt", occurrenceTime: 10, receiptTime: 20, crashId: "crash-1" })
    const a1 = apply(rec, { opId: "prompt:msgA", opKind: "prompt", outcome: "failed", occurrenceTime: 100, receiptTime: 110, crashId: "crash-1", cleanup: { released: true } })
    const a2 = apply(rec, { opId: "prompt:msgA", opKind: "prompt", outcome: "failed", occurrenceTime: 100, receiptTime: 110, crashId: "crash-1", cleanup: { released: true } })
    expect(a2).toEqual(a1)
    // applying to already-terminal exact replay is also idempotent
    const a3 = apply(a1, { opId: "prompt:msgA", opKind: "prompt", outcome: "failed", occurrenceTime: 100, receiptTime: 110, crashId: "crash-1", cleanup: { released: true } })
    expect(a3).toBe(a1)
    expect(a3.outcome).toBe("failed")
  })

  it("conflicting same-op disposition rejects", () => {
    const rec = create({ opId: "prompt:msgA", opKind: "prompt", occurrenceTime: 10, receiptTime: 20, crashId: "crash-1" })
    const a1 = apply(rec, { opId: "prompt:msgA", opKind: "prompt", outcome: "failed", occurrenceTime: 100, receiptTime: 110, crashId: "crash-1", cleanup: { released: true } })
    expect(() => apply(a1, { opId: "prompt:msgA", opKind: "prompt", outcome: "succeeded", occurrenceTime: 100, receiptTime: 110, crashId: "crash-1", cleanup: { released: true } })).toThrow(TypeError)
    expect(() => apply(a1, { opId: "prompt:msgA", opKind: "prompt", outcome: "failed", occurrenceTime: 101, receiptTime: 110, crashId: "crash-1", cleanup: { released: true } })).toThrow(TypeError)
    expect(() => apply(a1, { opId: "prompt:msgA", opKind: "prompt", outcome: "failed", occurrenceTime: 100, receiptTime: 110, crashId: "crash-1", cleanup: { released: false } })).toThrow(TypeError)
    expect(() => apply(a1, { opId: "prompt:msgA", opKind: "prompt", outcome: "failed", occurrenceTime: 100, receiptTime: 110, crashId: "crash-2", cleanup: { released: true } })).toThrow(TypeError)
    // conflicting terminal exact mismatch on already-terminal
    expect(() => apply(a1, { opId: "prompt:msgA", opKind: "prompt", outcome: "abandoned", occurrenceTime: 100, receiptTime: 110, crashId: "crash-1", cleanup: { released: true } })).toThrow(TypeError)
  })

  it("in-flight apply with different crashId rejects before transition and leaves record unchanged", () => {
    const rec = create({ opId: "prompt:msgA", opKind: "prompt", occurrenceTime: 10, receiptTime: 20, crashId: "crash-1" })
    expect(() => apply(rec, { opId: "prompt:msgA", opKind: "prompt", outcome: "failed", occurrenceTime: 10, receiptTime: 20, crashId: "crash-2", cleanup: { released: true } })).toThrow(TypeError)
    expect(rec.outcome).toBe("in-flight")
    expect(rec.crashId).toBe("crash-1")
    expect(() => apply(rec, { opId: "prompt:msgA", opKind: "prompt", outcome: "ambiguous", occurrenceTime: 11, receiptTime: 21, crashId: "other", cleanup: { released: false } })).toThrow(TypeError)
    // exact same crash replay remains idempotent
    const a1 = apply(rec, { opId: "prompt:msgA", opKind: "prompt", outcome: "failed", occurrenceTime: 100, receiptTime: 110, crashId: "crash-1", cleanup: { released: true } })
    const a2 = apply(rec, { opId: "prompt:msgA", opKind: "prompt", outcome: "failed", occurrenceTime: 100, receiptTime: 110, crashId: "crash-1", cleanup: { released: true } })
    expect(a2).toEqual(a1)
  })
})

describe("R14 only in-flight -> terminal/intermediate allowed, terminal exact replay allowed", () => {
  it("in-flight to each terminal outcome succeeds", () => {
    for (const outcome of ["succeeded", "failed", "ambiguous", "superseded", "abandoned"] as const) {
      const rec = create({ opId: "prompt:term", opKind: "prompt", occurrenceTime: 1, receiptTime: 2, crashId: "c1" })
      const applied = apply(rec, { opId: "prompt:term", opKind: "prompt", outcome, occurrenceTime: 10, receiptTime: 20, crashId: "c1", cleanup: { released: true } })
      expect(applied.outcome).toBe(outcome)
      expect(isTerminal(applied.outcome)).toBe(true)
      expect(Object.isFrozen(applied)).toBe(true)
      expect(Object.isFrozen(applied.cleanup)).toBe(true)
    }
  })

  it("terminal exact replay returns same and is frozen", () => {
    const rec = create({ opId: "prompt:rep", opKind: "prompt", occurrenceTime: 1, receiptTime: 2, crashId: "c1" })
    const t1 = apply(rec, { opId: "prompt:rep", opKind: "prompt", outcome: "abandoned", occurrenceTime: 10, receiptTime: 20, crashId: "c1", cleanup: { released: true } })
    const t2 = apply(t1, { opId: "prompt:rep", opKind: "prompt", outcome: "abandoned", occurrenceTime: 10, receiptTime: 20, crashId: "c1", cleanup: { released: true } })
    expect(t2).toBe(t1)
    expect(() => {
      ;(t1 as unknown as Record<string, unknown>)["outcome"] = "failed"
    }).toThrow()
  })

  it("regressive terminal -> in-flight rejects", () => {
    const rec = create({ opId: "prompt:reg", opKind: "prompt", occurrenceTime: 1, receiptTime: 2, crashId: "c1" })
    const t = apply(rec, { opId: "prompt:reg", opKind: "prompt", outcome: "failed", occurrenceTime: 10, receiptTime: 20, crashId: "c1", cleanup: { released: true } })
    expect(() => apply(t, { opId: "prompt:reg", opKind: "prompt", outcome: "in-flight", occurrenceTime: 11, receiptTime: 21, crashId: "c1", cleanup: { released: false } })).toThrow(TypeError)
  })

  it("in-flight conflicting replay with different facts rejects", () => {
    const rec = create({ opId: "prompt:conf", opKind: "prompt", occurrenceTime: 1, receiptTime: 2, crashId: "c1" })
    expect(() => apply(rec, { opId: "prompt:conf", opKind: "prompt", outcome: "in-flight", occurrenceTime: 2, receiptTime: 3, crashId: "c1", cleanup: { released: false } })).toThrow(TypeError)
  })
})

describe("R14 invalid cross-kind/cross-identity/regressive", () => {
  it("cross-kind rejects", () => {
    const rec = create({ opId: "prompt:msgX", opKind: "prompt", occurrenceTime: 1, receiptTime: 2, crashId: "c1" })
    expect(() => apply(rec, { opId: "provider:assistant1:0", opKind: "provider", outcome: "failed", occurrenceTime: 10, receiptTime: 20, crashId: "c1", cleanup: { released: true } })).toThrow(TypeError)
  })

  it("cross-identity rejects", () => {
    const rec = create({ opId: "prompt:msgY", opKind: "prompt", occurrenceTime: 1, receiptTime: 2, crashId: "c1" })
    expect(() => apply(rec, { opId: "prompt:other", opKind: "prompt", outcome: "failed", occurrenceTime: 10, receiptTime: 20, crashId: "c1", cleanup: { released: true } })).toThrow(TypeError)
  })

  it("regressive and terminal conflict rejects", () => {
    const rec = create({ opId: "tool:assistant1:callA", opKind: "tool", occurrenceTime: 1, receiptTime: 2, crashId: "c1" })
    const term = apply(rec, { opId: "tool:assistant1:callA", opKind: "tool", outcome: "succeeded", occurrenceTime: 10, receiptTime: 20, crashId: "c1", cleanup: { released: true } })
    expect(() => apply(term, { opId: "tool:assistant1:callA", opKind: "tool", outcome: "succeeded", occurrenceTime: 11, receiptTime: 21, crashId: "c1", cleanup: { released: true } })).toThrow(TypeError)
    expect(() => apply(term, { opId: "tool:assistant1:callA", opKind: "tool", outcome: "failed", occurrenceTime: 10, receiptTime: 20, crashId: "c1", cleanup: { released: true } })).toThrow(TypeError)
  })
})

describe("R14 pure module, no DB/timer/retry wiring", () => {
  it("no retry/timer/DB/production imports in module", () => {
    const src = awaitReadFile()
    expect(src).not.toContain("setTimeout")
    expect(src).not.toContain("setInterval")
    expect(src).not.toContain("Database")
    expect(src).not.toContain("Storage")
    expect(src).not.toContain("from \"@/\"")
    expect(src).not.toContain("import {")
  })

  it("validateRecord rejects extra fields and validates all required", () => {
    const rec = create({ opId: "permission:req1", opKind: "permission", occurrenceTime: 5, receiptTime: 6, crashId: "c1" })
    expect(() => validateRecord({ ...rec, extra: 1 } as unknown as DispositionRecord)).toThrow(TypeError)
    expect(() => validateRecord({ ...rec, version: "2.0" } as unknown as DispositionRecord)).toThrow(TypeError)
    expect(() => validateRecord({ ...rec, opId: "bad" } as unknown as DispositionRecord)).toThrow(TypeError)
  })

  it("immutability: returned records frozen, original not mutated", () => {
    const rec = create({ opId: "task:ses1", opKind: "task", occurrenceTime: 1, receiptTime: 2, crashId: "c1" })
    const applied = apply(rec, { opId: "task:ses1", opKind: "task", outcome: "abandoned", occurrenceTime: 10, receiptTime: 20, crashId: "c1", cleanup: { released: true } })
    expect(Object.isFrozen(rec)).toBe(true)
    expect(Object.isFrozen(applied)).toBe(true)
    expect(Object.isFrozen(applied.cleanup)).toBe(true)
    expect(rec.outcome).toBe("in-flight")
    expect(applied.outcome).toBe("abandoned")
    expect(() => {
      ;(applied as unknown as Record<string, unknown>)["outcome"] = "failed"
    }).toThrow()
  })
})

function awaitReadFile(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require("fs")
  const p = require("path")
  const file = p.join(__dirname, "../../src/private-worker/disposition.ts")
  return fs.readFileSync(file, "utf8")
}
