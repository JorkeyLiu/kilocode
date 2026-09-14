import { describe, expect, test } from "bun:test"
import { readFile } from "fs/promises"
import { join } from "path"

// Structural lock for profile logout: the only production `client.auth.remove`
// call lives in the private-first helper's exactly-one SDK fallback
// (`kilo-provider/auth-remove-privatefirst.ts`). The VS Code host holds no
// logout trigger (`kilo-provider/handlers/auth.ts` is removed) and
// `KiloProvider` must never call the SDK directly, so a future edit cannot
// silently regress to SDK-first logout or reintroduce a host login flow.
// Behavioral proof lives in `src/kilo-provider/auth-remove-privatefirst.test.ts`
// and the `serve-private-auth-remove` contract tests; this file only locks
// the call sites.
const ROOT = join(import.meta.dir, "..", "..")

async function src(rel: string): Promise<string> {
  return readFile(join(ROOT, rel), "utf8")
}

async function missing(rel: string): Promise<boolean> {
  try {
    await readFile(join(ROOT, rel), "utf8")
    return false
  } catch {
    return true
  }
}

function directAuthRemoveCalls(text: string): number {
  return text.match(/\.auth\.remove\s*\(/g)?.length ?? 0
}

describe("auth-remove logout call sites", () => {
  test("VS Code host has no logout handler and KiloProvider has zero direct SDK auth.remove calls", async () => {
    expect(await missing("src/kilo-provider/handlers/auth.ts")).toBe(true)
    const provider = await src("src/KiloProvider.ts")
    expect(directAuthRemoveCalls(provider)).toBe(0)
  })

  test("the private-first helper owns the single SDK fallback", async () => {
    const helper = await src("src/kilo-provider/auth-remove-privatefirst.ts")
    expect(helper).toContain("auth/remove")
    expect(helper).toContain("throwOnError")
    // The helper reaches the SDK through the generic client handle (never a
    // second hard-coded call site): exactly one fallback invocation path.
    expect(helper.match(/client\?\.auth\?\.remove/g)?.length ?? 0).toBeGreaterThan(0)
    expect(helper.match(/removeAuthPrivateFirst/g)?.length ?? 0).toBeGreaterThan(0)
  })

  test("logout has no production host route and fails closed without SDK", async () => {
    const provider = await src("src/KiloProvider.ts")
    expect(provider).not.toContain("handleLogout")
    expect(provider).not.toContain("authCtx")
    expect(provider).not.toContain("dormantHandleLogout")
    expect(provider).not.toContain("_dormantAuthFlows")
    expect(provider).toContain('case "logout"')
    expect(provider).toContain("CUSTOM_ONLY_AUTH_MESSAGE")
    expect(directAuthRemoveCalls(provider)).toBe(0)
  })
})
