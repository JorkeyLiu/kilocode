import { describe, it, expect } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { Window } from "happy-dom"

const ROOT = path.resolve(import.meta.dir, "../..")
const LIFECYCLE_FILE = path.join(ROOT, "script/e2e-probe-lifecycle.ts")
const src = fs.readFileSync(LIFECYCLE_FILE, "utf-8")

function makeWindow(opts: {
  theme: string | null
  hasAm: boolean
  hasChat: boolean
  hasPrompt: boolean
  readyState: string
  bodyChildren: number
}): Window {
  const win = new Window()
  const doc = win.document
  if (opts.theme !== null) doc.documentElement.setAttribute("data-theme", opts.theme)
  else doc.documentElement.removeAttribute("data-theme")
  Object.defineProperty(doc, "readyState", { value: opts.readyState, writable: true, configurable: true })
  doc.body.innerHTML = ""
  if (opts.hasAm) {
    const el = doc.createElement("div")
    el.className = "am-layout"
    doc.body.appendChild(el)
  }
  if (opts.hasChat) {
    const el = doc.createElement("div")
    el.className = "chat-view"
    doc.body.appendChild(el)
  }
  if (opts.hasPrompt) {
    const el = doc.createElement("textarea")
    el.className = "prompt-input"
    doc.body.appendChild(el)
  }
  // ensure bodyChildren count
  while (doc.body.children.length < opts.bodyChildren) {
    const el = doc.createElement("div")
    el.textContent = "x"
    doc.body.appendChild(el)
  }
  while (doc.body.children.length > opts.bodyChildren && doc.body.children.length > 0) {
    doc.body.removeChild(doc.body.lastChild!)
  }
  return win
}

function runPredicate(win: Window, fn: () => boolean): boolean {
  const prevDoc = (globalThis as unknown as { document?: unknown }).document
  const prevWin = (globalThis as unknown as { window?: unknown }).window
  ;(globalThis as unknown as Record<string, unknown>).document = win.document
  ;(globalThis as unknown as Record<string, unknown>).window = win
  try {
    return fn()
  } finally {
    if (prevDoc === undefined) delete (globalThis as unknown as Record<string, unknown>).document
    else (globalThis as unknown as Record<string, unknown>).document = prevDoc
    if (prevWin === undefined) delete (globalThis as unknown as Record<string, unknown>).window
    else (globalThis as unknown as Record<string, unknown>).window = prevWin
  }
}

describe("frame predicate positive Kilo identity", () => {
  it("exports real DOM predicate helper and isKiloTabPanelFrame uses it", () => {
    expect(src).toContain("kiloTabPanelDomPredicate")
    expect(src).toContain("export function kiloTabPanelDomPredicate")
    expect(src).toContain("export async function isKiloTabPanelFrame")
    expect(src).toContain("frame.evaluate(kiloTabPanelDomPredicate)")
    expect(src).toContain('getAttribute("data-theme") !== "kilo-vscode"')
    expect(src).toContain(".am-layout")
    expect(src).toContain(".chat-view")
    expect(src).toContain("textarea.prompt-input")
    expect(src).toContain('document.readyState === "loading"')
  })

  it("countEditorTabs uses positive predicate, not hasHeader", () => {
    const countIdx = src.indexOf("async function countEditorTabs")
    const countBody = src.slice(countIdx, countIdx + 800)
    expect(countBody).toContain("collectKiloTabPanelFrames")
    expect(countBody).not.toContain("hasHeader")
    expect(countBody).not.toContain("task-header-title-label")
  })

  it("findEditorTabFrame uses positive predicate and fails closed on multiple", () => {
    const findIdx = src.indexOf("async function findEditorTabFrame")
    const findBody = src.slice(findIdx, findIdx + 1200)
    expect(findBody).toContain("collectKiloTabPanelFrames")
    expect(findBody).toContain("cand.length === 1")
    expect(findBody).toContain("cand.length > 1")
    expect(findBody).toContain("multiple Kilo TabPanel frames")
  })

  it("waitForEditorTabDisposed and waitForEditorTabReady use predicate", () => {
    const disposedIdx = src.indexOf("async function waitForEditorTabDisposed")
    const disposedBody = src.slice(disposedIdx, disposedIdx + 600)
    expect(disposedBody).toContain("countEditorTabs")

    const readyIdx = src.indexOf("async function waitForEditorTabReady")
    const readyBody = src.slice(readyIdx, readyIdx + 1500)
    expect(readyBody).toContain("collectKiloTabPanelFrames")
  })

  it("executes actual production predicate against representative DOM states", async () => {
    const { kiloTabPanelDomPredicate, isKiloTabPanelFrame } = await import("../../script/e2e-probe-lifecycle")

    // Kilo welcome: theme kilo, chat true, prompt true, no AM, ready, bodyChildren>0 => true even without header
    const welcomeWin = makeWindow({
      theme: "kilo-vscode",
      hasAm: false,
      hasChat: true,
      hasPrompt: true,
      readyState: "complete",
      bodyChildren: 3,
    })
    expect(runPredicate(welcomeWin, kiloTabPanelDomPredicate)).toBeTrue()

    // Kilo chat: same but header true (still predicate true)
    const kiloChatWin = makeWindow({
      theme: "kilo-vscode",
      hasAm: false,
      hasChat: true,
      hasPrompt: true,
      readyState: "complete",
      bodyChildren: 5,
    })
    // add header to verify it doesn't affect predicate (header not checked)
    const hdr = kiloChatWin.document.createElement("div")
    hdr.setAttribute("data-slot", "task-header-title-label")
    kiloChatWin.document.body.appendChild(hdr)
    expect(runPredicate(kiloChatWin, kiloTabPanelDomPredicate)).toBeTrue()

    // Multiple positive frames: each individually returns true – caller must fail closed on count>1
    const secondWin = makeWindow({
      theme: "kilo-vscode",
      hasAm: false,
      hasChat: true,
      hasPrompt: true,
      readyState: "complete",
      bodyChildren: 2,
    })
    expect(runPredicate(secondWin, kiloTabPanelDomPredicate)).toBeTrue()

    // Agent Manager: hasAm true => false
    const amWin = makeWindow({
      theme: "kilo-vscode",
      hasAm: true,
      hasChat: true,
      hasPrompt: true,
      readyState: "complete",
      bodyChildren: 5,
    })
    expect(runPredicate(amWin, kiloTabPanelDomPredicate)).toBeFalse()

    // Native Chat: theme not kilo => false (Chat/placeholder cannot match actual predicate)
    const nativeWin = makeWindow({
      theme: "vscode",
      hasAm: false,
      hasChat: true,
      hasPrompt: true,
      readyState: "complete",
      bodyChildren: 5,
    })
    expect(runPredicate(nativeWin, kiloTabPanelDomPredicate)).toBeFalse()

    // placeholder: no chat => false
    const placeholderWin = makeWindow({
      theme: "kilo-vscode",
      hasAm: false,
      hasChat: false,
      hasPrompt: false,
      readyState: "complete",
      bodyChildren: 0,
    })
    expect(runPredicate(placeholderWin, kiloTabPanelDomPredicate)).toBeFalse()

    // loading state => false
    const loadingWin = makeWindow({
      theme: "kilo-vscode",
      hasAm: false,
      hasChat: true,
      hasPrompt: true,
      readyState: "loading",
      bodyChildren: 3,
    })
    expect(runPredicate(loadingWin, kiloTabPanelDomPredicate)).toBeFalse()

    // empty body => false
    const emptyWin = makeWindow({
      theme: "kilo-vscode",
      hasAm: false,
      hasChat: true,
      hasPrompt: true,
      readyState: "complete",
      bodyChildren: 0,
    })
    expect(runPredicate(emptyWin, kiloTabPanelDomPredicate)).toBeFalse()

    // isKiloTabPanelFrame URL gate + predicate integration (Chat/placeholder cannot match actual predicate)
    const mockFrame = (url: string, w: Window) => ({
      url: () => url,
      evaluate: async (fn: () => unknown) => runPredicate(w, fn as () => boolean),
    })
    const validFrame = mockFrame("vscode-webview://kilo", welcomeWin) as unknown as import("@playwright/test").Frame
    expect(await isKiloTabPanelFrame(validFrame)).toBeTrue()
    const wrongUrlFrame = mockFrame("https://example.com", welcomeWin) as unknown as import("@playwright/test").Frame
    expect(await isKiloTabPanelFrame(wrongUrlFrame)).toBeFalse()
    const nativeFrame = mockFrame("vscode-webview://native", nativeWin) as unknown as import("@playwright/test").Frame
    expect(await isKiloTabPanelFrame(nativeFrame)).toBeFalse()
    const placeholderFrame = mockFrame(
      "vscode-webview://placeholder",
      placeholderWin,
    ) as unknown as import("@playwright/test").Frame
    expect(await isKiloTabPanelFrame(placeholderFrame)).toBeFalse()
    const amFrame = mockFrame("vscode-webview://am", amWin) as unknown as import("@playwright/test").Frame
    expect(await isKiloTabPanelFrame(amFrame)).toBeFalse()
  })

  it("never returns first arbitrary non-AM frame when multiple positive exist", () => {
    const findBody = src.slice(
      src.indexOf("async function findEditorTabFrame"),
      src.indexOf("async function findEditorTabFrame") + 1200,
    )
    expect(findBody).toContain("throw new Error")
    expect(findBody).toContain("multiple Kilo TabPanel frames")
  })

  it("header remains title assertion after target activation, not identity", () => {
    const observeIdx = src.indexOf("observeBothTitlesRequired")
    const observeBody = src.slice(observeIdx, observeIdx + 800)
    expect(observeBody).toContain("headerTitle")
    const predicateIdx = src.indexOf("export function kiloTabPanelDomPredicate")
    const predicateBody = src.slice(predicateIdx, predicateIdx + 800)
    expect(predicateBody).not.toContain("task-header-title-label")
  })

  it("New session helper re-acquires AM frame via findAgentManagerFrameAny (not stale frame)", async () => {
    const domSrc = fs.readFileSync(path.join(ROOT, "script/e2e-probe-dom.ts"), "utf-8")
    const idx = domSrc.indexOf("export async function clickRealNewSessionAction")
    expect(idx).toBeGreaterThan(-1)
    const slice = domSrc.slice(idx, idx + 4000)
    expect(slice).toContain("findAgentManagerFrameAny")
    expect(slice).not.toContain(".am-tab-add-split")

    // pure decision: hidden candidate fails, ambiguous fails, single visible picks role/fallback
    const { decideNewSessionCandidates } = await import("../../script/e2e-probe-dom")
    expect(
      (decideNewSessionCandidates({ roleCandidates: [{ visible: true }], fallbackCandidates: [] }) as { pick: string }).pick,
    ).toBe("role")
    expect(
      (decideNewSessionCandidates({ roleCandidates: [{ visible: false }], fallbackCandidates: [] }) as { error: string }).error,
    ).toContain("no visible")
    expect(
      (
        decideNewSessionCandidates({
          roleCandidates: [{ visible: true }, { visible: true }],
          fallbackCandidates: [],
        }) as { error: string }
      ).error,
    ).toContain("ambiguous")
    expect(
      (
        decideNewSessionCandidates({
          roleCandidates: [],
          fallbackCandidates: [{ visible: true }],
        }) as { pick: string }
      ).pick,
    ).toBe("fallback")
  })
})
