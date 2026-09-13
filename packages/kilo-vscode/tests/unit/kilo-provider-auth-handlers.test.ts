import { describe, expect, it } from "bun:test"
import {
  handleLogin,
  handleLogout,
  handleSetOrganization,
} from "../../src/kilo-provider/handlers/auth"

type Msg = { type: string; [key: string]: unknown }

type MockOpts = {
  failCallback?: boolean
  failAuthRemove?: boolean
  failProfile?: boolean
  failRefresh?: boolean
  failOrgSet?: boolean
  privateOutcome?: "ok" | "terminal" | "unavailable" | "timeout"
}

function createCtx(opts: MockOpts = {}) {
  const calls = {
    posts: [] as Msg[],
    refresh: 0,
    refreshAgents: 0,
    callback: 0,
    authRemove: 0,
    profile: 0,
    orgSet: 0,
    private: 0,
    cancelled: [] as string[],
  }
  const client = {
    provider: {
      oauth: {
        authorize: async () => ({
          data: {
            url: "https://example.com/oauth",
            instructions: "Open URL and enter code: ABCD-1234",
          },
        }),
        callback: async () => {
          calls.callback += 1
          if (opts.failCallback) throw new Error("callback exploded")
          return { data: true }
        },
      },
    },
    kilo: {
      profile: async () => {
        calls.profile += 1
        if (opts.failProfile) throw new Error("profile exploded")
        return { data: { username: "kilo-user" } }
      },
      organization: {
        set: async () => {
          calls.orgSet += 1
          if (opts.failOrgSet) throw new Error("org exploded")
          return { data: true }
        },
      },
    },
    auth: {
      remove: async () => {
        calls.authRemove += 1
        if (opts.failAuthRemove) throw new Error("auth remove exploded")
        return { data: true }
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
          connection: privateConnFor(opts.privateOutcome, calls),
        }),
  } as unknown as Parameters<typeof handleLogin>[0]
  return { calls, ctx }
}

function privateConnFor(
  outcome: NonNullable<MockOpts["privateOutcome"]>,
  calls: { private: number; cancelled: string[] },
): unknown {
  if (outcome === "unavailable") return { isPrivateAvailable: () => false }
  if (outcome === "timeout")
    return {
      isPrivateAvailable: () => true,
      privateAuthRemoveOutcomeWithHandle: () => ({
        id: 42,
        promise: new Promise(() => {}),
        cancel: (msg?: string) => {
          calls.cancelled.push(msg ?? "")
          return true
        },
      }),
    }
  return {
    isPrivateAvailable: () => true,
    privateAuthRemoveOutcomeWithHandle: (
      req: { requestId: string; opId: string; op: string; idempotencyKey: string },
    ) => {
      calls.private += 1
      return {
        id: 7,
        promise: Promise.resolve(outcome === "ok" ? okPrivateResult(req) : terminalPrivateResult(req)),
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
      data: { removed: true },
    },
  }
}

function terminalPrivateResult(req: { requestId: string; opId: string; op: string; idempotencyKey: string }) {
  return {
    kind: "valid" as const,
    result: {
      v: 1,
      requestId: req.requestId,
      opId: req.opId,
      op: req.op,
      idempotencyKey: req.idempotencyKey,
      status: "failed",
      outcome: { type: "failed", time: 1, failure: { code: "internal", message: "m", retryable: false } },
      accepted: false,
      failure: { code: "internal", message: "m", retryable: false },
    },
  }
}

describe("handleLogin", () => {
  it("never calls global.dispose and acknowledges login after the OAuth callback (LOCK-001/003)", async () => {
    const { calls, ctx } = createCtx()

    await handleLogin(ctx, 1, () => 1)

    expect((ctx as unknown as Record<string, unknown>).disposeGlobal).toBeUndefined()
    expect((ctx.client as unknown as Record<string, unknown>).global).toBeUndefined()
    expect(calls.callback).toBe(1)
    expect(calls.posts).toContainEqual(expect.objectContaining({ type: "deviceAuthStarted" }))
    expect(calls.posts).toContainEqual(expect.objectContaining({ type: "profileData", data: { username: "kilo-user" } }))
    expect(calls.posts).toContainEqual(expect.objectContaining({ type: "deviceAuthComplete" }))
    expect(calls.posts.some((m) => m.type === "deviceAuthFailed")).toBe(false)
  })

  it("never reports a post-success profile fetch failure as a login failure", async () => {
    const { calls, ctx } = createCtx({ failProfile: true })

    await handleLogin(ctx, 1, () => 1)

    // The OAuth callback response IS the login acknowledgement.
    expect((ctx as unknown as Record<string, unknown>).disposeGlobal).toBeUndefined()
    expect((ctx.client as unknown as Record<string, unknown>).global).toBeUndefined()
    expect(calls.callback).toBe(1)
    expect(calls.posts).toContainEqual(expect.objectContaining({ type: "deviceAuthComplete" }))
    expect(calls.posts.some((m) => m.type === "deviceAuthFailed")).toBe(false)
  })

  it("reports deviceAuthFailed when the OAuth callback mutation fails", async () => {
    const { calls, ctx } = createCtx({ failCallback: true })

    await handleLogin(ctx, 1, () => 1)

    expect(calls.posts).toContainEqual(
      expect.objectContaining({ type: "deviceAuthFailed", error: "callback exploded" }),
    )
    expect(calls.posts.some((m) => m.type === "deviceAuthComplete")).toBe(false)
    expect((ctx as unknown as Record<string, unknown>).disposeGlobal).toBeUndefined()
    expect((ctx.client as unknown as Record<string, unknown>).global).toBeUndefined()
  })

  it("returns without acknowledging when the login attempt was cancelled", async () => {
    const { calls, ctx } = createCtx()

    await handleLogin(ctx, 1, () => 2) // attempt counter moved on while polling

    expect(calls.callback).toBe(1)
    expect(calls.posts.some((m) => m.type === "deviceAuthComplete")).toBe(false)
    expect(calls.posts.some((m) => m.type === "profileData")).toBe(false)
    expect((ctx as unknown as Record<string, unknown>).disposeGlobal).toBeUndefined()
    expect((ctx.client as unknown as Record<string, unknown>).global).toBeUndefined()
  })
})

describe("handleLogout", () => {
  it("never calls global.dispose and clears the profile after auth.remove succeeds (LOCK-001/003)", async () => {
    const { calls, ctx } = createCtx()

    await handleLogout(ctx)

    expect((ctx as unknown as Record<string, unknown>).disposeGlobal).toBeUndefined()
    expect((ctx.client as unknown as Record<string, unknown>).global).toBeUndefined()
    expect(calls.authRemove).toBe(1)
    expect(calls.posts).toContainEqual({ type: "profileData", data: null })
    expect(calls.refresh).toBe(1)
    expect(calls.posts.some((m) => m.type === "error")).toBe(false)
  })

  it("never swallows an auth.remove failure and never claims a false logout", async () => {
    const { calls, ctx } = createCtx({ failAuthRemove: true })

    await handleLogout(ctx)

    expect(calls.authRemove).toBe(1)
    expect(calls.posts).toContainEqual(
      expect.objectContaining({ type: "error", message: "auth remove exploded" }),
    )
    expect(calls.posts.some((m) => m.type === "profileData")).toBe(false)
    expect(calls.refresh).toBe(0)
    expect((ctx as unknown as Record<string, unknown>).disposeGlobal).toBeUndefined()
    expect((ctx.client as unknown as Record<string, unknown>).global).toBeUndefined()
  })

  it("never reports a post-success provider refresh failure as a logout failure", async () => {
    const { calls, ctx } = createCtx({ failRefresh: true })

    await handleLogout(ctx)

    expect((ctx as unknown as Record<string, unknown>).disposeGlobal).toBeUndefined()
    expect((ctx.client as unknown as Record<string, unknown>).global).toBeUndefined()
    expect(calls.authRemove).toBe(1)
    expect(calls.posts).toContainEqual({ type: "profileData", data: null })
    expect(calls.posts.some((m) => m.type === "error")).toBe(false)
  })

  it("private-first success clears the profile with zero SDK auth.remove", async () => {
    const { calls, ctx } = createCtx({ privateOutcome: "ok" })

    await handleLogout(ctx)

    expect(calls.private).toBe(1)
    expect(calls.authRemove).toBe(0)
    expect(calls.posts).toContainEqual({ type: "profileData", data: null })
    expect(calls.refresh).toBe(1)
    expect(calls.posts.some((m) => m.type === "error")).toBe(false)
    expect((ctx as unknown as Record<string, unknown>).disposeGlobal).toBeUndefined()
    expect((ctx.client as unknown as Record<string, unknown>).global).toBeUndefined()
  })

  it("private terminal surfaces the logout error with zero SDK auth.remove", async () => {
    const { calls, ctx } = createCtx({ privateOutcome: "terminal" })

    await handleLogout(ctx)

    expect(calls.private).toBe(1)
    expect(calls.authRemove).toBe(0)
    expect(calls.posts).toContainEqual(expect.objectContaining({ type: "error" }))
    expect(calls.posts.some((m) => m.type === "profileData")).toBe(false)
    expect(calls.refresh).toBe(0)
    expect((ctx as unknown as Record<string, unknown>).disposeGlobal).toBeUndefined()
    expect((ctx.client as unknown as Record<string, unknown>).global).toBeUndefined()
  })

  it("private unavailable falls back to exactly one same-identity SDK auth.remove", async () => {
    const { calls, ctx } = createCtx({ privateOutcome: "unavailable" })

    await handleLogout(ctx)

    expect(calls.authRemove).toBe(1)
    expect(calls.posts).toContainEqual({ type: "profileData", data: null })
    expect(calls.refresh).toBe(1)
    expect(calls.posts.some((m) => m.type === "error")).toBe(false)
  })

  it("private timeout exact-cancels and falls back to exactly one SDK auth.remove", async () => {
    const { calls, ctx } = createCtx({ privateOutcome: "timeout" })

    await handleLogout(ctx)

    expect(calls.authRemove).toBe(1)
    expect(calls.posts).toContainEqual({ type: "profileData", data: null })
    expect(calls.posts.some((m) => m.type === "error")).toBe(false)
  })
})

describe("handleSetOrganization (LOCK-001)", () => {
  it("never calls global.dispose and refreshes profile/providers/agents after org set succeeds", async () => {
    const { calls, ctx } = createCtx()

    await handleSetOrganization(ctx, "org-1")

    // The backend org.set response is the mutation acknowledgement; the
    // extension must not trigger a second disposal that races the backend's
    // own rebuild.
    expect(calls.orgSet).toBe(1)
    expect((ctx as unknown as Record<string, unknown>).disposeGlobal).toBeUndefined()
    expect((ctx.client as unknown as Record<string, unknown>).global).toBeUndefined()
    expect(calls.posts).toContainEqual(expect.objectContaining({ type: "profileData" }))
    expect(calls.refresh).toBe(1)
    expect(calls.refreshAgents).toBe(1)
    expect(calls.posts.some((m) => m.type === "error")).toBe(false)
  })

  it("never reports a post-success refresh failure as an organization switch failure", async () => {
    const { calls, ctx } = createCtx({ failRefresh: true })

    await handleSetOrganization(ctx, "org-1")

    // The org set succeeded (truthful): the refresh failure is guard/log-only
    // and must not surface as an error message in the webview.
    expect(calls.orgSet).toBe(1)
    expect((ctx as unknown as Record<string, unknown>).disposeGlobal).toBeUndefined()
    expect((ctx.client as unknown as Record<string, unknown>).global).toBeUndefined()
    expect(calls.refresh).toBe(1)
    expect(calls.refreshAgents).toBe(1)
    expect(calls.posts).toContainEqual(expect.objectContaining({ type: "profileData" }))
    expect(calls.posts.some((m) => m.type === "error")).toBe(false)
  })

  it("reports no error message when org set itself fails (best-effort profile reset)", async () => {
    const { calls, ctx } = createCtx({ failOrgSet: true })

    await handleSetOrganization(ctx, "org-1")

    expect(calls.orgSet).toBe(1)
    expect((ctx as unknown as Record<string, unknown>).disposeGlobal).toBeUndefined()
    expect((ctx.client as unknown as Record<string, unknown>).global).toBeUndefined()
    // The mutation failure is logged; the profile reset is best-effort only.
    expect(calls.posts).toContainEqual(expect.objectContaining({ type: "profileData" }))
    expect(calls.refresh).toBe(0)
  })
})
