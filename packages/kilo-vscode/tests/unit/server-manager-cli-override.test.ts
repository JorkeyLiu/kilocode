import { describe, expect, it } from "bun:test"
import { resolveCliPath } from "../../src/services/cli-backend/server-manager"

/**
 * Benchmark-only CLI snapshot override selection (KILO_P0_BACKEND_CLI).
 * Production behavior (no override) is unchanged: the bundled binary under the
 * extension dir is used. The override is honored only when explicitly set, so
 * the P0 harness can pin the immutable run-owned snapshot path without touching
 * product paths.
 */
describe("resolveCliPath (ServerManager benchmark CLI override)", () => {
  const snapshot = "/var/folders/kilo-p0-cli-abc/kilo"

  it("prefers the benchmark-only KILO_P0_BACKEND_CLI override when explicitly set", () => {
    expect(resolveCliPath("/ext", { KILO_P0_BACKEND_CLI: snapshot })).toBe(snapshot)
  })

  it("falls back to the bundled binary when the override is absent", () => {
    expect(resolveCliPath("/ext")).toBe("/ext/bin/kilo")
    expect(resolveCliPath("/ext", {})).toBe("/ext/bin/kilo")
    expect(resolveCliPath("/ext", { KILO_P0_PERF: "1" })).toBe("/ext/bin/kilo")
  })

  it("falls back when the override is empty or whitespace-only (not explicitly set)", () => {
    expect(resolveCliPath("/ext", { KILO_P0_BACKEND_CLI: "" })).toBe("/ext/bin/kilo")
    expect(resolveCliPath("/ext", { KILO_P0_BACKEND_CLI: "   " })).toBe("/ext/bin/kilo")
  })
})
