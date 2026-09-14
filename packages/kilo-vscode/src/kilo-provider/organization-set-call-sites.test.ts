import { describe, expect, test } from "bun:test"
import { readFile } from "fs/promises"
import { join } from "path"

// Structural lock for organization switch: the only production
// `client.kilo.organization.set` call lives in the private-first helper's
// exactly-one SDK fallback
// (`kilo-provider/organization-set-privatefirst.ts`). The VS Code host holds no
// switch trigger (`kilo-provider/handlers/auth.ts` is removed) and
// `KiloProvider` must never call the SDK directly, so a future edit cannot
// silently regress to SDK-first switch or reintroduce a host org flow.
// Behavioral proof lives in
// `src/kilo-provider/organization-set-privatefirst.test.ts` and the
// `serve-private-organization-set` contract tests; this file only locks the
// call sites.
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

function directOrgSetCalls(text: string): number {
  return text.match(/\.kilo\.organization\.set\s*\(/g)?.length ?? 0
}

describe("organization-set switch call sites", () => {
  test("VS Code host has no switch handler and KiloProvider has zero direct SDK organization.set calls", async () => {
    expect(await missing("src/kilo-provider/handlers/auth.ts")).toBe(true)
    const provider = await src("src/KiloProvider.ts")
    expect(directOrgSetCalls(provider)).toBe(0)
  })

  test("the private-first helper owns the single SDK fallback", async () => {
    const helper = await src("src/kilo-provider/organization-set-privatefirst.ts")
    expect(helper).toContain("kilo/organization/set")
    expect(helper).toContain("throwOnError")
    // The helper reaches the SDK through the generic client handle (never a
    // second hard-coded call site): exactly one fallback invocation path.
    expect(helper.match(/kilo\?\.organization\?\.set/g)?.length ?? 0).toBeGreaterThan(0)
    expect(helper.match(/setOrganizationPrivateFirst/g)?.length ?? 0).toBeGreaterThan(0)
  })

  test("organization switch has no production host route and fails closed without SDK", async () => {
    const provider = await src("src/KiloProvider.ts")
    expect(provider).not.toContain("handleSetOrganization")
    expect(provider).not.toContain("authCtx")
    expect(provider).not.toContain("dormantHandleSetOrganization")
    expect(provider).not.toContain("_dormantAuthFlows")
    expect(provider).toContain('case "setOrganization"')
    expect(provider).toContain("CUSTOM_ONLY_AUTH_MESSAGE")
    expect(directOrgSetCalls(provider)).toBe(0)
  })
})
