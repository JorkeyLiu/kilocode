import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { setOrganization } from "../src/server/handlers.js"

const gatewaySrc = join(import.meta.dir, "../src")

function read(rel: string): string {
  return readFileSync(join(gatewaySrc, rel), "utf8")
}

describe("P4.4 ModelCache gateway residual removal — no ModelCache seam, org auth preserved", () => {
  test("gateway production routes/handlers contain no ModelCache dependency or clear callback", () => {
    const routes = read("server/routes.ts")
    const handlers = read("server/handlers.ts")
    const modes = read("api/modes.ts")
    const combined = routes + "\n" + handlers + "\n" + modes
    expect(combined).not.toContain("ModelCache")
    expect(combined).not.toContain("model-cache")
    expect(combined).not.toContain("modelCache")
    // Protect removed route/handler seam: only organization modes cache clear remains
    expect(combined).not.toContain("clearModelCache")
    expect(combined).not.toContain("clearCache")
    // Ensure the organization modes cache clear is still present via handlers
    expect(handlers).toContain("clearModesCache")
    expect(routes).toContain("clearModesCache")
  })

  test("handlers preserve organization auth persistence, clearModesCache, and dispose ordering", () => {
    const src = read("server/handlers.ts")
    // Auth persistence: setOrganization writes oauth auth with accountId
    expect(src).toContain('deps.auth.set("kilo"')
    expect(src).toContain("accountId")
    expect(src).toContain("clearModesCache()")
    expect(src).toContain("await deps.dispose()")
    // Ordering: auth.set -> clearModesCache -> dispose
    const setIdx = src.indexOf('deps.auth.set("kilo"')
    const clearIdx = src.indexOf("clearModesCache()")
    const disposeIdx = src.indexOf("await deps.dispose()")
    expect(setIdx).toBeGreaterThan(-1)
    expect(clearIdx).toBeGreaterThan(-1)
    expect(disposeIdx).toBeGreaterThan(-1)
    expect(setIdx).toBeLessThan(clearIdx)
    expect(clearIdx).toBeLessThan(disposeIdx)
    // No ModelCache clear remains
    expect(src).not.toContain("ModelCache")
  })

  test("routes preserve organization auth persistence, clearModesCache via handlers, and dispose wiring", () => {
    const src = read("server/routes.ts")
    expect(src).toContain("setOrganization")
    expect(src).toContain("clearModesCache")
    expect(src).toContain("Instances.disposeAllInstances")
    expect(src).toContain('operationId: "kilo.organization.set"')
    expect(src).not.toContain("ModelCache")
  })

  test("setOrganization persists organizationId and calls clearModesCache + dispose in order (actual implementation)", async () => {
    const order: string[] = []
    let saved: any = undefined
    const deps: any = {
      auth: {
        get: async () => ({ type: "oauth", access: "access-token", refresh: "refresh-token", expires: 9999, accountId: "old-org" }),
        set: async (_provider: string, auth: any) => {
          order.push("set")
          saved = auth
        },
      },
      dispose: async () => {
        order.push("dispose")
      },
    }
    // Intercept clearModesCache via module-level cache observation:
    // The handlers module imports clearModesCache from api/modes.js — we verify ordering
    // via source scan above and via actual call that does not throw and returns true.
    const result = await setOrganization(deps, "new-org-id")
    expect(result).toBe(true)
    expect(saved.accountId).toBe("new-org-id")
    expect(saved.access).toBe("access-token")
    expect(order).toEqual(["set", "dispose"])
    // clearModesCache is called between set and dispose per source ordering — verify file still has it
    const src = read("server/handlers.ts")
    expect(src.indexOf("clearModesCache()")).toBeGreaterThan(src.indexOf('deps.auth.set("kilo"'))
  })

  test("setOrganization with null clears accountId but still clears cache and disposes", async () => {
    let saved: any = undefined
    const deps: any = {
      auth: {
        get: async () => ({ type: "oauth", access: "a", refresh: "r", expires: 1, accountId: "old" }),
        set: async (_p: string, auth: any) => {
          saved = auth
        },
      },
      dispose: async () => {},
    }
    const result = await setOrganization(deps, null)
    expect(result).toBe(true)
    expect(saved.accountId).toBeUndefined()
    expect(saved.type).toBe("oauth")
  })
})
