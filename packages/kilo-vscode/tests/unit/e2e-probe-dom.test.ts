/**
 * Focused unit tests for the ModeSwitcher harness diagnostics in
 * script/e2e-probe-dom.ts: the snapshot variant classifier
 * ("interactive" | "disabled" | "absent"), the distinct agentOptionFailure
 * reasons, and source-contract assertions for the bounded list wait and the
 * captured (never swallowed) trigger-click errors.
 */

import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { agentOptionFailure, type ModeSwitcherSnapshot } from "../../script/e2e-probe-dom"

const interactive = (options: string[]): ModeSwitcherSnapshot => ({ triggerRendered: true, variant: "interactive", options })

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
      { triggerRendered: true, variant: "interactive", options: [], clickError: "ModeSwitcher trigger click failed: Timeout 5000ms exceeded" },
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
    const fn = src.slice(src.indexOf("export async function agentOptions"), src.indexOf("/**\n * Canonical-state probe"))
    const disabledAt = fn.indexOf("button[aria-disabled=\"true\"] .mode-switcher-trigger-label")
    const clickAt = fn.indexOf(".click({ timeout: 5_000 })")
    expect(disabledAt).toBeGreaterThan(-1)
    expect(clickAt).toBeGreaterThan(disabledAt)
  })
})
