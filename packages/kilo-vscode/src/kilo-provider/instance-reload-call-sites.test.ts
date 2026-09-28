import { describe, expect, it } from "bun:test"
import { RELOAD_CONFLICT_WARNING, RELOAD_FAILED_ERROR, RELOAD_UNRESOLVED_WARNING } from "./instance-reload"

// Structural proof that both reload entries share one accepted-only owner.
// The helper (`instance-reload.ts`) owns the only `client.instance.reload`
// SDK fallback plus the private `instance/reload` attempt; the attempt helper
// (`instance-reload-privatefirst.ts`) owns zero SDK calls. `KiloProvider.handleReload`
// and the `kilo-code.new.reload` command resolve their own directory, share
// the 409/generic/unresolved copy, pass the private connection, and keep their
// existing success projection (provider clears commands + cross-directory
// lifecycle refresh only on settled success). Provider `unresolved` warns with
// no cache-clear and no second reload, then requests one guarded read-only
// reconciliation through the existing `LifecycleRefreshCoordinator` so a lost
// disposed SSE event cannot leave state stale; the command has no provider
// instance and no existing shared read-only path, so it keeps warn-only and
// converges via the disposed events plus the next provider round. No second
// reload on after-send uncertainty; this unit promises no exactly-once boots,
// no new dedup/singleflight owner, no new lifecycle owner/protocol, and no
// polling.
async function src(rel: string): Promise<string> {
  return Bun.file(new URL(rel, import.meta.url)).text()
}

function directReloadCalls(text: string): number {
  return text.match(/\.instance\.reload\s*\(/g)?.length ?? 0
}

function handleReloadBlock(text: string): string {
  return text.match(/private async handleReload\(\)[\s\S]*?^\s{2}\}/m)?.[0] ?? ""
}

function unresolvedSlice(block: string): string {
  const at = block.indexOf('outcome.kind === "unresolved"')
  if (at < 0) return ""
  const ret = block.indexOf("return", at)
  return ret < 0 ? block.slice(at) : block.slice(at, ret)
}

describe("instance reload production call sites", () => {
  it("helper owns the single SDK fallback with the private attempt alongside", async () => {
    const helper = await src("./instance-reload.ts")
    expect(directReloadCalls(helper)).toBe(1)
    expect(helper).toContain("{ throwOnError: true }")
    expect(helper).toContain("attemptInstanceReloadPrivate")
    expect(helper).toContain("buildInstanceReloadReq")
    expect(helper).toContain("instance/reload")
    expect(helper).toContain("RELOAD_CONFLICT_WARNING")
    expect(helper).toContain("RELOAD_FAILED_ERROR")
    expect(helper).toContain("RELOAD_UNRESOLVED_WARNING")
    expect(helper).toContain("unresolved")
    // The SDK call lives only in the proven pre-send/strict-fence fallback:
    // private ok/terminal/unresolved return before it. Exactly one fallback
    // path, never retried, never a second reload on after-send uncertainty.
    expect(helper.match(/\.instance\.reload\s*\(/g)?.length ?? 0).toBe(1)
    // Helper owns no refresh: reconciliation lives in the existing provider
    // coordinator call sites only.
    expect(helper).not.toContain("lifecycleRefresh")
    expect(helper).not.toContain("reloadAfterAuthChange")
    expect(helper).not.toContain("fetchAndSendCommands")
    expect(helper).not.toContain("clearCommandsCache")
  })

  it("attempt helper owns zero SDK calls and explicit unresolved", async () => {
    const attempt = await src("./instance-reload-privatefirst.ts")
    expect(directReloadCalls(attempt)).toBe(0)
    expect(attempt).toContain("instance/reload")
    expect(attempt).toContain("canonicalInstanceReloadOpId")
    expect(attempt).toContain("attemptInstanceReloadPrivate")
    expect(attempt).toContain("unresolved")
    expect(attempt).toContain("provenPreSend")
  })

  it("KiloProvider reload goes through the shared helper with zero direct SDK calls", async () => {
    const text = await src("../KiloProvider.ts")
    expect(directReloadCalls(text)).toBe(0)
    expect(text).toContain("requestInstanceReload")
    expect(text).toContain("RELOAD_CONFLICT_WARNING")
    expect(text).toContain("RELOAD_FAILED_ERROR")
    expect(text).toContain("RELOAD_UNRESOLVED_WARNING")
    expect(text).toContain('from "./kilo-provider/instance-reload"')
    expect(text).toContain("connection: this.connectionService")
  })

  it("extension reload command goes through the shared helper with zero direct SDK calls", async () => {
    const text = await src("../extension.ts")
    expect(directReloadCalls(text)).toBe(0)
    expect(text).toContain("requestInstanceReload")
    expect(text).toContain("RELOAD_CONFLICT_WARNING")
    expect(text).toContain("RELOAD_FAILED_ERROR")
    expect(text).toContain("RELOAD_UNRESOLVED_WARNING")
    expect(text).toContain('from "./kilo-provider/instance-reload"')
    expect(text).toContain("connection: connectionService")
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
    const block = handleReloadBlock(text)
    expect(block.length).toBeGreaterThan(0)
    expect(block).toContain("requestInstanceReload")
    expect(block).toContain("this.clearCommandsCache()")
    expect(block).toContain("sameDirectory(dir, this.getWorkspaceDirectory())")
    expect(block).toContain("await this.reloadAfterAuthChange()")
    expect(block).toContain('outcome.kind === "unresolved"')
    expect(block).toContain("RELOAD_UNRESOLVED_WARNING")
    expect(block).toContain("showWarningMessage")
  })

  it("unresolved never clears cache or redispatches reload: warning returns before success projection", async () => {
    const text = await src("../KiloProvider.ts")
    const block = handleReloadBlock(text)
    const slice = unresolvedSlice(block)
    expect(slice.length).toBeGreaterThan(0)
    expect(slice).toContain("RELOAD_UNRESOLVED_WARNING")
    expect(slice).toContain("showWarningMessage")
    expect(slice).not.toContain("this.clearCommandsCache()")
    expect(slice).not.toContain("requestInstanceReload")
    expect(directReloadCalls(slice)).toBe(0)
    const unresolvedAt = block.indexOf('outcome.kind === "unresolved"')
    const clearAt = block.indexOf("this.clearCommandsCache()")
    expect(unresolvedAt).toBeGreaterThan(-1)
    expect(clearAt).toBeGreaterThan(-1)
    expect(unresolvedAt).toBeLessThan(clearAt)
  })

  it("unresolved lost-event reconciliation requests one read-only round with current guards", async () => {
    const text = await src("../KiloProvider.ts")
    const block = handleReloadBlock(text)
    const slice = unresolvedSlice(block)
    // Same existing coordinator as the disposed handlers, fire-and-forget
    // read-only; no success asserted, no second reload, no cache clear.
    expect(slice).toContain("void this.reloadAfterAuthChange()")
    expect(slice).not.toContain("await this.reloadAfterAuthChange()")
    expect(slice).not.toContain("this.clearCommandsCache()")
    // Guards mirror existing current/dispose/dir patterns.
    expect(slice).toContain("!this.disposed")
    expect(slice).toContain("this.client === client")
    expect(slice).toContain("this.connectionGeneration === gen")
    expect(slice).toContain("sameDirectory(dir, this.getWorkspaceDirectory(this.currentSession?.id))")
    // Exactly one shared helper call per handleReload: no second dispatch.
    expect(block.match(/requestInstanceReload/g)?.length ?? 0).toBe(1)
  })

  it("command has no provider instance so keeps warn-only: precise limitation, no second owner", async () => {
    const text = await src("../extension.ts")
    const start = text.indexOf("kilo-code.new.reload")
    expect(start).toBeGreaterThan(-1)
    const block = text.slice(start, start + 2500)
    expect(block).toContain("requestInstanceReload")
    expect(block).toContain("RELOAD_UNRESOLVED_WARNING")
    expect(block).toContain("showWarningMessage")
    // No existing shared read-only path is reachable from the command (no
    // provider instance); adding one would require a new lifecycle owner, so
    // the command converges via the disposed events plus the next provider
    // round like every other non-provider entry.
    expect(block).not.toContain("reloadAfterAuthChange")
    expect(block).not.toContain("clearCommandsCache")
    expect(block).not.toContain("lifecycleRefresh")
    expect(directReloadCalls(block)).toBe(0)
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
    expect(RELOAD_UNRESOLVED_WARNING).toBe(
      "Reload status could not be confirmed. No retry was issued. It will converge automatically if the reload was accepted.",
    )
  })
})
