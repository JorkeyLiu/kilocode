/**
 * P4.1 Immutable snapshot tests.
 */

import { describe, expect, it, beforeEach } from "bun:test"
import { snapshot as makeSnapshot, sameSnapshot } from "../../src/config/snapshot"
import { materialize, resetVersion } from "../../src/config/materialize"
import type { MaterializedConfig } from "../../src/config/types"

beforeEach(() => {
  resetVersion()
})

function makeConfig(model?: string): MaterializedConfig {
  const input = {
    global: model ? {
      scope: "global" as const,
      root: "/home/.config/kilo",
      raw: { model },
      provenance: { scope: "global" as const, canonicalPath: "/home/.config/kilo/kilo.jsonc", explicit: true, operator: "single" as const },
    } : null,
    project: null,
  }
  return materialize(input).config
}

describe("snapshot", () => {
  it("creates a snapshot from a materialized config", () => {
    const config = makeConfig("openai/gpt-4")
    const snap = makeSnapshot(config)

    expect(snap.config).toBe(config)
    expect(snap.generation).toBe(config.version)
    expect(snap.contentHash).toBe(config.contentHash)
  })

  it("snapshot retains exact reference to the config object", () => {
    const config = makeConfig("openai/gpt-4")
    const snap = makeSnapshot(config)

    // The snapshot holds a direct reference — no cloning
    expect(snap.config).toBe(config)
    expect(snap.config.value).toBe(config.value)
  })
})

describe("sameSnapshot", () => {
  it("returns true for snapshots with same generation and hash", () => {
    const config = makeConfig("openai/gpt-4")
    const a = makeSnapshot(config)
    const b = makeSnapshot(config)

    expect(sameSnapshot(a, b)).toBe(true)
  })

  it("returns false for different generations", () => {
    const a = makeSnapshot(makeConfig("openai/gpt-4"))
    const b = makeSnapshot(makeConfig("anthropic/claude-sonnet-4-20250514"))

    expect(sameSnapshot(a, b)).toBe(false)
  })
})
