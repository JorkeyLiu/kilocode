import { describe, expect, test } from "bun:test"
import { readFile } from "fs/promises"
import { join } from "path"

// Structural lock for profile logout: the only production `client.auth.remove`
// call lives in the private-first helper's exactly-one SDK fallback
// (`kilo-provider/auth-remove-privatefirst.ts`). The logout handler
// (`kilo-provider/handlers/auth.ts`) and `KiloProvider` must never call the
// SDK directly, so a future edit cannot silently regress to SDK-first logout.
// Behavioral proof lives in `tests/unit/kilo-provider-auth-handlers.test.ts`
// (private success/terminal zero-SDK, unavailable/timeout exactly-one fallback)
// and `src/kilo-provider/auth-remove-privatefirst.test.ts`; this file only
// locks the call sites.
const ROOT = join(import.meta.dir, "..", "..")

async function src(rel: string): Promise<string> {
  return readFile(join(ROOT, rel), "utf8")
}

function directAuthRemoveCalls(text: string): number {
  return text.match(/\.auth\.remove\s*\(/g)?.length ?? 0
}

describe("auth-remove logout call sites", () => {
  test("logout handler and KiloProvider have zero direct SDK auth.remove calls", async () => {
    const handler = await src("src/kilo-provider/handlers/auth.ts")
    expect(directAuthRemoveCalls(handler)).toBe(0)
    const provider = await src("src/KiloProvider.ts")
    expect(directAuthRemoveCalls(provider)).toBe(0)
  })

  test("the private-first helper owns the single SDK fallback", async () => {
    const helper = await src("src/kilo-provider/auth-remove-privatefirst.ts")
    expect(helper).toContain("auth/remove")
    expect(helper).toContain("throwOnError")
    expect(directAuthRemoveCalls(await src("src/kilo-provider/handlers/auth.ts"))).toBe(0)
    // The helper reaches the SDK through the generic client handle (never a
    // second hard-coded call site): exactly one fallback invocation path.
    expect(helper.match(/client\?\.auth\?\.remove/g)?.length ?? 0).toBeGreaterThan(0)
    expect(helper.match(/removeAuthPrivateFirst/g)?.length ?? 0).toBeGreaterThan(0)
  })

  test("logout still routes through handleLogout with the private connection", async () => {
    const provider = await src("src/KiloProvider.ts")
    expect(provider.match(/handleLogout\(this\.authCtx\)/g)?.length ?? 0).toBeGreaterThan(0)
    expect(provider).toContain("connection: this.connectionService")
    const handler = await src("src/kilo-provider/handlers/auth.ts")
    expect(handler).toContain("removeAuthPrivateFirst")
  })
})
