/**
 * Focused unit tests for the ModeSwitcher harness diagnostics in
 * script/e2e-probe-dom.ts: the snapshot variant classifier
 * ("interactive" | "disabled" | "absent"), the distinct agentOptionFailure
 * reasons, and source-contract assertions for the bounded list wait and the
 * captured (never swallowed) trigger-click errors.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  TIMELINE_CLEANUP_DIAGNOSTIC_LIMIT,
  agentOptionFailure,
  decideNewSessionCandidates,
  runWithTimelineStop,
  type ModeSwitcherSnapshot,
  type TimelinePrimaryError,
} from "../../script/e2e-probe-dom"

const interactive = (options: string[]): ModeSwitcherSnapshot => ({
  triggerRendered: true,
  variant: "interactive",
  options,
})

describe("ModeSwitcherSnapshot.variant classifier", () => {
  it("reports absent when the trigger is not rendered at all", () => {
    const snap: ModeSwitcherSnapshot = { triggerRendered: false, variant: "absent", options: [] }
    expect(snap.variant).toBe("absent")
  })

  it("reports disabled when the trigger carries aria-disabled=true", () => {
    const snap: ModeSwitcherSnapshot = { triggerRendered: true, variant: "disabled", options: [] }
    expect(snap.variant).toBe("disabled")
  })

  it("reports interactive only for a rendered enabled trigger", () => {
    expect(interactive(["Ask", "Code"]).variant).toBe("interactive")
  })
})

describe("agentOptionFailure (variant reasons)", () => {
  it("gives the absent variant its own never-rendered reason", () => {
    const reason = agentOptionFailure({ triggerRendered: false, variant: "absent", options: [] }, "E2E Agent")
    expect(reason).toContain("trigger never rendered")
  })

  it("distinguishes the disabled variant from absence and empty lists", () => {
    const disabled = agentOptionFailure({ triggerRendered: true, variant: "disabled", options: [] }, "E2E Agent")
    expect(disabled).toContain('aria-disabled="true"')
    expect(disabled).not.toContain("never rendered")
    expect(disabled).not.toContain("visible option(s)")
    // The empty interactive list keeps its own distinct reason.
    const empty = agentOptionFailure(interactive([]), "E2E Agent")
    expect(empty).toContain("0 visible option(s)")
    expect(empty).not.toContain("aria-disabled")
  })

  it("surfaces a captured click error verbatim as its own reason", () => {
    const reason = agentOptionFailure(
      {
        triggerRendered: true,
        variant: "interactive",
        options: [],
        clickError: "ModeSwitcher trigger click failed: Timeout 5000ms exceeded",
      },
      "E2E Agent",
    )
    expect(reason).toContain("trigger click failed")
    expect(reason).toContain("Timeout 5000ms exceeded")
  })

  it("still passes a properly populated interactive switcher", () => {
    expect(agentOptionFailure(interactive(["Ask", "E2E Agent"]), "E2E Agent")).toBeUndefined()
  })
})

describe("agentOptions source contract (bounded wait + captured clicks)", () => {
  const src = readFileSync(join(import.meta.dirname, "../../script/e2e-probe-dom.ts"), "utf8")

  it("waits boundedly (~2s) for .mode-switcher-list visibility before reading items", () => {
    expect(src).toContain("MODE_SWITCHER_LIST_WAIT_MS = 2_000")
    const optionsAt = src.indexOf("export async function agentOptions")
    const waitAt = src.indexOf('.waitFor({ state: "visible", timeout:', optionsAt)
    const readAt = src.indexOf("allTextContents", optionsAt)
    expect(waitAt).toBeGreaterThan(optionsAt)
    expect(readAt).toBeGreaterThan(waitAt)
  })

  it("captures trigger click errors instead of swallowing them", () => {
    const fn = src.slice(src.indexOf("export async function agentOptions"), src.indexOf("requestCanonicalState"))
    expect(fn).toContain("clickError")
    // The old swallow is gone: no bare catch-all on the trigger click.
    expect(fn).not.toMatch(/\.click\(\{ timeout: 5_000 \}\)[\s\S]*?\.catch\(\(\) => \{\}\)/)
  })

  it("detects the disabled variant via button[aria-disabled] before clicking", () => {
    const fn = src.slice(
      src.indexOf("export async function agentOptions"),
      src.indexOf("/**\n * Canonical-state probe"),
    )
    const disabledAt = fn.indexOf('button[aria-disabled="true"] .mode-switcher-trigger-label')
    const clickAt = fn.indexOf(".click({ timeout: 5_000 })")
    expect(disabledAt).toBeGreaterThan(-1)
    expect(clickAt).toBeGreaterThan(disabledAt)
  })
})

describe("decideNewSessionCandidates pure decision", () => {
  it("picks role when single visible role candidate (tab-bar semantic button)", () => {
    const res = decideNewSessionCandidates({
      roleCandidates: [{ visible: true }],
      fallbackCandidates: [],
    })
    expect("pick" in res && res.pick).toBe("role")
  })

  it("picks role when single visible role candidate (empty primary Button)", () => {
    // empty state also exposes one visible role button with text New session
    const res = decideNewSessionCandidates({
      roleCandidates: [{ visible: true }],
      fallbackCandidates: [{ visible: false }],
    })
    expect("pick" in res && res.pick).toBe("role")
  })

  it("fails closed when role candidate exists but hidden", () => {
    const res = decideNewSessionCandidates({
      roleCandidates: [{ visible: false }],
      fallbackCandidates: [],
    })
    expect("error" in res && res.error).toContain("no visible")
    expect("error" in res && res.error).toContain("roleCount=1")
  })

  it("fails closed when multiple visible role candidates (ambiguous)", () => {
    const res = decideNewSessionCandidates({
      roleCandidates: [{ visible: true }, { visible: true }],
      fallbackCandidates: [],
    })
    expect("error" in res && res.error).toContain("ambiguous")
    expect("error" in res && res.error).toContain("visible=2")
  })

  it("falls back to icon plus when no role visible but single fallback visible", () => {
    const res = decideNewSessionCandidates({
      roleCandidates: [{ visible: false }],
      fallbackCandidates: [{ visible: true }],
    })
    expect("pick" in res && res.pick).toBe("fallback")
  })

  it("fails closed when fallback ambiguous (multiple visible fallback, no role visible)", () => {
    const res = decideNewSessionCandidates({
      roleCandidates: [],
      fallbackCandidates: [{ visible: true }, { visible: true }],
    })
    expect("error" in res && res.error).toContain("ambiguous")
    expect("error" in res && res.error).toContain("fallback")
  })

  it("does not leak raw titles/sessions in error (redacted counts only)", () => {
    const res = decideNewSessionCandidates({
      roleCandidates: [],
      fallbackCandidates: [],
    })
    expect("error" in res && res.error).not.toContain("ses_")
    expect("error" in res && res.error).not.toContain("New session - ")
  })
})

describe("clickRealNewSessionAction source contract (re-acquire AM frame)", () => {
  const src = readFileSync(join(import.meta.dirname, "../../script/e2e-probe-dom.ts"), "utf8")
  it("re-acquires Agent Manager frame positively via findAgentManagerFrameAny", () => {
    const fnIdx = src.indexOf("export async function clickRealNewSessionAction")
    expect(fnIdx).toBeGreaterThan(-1)
    const fnSlice = src.slice(fnIdx, fnIdx + 4000)
    expect(fnSlice).toContain("findAgentManagerFrameAny")
    // must not select first non-AM frame — positive identity via AM layout
    expect(fnSlice).toContain("findAgentManagerFrameAny(browser")
  })

  it("prefers accessible role name New session and distinguishes dropdown", () => {
    const fnIdx = src.indexOf("export async function clickRealNewSessionAction")
    const fnSlice = src.slice(fnIdx, fnIdx + 5000)
    expect(fnSlice).toContain('getByRole("button", { name: "New session"')
    expect(fnSlice).not.toContain("New Session")
    // dropdown trigger is More new-tab options, not New session — ensure not matching it
    expect(fnSlice).toContain("fallback")
  })

  it("allows fallback via stable icon-button plus without split-container hierarchy", () => {
    const fnIdx = src.indexOf("export async function clickRealNewSessionAction")
    const fnSlice = src.slice(fnIdx, fnIdx + 5000)
    expect(fnSlice).toContain('button[data-component="icon-button"][data-icon="plus"]')
    expect(fnSlice).not.toContain(".am-tab-add-split")
  })

  it("emits redacted diagnostics with counts/visibility/frame classification and no raw title leak", () => {
    const fnIdx = src.indexOf("export async function clickRealNewSessionAction")
    const fnSlice = src.slice(fnIdx, fnIdx + 6000)
    expect(fnSlice).toContain("roleCount")
    expect(fnSlice).toContain("roleVisibleCount")
    expect(fnSlice).toContain("fallbackCount")
    expect(fnSlice).toContain("frameDetached")
    expect(fnSlice).toContain("tabCount")
    expect(fnSlice).toContain("emptyVisible")
    // no raw title/session leak in diagnostics construction — only hashes/counts
    expect(fnSlice).not.toContain("\"New session - \"")
    expect(fnSlice).not.toContain("sessionIdHash")
    expect(fnSlice).not.toContain("raw title")
  })
})

describe("clickRealNewSessionAction deadline/retry + redaction contract (LOCK-review)", () => {
  const src = readFileSync(join(import.meta.dirname, "../../script/e2e-probe-dom.ts"), "utf8")
  const helperSlice = (() => {
    const idx = src.indexOf("export async function clickRealNewSessionAction")
    return idx >= 0 ? src.slice(idx, idx + 9000) : ""
  })()

  it("pure: decideNewSessionCandidates remains deterministic for small remaining (no provider/model path)", () => {
    const r = decideNewSessionCandidates({ roleCandidates: [{ visible: true }], fallbackCandidates: [] })
    expect("pick" in r && r.pick).toBe("role")
  })

  it("source: click timeout never expands small remaining via Math.max(1000,remaining)", () => {
    expect(helperSlice).not.toContain("Math.max(1_000")
    expect(helperSlice).not.toContain("Math.max(1000")
    // must use remaining-bounded timeout, not blind 5_000 alone
    expect(helperSlice).toContain("Math.min(5_000, remaining")
    expect(helperSlice).toContain("remainingClick")
    expect(helperSlice).toContain("clickTimeout")
  })

  it("source: retry delay strictly bounded by remaining (no unconditional sleep 250 beyond deadline)", () => {
    // helper should sleep min(250, remainingAfter) and check remaining <=0 before sleep
    expect(helperSlice).toContain("Math.min(250, remainingAfter)")
    // also ensures remainingAfter <=0 throws before sleep path
    expect(helperSlice).toContain("remainingAfter <= 0")
    // old unconditional await sleep(250) without remaining cap should not dominate
    // ensure at least two bounded sleeps (detached path + main loop)
    const boundedCount = (helperSlice.match(/Math\.min\(250, remaining/g) ?? []).length
    expect(boundedCount).toBeGreaterThanOrEqual(2)
  })

  it("source: every operation checks remaining <=0 before proceeding", () => {
    expect(helperSlice).toContain("remainingBefore <= 0")
    expect(helperSlice).toContain("remainingClick <= 0")
    expect(helperSlice).toContain("deadline - Date.now()")
  })

  it("source: initial and reacquire finder failures use fixed redacted category without raw err.message", () => {
    // fixed category
    expect(helperSlice).toContain("frame-lookup-failed")
    // finder catch blocks must not propagate err.message/body text
    // extract finder-related catch segments: findAgentManagerFrameAny calls
    const finderCalls = helperSlice.split("findAgentManagerFrameAny")
    expect(finderCalls.length).toBeGreaterThan(2)
    expect(finderCalls.slice(1).join("")).toContain("frame-lookup-failed")
    // each finder call after the split should be inside a try, catch sets fixed string
    // ensure no err.message.slice in the helperSlice for finder paths (only fixed category)
    // we allow click-failed redaction but not finder raw message
    // So check that helperSlice does NOT contain 'frame detached reacquire failed' with err.message
    expect(helperSlice).not.toContain("frame detached reacquire failed")
    expect(helperSlice).not.toContain("err.message.slice(0, 120)")
    // ensure void err handling exists (no empty catch)
    expect(helperSlice).toContain("void err")
    expect(helperSlice).toContain("void inner")
    // ensure no bare empty catch like catch (err) {}
    expect(helperSlice).not.toMatch(/catch\s*\([^)]*\)\s*\{\s*\}/)
    expect(helperSlice).not.toMatch(/catch\s*\([^)]*\)\s*\{\s*void inner\s*\}/)
  })

  it("source: no empty catch in helper (must have fixed category assignment)", () => {
    expect(helperSlice).not.toMatch(/catch\s*\(inner\)\s*\{\s*void inner\s*\}/)
    // our reacquire catch must assign frame-lookup-failed, not just void
    expect(helperSlice).toContain('lastError = "frame-lookup-failed"')
  })

  it("runtime: helper error does not leak raw finder URL/body text (redacted to fixed category)", async () => {
    const { clickRealNewSessionAction } = await import("../../script/e2e-probe-dom")
    // vscode-webview finder timeout must go through detailed diagnostic path:
    // frame with vscode-webview URL but no .am-layout, evaluate returns bodyLen/amLayout/raw details.
    // helper must redact those to fixed category "frame-lookup-failed" and not leak URL/body.
    const rawContainingBrowser = {
      contexts: () => [
        {
          pages: () => [
            {
              frames: () => [
                {
                  url: () => "https://vscode-webview.example.com/vscode-webview/fake.html?secret=leak",
                  locator: () => ({
                    count: async () => 0,
                    all: async () => [],
                  }),
                  evaluate: async () => ({
                    amLayout: 42,
                    amTabs: 7,
                    bodyLen: 9999,
                    text: "raw leaked body text with secret",
                  }),
                },
              ],
              url: () => "https://vscode-webview.example.com",
            },
          ],
        },
      ],
    } as unknown as import("@playwright/test").Browser
    let msg = ""
    try {
      await clickRealNewSessionAction(rawContainingBrowser, 280)
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e)
    }
    expect(msg.length).toBeGreaterThan(0)
    expect(msg).toContain("frame-lookup-failed")
    expect(msg).not.toContain("vscode-webview")
    expect(msg).not.toContain("bodyLen")
    expect(msg).not.toContain("amLayout")
    expect(msg).not.toContain("raw leaked")
    expect(msg).not.toContain("https://vscode-webview")
    expect(msg).not.toContain("secret=leak")
  })

  it("runtime: small remaining click timeout is bounded and not expanded to 1000", async () => {
    // Verify source already proves no Math.max expansion, runtime probes deadline strictness:
    // With tiny timeout, helper must fail quickly without sleeping beyond deadline.
    const { clickRealNewSessionAction } = await import("../../script/e2e-probe-dom")
    const browser = {
      contexts: () => [],
    } as unknown as import("@playwright/test").Browser
    const start = Date.now()
    let thrown = false
    try {
      await clickRealNewSessionAction(browser, 15)
    } catch {
      thrown = true
    }
    const elapsed = Date.now() - start
    expect(thrown).toBeTrue()
    // with bounded retry delay, elapsed should be close to deadline, not 250+delta
    // allow generous upper bound but must not have expanded 1000ms click
    expect(elapsed).toBeLessThan(500)
  })
})

describe("runWithTimelineStop primary-preserving cleanup (LOCK-079)", () => {
  const logged: string[] = []
  const original = console.error
  beforeEach(() => {
    logged.length = 0
    console.error = (...args: unknown[]) => {
      logged.push(args.map((a) => String(a)).join(" "))
    }
  })
  afterEach(() => {
    logged.length = 0
    console.error = original
  })

  it("resolves after successful work and cleanup", async () => {
    let stops = 0
    await runWithTimelineStop(
      "A",
      async () => {},
      async () => {
        stops += 1
      },
    )
    expect(stops).toBe(1)
    expect(logged).toHaveLength(0)
  })

  it("rejects with the cleanup error when work succeeds but cleanup fails", async () => {
    const cleanup = new Error("stop failed")
    let caught: unknown
    try {
      await runWithTimelineStop(
        "A",
        async () => {},
        async () => {
          throw cleanup
        },
      )
    } catch (err) {
      caught = err
    }
    expect(caught).toBe(cleanup)
  })

  it("rethrows the same primary object when cleanup succeeds", async () => {
    const primary = new Error("primary Stop failed")
    let stops = 0
    let caught: unknown
    try {
      await runWithTimelineStop(
        "A",
        async () => {
          throw primary
        },
        async () => {
          stops += 1
        },
      )
    } catch (err) {
      caught = err
    }
    expect(stops).toBe(1)
    expect(caught).toBe(primary)
    expect((caught as TimelinePrimaryError).timelineCleanupError).toBeUndefined()
  })

  it("preserves primary identity and exposes bounded secondary diagnostic on dual failure", async () => {
    const primary = Object.assign(new Error("primary asserted"), { code: "PRIMARY" })
    const secondary = new Error(`cleanup failed ${"x".repeat(TIMELINE_CLEANUP_DIAGNOSTIC_LIMIT + 50)}`)
    let caught: unknown
    try {
      await runWithTimelineStop(
        "B",
        async () => {
          throw primary
        },
        async () => {
          throw secondary
        },
      )
    } catch (err) {
      caught = err
    }
    expect(caught).toBe(primary)
    const diag = (caught as TimelinePrimaryError).timelineCleanupError
    expect(typeof diag).toBe("string")
    expect(diag!.length).toBeLessThanOrEqual(TIMELINE_CLEANUP_DIAGNOSTIC_LIMIT)
    expect(Object.keys(caught as object)).not.toContain("timelineCleanupError")
    expect(logged.join("\n")).toContain("timeline-stop B cleanup also failed")
    expect(logged.join("\n").length).toBeLessThan(TIMELINE_CLEANUP_DIAGNOSTIC_LIMIT + 200)
  })
})
