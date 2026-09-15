import { describe, expect, test } from "bun:test"
import { readFileSync } from "fs"
import { join } from "path"

const root = join(__dirname, "..")
const provider = readFileSync(join(root, "KiloProvider.ts"), "utf8")

describe("sandbox-support call sites", () => {
  test("both production support reads use the private-first helper", () => {
    expect(provider).toContain("fetchSandboxSupportPrivateFirst")
    const uses = provider.match(/fetchSandboxSupportPrivateFirst/g)?.length ?? 0
    expect(uses).toBeGreaterThanOrEqual(2)
    // The production SDK call lives only in the helper fallback, not in the provider.
    expect(provider).not.toContain("sandbox.support({ directory }")
  })

  test("default refresh preserves parallelism, revision, guards, and fail-closed post shape", () => {
    expect(provider).toContain("private async fetchAndSendSandboxDefault")
    expect(provider).toContain("++this.sandboxRevision")
    expect(provider).toContain("this.connectionGeneration !== generation")
    expect(provider).toContain("this.client !== client")
    expect(provider).toContain("Promise.all([")
    expect(provider).toContain("sandboxDefault(this.connectionService.sandboxPreference, client, directory, this.connectionService)")
    expect(provider).toContain('type: "sandboxDefaultStatus"')
    expect(provider).toContain("desired: false")
    expect(provider).toContain("Failed to load sandbox default")
  })

  test("set path keeps validation-before-persist ordering and post-save refresh", () => {
    expect(provider).toContain("private async handleSetSandboxDefault")
    expect(provider).toContain("sandboxPreference.set(enabled, async () => {")
    expect(provider).toContain("Sandbox backend is unavailable")
    expect(provider).toContain("await this.fetchAndSendSandboxDefault(directory, requestID)")
    expect(provider).toContain("Sandbox enabled for new sessions")
  })
})
