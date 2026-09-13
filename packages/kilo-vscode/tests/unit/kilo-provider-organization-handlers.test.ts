import { describe, expect, it } from "bun:test"
import { handleSetOrganization } from "../../src/kilo-provider/handlers/auth"

type Msg = { type: string; [key: string]: unknown }

type MockOpts = {
  failProfile?: boolean
  failRefresh?: boolean
  failOrgSet?: boolean
  privateOutcome?: "ok" | "terminal" | "unavailable" | "timeout"
  privateCode?: string
}

function createCtx(opts: MockOpts = {}) {
  const calls = {
    posts: [] as Msg[],
    refresh: 0,
    refreshAgents: 0,
    profile: 0,
    orgSet: 0,
    private: 0,
    orgIds: [] as unknown[],
  }
  const client = {
    kilo: {
      profile: async () => {
        calls.profile += 1
        if (opts.failProfile) throw new Error("profile exploded")
        return { data: { username: "kilo-user" } }
      },
      organization: {
        set: async (params?: unknown) => {
          calls.orgSet += 1
          calls.orgIds.push((params as { organizationId?: unknown } | undefined)?.organizationId)
          if (opts.failOrgSet) throw new Error("org exploded")
          return { data: true }
        },
      },
    },
  }
  const ctx = {
    client,
    postMessage: (msg: unknown) => calls.posts.push(msg as Msg),
    getWorkspaceDirectory: () => "/tmp",
    fetchAndSendProviders: async () => {
      calls.refresh += 1
      if (opts.failRefresh) throw new Error("refresh exploded")
    },
    fetchAndSendAgents: async () => {
      calls.refreshAgents += 1
    },
    ...(opts.privateOutcome === undefined
      ? {}
      : {
          connection: privateConnFor(opts.privateOutcome, calls, opts.privateCode ?? "unauthorized"),
        }),
  } as unknown as Parameters<typeof handleSetOrganization>[0]
  return { calls, ctx }
}

function privateConnFor(
  outcome: NonNullable<MockOpts["privateOutcome"]>,
  calls: { private: number },
  code: string,
): unknown {
  if (outcome === "unavailable") return { isPrivateAvailable: () => false }
  if (outcome === "timeout")
    return {
      isPrivateAvailable: () => true,
      privateOrganizationSetOutcomeWithHandle: () => ({
        id: 42,
        promise: new Promise(() => {}),
        cancel: () => true,
      }),
    }
  return {
    isPrivateAvailable: () => true,
    privateOrganizationSetOutcomeWithHandle: (
      req: { requestId: string; opId: string; op: string; idempotencyKey: string },
    ) => {
      calls.private += 1
      return {
        id: 7,
        promise: Promise.resolve(outcome === "ok" ? okPrivateResult(req) : terminalPrivateResult(req, code)),
        cancel: () => true,
      }
    },
  }
}

function okPrivateResult(req: { requestId: string; opId: string; op: string; idempotencyKey: string }) {
  return {
    kind: "valid" as const,
    result: {
      v: 1,
      requestId: req.requestId,
      opId: req.opId,
      op: req.op,
      idempotencyKey: req.idempotencyKey,
      status: "succeeded",
      outcome: { type: "succeeded", time: 1 },
      accepted: true,
      data: { updated: true },
    },
  }
}

function terminalPrivateResult(req: { requestId: string; opId: string; op: string; idempotencyKey: string }, code: string) {
  return {
    kind: "valid" as const,
    result: {
      v: 1,
      requestId: req.requestId,
      opId: req.opId,
      op: req.op,
      idempotencyKey: req.idempotencyKey,
      status: "failed",
      outcome: { type: "failed", time: 1, failure: { code, message: "m", retryable: false } },
      accepted: false,
      failure: { code, message: "m", retryable: false },
    },
  }
}

describe("handleSetOrganization private-first (original UX preserved)", () => {
  it("never calls global.dispose and refreshes profile/providers/agents after private success with zero SDK", async () => {
    const { calls, ctx } = createCtx({ privateOutcome: "ok" })

    await handleSetOrganization(ctx, "org-1")

    expect(calls.private).toBe(1)
    expect(calls.orgSet).toBe(0)
    expect((ctx as unknown as Record<string, unknown>).disposeGlobal).toBeUndefined()
    expect((ctx.client as unknown as Record<string, unknown>).global).toBeUndefined()
    expect(calls.posts).toContainEqual(expect.objectContaining({ type: "profileData" }))
    expect(calls.refresh).toBe(1)
    expect(calls.refreshAgents).toBe(1)
    expect(calls.posts.some((m) => m.type === "error")).toBe(false)
  })

  it("private terminal follows the same best-effort profile-reset path with zero SDK", async () => {
    const { calls, ctx } = createCtx({ privateOutcome: "terminal", privateCode: "unauthorized" })

    await handleSetOrganization(ctx, "org-1")

    expect(calls.private).toBe(1)
    expect(calls.orgSet).toBe(0)
    expect((ctx as unknown as Record<string, unknown>).disposeGlobal).toBeUndefined()
    expect((ctx.client as unknown as Record<string, unknown>).global).toBeUndefined()
    expect(calls.posts).toContainEqual(expect.objectContaining({ type: "profileData" }))
    expect(calls.refresh).toBe(0)
    expect(calls.refreshAgents).toBe(0)
    expect(calls.posts.some((m) => m.type === "error")).toBe(false)
  })

  it("private unavailable falls back to exactly one same-identity SDK organization.set", async () => {
    const { calls, ctx } = createCtx({ privateOutcome: "unavailable" })

    await handleSetOrganization(ctx, "org-1")

    expect(calls.orgSet).toBe(1)
    expect(calls.orgIds).toEqual(["org-1"])
    expect(calls.posts).toContainEqual(expect.objectContaining({ type: "profileData" }))
    expect(calls.refresh).toBe(1)
    expect(calls.refreshAgents).toBe(1)
  })

  it("private timeout exact-cancels and falls back to exactly one SDK organization.set", async () => {
    const { calls, ctx } = createCtx({ privateOutcome: "timeout" })

    await handleSetOrganization(ctx, null)

    expect(calls.orgSet).toBe(1)
    expect(calls.orgIds).toEqual([null])
    expect(calls.posts).toContainEqual(expect.objectContaining({ type: "profileData" }))
  })

  it("SDK-only (no connection) keeps the original success UX", async () => {
    const { calls, ctx } = createCtx()

    await handleSetOrganization(ctx, "org-1")

    expect(calls.orgSet).toBe(1)
    expect(calls.posts).toContainEqual(expect.objectContaining({ type: "profileData" }))
    expect(calls.refresh).toBe(1)
    expect(calls.refreshAgents).toBe(1)
  })

  it("never reports a post-success refresh failure as an organization switch failure", async () => {
    const { calls, ctx } = createCtx({ privateOutcome: "ok", failRefresh: true })

    await handleSetOrganization(ctx, "org-1")

    expect(calls.orgSet).toBe(0)
    expect(calls.refresh).toBe(1)
    expect(calls.posts).toContainEqual(expect.objectContaining({ type: "profileData" }))
    expect(calls.posts.some((m) => m.type === "error")).toBe(false)
  })
})
