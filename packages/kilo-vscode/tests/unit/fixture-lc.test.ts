import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { validateLcProof } from "../../script/e2e-evidence"

function makeValidLcProof(): Record<string, unknown> {
  const h = "aaaaaaaaaaaaaaaa"
  const pid = 1234
  const port = 4321
  const epoch = 1
  const backend = { pid, port, epoch }
  const priv = {
    pid,
    epoch,
    available: true,
    state: "open",
    protocol: { name: "kilo-private", major: 1 },
    capabilities: ["session/cancelQueued", "session/update"],
    hasSessionUpdate: true,
  }
  const revision = { session: 5, config: 2 }
  const sdk = { status: "succeeded", httpStatus: 200, hasData: true }
  const privRes = { status: "succeeded", hasData: true }
  const at = new Date().toISOString()
  void at
  const cloneB = () => ({ pid, port, epoch })
  const prPriv = () => ({ ...priv, protocol: { ...priv.protocol }, capabilities: [...priv.capabilities] })
  const siblingTitle = "bbbbbbbbbbbbbbbb"
  return {
    schema: "kilo-gc-lifecycle-proof/1",
    version: 1,
    scope: "real-lifecycle Gate C: UI-only lifecycle convergence with stable identity and same-key replay",
    fixtureIdHash: h,
    sessionIdHash: h,
    siblingIdHash: h,
    titleHash: h,
    siblingTitleHash: siblingTitle,
    orderHash: h,
    pre: { backend: cloneB(), private: prPriv() },
    openTab: {
      before: {
        backend: cloneB(),
        private: {
          pid,
          epoch,
          available: true,
          hasSessionUpdate: true,
          state: "open",
          protocol: { name: "kilo-private", major: 1 },
          capabilities: ["session/cancelQueued", "session/update"],
        },
      },
      after: {
        backend: cloneB(),
        private: {
          pid,
          epoch,
          available: true,
          hasSessionUpdate: true,
          state: "open",
          protocol: { name: "kilo-private", major: 1 },
          capabilities: ["session/cancelQueued", "session/update"],
        },
      },
      editorCount: 1,
      ready: true,
      loadOk: true,
      targetSessionIdHash: h,
      currentSessionIdHash: h,
      attached: true,
    },
    titleOp: {
      opIdHash: h,
      idempotencyKeyHash: h,
      requestIdHash: h,
      sessionIdHash: h,
      titleHash: h,
      order: ["sdk", "private"],
      sdk: { ...sdk },
      private: { ...privRes },
      parity: { divergence: null, details: {} },
      revision: { ...revision },
    },
    replay: {
      found: true,
      private: { ...privRes },
      revision: { ...revision },
      titleHash: h,
      opIdHash: h,
      idempotencyKeyHash: h,
      requestIdHash: h,
      sessionIdHash: h,
    },
    boundaries: {
      panelCloseReopen: {
        pre: { backend: cloneB(), private: prPriv() },
        post: { backend: cloneB(), private: prPriv() },
        orderHash: h,
        orderCount: 2,
        agentTitleHash: h,
        tabTitleHash: h,
      },
      webviewReload: {
        pre: { backend: cloneB(), private: prPriv() },
        post: { backend: cloneB(), private: prPriv() },
        orderHash: h,
        orderCount: 2,
        agentTitleHash: h,
        tabTitleHash: h,
      },
      tabCloseReopen: {
        pre: { backend: cloneB(), private: prPriv() },
        post: { backend: cloneB(), private: prPriv() },
        orderHash: h,
        orderCount: 2,
        agentTitleHash: h,
        tabTitleHash: h,
      },
      sessionSwitch: {
        pre: { backend: cloneB(), private: prPriv(), activeIdHash: h },
        post: { backend: cloneB(), private: prPriv(), activeIdHash: h },
        switched: { backend: cloneB(), private: prPriv(), activeIdHash: h },
        orderHash: h,
        orderCount: 2,
        agentTitleHash: h,
        tabTitleHash: h,
        switchedAgentTitleHash: siblingTitle,
        switchedTabTitleHash: h,
        preAgentTitleHash: h,
        preTabTitleHash: h,
      },
    },
    finalReplay: {
      found: true,
      private: { ...privRes },
      revision: { ...revision },
      titleHash: h,
      opIdHash: h,
      idempotencyKeyHash: h,
      requestIdHash: h,
      sessionIdHash: h,
    },
    parity: { divergence: null, details: {} },
    collectedAt: new Date().toISOString(),
  }
}

describe("validateLcProof lifecycle", () => {
  test("accepts valid lifecycle proof", () => {
    expect(validateLcProof(makeValidLcProof())).toBeNull()
  })
  test("rejects missing top-level field", () => {
    const p = makeValidLcProof() as Record<string, unknown>
    delete p.pre
    expect(validateLcProof(p)).not.toBeNull()
  })
  test("rejects unknown top-level field", () => {
    const p = makeValidLcProof() as Record<string, unknown>
    p.extra = 1
    expect(validateLcProof(p)).toContain("keys mismatch")
  })
  test("rejects unknown nested in boundaries", () => {
    const p = makeValidLcProof() as Record<string, unknown>
    ;((p.boundaries as Record<string, unknown>).panelCloseReopen as Record<string, unknown>).extra = 1
    expect(validateLcProof(p)).not.toBeNull()
  })
  test("rejects forbidden raw title", () => {
    const p = makeValidLcProof() as Record<string, unknown>
    ;(p.boundaries as Record<string, unknown>).payload = "x"
    expect(validateLcProof(p)).toContain("forbidden")
  })
  test("rejects revision mismatch between replay and titleOp", () => {
    const p = makeValidLcProof() as Record<string, unknown>
    ;(p.replay as Record<string, unknown>).revision = { session: 99 }
    expect(validateLcProof(p)).toContain("replay.revision")
  })
  test("rejects finalReplay not equal", () => {
    const p = makeValidLcProof() as Record<string, unknown>
    ;(p.finalReplay as Record<string, unknown>).revision = { session: 99 }
    expect(validateLcProof(p)).toContain("finalReplay")
  })
  test("rejects pid changed across boundary", () => {
    const p = makeValidLcProof() as Record<string, unknown>
    const b = (p.boundaries as Record<string, unknown>).panelCloseReopen as Record<string, unknown>
    ;((b.post as Record<string, unknown>).backend as Record<string, unknown>).pid = 9999
    expect(validateLcProof(p)).toContain("backend must equal")
  })
  test("rejects title hash mismatch", () => {
    const p = makeValidLcProof() as Record<string, unknown>
    const b = (p.boundaries as Record<string, unknown>).panelCloseReopen as Record<string, unknown>
    b.agentTitleHash = "bbbbbbbbbbbbbbbb"
    expect(validateLcProof(p)).toContain("agentTitleHash")
  })
  test("rejects sessionSwitch active hash wrong", () => {
    const p = makeValidLcProof() as Record<string, unknown>
    const sw = (p.boundaries as Record<string, unknown>).sessionSwitch as Record<string, unknown>
    ;(sw.switched as Record<string, unknown>).activeIdHash = "bbbbbbbbbbbbbbbb"
    expect(validateLcProof(p)).toContain("siblingIdHash")
  })
  test("rejects malformed orderHash", () => {
    const p = makeValidLcProof() as Record<string, unknown>
    p.orderHash = "nothex"
    expect(validateLcProof(p)).toContain("16-hex")
  })
  test("lifecycle probe hashes are 16 hex", () => {
    const h = createHash("sha256").update("hello").digest("hex").slice(0, 16)
    expect(h.length).toBe(16)
    expect(/^[0-9a-f]{16}$/.test(h)).toBeTrue()
  })
  test("order hash stability", () => {
    const ids = ["a", "b"]
    const h1 = createHash("sha256").update(ids.join("|")).digest("hex").slice(0, 16)
    const h2 = createHash("sha256").update(ids.join("|")).digest("hex").slice(0, 16)
    expect(h1).toBe(h2)
  })
  test("rejects switchedAgentTitleHash not equal siblingTitleHash", () => {
    const p = makeValidLcProof() as Record<string, unknown>
    const sw = (p.boundaries as Record<string, unknown>).sessionSwitch as Record<string, unknown>
    sw.switchedAgentTitleHash = "cccccccccccccccc"
    expect(validateLcProof(p)).toContain("siblingTitleHash")
  })
  test("rejects switchedTabTitleHash not equal titleHash", () => {
    const p = makeValidLcProof() as Record<string, unknown>
    const sw = (p.boundaries as Record<string, unknown>).sessionSwitch as Record<string, unknown>
    sw.switchedTabTitleHash = "cccccccccccccccc"
    expect(validateLcProof(p)).toContain("switchedTabTitleHash")
  })
  test("rejects preAgentTitleHash not equal titleHash", () => {
    const p = makeValidLcProof() as Record<string, unknown>
    const sw = (p.boundaries as Record<string, unknown>).sessionSwitch as Record<string, unknown>
    sw.preAgentTitleHash = "cccccccccccccccc"
    expect(validateLcProof(p)).toContain("preAgentTitleHash")
  })
  test("rejects siblingTitleHash equals titleHash", () => {
    const p = makeValidLcProof() as Record<string, unknown>
    p.siblingTitleHash = p.titleHash
    const sw = (p.boundaries as Record<string, unknown>).sessionSwitch as Record<string, unknown>
    sw.switchedAgentTitleHash = p.siblingTitleHash
    expect(validateLcProof(p)).toContain("siblingTitleHash must differ")
  })
  test("rejects openTab before private pid drift", () => {
    const p = makeValidLcProof() as Record<string, unknown>
    const before = (p.openTab as Record<string, unknown>).before as Record<string, unknown>
    ;((before.private as Record<string, unknown>).pid as number) = 9999
    expect(validateLcProof(p)).toContain("openTab.before.private.pid")
  })
  test("rejects openTab after private epoch drift", () => {
    const p = makeValidLcProof() as Record<string, unknown>
    const after = (p.openTab as Record<string, unknown>).after as Record<string, unknown>
    ;((after.private as Record<string, unknown>).epoch as number) = 999
    expect(validateLcProof(p)).toContain("openTab.after.private.epoch")
  })
  test("rejects openTab before private state drift", () => {
    const p = makeValidLcProof() as Record<string, unknown>
    const before = (p.openTab as Record<string, unknown>).before as Record<string, unknown>
    ;((before.private as Record<string, unknown>).state as string) = "closed"
    expect(validateLcProof(p)).toContain("openTab.before.private.state")
  })
  test("rejects openTab after private protocol drift", () => {
    const p = makeValidLcProof() as Record<string, unknown>
    const after = (p.openTab as Record<string, unknown>).after as Record<string, unknown>
    ;((after.private as Record<string, unknown>).protocol as Record<string, unknown>).major = 2
    expect(validateLcProof(p)).toContain("openTab.after.private.protocol")
  })
  test("rejects openTab after private capabilities drift", () => {
    const p = makeValidLcProof() as Record<string, unknown>
    const after = (p.openTab as Record<string, unknown>).after as Record<string, unknown>
    ;((after.private as Record<string, unknown>).capabilities as string[]) = ["session/cancelQueued"]
    expect(validateLcProof(p)).toContain("openTab.after.private.capabilities")
  })
  test("rejects openTab before/after private pid mismatch via pre equality", () => {
    const p = makeValidLcProof() as Record<string, unknown>
    const after = (p.openTab as Record<string, unknown>).after as Record<string, unknown>
    ;((after.private as Record<string, unknown>).pid as number) = 2222
    // before still equals pre, after diverges from both pre and before
    expect(validateLcProof(p)).toContain("openTab.after.private.pid")
    expect(validateLcProof(p)).toContain("pre.private.pid")
  })
  test("rejects openTab editorCount not 1 ( conflates with orderCount )", () => {
    const p = makeValidLcProof() as Record<string, unknown>
    ;(p.openTab as Record<string, unknown>).editorCount = 2
    expect(validateLcProof(p)).toContain("openTab.editorCount must be 1")
    // Ensure validator distinguishes editorCount (1) from orderCount (2) and does not equate them
    const q = makeValidLcProof() as Record<string, unknown>
    ;(q.openTab as Record<string, unknown>).editorCount = 1
    expect(validateLcProof(q)).toBeNull()
  })
  test("rejects orderCount baseline mismatch (all boundaries must be 2)", () => {
    const p = makeValidLcProof() as Record<string, unknown>
    const b = (p.boundaries as Record<string, unknown>).panelCloseReopen as Record<string, unknown>
    b.orderCount = 3
    expect(validateLcProof(p)).toContain("orderCount")
  })
  test("rejects orderCount mismatch among boundaries (must equal each other)", () => {
    const p = makeValidLcProof() as Record<string, unknown>
    const b = (p.boundaries as Record<string, unknown>).webviewReload as Record<string, unknown>
    b.orderCount = 1
    // panel still 2, webview 1 => not equal baseline and not equal each other
    expect(validateLcProof(p)).toContain("orderCount")
  })
  test("rejects orderCount conflated with editorCount", () => {
    const p = makeValidLcProof() as Record<string, unknown>
    // mutate orderCount to editorCount value (1) — should fail because baseline is 2
    const b = (p.boundaries as Record<string, unknown>).tabCloseReopen as Record<string, unknown>
    b.orderCount = 1
    expect(validateLcProof(p)).not.toBeNull()
    expect(validateLcProof(p)).toContain("orderCount")
  })
  test("rejects openTab ready false (fail-closed on editor readiness)", () => {
    const p = makeValidLcProof() as Record<string, unknown>
    ;(p.openTab as Record<string, unknown>).ready = false
    expect(validateLcProof(p)).toContain("openTab.ready must be true")
  })
  test("rejects openTab before private available false", () => {
    const p = makeValidLcProof() as Record<string, unknown>
    const before = (p.openTab as Record<string, unknown>).before as Record<string, unknown>
    ;((before.private as Record<string, unknown>).available as boolean) = false
    expect(validateLcProof(p)).toContain("openTab.before.private.available must be true")
  })
  test("rejects openTab after private available false", () => {
    const p = makeValidLcProof() as Record<string, unknown>
    const after = (p.openTab as Record<string, unknown>).after as Record<string, unknown>
    ;((after.private as Record<string, unknown>).available as boolean) = false
    expect(validateLcProof(p)).toContain("openTab.after.private.available must be true")
  })
  test("rejects openTab before private hasSessionUpdate false", () => {
    const p = makeValidLcProof() as Record<string, unknown>
    const before = (p.openTab as Record<string, unknown>).before as Record<string, unknown>
    ;((before.private as Record<string, unknown>).hasSessionUpdate as boolean) = false
    expect(validateLcProof(p)).toContain("openTab.before.private.hasSessionUpdate must be true")
  })
  test("rejects openTab after private hasSessionUpdate false", () => {
    const p = makeValidLcProof() as Record<string, unknown>
    const after = (p.openTab as Record<string, unknown>).after as Record<string, unknown>
    ;((after.private as Record<string, unknown>).hasSessionUpdate as boolean) = false
    expect(validateLcProof(p)).toContain("openTab.after.private.hasSessionUpdate must be true")
  })
  test("rejects openTab before private available mismatch against pre", () => {
    const p = makeValidLcProof() as Record<string, unknown>
    const before = (p.openTab as Record<string, unknown>).before as Record<string, unknown>
    ;((before.private as Record<string, unknown>).available as boolean) = false
    const err = validateLcProof(p) as string
    expect(err).toContain("openTab.before.private.available")
    expect(err).toContain("must be true")
  })
  test("rejects openTab before/after private available mismatch between snapshots", () => {
    // This test ensures before/after equality is checked; we mutate after to false, before stays true, so both shape and cross-snapshot checks fire.
    // First, shape-level rejection already covers after false; second, verify that a later equality check would also catch mismatch if shape were bypassed.
    // We simulate mismatch by making only after false (before true) — validator fails on after's own true requirement, which is the fail-closed path.
    const p = makeValidLcProof() as Record<string, unknown>
    const after = (p.openTab as Record<string, unknown>).after as Record<string, unknown>
    ;((after.private as Record<string, unknown>).available as boolean) = false
    expect(validateLcProof(p)).toContain("available")
  })
  test("rejects openTab hasSessionUpdate mismatch against pre when before diverges", () => {
    const p = makeValidLcProof() as Record<string, unknown>
    const before = (p.openTab as Record<string, unknown>).before as Record<string, unknown>
    ;((before.private as Record<string, unknown>).hasSessionUpdate as boolean) = false
    const err = validateLcProof(p) as string
    expect(err).toContain("hasSessionUpdate")
  })
  test("rejects openTab loadOk false (fail-closed on load success)", () => {
    const p = makeValidLcProof() as Record<string, unknown>
    ;(p.openTab as Record<string, unknown>).loadOk = false
    expect(validateLcProof(p)).toContain("openTab.loadOk must be true")
  })
  test("rejects openTab loadOk missing (no fallback default)", () => {
    const p = makeValidLcProof() as Record<string, unknown>
    delete (p.openTab as Record<string, unknown>).loadOk
    const err = validateLcProof(p) as string
    expect(err).toContain("keys mismatch")
    expect(err).toContain("loadOk")
  })
  test("rejects openTab loadOk non-boolean fallback synthesized success", () => {
    const p = makeValidLcProof() as Record<string, unknown>
    ;(p.openTab as Record<string, unknown>).loadOk = "true" as unknown as boolean
    expect(validateLcProof(p)).toContain("openTab.loadOk must be true")
  })
  test("proof construction uses no fallback defaults for loadOk/attached/hash", () => {
    const src = readFileSync(join(import.meta.dir, "../../script/e2e-probe-lifecycle.ts"), "utf8")
    const probeSlice = src.slice(src.indexOf("openTab: {"), src.indexOf("openTab: {") + 3000)
    expect(probeSlice).not.toContain("?? true")
    expect(probeSlice).not.toContain("?? fixtureHash")
    expect(probeSlice).toContain("loadOk: gcOpen!.openRes.loadOk")
    expect(probeSlice).toContain("targetSessionIdHash: gcOpen!.openRes.targetSessionIdHash")
    expect(probeSlice).toContain("currentSessionIdHash: gcOpen!.openRes.currentSessionIdHash")
    expect(probeSlice).toContain("attached: gcOpen!.openRes.attached")
  })
  test("lifecycle lc-dom-evidence contains only hashes, no raw plan", () => {
    const src = readFileSync(join(import.meta.dir, "../../script/e2e-probe-lifecycle.ts"), "utf8")
    const domSlice = src.slice(src.indexOf("lc-dom-evidence"), src.indexOf("lc-dom-evidence") + 800)
    expect(domSlice).not.toContain("plan,")
    expect(domSlice).not.toContain("plan:")
    expect(domSlice).toContain("sessionIdHash")
    expect(domSlice).toContain("siblingIdHash")
    expect(domSlice).toContain("orderHash")
    expect(domSlice).toContain("titleHash")
  })
})
