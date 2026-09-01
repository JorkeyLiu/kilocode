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
  const cloneB = () => ({ pid, port, epoch })
  const prPriv = () => ({ ...priv, protocol: { ...priv.protocol }, capabilities: [...priv.capabilities] })
  const siblingTitle = "bbbbbbbbbbbbbbbb"
  const sibHash = "bbbbbbbbbbbbbbbb"
  return {
    schema: "kilo-gc-lifecycle-proof/2",
    version: 2,
    scope: "real-lifecycle Gate C: Agent Manager lifecycle with stable identity and same-key replay",
    fixtureIdHash: h,
    sessionIdHash: h,
    siblingIdHash: sibHash,
    titleHash: h,
    siblingTitleHash: siblingTitle,
    orderHash: h,
    pre: { backend: cloneB(), private: prPriv() },
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
        titleHash: h,
      },
      webviewReload: {
        pre: { backend: cloneB(), private: prPriv() },
        post: { backend: cloneB(), private: prPriv() },
        orderHash: h,
        orderCount: 2,
        titleHash: h,
      },
      sessionSwitch: {
        pre: { backend: cloneB(), private: prPriv(), activeIdHash: h, titleHash: h },
        switched: { backend: cloneB(), private: prPriv(), activeIdHash: sibHash, titleHash: siblingTitle },
        post: { backend: cloneB(), private: prPriv(), activeIdHash: h, titleHash: h },
        orderHash: h,
        orderCount: 2,
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
    b.titleHash = "bbbbbbbbbbbbbbbb"
    expect(validateLcProof(p)).toContain("titleHash")
  })
  test("rejects sessionSwitch active hash wrong", () => {
    const p = makeValidLcProof() as Record<string, unknown>
    const sw = (p.boundaries as Record<string, unknown>).sessionSwitch as Record<string, unknown>
    ;(sw.switched as Record<string, unknown>).activeIdHash = "cccccccccccccccc"
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
  test("rejects switched titleHash not equal siblingTitleHash", () => {
    const p = makeValidLcProof() as Record<string, unknown>
    const sw = (p.boundaries as Record<string, unknown>).sessionSwitch as Record<string, unknown>
    ;(sw.switched as Record<string, unknown>).titleHash = "cccccccccccccccc"
    expect(validateLcProof(p)).toContain("siblingTitleHash")
  })
  test("rejects pre titleHash not equal titleHash", () => {
    const p = makeValidLcProof() as Record<string, unknown>
    const sw = (p.boundaries as Record<string, unknown>).sessionSwitch as Record<string, unknown>
    ;(sw.pre as Record<string, unknown>).titleHash = "cccccccccccccccc"
    expect(validateLcProof(p)).toContain("titleHash")
  })
  test("rejects siblingTitleHash equals titleHash", () => {
    const p = makeValidLcProof() as Record<string, unknown>
    p.siblingTitleHash = p.titleHash
    const sw = (p.boundaries as Record<string, unknown>).sessionSwitch as Record<string, unknown>
    ;(sw.switched as Record<string, unknown>).titleHash = p.siblingTitleHash
    expect(validateLcProof(p)).toContain("siblingTitleHash must differ")
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
    expect(validateLcProof(p)).toContain("orderCount")
  })
  test("rejects schema version mismatch", () => {
    const p = makeValidLcProof() as Record<string, unknown>
    p.schema = "kilo-gc-lifecycle-proof/1"
    expect(validateLcProof(p)).toContain("schema")
  })
  test("rejects missing tabCloseReopen is not required (only 3 boundaries)", () => {
    const p = makeValidLcProof() as Record<string, unknown>
    // Ensure old tabCloseReopen is rejected as unknown
    ;(p.boundaries as Record<string, unknown>).tabCloseReopen = {
      pre: { backend: { pid: 1234, port: 4321, epoch: 1 }, private: { pid: 1234, epoch: 1, available: true, hasSessionUpdate: true, state: "open", protocol: { name: "kilo-private", major: 1 }, capabilities: ["session/cancelQueued", "session/update"] } },
      post: { backend: { pid: 1234, port: 4321, epoch: 1 }, private: { pid: 1234, epoch: 1, available: true, hasSessionUpdate: true, state: "open", protocol: { name: "kilo-private", major: 1 }, capabilities: ["session/cancelQueued", "session/update"] } },
      orderHash: "aaaaaaaaaaaaaaaa",
      orderCount: 2,
      titleHash: "aaaaaaaaaaaaaaaa",
    }
    expect(validateLcProof(p)).toContain("keys mismatch")
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
  test("proof is Agent Manager only with no TabPanel fields", () => {
    const src = readFileSync(join(import.meta.dir, "../../script/e2e-probe-lifecycle.ts"), "utf8")
    expect(src).not.toContain("kiloTabPanelDomPredicate")
    expect(src).not.toContain("isKiloTabPanelFrame")
    expect(src).not.toContain("collectKiloTabPanelFrames")
    expect(src).not.toContain("tabCloseReopen")
    expect(src).not.toContain("agentTitleHash")
    expect(src).not.toContain("tabTitleHash")
    expect(src).toContain('schema: "kilo-gc-lifecycle-proof/2"')
    expect(src).toContain("sessionSwitch")
    expect(src).toContain("panelCloseReopen")
    expect(src).toContain("webviewReload")
  })
  test("rejects identical sessionIdHash and siblingIdHash (distinct identity required)", () => {
    const p = makeValidLcProof() as Record<string, unknown>
    p.siblingIdHash = p.sessionIdHash
    const sw = (p.boundaries as Record<string, unknown>).sessionSwitch as Record<string, unknown>
    ;(sw.switched as Record<string, unknown>).activeIdHash = p.siblingIdHash
    expect(validateLcProof(p)).toContain("must differ")
  })
  test("rejects 64-hex orderHash (producer is 16-hex only)", () => {
    const p = makeValidLcProof() as Record<string, unknown>
    const long = "a".repeat(64)
    p.orderHash = long
    const b = (p.boundaries as Record<string, unknown>).panelCloseReopen as Record<string, unknown>
    b.orderHash = long
    const w = (p.boundaries as Record<string, unknown>).webviewReload as Record<string, unknown>
    w.orderHash = long
    const sw = (p.boundaries as Record<string, unknown>).sessionSwitch as Record<string, unknown>
    sw.orderHash = long
    expect(validateLcProof(p)).toContain("16-hex")
  })
  test("rejects boundary 64-hex orderHash even when top-level is 16", () => {
    const p = makeValidLcProof() as Record<string, unknown>
    const long = "b".repeat(64)
    const b = (p.boundaries as Record<string, unknown>).panelCloseReopen as Record<string, unknown>
    b.orderHash = long
    expect(validateLcProof(p)).toContain("16-hex")
  })
})
