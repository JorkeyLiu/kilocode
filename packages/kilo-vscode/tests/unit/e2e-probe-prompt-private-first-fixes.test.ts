import { describe, expect, it } from "bun:test"
import { readFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isValidE2EScratch } from "../../src/util/e2e-fixture"

describe("prompt-private-first E2E-only lifecycle fixes", () => {
  it("e2e-probe.ts keeps prompt scratch only with explicit opt-in", () => {
    const src = readFileSync(join(import.meta.dirname, "../../script/e2e-probe.ts"), "utf8")
    // Must introduce explicit opt-in env and gate prompt failure retention on it
    expect(src).toContain("KILO_E2E_KEEP_PROMPT_ON_FAIL")
    expect(src).toContain("keepPromptOnFailOptIn")
    expect(src).toContain("shouldKeepPromptOnFail")
    // Default failure must not keep: keepRequested OR (promptFailed && optIn)
    expect(src).toContain("shouldKeep = keepRequested || shouldKeepPromptOnFail")
    expect(src).not.toContain("shouldKeep = keepRequested || promptFailedMarker\n")
    // Must preserve other keep envs unchanged
    expect(src).toContain("KILO_E2E_KEEP_SCRATCH")
    expect(src).toContain("KILO_E2E_KEEP_PROMPT")
    // Must log removable path when kept
    expect(src).toContain("to manually remove")
    expect(src).toContain("rm -rf")
    // Must still cleanup exact child/port before deletion decision
    const verifyAt = src.indexOf("async function verifyCleanup")
    const keepAt = src.indexOf("keepPromptOnFailOptIn")
    const rmAt = src.indexOf("rmSync(scratch")
    expect(verifyAt).toBeGreaterThan(-1)
    expect(keepAt).toBeGreaterThan(verifyAt)
    expect(rmAt).toBeGreaterThan(keepAt)
  })

  it("connection-service-observation-fixture.ts gates writeFixtureDiag on valid scratch", () => {
    const src = readFileSync(join(import.meta.dirname, "../../src/services/cli-backend/connection-service-observation-fixture.ts"), "utf8")
    expect(src).toContain("isValidE2EScratch")
    expect(src).toContain("function writeFixtureDiag")
    // Must reject invalid scratch, not just non-empty
    expect(src).toContain("if (!scratch || !isValidE2EScratch(scratch)) return")
    expect(src).not.toContain("if (!scratch) return\n  try {")
    // Import must include isValidE2EScratch alongside isE2EFixtureEnabled
    expect(src).toContain("isE2EFixtureEnabled, isValidE2EScratch")
  })

  it("isValidE2EScratch rejects arbitrary invalid scratch (write gate)", () => {
    const scratch = join(tmpdir(), "kilo-e2e-invalid-" + Date.now())
    // non-existent scratch without marker must be invalid, so gate would prevent write
    expect(isValidE2EScratch(scratch)).toBe(false)
    expect(isValidE2EScratch("/tmp")).toBe(false)
    expect(isValidE2EScratch("/tmp/kilo-e2e-")).toBe(false)
    expect(isValidE2EScratch(undefined)).toBe(false)
  })

  it("isValidE2EScratch allows valid scratch with marker (normal fixture path)", () => {
    const scratch = mkdtempSync(join(tmpdir(), "kilo-e2e-"))
    const fixtureId = "test-fixture-id"
    const prev = process.env.KILO_E2E_FIXTURE_ID
    const prevFix = process.env.KILO_E2E_FIXTURE
    try {
      process.env.KILO_E2E_FIXTURE_ID = fixtureId
      process.env.KILO_E2E_FIXTURE = "1"
      writeFileSync(join(scratch, "e2e-marker.json"), JSON.stringify({ v: 1, fixtureId }))
      expect(isValidE2EScratch(scratch)).toBe(true)
      expect(existsSync(join(scratch, "e2e-marker.json"))).toBe(true)
    } finally {
      if (prev) process.env.KILO_E2E_FIXTURE_ID = prev
      else delete process.env.KILO_E2E_FIXTURE_ID
      if (prevFix) process.env.KILO_E2E_FIXTURE = prevFix
      else delete process.env.KILO_E2E_FIXTURE
      rmSync(scratch, { recursive: true, force: true })
    }
  })
})
