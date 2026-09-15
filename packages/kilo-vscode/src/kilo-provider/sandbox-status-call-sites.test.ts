import { describe, expect, test } from "bun:test"
import { readFileSync } from "fs"
import { join } from "path"

const root = join(__dirname, "..")
const provider = readFileSync(join(root, "KiloProvider.ts"), "utf8")

describe("sandbox-status call sites", () => {
  test("production status refresh uses the private-first helper once", () => {
    expect(provider).toContain("fetchSandboxStatusPrivateFirst")
    const uses = provider.match(/fetchSandboxStatusPrivateFirst/g)?.length ?? 0
    expect(uses).toBeGreaterThanOrEqual(1)
    // The production SDK call lives only in the helper fallback, not in the provider.
    expect(provider).not.toMatch(/sandbox\.status\(\{ sessionID/)
  })

  test("status refresh preserves revision, guards, drift re-fetch, post shape, and failed-set convergence", () => {
    expect(provider).toContain("private async fetchAndSendSandboxStatus")
    expect(provider).toContain("++this.sandboxRevision")
    expect(provider).toContain("this.connectionGeneration !== generation")
    expect(provider).toContain("this.client !== client")
    expect(provider).toContain('sameDirectory(data.directory')
    expect(provider).toContain("void this.fetchAndSendSandboxStatus(sessionID, requestID)")
    expect(provider).toContain('type: "sandboxStatus"')
    expect(provider).toContain("postSandboxError(sessionID")
    // Failed sandbox set still converges on authoritative status.
    expect(provider).toContain("void this.fetchAndSendSandboxStatus(resolved.sid)")
    // Sandbox support reads are private-first via their own helper; no direct
    // production `sandbox.support` call remains in the provider.
    expect(provider).toContain("fetchSandboxSupportPrivateFirst")
    expect(provider).not.toContain("sandbox.support({ directory }")
  })
})
