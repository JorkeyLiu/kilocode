import { describe, expect, test } from "bun:test"
import {
  removeMarketplaceItem,
  removeMarketplaceItemFromAllScopes,
} from "../../src/services/marketplace/actions"
import { InstallationDetector } from "../../src/services/marketplace/detection"
import { MarketplacePaths } from "../../src/services/marketplace/paths"
import { MarketplaceService } from "../../src/services/marketplace"

function skillItem(id = "demo") {
  return {
    type: "skill" as const,
    id,
    name: "Demo",
    description: "",
    category: "test",
    githubUrl: "https://example.com",
    content: "https://example.com/skill.tar.gz",
    displayName: "Demo",
    displayCategory: "Test",
  }
}

function okResult(r: { requestId: string; opId: string; idempotencyKey: string }) {
  return {
    v: 1,
    requestId: r.requestId,
    opId: r.opId,
    op: "skill/remove",
    idempotencyKey: r.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: 1 },
    accepted: true,
    data: { removed: true },
  }
}

function failedResult(r: { requestId: string; opId: string; idempotencyKey: string }, code: string) {
  return {
    v: 1,
    requestId: r.requestId,
    opId: r.opId,
    op: "skill/remove",
    idempotencyKey: r.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time: 1, failure: { code, message: "m", retryable: false } },
    accepted: false,
    failure: { code, message: "m", retryable: false },
  }
}

function ctx(opts: {
  skills: Array<{ name: string; location: string }>
  private: (req: { payload: { location: string } }) => { id: number; promise: Promise<unknown>; cancel: () => boolean }
}) {
  const seen: string[] = []
  let serviceRemoveCalled = false
  let configUpdateCalled = false
  let disposeCalled = false
  let kilocodeRemoveCalls = 0
  const client = {
    app: {
      skills: async () => ({ data: opts.skills }),
    },
    kilocode: {
      removeSkill: async () => {
        kilocodeRemoveCalls += 1
        throw new Error("SDK fallback kilocode.removeSkill must not be called")
      },
    },
    global: {
      config: {
        update: async () => {
          configUpdateCalled = true
        },
      },
    },
    instance: {
      dispose: async () => {
        disposeCalled = true
      },
    },
  }
  const connection = {
    getClientAsync: async () => client,
    isPrivateAvailable: () => true,
    privateSkillRemoveOutcomeWithHandle: (r: { payload: { location: string } }) => {
      seen.push(r.payload.location)
      return opts.private(r)
    },
  }
  const marketplace = {
    remove: async () => {
      serviceRemoveCalled = true
      return { success: true, slug: "demo" }
    },
  }
  return {
    ctx: { connection, marketplace } as never,
    seen,
    serviceRemoveCalled: () => serviceRemoveCalled,
    lifecycleCalled: () => configUpdateCalled || disposeCalled,
    sdkRemovePresent: () => "kilocode" in (client as Record<string, unknown>),
    kilocodeRemoveCalls: () => kilocodeRemoveCalls,
  }
}

const okPrivate = (req: { payload: { location: string } }) => ({
  id: 1,
  promise: Promise.resolve({ kind: "valid", result: okResult(req as never) }),
  cancel: () => true,
})

describe("marketplace skill detection retains observed locations", () => {
  test("project/global duplicates stay independently addressable with locations", async () => {
    const detector = new InstallationDetector(new MarketplacePaths())
    const workspace = "/repo"
    const out = await detector.detect(workspace, [
      { name: "demo", location: "/repo/.kilo/skills/demo/SKILL.md" },
      { name: "demo", location: "/home/.config/kilo/skills/demo/SKILL.md" },
      { name: "other", location: "/home/.config/kilo/skills/other/SKILL.md" },
    ])
    expect(out.project["skill:demo"]).toEqual({ type: "skill", locations: ["/repo/.kilo/skills/demo/SKILL.md"] })
    expect(out.global["skill:demo"]).toEqual({ type: "skill", locations: ["/home/.config/kilo/skills/demo/SKILL.md"] })
    expect(out.global["skill:other"]).toEqual({ type: "skill", locations: ["/home/.config/kilo/skills/other/SKILL.md"] })
    expect(out.project["skill:other"]).toBeUndefined()
  })

  test("same-scope duplicates retain every location for ambiguity detection", async () => {
    const detector = new InstallationDetector(new MarketplacePaths())
    const out = await detector.detect("/repo", [
      { name: "demo", location: "/repo/.kilo/skills/demo/SKILL.md" },
      { name: "demo", location: "/repo/extra/demo/SKILL.md" },
    ])
    expect(out.project["skill:demo"]?.locations).toEqual([
      "/repo/.kilo/skills/demo/SKILL.md",
      "/repo/extra/demo/SKILL.md",
    ])
  })
})

describe("marketplace skill removal is CLI-owned", () => {
  test("project removal sends the exact observed location with no filesystem or SDK path", async () => {
    const c = ctx({
      skills: [{ name: "demo", location: "/repo/.kilo/skills/demo/SKILL.md" }],
      private: okPrivate,
    })
    const out = await removeMarketplaceItem(c.ctx, skillItem(), "project", "/repo", "/repo")
    expect(out).toEqual({ success: true, slug: "demo" })
    expect(c.seen).toEqual(["/repo/.kilo/skills/demo/SKILL.md"])
    expect(c.serviceRemoveCalled()).toBe(false)
    expect(c.lifecycleCalled()).toBe(false)
    expect(c.sdkRemovePresent()).toBe(true)
    expect(c.kilocodeRemoveCalls()).toBe(0)
  })

  test("global duplicates resolve independently by scope projection", async () => {
    const skills = [
      { name: "demo", location: "/repo/.kilo/skills/demo/SKILL.md" },
      { name: "demo", location: "/home/.config/kilo/skills/demo/SKILL.md" },
    ]
    const project = ctx({ skills, private: okPrivate })
    const projectOut = await removeMarketplaceItem(project.ctx, skillItem(), "project", "/repo", "/repo")
    expect(projectOut.success).toBe(true)
    expect(project.seen).toEqual(["/repo/.kilo/skills/demo/SKILL.md"])
    expect(project.kilocodeRemoveCalls()).toBe(0)

    const global = ctx({ skills, private: okPrivate })
    const globalOut = await removeMarketplaceItem(global.ctx, skillItem(), "global", "/repo", "/repo")
    expect(globalOut.success).toBe(true)
    expect(global.seen).toEqual(["/home/.config/kilo/skills/demo/SKILL.md"])
    expect(global.kilocodeRemoveCalls()).toBe(0)
  })

  test("ambiguity within one scope fails closed without calling the backend", async () => {
    const c = ctx({
      skills: [
        { name: "demo", location: "/repo/.kilo/skills/demo/SKILL.md" },
        { name: "demo", location: "/repo/extra/demo/SKILL.md" },
      ],
      private: () => {
        throw new Error("must not be called")
      },
    })
    const out = await removeMarketplaceItem(c.ctx, skillItem(), "project", "/repo", "/repo")
    expect(out.success).toBe(false)
    expect(c.seen).toEqual([])
    expect(c.serviceRemoveCalled()).toBe(false)
    expect(c.kilocodeRemoveCalls()).toBe(0)
  })

  test("shown installed but no location fails closed with refresh message", async () => {
    const c = ctx({
      skills: [],
      private: () => {
        throw new Error("must not be called")
      },
    })
    const out = await removeMarketplaceItem(c.ctx, skillItem(), "project", "/repo", "/repo")
    expect(out.success).toBe(false)
    expect(out.error).toContain("Refresh")
    expect(c.seen).toEqual([])
    expect(c.kilocodeRemoveCalls()).toBe(0)
  })

  test("private builtin failure surfaces an actionable message", async () => {
    const c = ctx({
      skills: [{ name: "demo", location: "/repo/.kilo/skills/demo/SKILL.md" }],
      private: (req) => ({
        id: 2,
        promise: Promise.resolve({ kind: "valid", result: failedResult(req as never, "skill.builtin") }),
        cancel: () => true,
      }),
    })
    const out = await removeMarketplaceItem(c.ctx, skillItem(), "project", "/repo", "/repo")
    expect(out.success).toBe(false)
    expect(out.error).toContain("built-in")
    expect(c.lifecycleCalled()).toBe(false)
    expect(c.kilocodeRemoveCalls()).toBe(0)
  })

  test("private unavailable fails closed without filesystem or lifecycle calls", async () => {
    const c = ctx({
      skills: [{ name: "demo", location: "/repo/.kilo/skills/demo/SKILL.md" }],
      private: okPrivate,
    })
    const unavailable = {
      ...c.ctx,
      connection: { ...(c.ctx as { connection: object }).connection, isPrivateAvailable: () => false },
    } as never
    const out = await removeMarketplaceItem(unavailable, skillItem(), "project", "/repo", "/repo")
    expect(out.success).toBe(false)
    expect(c.seen).toEqual([])
    expect(c.serviceRemoveCalled()).toBe(false)
    expect(c.lifecycleCalled()).toBe(false)
    expect(c.kilocodeRemoveCalls()).toBe(0)
  })

  test("generic remove-all-scopes helper never invokes local skill deletion", async () => {
    let called = false
    const out = await removeMarketplaceItemFromAllScopes(
      { remove: async () => ({ called: true }) } as never,
      { id: "demo", type: "skill" },
      "/repo",
      "/repo",
    )
    expect(called).toBe(false)
    expect(out).toBe(false)
  })

  test("marketplace service rejects skill removal before the filesystem", async () => {
    const service = new MarketplaceService()
    const out = await service.remove(skillItem(), "project", "/repo")
    expect(out.success).toBe(false)
    service.dispose()
  })
})
