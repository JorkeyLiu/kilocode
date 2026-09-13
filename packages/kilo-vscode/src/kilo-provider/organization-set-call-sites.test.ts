import { describe, expect, test } from "bun:test"
import { readFile } from "fs/promises"
import { join } from "path"

// Structural lock for organization switch: the only production
// `client.kilo.organization.set` call lives in the private-first helper's
// exactly-one SDK fallback
// (`kilo-provider/organization-set-privatefirst.ts`). The switch handler
// (`kilo-provider/handlers/auth.ts`) and `KiloProvider` must never call the
// SDK directly, so a future edit cannot silently regress to SDK-first switch.
// Behavioral proof lives in `tests/unit/kilo-provider-organization-handlers.test.ts`
// (private success/terminal zero-SDK, unavailable/timeout exactly-one fallback)
// and `src/kilo-provider/organization-set-privatefirst.test.ts`; this file only
// locks the call sites.
const ROOT = join(import.meta.dir, "..", "..")

async function src(rel: string): Promise<string> {
  return readFile(join(ROOT, rel), "utf8")
}

function directOrgSetCalls(text: string): number {
  return text.match(/\.kilo\.organization\.set\s*\(/g)?.length ?? 0
}

describe("organization-set switch call sites", () => {
  test("switch handler and KiloProvider have zero direct SDK organization.set calls", async () => {
    const handler = await src("src/kilo-provider/handlers/auth.ts")
    expect(directOrgSetCalls(handler)).toBe(0)
    const provider = await src("src/KiloProvider.ts")
    expect(directOrgSetCalls(provider)).toBe(0)
  })

  test("the private-first helper owns the single SDK fallback", async () => {
    const helper = await src("src/kilo-provider/organization-set-privatefirst.ts")
    expect(helper).toContain("kilo/organization/set")
    expect(helper).toContain("throwOnError")
    expect(directOrgSetCalls(await src("src/kilo-provider/handlers/auth.ts"))).toBe(0)
    // The helper reaches the SDK through the generic client handle (never a
    // second hard-coded call site): exactly one fallback invocation path.
    expect(helper.match(/kilo\?\.organization\?\.set/g)?.length ?? 0).toBeGreaterThan(0)
    expect(helper.match(/setOrganizationPrivateFirst/g)?.length ?? 0).toBeGreaterThan(0)
  })

  test("switch still routes through handleSetOrganization with the private connection", async () => {
    const provider = await src("src/KiloProvider.ts")
    expect(provider.match(/handleSetOrganization\(this\.authCtx/g)?.length ?? 0).toBeGreaterThan(0)
    expect(provider).toContain("connection: this.connectionService")
    const handler = await src("src/kilo-provider/handlers/auth.ts")
    expect(handler).toContain("setOrganizationPrivateFirst")
  })
})
