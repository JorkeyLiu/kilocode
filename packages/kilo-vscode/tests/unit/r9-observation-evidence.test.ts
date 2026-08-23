import { describe, it, expect } from "bun:test"
import { validateR9Boundary, isR9RuntimeValid, type R9BoundaryEvidence, type R9RuntimeEvidence } from "../../script/e2e-probe-r9"

function notif(seq: number) {
  return {
    method: "observation/changed",
    params: { v: "1.0", cursor: seq, entries: [{ seq, session_id: `ses_${seq}`, revision: 1, kind: "changed" as const, time: 7000 + seq }] },
    at: new Date().toISOString(),
  }
}

function validBoundary(name = "panel"): R9BoundaryEvidence {
  const isRestart = name === "restart"
  const isReconnect = name === "reconnect"
  const isSwitch = name === "switch"
  return {
    boundary: name,
    before: { pid: 100, hostState: "open", cursor: 1, rehydrate: false },
    after: { pid: 101, hostState: "open", cursor: 2, rehydrate: isRestart ? true : false },
    duplicate: false,
    continuity: true,
    rehydrate: isRestart ? true : false,
    notes: ["ok"],
    beforeEntriesCount: 0,
    afterEntriesCount: isRestart ? 0 : 1,
    ...(isReconnect
      ? { trigger: { reason: "peer:closed", rehydrate: false }, notifications: { before: [], after: [notif(2)] }, subscribe: { v: "1.0", cursor: 2, subscribed: true } }
      : {}),
    ...(isRestart
      ? {
          kill: { beforePid: 100, after: { pid: 101, pendingAlive: false, hostState: "open" } },
          notifications: { before: [], after: [notif(2)] },
          subscribe: { v: "1.0", cursor: 2, subscribed: true },
        }
      : {}),
    ...(isSwitch
      ? {
          switchConfirmation: { clickedTabId: "ses_switch_target", activeTabId: "ses_switch_target", selected: true, at: new Date().toISOString() },
          actionResult: { switchConfirmation: { clickedTabId: "ses_switch_target", activeTabId: "ses_switch_target", selected: true, at: new Date().toISOString() } },
        }
      : {}),
  }
}

describe("r9-observation evidence helpers", () => {
  it("validateR9Boundary accepts valid evidence", () => {
    expect(validateR9Boundary(validBoundary())).toBeUndefined()
    expect(validateR9Boundary(validBoundary("switch"))).toBeUndefined()
    expect(validateR9Boundary(validBoundary("reconnect"))).toBeUndefined()
    expect(validateR9Boundary(validBoundary("restart"))).toBeUndefined()
  })
  it("switch requires click confirmation with clickedTabId", () => {
    const b = validBoundary("switch")
    delete (b as Record<string, unknown>).switchConfirmation
    delete (b as Record<string, unknown>).actionResult
    expect(validateR9Boundary(b)).toMatch(/switch missing click confirmation/)
    const b2 = validBoundary("switch")
    b2.switchConfirmation = { activeTabId: "x" }
    b2.actionResult = { switchConfirmation: { activeTabId: "x" } }
    expect(validateR9Boundary(b2)).toMatch(/clickedTabId must be non-empty/)
    const b3 = validBoundary("switch")
    b3.switchConfirmation = { clickedTabId: "", activeTabId: "x" }
    b3.actionResult = { switchConfirmation: { clickedTabId: "", activeTabId: "x" } }
    expect(validateR9Boundary(b3)).toMatch(/clickedTabId must be non-empty/)
  })
  it("rejects duplicate", () => {
    const b = validBoundary()
    b.duplicate = true
    expect(validateR9Boundary(b)).toMatch(/duplicate/)
  })
  it("rejects bad hostState", () => {
    const b = validBoundary()
    b.after.hostState = "closed"
    expect(validateR9Boundary(b)).toMatch(/open/)
  })
  it("rejects missing continuity", () => {
    const b = validBoundary()
    b.continuity = false
    expect(validateR9Boundary(b)).toMatch(/continuity/)
  })
  it("restart requires rehydrate true", () => {
    const b = validBoundary("restart")
    b.rehydrate = false
    b.after.rehydrate = false
    expect(validateR9Boundary(b)).toMatch(/rehydrate/)
  })
  it("restart requires pid change", () => {
    const b = validBoundary("restart")
    b.after.pid = 100
    expect(validateR9Boundary(b)).toMatch(/pid must change/)
  })
  it("requires numeric before/after pid", () => {
    const b = validBoundary("panel")
    delete (b.before as Record<string, unknown>).pid
    expect(validateR9Boundary(b)).toMatch(/before pid must be number/)
    const b2 = validBoundary("panel")
    delete (b2.after as Record<string, unknown>).pid
    expect(validateR9Boundary(b2)).toMatch(/after pid must be number/)
  })
  it("reconnect requires peer:closed trigger and open states", () => {
    const b = validBoundary("reconnect")
    delete (b as Record<string, unknown>).trigger
    expect(validateR9Boundary(b)).toMatch(/reconnect missing trigger/)
    const b2 = validBoundary("reconnect")
    b2.trigger = { reason: "other" }
    expect(validateR9Boundary(b2)).toMatch(/peer:closed/)
    const b3 = validBoundary("reconnect")
    b3.before.hostState = "closed"
    expect(validateR9Boundary(b3)).toMatch(/before hostState must be open/)
  })
  it("restart requires exact-kill evidence with changed pid and pendingAlive false", () => {
    const b = validBoundary("restart")
    delete (b as Record<string, unknown>).kill
    expect(validateR9Boundary(b)).toMatch(/restart missing exact-kill/)
    const b2 = validBoundary("restart")
    b2.kill = { beforePid: 100, after: { pid: 100, pendingAlive: false } }
    expect(validateR9Boundary(b2)).toMatch(/must change/)
    const b3 = validBoundary("restart")
    b3.kill = { beforePid: 100, after: { pid: 101, pendingAlive: true } }
    expect(validateR9Boundary(b3)).toMatch(/pendingAlive must be false/)
  })
  it("reconnect and restart require notification sequence evidence", () => {
    const b = validBoundary("reconnect")
    delete (b as Record<string, unknown>).notifications
    expect(validateR9Boundary(b)).toMatch(/missing notification sequence/)
    const b2 = validBoundary("restart")
    delete (b2 as Record<string, unknown>).notifications
    expect(validateR9Boundary(b2)).toMatch(/missing notification sequence/)
  })
  it("detects duplicate via notification seq overlap", () => {
    const b = validBoundary("reconnect")
    b.notifications = {
      before: [notif(5)],
      after: [notif(5)],
    }
    b.duplicate = false
    expect(validateR9Boundary(b)).toMatch(/duplicate notification seq 5/)
  })
  it("rejects strict envelope violations", () => {
    const b = validBoundary("reconnect")
    b.notifications = { before: [], after: [{ method: "wrong/method", params: { v: "1.0", cursor: 2, entries: [{ seq: 2, session_id: "s", revision: 1, kind: "changed", time: 7002 }] }, at: "t" }] }
    expect(validateR9Boundary(b)).toMatch(/method must be observation\/changed/)
    const b2 = validBoundary("reconnect")
    b2.notifications = { before: [], after: [{ method: "observation/changed", params: { v: "2.0", cursor: 2, entries: [{ seq: 2, session_id: "s", revision: 1, kind: "changed", time: 7002 }] }, at: "t" }] }
    expect(validateR9Boundary(b2)).toMatch(/v must be 1\.0/)
    const b3 = validBoundary("reconnect")
    b3.notifications = { before: [], after: [{ method: "observation/changed", params: { v: "1.0", cursor: 2, entries: [{ seq: 2 }] }, at: "t" }] }
    expect(validateR9Boundary(b3)).toMatch(/session_id must be non-empty/)
    const b4 = validBoundary("reconnect")
    b4.notifications = { before: [], after: [{ method: "observation/changed", params: { v: "1.0", cursor: 2, entries: [] }, at: "t" }] }
    expect(validateR9Boundary(b4)).toMatch(/non-empty array/)
    const b5 = validBoundary("reconnect")
    b5.notifications = { before: [], after: [{ method: "observation/changed", params: { v: "1.0", cursor: 3, entries: [{ seq: 2, session_id: "s", revision: 1, kind: "changed", time: 7002 }] }, at: "t" }] }
    expect(validateR9Boundary(b5)).toMatch(/must equal max entry seq/)
  })
  it("empty after notifications must not pass reconnect/restart continuity", () => {
    const b = validBoundary("reconnect")
    b.notifications = { before: [], after: [] }
    expect(validateR9Boundary(b)).toMatch(/after notifications empty/)
    const b2 = validBoundary("restart")
    b2.notifications = { before: [], after: [] }
    expect(validateR9Boundary(b2)).toMatch(/after notifications empty/)
  })
  it("detects gap in observed seq progression", () => {
    const b = validBoundary("reconnect")
    b.notifications = { before: [notif(2)], after: [notif(4)] }
    // before max 2 -> after min 4 gap missing 3
    expect(validateR9Boundary(b)).toMatch(/gap across boundary/)
    const b2 = validBoundary("restart")
    b2.notifications = { before: [], after: [notif(2), { method: "observation/changed", params: { v: "1.0", cursor: 4, entries: [{ seq: 4, session_id: "s", revision: 1, kind: "changed", time: 7004 }] }, at: "t" }] }
    expect(validateR9Boundary(b2)).toMatch(/gap in after seqs/)
  })
  it("rejects non-integer cursor in notification", () => {
    const b = validBoundary("reconnect")
    b.notifications = { before: [], after: [{ method: "observation/changed", params: { v: "1.0", cursor: 1.5, entries: [{ seq: 1.5, session_id: "s", revision: 1, kind: "changed", time: 7000 }] }, at: "t" }] }
    expect(validateR9Boundary(b)).toMatch(/cursor must be integer/)
  })
  it("validates subscribe envelope strictly", () => {
    const b = validBoundary("reconnect")
    b.subscribe = { v: "2.0", cursor: 2, subscribed: true }
    expect(validateR9Boundary(b)).toMatch(/subscribe v must be 1.0/)
    const b2 = validBoundary("reconnect")
    b2.subscribe = { v: "1.0", cursor: 1.5, subscribed: true }
    expect(validateR9Boundary(b2)).toMatch(/cursor must be integer/)
    const b3 = validBoundary("reconnect")
    b3.subscribe = { v: "1.0", cursor: 2, subscribed: false }
    expect(validateR9Boundary(b3)).toMatch(/subscribed must be true/)
  })
  it("isR9RuntimeValid requires exactly 5 unique expected boundaries", () => {
    const runtime: R9RuntimeEvidence = {
      scenario: "r9-observation",
      collectedAt: new Date().toISOString(),
      pid: 1,
      canonical: { dbPath: "/tmp/kilo.db", gateOk: true },
      testBridge: true,
      boundaries: [validBoundary("panel"), validBoundary("reload"), validBoundary("switch"), validBoundary("reconnect"), validBoundary("restart")],
      finalDom: {},
    }
    expect(isR9RuntimeValid(runtime)).toBeUndefined()
    const short = { ...runtime, boundaries: [validBoundary("panel")] }
    expect(isR9RuntimeValid(short)).toMatch(/5 boundaries/)
    const dup = { ...runtime, boundaries: [validBoundary("panel"), validBoundary("panel"), validBoundary("switch"), validBoundary("reconnect"), validBoundary("restart")] }
    expect(isR9RuntimeValid(dup)).toMatch(/unique/)
    const wrongName = { ...runtime, boundaries: [validBoundary("panel"), validBoundary("reload"), validBoundary("switch"), validBoundary("reconnect"), validBoundary("bogus")] }
    expect(isR9RuntimeValid(wrongName)).toMatch(/missing expected/)
  })
  it("isR9RuntimeValid checks scenario and gate and subscribe", () => {
    const base: R9RuntimeEvidence = {
      scenario: "r9-observation",
      collectedAt: new Date().toISOString(),
      pid: 1,
      canonical: { dbPath: "/tmp/kilo.db", gateOk: true },
      testBridge: true,
      boundaries: [validBoundary("panel"), validBoundary("reload"), validBoundary("switch"), validBoundary("reconnect"), validBoundary("restart")],
      finalDom: {},
    }
    expect(isR9RuntimeValid({ ...base, scenario: "other" } as R9RuntimeEvidence)).toMatch(/scenario/)
    expect(isR9RuntimeValid({ ...base, canonical: { dbPath: "/x", gateOk: false } })).toMatch(/gate/)
    // Missing subscribe on reconnect must fail
    const noReconnectSub = {
      ...base,
      boundaries: (["panel", "reload", "switch", "reconnect", "restart"] as const).map((n) => {
        const b = validBoundary(n)
        if (n === "reconnect") delete (b as Record<string, unknown>).subscribe
        return b
      }),
    } as R9RuntimeEvidence
    expect(isR9RuntimeValid(noReconnectSub)).toMatch(/reconnect missing subscribe/)
    const noRestartSub = {
      ...base,
      boundaries: (["panel", "reload", "switch", "reconnect", "restart"] as const).map((n) => {
        const b = validBoundary(n)
        if (n === "restart") delete (b as Record<string, unknown>).subscribe
        return b
      }),
    } as R9RuntimeEvidence
    expect(isR9RuntimeValid(noRestartSub)).toMatch(/restart missing subscribe/)
    // Invalid subscribe fails strictly
    const badSub = {
      ...base,
      boundaries: (["panel", "reload", "switch", "reconnect", "restart"] as const).map((n) => {
        const b = validBoundary(n)
        if (n === "reconnect") b.subscribe = { v: "1.0", cursor: "bad", subscribed: true } as unknown as Record<string, unknown>
        return b
      }),
    } as R9RuntimeEvidence
    expect(isR9RuntimeValid(badSub)).toMatch(/subscribe invalid/)
  })
  it("validates duplicate derived from seq sets not hardcoded", () => {
    const b = validBoundary("panel")
    b.duplicate = false
    b.continuity = true
    expect(validateR9Boundary(b)).toBeUndefined()
    b.duplicate = true
    expect(validateR9Boundary(b)).toMatch(/duplicate/)
  })
  it("runtime requires reconnect trigger and restart kill facts", () => {
    const base: R9RuntimeEvidence = {
      scenario: "r9-observation",
      collectedAt: new Date().toISOString(),
      pid: 1,
      canonical: { dbPath: "/tmp/kilo.db", gateOk: true },
      testBridge: true,
      boundaries: [validBoundary("panel"), validBoundary("reload"), validBoundary("switch"), validBoundary("reconnect"), validBoundary("restart")],
      finalDom: {},
    }
    const noTrigger = {
      ...base,
      boundaries: base.boundaries.map((b) => (b.boundary === "reconnect" ? { ...b, trigger: undefined } : b)),
    } as R9RuntimeEvidence
    expect(isR9RuntimeValid(noTrigger)).toMatch(/reconnect/)
    const noKill = {
      ...base,
      boundaries: base.boundaries.map((b) => (b.boundary === "restart" ? { ...b, kill: undefined } : b)),
    } as R9RuntimeEvidence
    expect(isR9RuntimeValid(noKill)).toMatch(/restart/)
  })
  it("cursor monotonicity separate from seq continuity", () => {
    const b = validBoundary("reconnect")
    b.before.cursor = 5
    b.after.cursor = 4
    // seq continuity passes (after 6? but we have after seq 2 which duplicates? Let's set after seq 6 and before cursor 5->4 regression should fail on cursor monotonicity
    b.notifications = { before: [notif(5)], after: [notif(6)] }
    b.before.cursor = 5
    b.after.cursor = 4
    expect(validateR9Boundary(b)).toMatch(/cursor monotonicity failed/)
  })
})
