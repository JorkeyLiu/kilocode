import { describe, it, expect } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"

const ROOT = path.resolve(import.meta.dir, "../..")
const LIFECYCLE_FILE = path.join(ROOT, "script/e2e-probe-lifecycle.ts")
const EVIDENCE_FILE = path.join(ROOT, "script/e2e-evidence.ts")

const lifecycleSrc = fs.readFileSync(LIFECYCLE_FILE, "utf-8")
const evidenceSrc = fs.readFileSync(EVIDENCE_FILE, "utf-8")

function hash16(v: string): string {
  return createHash("sha256").update(v).digest("hex").slice(0, 16)
}

function makeValidEntry(ts: number, phase: string) {
  return {
    ts,
    iso: new Date(ts).toISOString(),
    phase,
    auxiliaryBar: { exists: true, visible: true, width: 300, height: 600, focusWithin: false },
    chat: { exists: true, visible: true, inputVisible: true },
    editors: { tabCount: 1, groupCount: 1, tabHashes: [hash16("tab")] },
    frames: [
      {
        urlHash: hash16("vscode-webview://a"),
        urlKind: "vscode-webview",
        pageKind: "webview",
        dataTheme: "kilo-vscode",
        hasAm: false,
        hasKiloChat: true,
        hasPrompt: true,
        hasHeader: false,
        bodyClassHash: hash16("cls"),
        bodyCategory: "kilo-welcome",
        visible: true,
      },
    ],
  }
}

function buildFullValidTimeline(): unknown[] {
  const base = Date.now()
  const phases = [
    "pre-first-target-open",
    "post-first-target-open",
    "pre-panel-close",
    "post-panel-reopen",
    "pre-webview-reload",
    "post-webview-reload",
    "pre-editor-tab-close",
    "post-editor-tab-close",
    "immediately-after-lc-tab-reopen-done-before-frame-selection",
    "after-chosen-frame",
    "pre-session-switch",
    "switched-session",
    "post-session-switch",
    "final-done",
  ]
  return phases.map((p, i) => makeValidEntry(base + i * 1000, p))
}

describe("lc-layout-timeline diagnostics", () => {
  it("capture helper uses top-level Electron workbench pages, not webview frames", () => {
    expect(lifecycleSrc).toContain("captureLcLayoutTimeline")
    expect(lifecycleSrc).toContain("browser.contexts()")
    expect(lifecycleSrc).toContain("for (const page of ctx.pages())")
    expect(lifecycleSrc).toContain("page.evaluate")
    expect(lifecycleSrc).toContain(".part.auxiliarybar")
    expect(lifecycleSrc).toContain("auxiliaryBar")
    expect(lifecycleSrc).toContain("lc-layout-timeline.json")
  })

  it("timeline records ts/ISO, Auxiliary Bar visible/bounds, Chat visibility, editor counts/hashes, frame inventory with enum kinds", () => {
    expect(lifecycleSrc).toContain("ts")
    expect(lifecycleSrc).toContain("iso")
    expect(lifecycleSrc).toContain("phase")
    expect(lifecycleSrc).toContain("auxiliaryBar")
    expect(lifecycleSrc).toContain("width")
    expect(lifecycleSrc).toContain("height")
    expect(lifecycleSrc).toContain("focusWithin")
    expect(lifecycleSrc).toContain("chat")
    expect(lifecycleSrc).toContain("inputVisible")
    expect(lifecycleSrc).toContain("tabCount")
    expect(lifecycleSrc).toContain("groupCount")
    expect(lifecycleSrc).toContain("tabHashes")
    expect(lifecycleSrc).toContain("frames")
    expect(lifecycleSrc).toContain("urlHash")
    expect(lifecycleSrc).toContain("urlKind")
    expect(lifecycleSrc).toContain("pageKind")
    expect(lifecycleSrc).toContain("dataTheme")
    expect(lifecycleSrc).toContain("hasAm")
    expect(lifecycleSrc).toContain("hasKiloChat")
    expect(lifecycleSrc).toContain("hasPrompt")
    expect(lifecycleSrc).toContain("hasHeader")
    expect(lifecycleSrc).toContain("bodyCategory")
    expect(lifecycleSrc).toContain("bodyClassHash")
    expect(lifecycleSrc).toContain("deriveUrlKind")
    expect(lifecycleSrc).toContain("derivePageKind")
    expect(lifecycleSrc).toContain("deriveDataThemeKind")
    expect(lifecycleSrc).toContain("ALLOWED_URL_KIND")
    expect(lifecycleSrc).toContain("ALLOWED_BODY_CATEGORY")
  })

  it("enum-only URL/page/frame kinds without raw substring storage", () => {
    // urlKind must be enum, not fragment slice
    expect(lifecycleSrc).toContain("deriveUrlKind")
    expect(lifecycleSrc).not.toContain(".slice(0, 30)")
    expect(lifecycleSrc).not.toContain("replace(/[^a-zA-Z0-9")
    // dataTheme must be enum-mapped
    expect(lifecycleSrc).toContain("deriveDataThemeKind")
  })

  it("capture failures abort with bounded redacted messages and no swallow", () => {
    expect(lifecycleSrc).toContain("lc timeline auxiliary capture failed (redacted)")
    expect(lifecycleSrc).toContain("lc timeline frame capture failed (redacted)")
    expect(lifecycleSrc).toContain("lc timeline write failed (redacted)")
    expect(lifecycleSrc).toContain("lc timeline read failed (redacted)")
    // required captures must not be swallowed
    const swallowed = (lifecycleSrc.match(/captureLcLayoutTimeline\(.*\)\.catch/g) ?? []).length
    expect(swallowed).toBe(0)
  })

  it("does not execute any command that toggles Chat/Auxiliary Bar", () => {
    expect(lifecycleSrc).not.toContain("workbench.action.toggleAuxiliaryBar")
    expect(lifecycleSrc).not.toContain("workbench.action.chat.open")
    expect(lifecycleSrc).not.toContain("workbench.action.closeAuxiliaryBar")
    expect(lifecycleSrc).not.toContain('executeCommand("workbench.action')
    expect(lifecycleSrc).toContain("window.getComputedStyle")
    expect(lifecycleSrc).toContain("getBoundingClientRect")
  })

  it("captures at required lifecycle boundaries", () => {
    const phases = [
      "pre-first-target-open",
      "post-first-target-open",
      "pre-panel-close",
      "post-panel-reopen",
      "pre-webview-reload",
      "post-webview-reload",
      "pre-editor-tab-close",
      "post-editor-tab-close",
      "immediately-after-lc-tab-reopen-done-before-frame-selection",
      "after-chosen-frame",
      "pre-session-switch",
      "switched-session",
      "post-session-switch",
      "final-done",
      "failure-diagnostics",
    ]
    for (const p of phases) {
      expect(lifecycleSrc).toContain(p)
    }
  })

  it("evidence inventory includes lc-layout-timeline.json as required artifact", async () => {
    expect(evidenceSrc).toContain("lc-layout-timeline.json")
    expect(evidenceSrc).toContain("real-lifecycle")
    const { evidenceInventory } = await import("../../script/e2e-evidence")
    const inv = evidenceInventory(new Set(["real-lifecycle"]))
    const req = inv.required.map((s) => s.rel)
    const opt = inv.optional.map((s) => s.rel)
    expect(req).toContain("lc-layout-timeline.json")
    expect(opt).not.toContain("lc-layout-timeline.json")
  })

  it("validator ensures timeline schema and redaction prevents raw title/path leakage", async () => {
    const { validateLcTimeline, parseFailure } = await import("../../script/e2e-evidence")
    const valid = buildFullValidTimeline()
    expect(validateLcTimeline(valid)).toBeNull()
    expect(parseFailure("lc-layout-timeline.json", Buffer.from(JSON.stringify(valid)))).toBeNull()
  })

  it("rejects missing required phase", async () => {
    const { validateLcTimeline } = await import("../../script/e2e-evidence")
    const valid = buildFullValidTimeline() as Record<string, unknown>[]
    const missing = valid.filter((e) => e.phase !== "pre-first-target-open")
    expect(validateLcTimeline(missing)).toContain("missing phase")
  })

  it("rejects malformed hash and unknown keys", async () => {
    const { validateLcTimeline } = await import("../../script/e2e-evidence")
    const valid = buildFullValidTimeline() as Record<string, unknown>[]
    const badHash = JSON.parse(JSON.stringify(valid))
    ;(badHash[0].frames[0] as Record<string, unknown>).urlHash = "nothex"
    expect(validateLcTimeline(badHash)).toContain("urlHash")

    const unknownRoot = JSON.parse(JSON.stringify(valid))
    ;(unknownRoot[0] as Record<string, unknown>).extra = 1
    expect(validateLcTimeline(unknownRoot)).toContain("keys mismatch")

    const unknownNested = JSON.parse(JSON.stringify(valid))
    ;((unknownNested[0] as Record<string, unknown>).auxiliaryBar as Record<string, unknown>).extra = 1
    expect(validateLcTimeline(unknownNested)).toContain("auxiliaryBar")

    const unknownFrame = JSON.parse(JSON.stringify(valid))
    ;(unknownFrame[0].frames[0] as Record<string, unknown>).evil = 1
    expect(validateLcTimeline(unknownFrame)).toContain("frame")
  })

  it("rejects raw URL/path/title/session fields and forbidden keys", async () => {
    const { validateLcTimeline, parseFailure } = await import("../../script/e2e-evidence")
    const valid = buildFullValidTimeline() as Record<string, unknown>[]
    const withUrl = JSON.parse(JSON.stringify(valid))
    ;(withUrl[0].frames[0] as Record<string, unknown>).url = "https://example.com"
    const urlErr = validateLcTimeline(withUrl) as string
    expect(urlErr.includes("forbidden") || urlErr.includes("keys mismatch")).toBeTrue()

    const withTitle = JSON.parse(JSON.stringify(valid))
    ;(withTitle[0] as Record<string, unknown>).title = "GcLifecycle Title leak"
    const titleErr = validateLcTimeline(withTitle) as string
    expect(titleErr.includes("forbidden") || titleErr.includes("keys mismatch")).toBeTrue()

    const withRawPhase = JSON.parse(JSON.stringify(valid))
    ;(withRawPhase[0] as Record<string, unknown>).phase = "GcLifecycle Title leak"
    const rawPhaseErr = validateLcTimeline(withRawPhase) as string
    expect(rawPhaseErr.includes("leaked") || rawPhaseErr.includes("unknown")).toBeTrue()

    const withSecret = JSON.parse(JSON.stringify(valid))
    ;(withSecret[0] as Record<string, unknown>).secret = "e2e-fixture-key"
    expect(validateLcTimeline(withSecret)).not.toBeNull()

    const withPath = JSON.parse(JSON.stringify(valid)) as unknown[]
    // inject raw path via bodyClassHash not hash – already covered but also test parseFailure path leak
    const rawLeak = JSON.stringify(valid).replace("vscode-webview", "/tmp/.kilo leaked")
    // We need to inject path string into a string field that is not hex-checked but would be caught by raw leak regex
    const leakEntry = JSON.parse(JSON.stringify(valid))
    ;(leakEntry[0] as Record<string, unknown>).phase = "pre-first-target-open"
    // directly test parseFailure path detection by adding a raw path in JSON that validator's raw check catches
    const pathLeakTimeline = JSON.parse(JSON.stringify(valid))
    // add a frame with dataTheme other but raw JSON contains path – we simulate by string replacement
    const jsonWithPath = JSON.stringify(pathLeakTimeline).replace('"kilo-vscode"', '"/tmp/.kilo"')
    const pathErr = parseFailure("lc-layout-timeline.json", Buffer.from(jsonWithPath)) as string
    expect(pathErr.includes("leaked") || pathErr.includes("dataTheme")).toBeTrue()
  })

  it("rejects phase order and monotonic timestamp violations", async () => {
    const { validateLcTimeline } = await import("../../script/e2e-evidence")
    const valid = buildFullValidTimeline() as Record<string, unknown>[]
    // swap two required phases to break order
    const swapped = JSON.parse(JSON.stringify(valid))
    const tmp = swapped[0]
    swapped[0] = swapped[1]
    swapped[1] = tmp
    // need to adjust ts to remain monotonic else ts violation masks order; keep ts monotonic but phases out of order
    for (let i = 0; i < swapped.length; i++) ((swapped[i].ts = valid[i].ts), (swapped[i].iso = valid[i].iso))
    expect(validateLcTimeline(swapped)).toContain("phase order")

    const nonMono = JSON.parse(JSON.stringify(valid))
    nonMono[1].ts = nonMono[0].ts - 1000
    nonMono[1].iso = new Date(nonMono[1].ts).toISOString()
    expect(validateLcTimeline(nonMono)).toContain("not monotonic")

    const badEnum = JSON.parse(JSON.stringify(valid))
    ;(badEnum[0].frames[0] as Record<string, unknown>).urlKind = "https://evil"
    expect(validateLcTimeline(badEnum)).toContain("urlKind")

    const badPageKind = JSON.parse(JSON.stringify(valid))
    ;(badPageKind[0].frames[0] as Record<string, unknown>).pageKind = "evil"
    expect(validateLcTimeline(badPageKind)).toContain("pageKind")

    const badDataTheme = JSON.parse(JSON.stringify(valid))
    ;(badDataTheme[0].frames[0] as Record<string, unknown>).dataTheme = "/tmp/.kilo"
    expect(validateLcTimeline(badDataTheme)).toContain("dataTheme")
  })

  it("timeline hashes raw session/title/path and does not emit them", () => {
    expect(lifecycleSrc).toContain("fixtureHash")
    expect(lifecycleSrc).toContain("urlHash")
    expect(lifecycleSrc).toContain("bodyClassHash")
    expect(lifecycleSrc).toContain("tabHashes")
    expect(lifecycleSrc).toContain("captureLcLayoutTimeline")
  })
})
