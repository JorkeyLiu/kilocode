import { afterEach, describe, expect, test } from "bun:test"
import * as Inheritance from "../../../src/kilocode/sandbox/inheritance"
import type { SessionID } from "@/session/schema"

afterEach(() => {
  Inheritance._resetForTest()
})

function tokenFor(sessionID: string, dir: string, count = 1) {
  return Inheritance.issue({ sessionID: sessionID as SessionID, directory: dir, count })
}

describe("SandboxInheritance reserve idempotency", () => {
  test("same opId+same token returns same reservation idempotently", () => {
    const token = tokenFor("ses_a", "/tmp/dir", 2)
    const opId = "op-1"
    const r1 = Inheritance.reserve(opId, token)!
    expect(r1.hash).toBe(Inheritance.hashToken(token))
    const r2 = Inheritance.reserve(opId, token)!
    expect(r2).toBe(r1)
    expect(r2.hash).toBe(r1.hash)
    // no new reservation object, same map entry
    expect(Inheritance._getReservation(opId)).toBe(r1)
    // remaining unchanged before commit
    expect(Inheritance._getGrant(token)?.remaining).toBe(2)
  })

  test("same opId+different token is conflict", () => {
    const t1 = tokenFor("ses_a", "/tmp/dir", 2)
    const t2 = tokenFor("ses_b", "/tmp/dir", 2)
    const opId = "op-2"
    Inheritance.reserve(opId, t1)
    expect(() => Inheritance.reserve(opId, t2)).toThrow(/conflict/)
    // original reservation preserved
    const kept = Inheritance._getReservation(opId)!
    expect(kept.hash).toBe(Inheritance.hashToken(t1))
  })

  test("commit deducts remaining once and clears reservation", () => {
    const token = tokenFor("ses_a", "/tmp/dir", 2)
    const opId = "op-3"
    const r1 = Inheritance.reserve(opId, token)!
    // second same-hash reserve before commit is idempotent, no extra deduction
    const r2 = Inheritance.reserve(opId, token)!
    expect(r2).toBe(r1)
    expect(Inheritance._getGrant(token)?.remaining).toBe(2)
    Inheritance.commit(opId)
    expect(Inheritance._getGrant(token)?.remaining).toBe(1)
    expect(Inheritance._getReservation(opId)).toBeUndefined()
    // commit again is no-op (idempotent)
    Inheritance.commit(opId)
    expect(Inheritance._getGrant(token)?.remaining).toBe(1)
  })

  test("release allows re-reserve with same token", () => {
    const token = tokenFor("ses_a", "/tmp/dir", 2)
    const opId = "op-4"
    Inheritance.reserve(opId, token)
    expect(Inheritance._getGrant(token)?.remaining).toBe(2)
    Inheritance.release(opId)
    expect(Inheritance._getReservation(opId)).toBeUndefined()
    expect(Inheritance._getGrant(token)?.remaining).toBe(2)
    const r2 = Inheritance.reserve(opId, token)!
    expect(r2.hash).toBe(Inheritance.hashToken(token))
    Inheritance.commit(opId)
    expect(Inheritance._getGrant(token)?.remaining).toBe(1)
  })

  test("release after commit not needed and re-reserve works", () => {
    const token = tokenFor("ses_a", "/tmp/dir", 1)
    const opId = "op-5"
    Inheritance.reserve(opId, token)
    Inheritance.commit(opId)
    expect(Inheritance._getGrant(token)).toBeUndefined()
    expect(Inheritance._getReservation(opId)).toBeUndefined()
    Inheritance.release(opId)
    expect(Inheritance._getReservation(opId)).toBeUndefined()
  })

  test("different opId same token creates independent reservations", () => {
    const token = tokenFor("ses_a", "/tmp/dir", 3)
    const r1 = Inheritance.reserve("op-a", token)!
    const r2 = Inheritance.reserve("op-b", token)!
    expect(r1.hash).toBe(r2.hash)
    expect(r1).not.toBe(r2)
    expect(Inheritance._getGrant(token)?.remaining).toBe(3)
    Inheritance.commit("op-a")
    expect(Inheritance._getGrant(token)?.remaining).toBe(2)
    Inheritance.commit("op-b")
    expect(Inheritance._getGrant(token)?.remaining).toBe(1)
  })

  test("error results do not echo token plaintext", () => {
    const t1 = tokenFor("ses_a", "/tmp/dir", 1)
    const t2 = tokenFor("ses_b", "/tmp/dir", 1)
    const opId = "op-err"
    Inheritance.reserve(opId, t1)
    let msg = ""
    try {
      Inheritance.reserve(opId, t2)
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e)
    }
    expect(msg).not.toContain(t1)
    expect(msg).not.toContain(t2)
    expect(msg).toContain("conflict")
    // invalid shape does not echo token
    const bad = "si-not-a-valid-token-shape-xxxxx"
    let msg2 = ""
    try {
      Inheritance.reserve("op-bad", bad)
    } catch (e) {
      msg2 = e instanceof Error ? e.message : String(e)
    }
    expect(msg2).not.toContain(bad)
    // invalid grant (fake token with valid shape) does not echo
    const fake = "si-00000000-0000-4000-8000-000000000000"
    let msg3 = ""
    try {
      Inheritance.reserve("op-fake", fake)
    } catch (e) {
      msg3 = e instanceof Error ? e.message : String(e)
    }
    expect(msg3).not.toContain(fake)
  })

  test("same opId same token reentry while reservation pending preserves single deduction semantic", () => {
    const token = tokenFor("ses_a", "/tmp/dir", 5)
    const opId = "op-pending"
    const first = Inheritance.reserve(opId, token)!
    // simulate pre-commit window: second call with same opId+same token before commit
    const second = Inheritance.reserve(opId, token)!
    expect(second).toBe(first)
    expect(Inheritance._getGrant(token)?.remaining).toBe(5)
    // commit once
    Inheritance.commit(opId)
    expect(Inheritance._getGrant(token)?.remaining).toBe(4)
    // after commit, new reserve should again deduct
    const third = Inheritance.reserve(opId, token)!
    expect(third.hash).toBe(Inheritance.hashToken(token))
    expect(third).not.toBe(first)
    Inheritance.commit(opId)
    expect(Inheritance._getGrant(token)?.remaining).toBe(3)
  })
})
