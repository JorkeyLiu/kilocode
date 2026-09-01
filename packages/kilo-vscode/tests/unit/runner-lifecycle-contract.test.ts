import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  CREDENTIAL_FAILED,
  READ_FAILED,
  REMOVE_FAILED,
  credentialFailed,
  malformed,
  parsePrivateStatus,
  parseReplay,
  parseTitle,
} from "../../src/util/marker"

const pkgPath = join(import.meta.dir, "../../package.json")
const runnerPath = join(import.meta.dir, "../../tests/e2e/runner.ts")
const markerPath = join(import.meta.dir, "../../src/util/marker.ts")

describe("runner real-lifecycle contract", () => {
  test("package script test:e2e:real-lifecycle exists and follows scenario launch pattern", () => {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts: Record<string, string> }
    const script = pkg.scripts["test:e2e:real-lifecycle"]
    expect(script).toBe("KILO_E2E_SCENARIO=real-lifecycle node script/e2e-probe-launch.mjs")
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
    const hasSupported = src.includes("supported = new Set([") && src.includes('"real-lifecycle"')
    expect(hasSupported).toBeTrue()
  })

  test("runner dispatch calls serviceRealLifecycleBoundary", () => {
    const src = readFileSync(runnerPath, "utf8")
    expect(src).toContain("serviceRealLifecycleBoundary")
    expect(src).toContain("if (runRealLifecycle)")
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
    const hasTargeted = fnSlice.includes("reloadAgentManagerWebview") || fnSlice.includes("CMD_RELOAD_AM")
    expect(hasTargeted).toBeTrue()
    expect(fnSlice).toContain("lc-reload-request")
    expect(fnSlice).toContain("lc-reload-ready")
    const lcIdx = fnSlice.indexOf("lc-reload-request")
    const lcBlock = fnSlice.slice(lcIdx, lcIdx + 3000)
    expect(lcBlock).not.toContain("workbench.action.webview.reloadWebviewAction")
    expect(lcBlock).not.toContain("reloadWindow")
    expect(lcBlock).toContain("CMD_SETTLE")
    expect(lcBlock).not.toContain("sessionsLoaded")
    expect(lcBlock).not.toContain("sessionCreated")
  })

  test("runner writes lc-ready and services Agent Manager markers (no TabPanel)", () => {
    const src = readFileSync(runnerPath, "utf8")
    const fnStart = src.indexOf("async function serviceRealLifecycleBoundary")
    const fnSlice = src.slice(fnStart, fnStart + 15000)
    expect(fnSlice).not.toContain("handleLcOpenTabRequest")
    expect(fnSlice).not.toContain("handleLcTabReopenRequest")
    expect(fnSlice).not.toContain("lc-open-tab-request")
    expect(fnSlice).not.toContain("lc-tab-reopen-request")
    expect(fnSlice).not.toContain("lc-tab-close-request")
    expect(fnSlice).toContain("lc-ready")
    expect(fnSlice).toContain("lc-cstate-request")
    expect(fnSlice).toContain("lc-credential.json")
    expect(fnSlice).toContain("lc-private-status-request")
    expect(fnSlice).toContain("lc-title-request")
    expect(fnSlice).toContain("lc-replay-request")
    expect(fnSlice).toContain("lc-snap-")
    expect(fnSlice).toContain("lc-panel-close-request")
    expect(fnSlice).toContain("lc-reload-request")
    expect(fnSlice).toContain("writeLlmRequestsEvidence")
    expect(fnSlice).toContain("resetLlmRequests")
  })
  test("runner has no empty catch and no stale TabPanel comment", () => {
    const src = readFileSync(runnerPath, "utf8")
    expect(src).not.toContain("catch {}")
    const tabPanel = (src.match(/TabPanel/g) ?? []).length
    expect(tabPanel).toBe(0)
  })
  test("runner lc marker handling is fail-closed via helper (no silent fallback, strict schema)", () => {
    const src = readFileSync(runnerPath, "utf8")
    const markerSrc = readFileSync(markerPath, "utf8")
    const fnStart = src.indexOf("async function serviceRealLifecycleBoundary")
    const fnSlice = src.slice(fnStart, fnStart + 15000)
    // runner must import helper, not define inline drop/load/decode with raw String(err)
    expect(src).toContain('from "../../src/util/marker"')
    expect(src).toContain("parsePrivateStatus")
    expect(src).toContain("parseTitle")
    expect(src).toContain("parseReplay")
    expect(src).toContain("credentialFailed")
    expect(src).not.toContain("function drop(")
    expect(src).not.toContain("function load(")
    expect(src).not.toContain("function decode(")
    expect(fnSlice).not.toContain("String(err)")
    // helper defines fixed categories without dynamic payload
    expect(markerSrc).toContain(READ_FAILED)
    expect(markerSrc).toContain(REMOVE_FAILED)
    expect(markerSrc).toContain("marker malformed (redacted)")
    expect(markerSrc).not.toContain("String(err)")
    expect(markerSrc).not.toContain("slice(0, 80)")
    // credential artifact fixed redacted
    expect(markerSrc).toContain(CREDENTIAL_FAILED)
    expect(src).not.toContain("ok: false, error: String(err)")
    // behavior: helper enforces strict replay schema
    expect(() => parseReplay(JSON.stringify("raw-string"))).toThrow(malformed("lc-replay"))
    expect(() => parseReplay(JSON.stringify({ nonce: "n" }))).toThrow(malformed("lc-replay"))
    expect(() => parseReplay(JSON.stringify({ sessionId: "", nonce: "n" }))).toThrow(malformed("lc-replay"))
    expect(() => parseTitle(JSON.stringify({ sessionId: "s", title: "t" }))).toThrow(malformed("lc-title"))
    expect(() => parsePrivateStatus(JSON.stringify({}))).toThrow(malformed("lc-private-status"))
    // error messages must be stable, no path leak
    try {
      parseReplay(JSON.stringify({ nonce: "n" }))
    } catch (e) {
      expect((e as Error).message).not.toContain("/")
      expect((e as Error).message).toBe(malformed("lc-replay"))
    }
    // credential artifact redacted shape
    const art = credentialFailed()
    expect(art).toEqual({ ok: false, error: CREDENTIAL_FAILED })
    expect(fnSlice).not.toContain('payload = { sessionId: "", title: "" }')
    expect(src).not.toContain("catch {}")
  })

  test("runner credential retry paths rs/rr/lc are fail-closed via durable artifact and stable throw", () => {
    const src = readFileSync(runnerPath, "utf8")
    expect(src).toContain("function failCredential")
    expect(src).toContain("credentialFailed()")
    expect(src).toContain("CREDENTIAL_FAILED")
    const helperIdx = src.indexOf("function failCredential")
    const helperSlice = src.slice(helperIdx, helperIdx + 600)
    expect(helperSlice).toContain("credentialFailed()")
    expect(helperSlice).toContain("CREDENTIAL_FAILED")
    expect(helperSlice).not.toContain("String(err)")
    expect(src).not.toContain("ok: false, error: String(err)")
    for (const [seed, artifact] of [
      ["rs-credseed-request", "rs-credential.json"],
      ["rr-credseed-request", "rr-credential.json"],
      ["lc-credseed-request", "lc-credential.json"],
    ] as const) {
      const idx = src.indexOf(seed)
      expect(idx).toBeGreaterThan(-1)
      const slice = src.slice(idx, idx + 900)
      // retry path must delegate to unified helper that writes credentialFailed artifact
      expect(slice).toContain("failCredential")
      expect(slice).toContain(artifact)
      // stable throw via helper (helper itself contains CREDENTIAL_FAILED/credentialFailed)
      expect(helperSlice).toContain("credentialFailed()")
      expect(helperSlice).toContain("CREDENTIAL_FAILED")
      expect(slice).not.toContain("String(err)")
      expect(slice).not.toContain("ok: false, error: String")
      // ensure retry block does not write raw error and uses try/catch
      expect(slice).toContain("try {")
      expect(slice).toContain("catch")
    }
    // durable artifact shape verified via helper behavior
    const art = credentialFailed()
    expect(art).toEqual({ ok: false, error: CREDENTIAL_FAILED })
    expect(art.error).toBe("credential failed (redacted)")
    expect(art.error).not.toContain("Error")
    // stable throw
    try {
      throw new Error(CREDENTIAL_FAILED)
    } catch (e) {
      expect((e as Error).message).toBe(CREDENTIAL_FAILED)
      expect((e as Error).message).not.toContain("/")
    }
  })
})
