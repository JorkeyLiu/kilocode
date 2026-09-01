import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const pkgPath = join(import.meta.dir, "../../package.json")
const runnerPath = join(import.meta.dir, "../../tests/e2e/runner.ts")

describe("runner real-lifecycle contract", () => {
  test("package script test:e2e:real-lifecycle exists and follows scenario launch pattern", () => {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts: Record<string, string> }
    const script = pkg.scripts["test:e2e:real-lifecycle"]
    expect(script).toBe("KILO_E2E_SCENARIO=real-lifecycle node script/e2e-probe-launch.mjs")
    // pattern must exactly match sibling scripts
    expect(pkg.scripts["test:e2e:real-session"]).toBe("KILO_E2E_SCENARIO=real-session node script/e2e-probe-launch.mjs")
  })

  test("runner ScenarioFlags includes runRealLifecycle", () => {
    const src = readFileSync(runnerPath, "utf8")
    expect(src).toContain("runRealLifecycle: boolean")
    expect(src).toContain('runRealLifecycle: scenario === "real-lifecycle"')
  })

  test("runner scenario allowlist includes real-lifecycle", () => {
    const src = readFileSync(runnerPath, "utf8")
    expect(src).toContain('"real-lifecycle"')
    // must be in supported set
    const hasSupported = src.includes("supported = new Set([") && src.includes('"real-lifecycle"')
    expect(hasSupported).toBeTrue()
  })

  test("runner dispatch calls serviceRealLifecycleBoundary", () => {
    const src = readFileSync(runnerPath, "utf8")
    expect(src).toContain("serviceRealLifecycleBoundary")
    expect(src).toContain("if (runRealLifecycle)")
    // must not invoke restart commands
    const fnStart = src.indexOf("async function serviceRealLifecycleBoundary")
    const fnSlice = src.slice(fnStart, fnStart + 8000)
    expect(fnSlice).not.toContain("reloadWindow")
    expect(fnSlice).not.toContain("killServer")
    expect(fnSlice).not.toContain("reconnectServer")
  })

  test("runner lc-reload uses targeted AM reload and forbids global webview reload", () => {
    const src = readFileSync(runnerPath, "utf8")
    const fnStart = src.indexOf("async function serviceRealLifecycleBoundary")
    const fnSlice = src.slice(fnStart, fnStart + 15000)
    // targeted fixture reload (via CMD_RELOAD_AM constant which maps to reloadAgentManagerWebview)
    const hasTargeted = fnSlice.includes("reloadAgentManagerWebview") || fnSlice.includes("CMD_RELOAD_AM")
    expect(hasTargeted).toBeTrue()
    expect(fnSlice).toContain("lc-reload-request")
    expect(fnSlice).toContain("lc-reload-ready")
    // lc-reload block must not contain global webview reload action
    const lcIdx = fnSlice.indexOf("lc-reload-request")
    const lcBlock = fnSlice.slice(lcIdx, lcIdx + 3000)
    expect(lcBlock).not.toContain("workbench.action.webview.reloadWebviewAction")
    expect(lcBlock).not.toContain("reloadWindow")
    // targeted settle after reload, no synthetic injection
    expect(lcBlock).toContain("CMD_SETTLE")
    // ensure no synthetic session posts in reload block
    expect(lcBlock).not.toContain("sessionsLoaded")
    expect(lcBlock).not.toContain("sessionCreated")
  })

  test("runner writes lc-ready and services all probe markers via helpers", () => {
    const src = readFileSync(runnerPath, "utf8")
    const fnStart = src.indexOf("async function serviceRealLifecycleBoundary")
    const fnSlice = src.slice(fnStart, fnStart + 15000)
    // Service delegates open/reopen to helpers; helpers own the marker literals
    expect(fnSlice).toContain("handleLcOpenTabRequest")
    expect(fnSlice).toContain("handleLcTabReopenRequest")
    const openStart = src.indexOf("async function handleLcOpenTabRequest")
    const openSlice = src.slice(openStart, openStart + 8000)
    expect(openSlice).toContain("lc-open-tab-request")
    expect(openSlice).toContain("lc-open-tab.json")
    const reopenStart = src.indexOf("async function handleLcTabReopenRequest")
    const reopenSlice = src.slice(reopenStart, reopenStart + 8000)
    expect(reopenSlice).toContain("lc-tab-reopen-request")
    expect(reopenSlice).toContain("lc-tab-reopen-done")
    // Service still directly services remaining markers
    expect(fnSlice).toContain("lc-ready")
    expect(fnSlice).toContain("lc-cstate-request")
    expect(fnSlice).toContain("lc-credential.json")
    expect(fnSlice).toContain("lc-private-status-request")
    expect(fnSlice).toContain("lc-title-request")
    expect(fnSlice).toContain("lc-replay-request")
    expect(fnSlice).toContain("lc-snap-")
    expect(fnSlice).toContain("lc-panel-close-request")
    expect(fnSlice).toContain("lc-reload-request")
    expect(fnSlice).toContain("lc-tab-close-request")
    expect(fnSlice).toContain("writeLlmRequestsEvidence")
    expect(fnSlice).toContain("resetLlmRequests")
  })
})
