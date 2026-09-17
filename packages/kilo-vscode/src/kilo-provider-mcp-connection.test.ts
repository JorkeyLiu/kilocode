import { describe, expect, test, spyOn, afterEach, mock } from "bun:test"
import * as vscode from "vscode"
import { KiloProvider } from "./KiloProvider"
import { KiloConnectionService } from "./services/cli-backend/connection-service"
import { MCP_AUTHENTICATE_TIMEOUT_MS } from "./kilo-provider/mcp-connection-privatefirst"

// vscode mock is provided by the shared preload (tests/setup/vscode-mock.ts)
afterEach(() => {
  mock.restore()
})

type Req = Record<string, unknown>

function connectSucceeded(req: Req) {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "mcp/connect",
    idempotencyKey: req.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: Date.now() },
    accepted: true,
    data: { connected: true },
  }
}

function disconnectSucceeded(req: Req) {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "mcp/disconnect",
    idempotencyKey: req.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: Date.now() },
    accepted: true,
    data: { disconnected: true },
  }
}

function authenticateSucceeded(req: Req) {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "mcp/authenticate",
    idempotencyKey: req.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: Date.now() },
    accepted: true,
    data: { authenticated: true },
  }
}

function failed(req: Req, op: string, code: string, retryable: boolean) {
  const failure = { code, message: "m", retryable }
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op,
    idempotencyKey: req.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time: Date.now(), failure: { ...failure } },
    accepted: false,
    failure: { ...failure },
  }
}

function statusSucceeded(req: Req) {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "mcp/status",
    idempotencyKey: req.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: Date.now() },
    accepted: true,
    data: { status: { demo: { status: "connected" } } },
  }
}

describe("KiloProvider MCP connect/disconnect private-only actions", () => {
  function makeProvider(opts: {
    privateAvailable: boolean
    connectImpl?: (req: Req) => unknown
    disconnectImpl?: (req: Req) => unknown
    authenticateImpl?: (req: Req) => unknown
    statusImpl?: (req: Req) => unknown
    sdkStatusThrow?: boolean
    canonical?: boolean
  }) {
    const connectCalls: Req[] = []
    const disconnectCalls: Req[] = []
    const authenticateCalls: Req[] = []
    const statusCalls: Req[] = []
    const sdkStatusCalls: Req[] = []
    const posted: Req[] = []
    // The SDK client exposes only the status read: there is no
    // client.mcp.connect/disconnect/authenticate to call. Any host attempt to
    // reach one would throw here instead of silently passing.
    const client = {
      mcp: {
        status: async (p: Req) => {
          sdkStatusCalls.push(p)
          if (opts.sdkStatusThrow) throw new Error("sdk down")
          return { data: { demo: { status: "connected" } } }
        },
      },
    }
    const handle = (calls: Req[], impl?: (req: Req) => unknown) => (req: Req) => {
      calls.push(req)
      return { id: 7, promise: Promise.resolve({ kind: "valid", result: impl ? impl(req) : statusSucceeded(req) }), cancel: () => true }
    }
    const connectionService = {
      isPrivateAvailable: () => opts.privateAvailable,
      privateMcpConnectOutcomeWithHandle: handle(connectCalls, opts.connectImpl ?? connectSucceeded),
      privateMcpDisconnectOutcomeWithHandle: handle(disconnectCalls, opts.disconnectImpl ?? disconnectSucceeded),
      privateMcpAuthenticateOutcomeWithHandle: handle(authenticateCalls, opts.authenticateImpl ?? authenticateSucceeded),
      privateMcpStatusOutcomeWithHandle: handle(statusCalls, opts.statusImpl ?? statusSucceeded),
      getClient: () => client as unknown as never,
      getConnectionError: () => null,
      sandboxPreference: { onChange: () => ({ dispose: () => {} }) } as unknown as never,
      onEvent: () => () => {},
      onStateChange: () => () => {},
      getConfigRevision: () => 0,
      onConfigRevision: () => () => {},
    } as unknown as KiloConnectionService
    const provider = new KiloProvider(
      { fsPath: "/tmp" } as unknown as import("vscode").Uri,
      connectionService as unknown as KiloConnectionService,
      undefined,
      { projectDirectory: "/tmp" },
    )
    const anyProvider = provider as unknown as Record<string, unknown>
    anyProvider.getWorkspaceDirectory = () => "/tmp"
    // `client` is a getter over connectionService.getClient(), so the stub
    // above already serves the SDK client with no connect/disconnect/auth.
    if (opts.canonical) {
      anyProvider.canonicalConfig = { materializationReady: true }
      anyProvider.canonicalReady = true
    }
    const post = spyOn(provider, "postMessage").mockImplementation((msg: unknown) => {
      posted.push(msg as Req)
    })
    const errors = spyOn(vscode.window, "showErrorMessage").mockResolvedValue(undefined)
    return {
      provider: anyProvider,
      connectCalls,
      disconnectCalls,
      authenticateCalls,
      statusCalls,
      sdkStatusCalls,
      posted,
      errors,
      post,
    }
  }

  function loaded(posted: Req[]) {
    return posted.filter((m) => m.type === "mcpStatusLoaded")
  }

  function done(posted: Req[]) {
    return posted.filter((m) => m.type === "mcpActionDone")
  }

  test("connect runs one private mutation then status refresh with zero SDK mutation", async () => {
    const ctx = makeProvider({ privateAvailable: true })
    await (ctx.provider.handleMcpConnect as (n: string) => Promise<void>)("demo")
    expect(ctx.connectCalls).toHaveLength(1)
    expect(ctx.disconnectCalls).toHaveLength(0)
    expect(ctx.statusCalls).toHaveLength(1)
    expect(ctx.sdkStatusCalls).toHaveLength(0)
    const req = ctx.connectCalls[0]!
    expect(req.op).toBe("mcp/connect")
    expect((req.context as Req).directory).toBe("/tmp")
    expect((req.payload as Req).name).toBe("demo")
    expect(req.opId).toBe(req.idempotencyKey)
    expect(String(req.opId).startsWith("mcp-connect:")).toBeTrue()
    expect(loaded(ctx.posted)).toHaveLength(1)
    expect(done(ctx.posted)).toHaveLength(0)
    expect(ctx.errors).toHaveBeenCalledTimes(0)
  })

  test("disconnect runs one private mutation then status refresh with zero SDK mutation", async () => {
    const ctx = makeProvider({ privateAvailable: true })
    await (ctx.provider.handleMcpDisconnect as (n: string) => Promise<void>)("demo")
    expect(ctx.disconnectCalls).toHaveLength(1)
    expect(ctx.connectCalls).toHaveLength(0)
    expect(ctx.statusCalls).toHaveLength(1)
    expect(ctx.sdkStatusCalls).toHaveLength(0)
    expect(String(ctx.disconnectCalls[0]!.opId).startsWith("mcp-disconnect:")).toBeTrue()
    expect(loaded(ctx.posted)).toHaveLength(1)
    expect(ctx.errors).toHaveBeenCalledTimes(0)
  })

  test("terminal not-found shows an error yet still converges status and clears loading", async () => {
    const ctx = makeProvider({
      privateAvailable: true,
      connectImpl: (req) => failed(req, "mcp/connect", "mcp.not_found", false),
    })
    await (ctx.provider.handleMcpConnect as (n: string) => Promise<void>)("ghost")
    expect(ctx.connectCalls).toHaveLength(1)
    expect(ctx.statusCalls).toHaveLength(1)
    expect(ctx.errors).toHaveBeenCalledTimes(1)
    expect(String(ctx.errors.mock.calls[0]?.[0])).toContain("ghost")
    expect(loaded(ctx.posted)).toHaveLength(1)
    expect(done(ctx.posted)).toHaveLength(0)
  })

  test("ambiguous mutation shows an error yet still converges status", async () => {
    const ctx = makeProvider({
      privateAvailable: true,
      disconnectImpl: (req) => ({
        v: 1,
        requestId: req.requestId,
        opId: req.opId,
        op: "mcp/disconnect",
        idempotencyKey: req.idempotencyKey,
        status: "ambiguous",
        outcome: { type: "ambiguous", time: Date.now() },
        accepted: false,
        transportUnknown: true,
      }),
    })
    await (ctx.provider.handleMcpDisconnect as (n: string) => Promise<void>)("demo")
    expect(ctx.disconnectCalls).toHaveLength(1)
    expect(ctx.statusCalls).toHaveLength(1)
    expect(ctx.errors).toHaveBeenCalledTimes(1)
    expect(loaded(ctx.posted)).toHaveLength(1)
  })

  test("failed status re-observation clears loading via mcpActionDone without touching the cache", async () => {
    const ctx = makeProvider({
      privateAvailable: true,
      statusImpl: () => ({ kind: "invalid", detail: "bad" }),
      sdkStatusThrow: true,
    })
    await (ctx.provider.handleMcpConnect as (n: string) => Promise<void>)("demo")
    expect(ctx.connectCalls).toHaveLength(1)
    // Private-authority status has zero SDK fallback; invalid closes as
    // unavailable so convergence posts the minimal completion instead.
    expect(ctx.sdkStatusCalls).toHaveLength(0)
    expect(loaded(ctx.posted)).toHaveLength(0)
    const completions = done(ctx.posted)
    expect(completions).toHaveLength(1)
    expect(completions[0]).toMatchObject({ name: "demo", ok: false })
    expect(ctx.errors).toHaveBeenCalledTimes(0)
  })

  test("unavailable transport fails closed with one error and a completion, never a second mutation", async () => {
    const ctx = makeProvider({ privateAvailable: false, sdkStatusThrow: true })
    await (ctx.provider.handleMcpDisconnect as (n: string) => Promise<void>)("demo")
    expect(ctx.disconnectCalls).toHaveLength(0)
    expect(ctx.statusCalls).toHaveLength(0)
    // Private-authority status has zero SDK fallback; the mutation itself
    // never touches the SDK and is never replayed.
    expect(ctx.sdkStatusCalls).toHaveLength(0)
    expect(ctx.errors).toHaveBeenCalledTimes(1)
    const completions = done(ctx.posted)
    expect(completions).toHaveLength(1)
    expect(completions[0]).toMatchObject({ name: "demo", ok: false })
  })

  test("canonical readiness fails closed before any private call", async () => {
    const ctx = makeProvider({ privateAvailable: true, canonical: true })
    await (ctx.provider.handleMcpConnect as (n: string) => Promise<void>)("demo")
    expect(ctx.connectCalls).toHaveLength(0)
    expect(ctx.errors).toHaveBeenCalledTimes(1)
    expect(done(ctx.posted).length).toBeGreaterThan(0)
  })

  test("authenticate runs one private mutation then status refresh with zero SDK mutation", async () => {
    const ctx = makeProvider({ privateAvailable: true })
    await (ctx.provider.handleMcpAuthenticate as (n: string) => Promise<void>)("demo")
    expect(ctx.authenticateCalls).toHaveLength(1)
    expect(ctx.connectCalls).toHaveLength(0)
    expect(ctx.disconnectCalls).toHaveLength(0)
    expect(ctx.statusCalls).toHaveLength(1)
    expect(ctx.sdkStatusCalls).toHaveLength(0)
    const req = ctx.authenticateCalls[0]!
    expect(req.op).toBe("mcp/authenticate")
    expect((req.context as Req).directory).toBe("/tmp")
    expect((req.payload as Req).name).toBe("demo")
    expect(req.opId).toBe(req.idempotencyKey)
    expect(String(req.opId).startsWith("mcp-authenticate:")).toBeTrue()
    expect(loaded(ctx.posted)).toHaveLength(1)
    expect(done(ctx.posted)).toHaveLength(0)
    expect(ctx.errors).toHaveBeenCalledTimes(0)
  })

  test("authenticate terminal failure shows an error yet still converges status", async () => {
    const ctx = makeProvider({
      privateAvailable: true,
      authenticateImpl: (req) => failed(req, "mcp/authenticate", "mcp.not_found", false),
    })
    await (ctx.provider.handleMcpAuthenticate as (n: string) => Promise<void>)("ghost")
    expect(ctx.authenticateCalls).toHaveLength(1)
    expect(ctx.statusCalls).toHaveLength(1)
    expect(ctx.errors).toHaveBeenCalledTimes(1)
    expect(String(ctx.errors.mock.calls[0]?.[0])).toContain("ghost")
    expect(loaded(ctx.posted)).toHaveLength(1)
  })

  test("authenticate canonical readiness fails closed before any private call", async () => {
    const ctx = makeProvider({ privateAvailable: true, canonical: true })
    await (ctx.provider.handleMcpAuthenticate as (n: string) => Promise<void>)("demo")
    expect(ctx.authenticateCalls).toHaveLength(0)
    expect(ctx.errors).toHaveBeenCalledTimes(1)
    expect(done(ctx.posted).length).toBeGreaterThan(0)
  })

  test("authenticate missing name clears loading without a private call", async () => {
    const ctx = makeProvider({ privateAvailable: true })
    await (ctx.provider.handleMcpAuthenticate as (n: string) => Promise<void>)("")
    expect(ctx.authenticateCalls).toHaveLength(0)
    expect(ctx.statusCalls).toHaveLength(0)
    const completions = done(ctx.posted)
    expect(completions).toHaveLength(1)
    expect(completions[0]).toMatchObject({ name: "", ok: false })
  })

  test("authenticate waits on the OAuth bound, not the short action timeout", async () => {
    expect(MCP_AUTHENTICATE_TIMEOUT_MS).toBe(5 * 60 * 1000)
    const ctx = makeProvider({ privateAvailable: true })
    const delays: number[] = []
    const orig = globalThis.setTimeout
    const patched = ((fn: (...a: never[]) => void, ms?: number, ...rest: never[]) => {
      if (typeof ms === "number") delays.push(ms)
      return (orig as (...a: never[]) => unknown)(fn, ms, ...rest)
    }) as typeof setTimeout
    globalThis.setTimeout = patched
    try {
      await (ctx.provider.handleMcpAuthenticate as (n: string) => Promise<void>)("demo")
    } finally {
      globalThis.setTimeout = orig
    }
    expect(ctx.authenticateCalls).toHaveLength(1)
    expect(delays).toContain(MCP_AUTHENTICATE_TIMEOUT_MS)
  })

  test("authenticate cancelled/ambiguous outcome still converges status without hanging", async () => {
    const ctx = makeProvider({
      privateAvailable: true,
      authenticateImpl: (req) => ({
        v: 1,
        requestId: req.requestId,
        opId: req.opId,
        op: "mcp/authenticate",
        idempotencyKey: req.idempotencyKey,
        status: "ambiguous",
        outcome: { type: "ambiguous", time: Date.now() },
        accepted: false,
        transportUnknown: true,
      }),
    })
    await (ctx.provider.handleMcpAuthenticate as (n: string) => Promise<void>)("demo")
    expect(ctx.authenticateCalls).toHaveLength(1)
    expect(ctx.statusCalls).toHaveLength(1)
    expect(ctx.errors).toHaveBeenCalledTimes(1)
    expect(loaded(ctx.posted)).toHaveLength(1)
    expect(done(ctx.posted)).toHaveLength(0)
  })

  test("unknown Error with URL/token/path never reaches showErrorMessage", async () => {
    const secret = "tok-live-abc-123"
    const url = "https://mcp.example.com/sensitive"
    const path = "/tmp/secret-mcp-path-xyz"
    const ctx = makeProvider({
      privateAvailable: true,
      connectImpl: () => {
        throw new Error(`fetch ${url}?token=${secret} failed at ${path} env=SECRET_ENV command="mcp-secret-cmd"`)
      },
      statusImpl: () => ({ kind: "invalid", detail: "bad" }),
    })
    await (ctx.provider.handleMcpConnect as (n: string) => Promise<void>)("demo")
    expect(ctx.connectCalls).toHaveLength(1)
    expect(ctx.errors).toHaveBeenCalledTimes(1)
    const text = String(ctx.errors.mock.calls[0]?.[0])
    expect(text).not.toContain(secret)
    expect(text).not.toContain(url)
    expect(text).not.toContain(path)
    expect(text).not.toContain("SECRET_ENV")
    expect(text).not.toContain("mcp-secret-cmd")
    expect(text).toContain("internal error")
  })

  test("unknown failure code with secret never reaches showErrorMessage", async () => {
    const secretCode = "mcp.evil-leak?token=tok-xyz-999&url=https://mcp.example.com/secret"
    const ctx = makeProvider({
      privateAvailable: true,
      connectImpl: (req) => failed(req, "mcp/connect", secretCode, false),
    })
    await (ctx.provider.handleMcpConnect as (n: string) => Promise<void>)("demo")
    expect(ctx.connectCalls).toHaveLength(1)
    expect(ctx.errors).toHaveBeenCalledTimes(1)
    const text = String(ctx.errors.mock.calls[0]?.[0])
    expect(text).not.toContain("tok-xyz-999")
    expect(text).not.toContain("mcp.example.com")
    expect(text).not.toContain(secretCode)
    expect(text).toContain("internal error")
  })
})
