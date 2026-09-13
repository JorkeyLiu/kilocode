import { describe, expect, it } from "bun:test"
import { RELOAD_CONFLICT_WARNING, RELOAD_FAILED_ERROR } from "./instance-reload"

// Structural proof that both reload entries share one HTTP owner. The helper
// (`instance-reload.ts`) owns the only `client.instance.reload` call shape;
// `KiloProvider.handleReload` and the `kilo-code.new.reload` command resolve
// their own directory, share the 409/generic copy, and keep their existing
// success projection (provider clears commands + cross-directory lifecycle
// refresh; the command adds no second refresh owner and converges via the
// disposed events like every other provider).
async function src(rel: string): Promise<string> {
  return Bun.file(new URL(rel, import.meta.url)).text()
}

function directReloadCalls(text: string): number {
  return text.match(/\.instance\.reload\s*\(/g)?.length ?? 0
}

describe("instance reload production call sites", () => {
  it("helper owns the single instance.reload call shape", async () => {
    const helper = await src("./instance-reload.ts")
    expect(directReloadCalls(helper)).toBe(1)
    expect(helper).toContain("{ throwOnError: true }")
    expect(helper).toContain("RELOAD_CONFLICT_WARNING")
    expect(helper).toContain("RELOAD_FAILED_ERROR")
  })

  it("KiloProvider reload goes through the shared helper with zero direct SDK calls", async () => {
    const text = await src("../KiloProvider.ts")
    expect(directReloadCalls(text)).toBe(0)
    expect(text).toContain("requestInstanceReload")
    expect(text).toContain("RELOAD_CONFLICT_WARNING")
    expect(text).toContain("RELOAD_FAILED_ERROR")
    expect(text).toContain('from "./kilo-provider/instance-reload"')
  })

  it("extension reload command goes through the shared helper with zero direct SDK calls", async () => {
    const text = await src("../extension.ts")
    expect(directReloadCalls(text)).toBe(0)
    expect(text).toContain("requestInstanceReload")
    expect(text).toContain("RELOAD_CONFLICT_WARNING")
    expect(text).toContain("RELOAD_FAILED_ERROR")
    expect(text).toContain('from "./kilo-provider/instance-reload"')
  })

  it("both call sites keep their own directory selection", async () => {
    const provider = await src("../KiloProvider.ts")
    expect(provider).toContain("this.getWorkspaceDirectory(this.currentSession?.id)")
    const command = await src("../extension.ts")
    expect(command).toContain("resolveReloadDirectory")
    expect(command).toContain("agentManagerProvider.getActiveSessionId()")
    expect(command).toContain("agentManagerProvider.getSessionDirectories()")
  })

  it("provider keeps its success projection: clear commands plus cross-directory lifecycle refresh", async () => {
    const text = await src("../KiloProvider.ts")
    const block = text.match(/private async handleReload\(\)[\s\S]*?^\s{2}\}/m)?.[0] ?? ""
    expect(block.length).toBeGreaterThan(0)
    expect(block).toContain("requestInstanceReload")
    expect(block).toContain("this.clearCommandsCache()")
    expect(block).toContain("sameDirectory(dir, this.getWorkspaceDirectory())")
    expect(block).toContain("await this.reloadAfterAuthChange()")
  })

  it("command adds no second refresh owner: success converges via disposed events", async () => {
    const text = await src("../extension.ts")
    const start = text.indexOf("kilo-code.new.reload")
    expect(start).toBeGreaterThan(-1)
    const block = text.slice(start, start + 2000)
    expect(block).toContain("requestInstanceReload")
    expect(block).not.toContain("reloadAfterAuthChange")
    expect(block).not.toContain("clearCommandsCache")
    expect(block).not.toContain("lifecycleRefresh")
  })

  it("disposed events stay the final convergence owner for both entries", async () => {
    const text = await src("../KiloProvider.ts")
    expect(text).toContain('if (event.type === "global.disposed")')
    expect(text).toContain('if (event.type === "server.instance.disposed")')
    expect(text).toContain("sameDirectory(dir, this.getWorkspaceDirectory())")
    expect(text).toContain("void this.reloadAfterAuthChange()")
  })

  it("shared copy matches the contract both entries render", () => {
    expect(RELOAD_CONFLICT_WARNING).toBe(
      "Cannot reload while a session is running. Wait for it to finish or abort it first.",
    )
    expect(RELOAD_FAILED_ERROR).toBe("Reload failed. See extension logs for details.")
  })
})
