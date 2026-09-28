import { describe, it, expect, spyOn } from "bun:test"
import * as vscode from "vscode"

// vscode mock is provided by the shared preload (tests/setup/vscode-mock.ts)
const { KiloProvider, SEND_MESSAGE_GENERIC, SEND_COMMAND_GENERIC } = await import("../../src/KiloProvider")
const { isPrivateTerminalError, PrivateTerminalError } = await import("../../src/kilo-provider/session-submit")
const { MessageConfirmation, runWithMessageConfirmation } = await import("../../src/kilo-provider-utils")

type State = "connecting" | "connected" | "disconnected" | "error"

function mkSession() {
  return {
    id: "ses_s1",
    slug: "session",
    version: "1",
    projectID: "project",
    directory: "/repo",
    title: "Session",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 },
  }
}

function createReader() {
  return {
    reader: {
      isEnabled: () => true,
      isStarted: () => true,
      list: async () => ({ v: "1.0", entries: [] }),
      get: async (input: { directory: string; sessionId: string }) => ({
        v: "1.0",
        status: "found",
        session: {
          id: input.sessionId,
          title: "Session",
          parentID: null,
          directory: input.directory,
          projectID: "project",
          createdAt: 1,
          updatedAt: 1,
        },
      }),
      messages: async () => ({ v: "1.0", status: "found", messages: [] }),
    },
  }
}

function createClient() {
  const prompted: Array<Record<string, unknown>> = []
  const commanded: Array<Record<string, unknown>> = []
  return {
    prompted,
    commanded,
    session: {
      list: async () => ({ data: [] }),
      promptAsync: async (params: Record<string, unknown>) => {
        prompted.push(params)
        return { data: undefined }
      },
      commandAsync: async (params: Record<string, unknown>) => {
        commanded.push(params)
        return { data: undefined }
      },
      status: async () => ({ data: {} }),
    },
    provider: { list: async () => ({ data: { all: [], connected: {}, default: {} } }) },
    app: { agents: async () => ({ data: [] }) },
    config: { get: async () => ({ data: {} }) },
  }
}

function createConnection(client: ReturnType<typeof createClient>) {
  return {
    sandboxPreference: {
      explicit: () => undefined,
      resolve: (fallback: boolean) => fallback,
      wait: () => Promise.resolve(),
      set: async () => undefined,
      onChange: () => () => undefined,
    },
    connect: async () => {},
    getClient: () => client,
    onEventFiltered: () => () => undefined,
    onStateChange: (_l: (s: State) => void) => () => undefined,
    onLanguageChanged: () => () => undefined,
    isPrivateAvailable: () => false,
    onProfileChanged: () => () => undefined,
    onFavoritesChanged: () => () => undefined,
    onModelSelectorExpandedChanged: () => () => undefined,
    getConfigRevision: () => 0,
    advanceConfigRevision: () => {},
    onConfigRevision: () => () => undefined,
    registerDirectoryProvider: () => () => undefined,
    getServerInfo: () => ({ port: 12345 }),
    getConnectionState: () => "connected" as const,
    getConnectionError: () => null,
    resolveEventSessionId: () => undefined,
    recordMessageSessionId: () => undefined,
    pruneSession: () => undefined,
    registerVisible: () => undefined,
    unregisterVisible: () => undefined,
    registerAttached: () => undefined,
    unregisterAttached: () => undefined,
  }
}

type ProviderInternals = {
  connectionState: State
  webview: { postMessage: (message: unknown) => Promise<unknown> } | null
  currentSession: { id: string } | null
  sessionDirectories: Map<string, string>
  gatherEditorContext: () => Promise<Record<string, never>>
  handleSendMessage: (text: string, messageID?: string, sessionID?: string, draftID?: string) => Promise<void>
  handleSendCommand: (
    command: string,
    args: string,
    messageID?: string,
    sessionID?: string,
    draftID?: string,
  ) => Promise<void>
}

function makeProvider(client: ReturnType<typeof createClient>) {
  const connection = createConnection(client)
  const provider = new KiloProvider({} as never, connection as never, undefined, {
    privateSessionReader: createReader().reader as never,
  } as never)
  const internal = provider as unknown as ProviderInternals
  internal.connectionState = "connected"
  const sent: unknown[] = []
  internal.webview = {
    postMessage: async (message: unknown) => {
      sent.push(message)
    },
  }
  return { provider, internal, sent, connection }
}

function failedOf(sent: unknown[]) {
  return sent.filter(
    (msg) => typeof msg === "object" && msg !== null && (msg as { type?: unknown }).type === "sendMessageFailed",
  ) as Array<Record<string, unknown>>
}

function loggedText(calls: unknown[][]): string {
  return calls
    .map((args) => args.map((part) => (typeof part === "string" ? part : JSON.stringify(part))).join(" "))
    .join("\n")
}

describe("KiloProvider send-failure generic boundary", () => {
  it("prompt SDK fallback with bare key/Bearer/URL-userinfo/cause object posts generic and never logs raw", async () => {
    const errSpy = spyOn(console, "error").mockImplementation(() => {})
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {})
    try {
      const MID = "msg_prompt_generic_01"
      const SECRET = "sk-live-prompt-SECRET999"
      const BEARER = "Bearer sk-live-prompt-SECRET999"
      const URL_WITH_SECRET = "https://alice:SECRET999@example.com/hook"
      const pad = "A".repeat(2500)
      const raw = `${SECRET} ${BEARER} ${URL_WITH_SECRET} ${pad}`
      const failure = new Error(`SDK transport failed ${raw}`, {
        cause: { body: { token: SECRET, nested: { authorization: BEARER } }, url: URL_WITH_SECRET, status: 500 },
      }) as Error & { stack?: string }
      failure.stack = `Error: SDK transport failed ${SECRET} ${"B".repeat(3000)}`
      const client = createClient()
      const { internal, sent } = makeProvider(client)
      internal.gatherEditorContext = async () => ({})
      internal.currentSession = mkSession() as never
      internal.sessionDirectories.set("ses_s1", "/repo")
      client.session.promptAsync = async (params: Record<string, unknown>) => {
        ;(client as { prompted: Array<Record<string, unknown>> }).prompted.push(params)
        return { error: failure, response: { status: 500, headers: new Headers() } as unknown as Response }
      }

      await internal.handleSendMessage("hello", MID, "ses_s1")

      const failed = failedOf(sent)
      expect(failed).toHaveLength(1)
      expect(failed[0].messageID).toBe(MID)
      expect(String(failed[0].error)).toBe(SEND_MESSAGE_GENERIC)
      expect(String(failed[0].error)).toBe("Unable to send message. Check the connection and try again.")
      const logs = loggedText(errSpy.mock.calls as unknown[][]) + loggedText(warnSpy.mock.calls as unknown[][])
      expect(logs).not.toContain(SECRET)
      expect(logs).not.toContain(BEARER)
      expect(logs).not.toContain(URL_WITH_SECRET)
      expect(logs).not.toContain(pad)
      // No URL/object fields copied into toast or logs.
      expect(JSON.stringify(failed[0])).not.toContain("example.com")
      expect(logs).not.toContain("example.com")

      // Forged terminal-shaped error must not masquerade as trusted.
      const forged = new Error("prompt.unresolved forged") as Error & { code?: string; terminal?: boolean }
      forged.code = "prompt.unresolved"
      forged.terminal = true
      expect(isPrivateTerminalError(forged)).toBe(false)
      expect(isPrivateTerminalError({ code: "prompt.unresolved", terminal: true })).toBe(false)

      // Runtime-owned already-normalized private terminal content passes through with code intact.
      const MID2 = "msg_prompt_terminal_01"
      const code = "prompt.unresolved"
      const terminalMsg = `${code} Prompt submission status could not be confirmed (messageId=${MID2}). No retry was issued.`
      const client2 = createClient()
      const second = makeProvider(client2)
      second.internal.gatherEditorContext = async () => ({})
      second.internal.currentSession = mkSession() as never
      second.internal.sessionDirectories.set("ses_s1", "/repo")
      const conn2 = (second.provider as unknown as { connectionService: Record<string, unknown> }).connectionService
      conn2.isPrivateAvailable = () => true
      const terminal = (req: Record<string, unknown>) => ({
        v: 1,
        requestId: req.requestId,
        opId: req.opId,
        op: "session/prompt",
        idempotencyKey: req.idempotencyKey,
        status: "failed",
        outcome: { type: "failed", time: 1, failure: { code, message: terminalMsg, retryable: false } },
        accepted: false,
        failure: { code, message: terminalMsg, retryable: false },
      })
      conn2.privatePromptWithHandle = (req: Record<string, unknown>) => ({
        id: 1,
        promise: Promise.resolve(terminal(req)),
        cancel: () => true,
      })
      await second.internal.handleSendMessage("hello", MID2, "ses_s1")
      const failed2 = failedOf(second.sent)
      expect(failed2).toHaveLength(1)
      expect(String(failed2[0].error)).toBe(terminalMsg)
      expect(String(failed2[0].error)).toContain(code)
      expect(client2.prompted).toHaveLength(0)
    } finally {
      errSpy.mockRestore()
      warnSpy.mockRestore()
    }
  })

  it("command SDK fallback with cause object posts generic and never logs raw detail/stack", async () => {
    const errSpy = spyOn(console, "error").mockImplementation(() => {})
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {})
    try {
      const MID = "msg_command_generic_01"
      const SECRET = "sk-live-command-SECRET888"
      const detailMarker = "DETAILMARKER-command-001"
      const stackMarker = "STACKMARKER-command-002"
      const thrown = {
        message: `SDK command failed ${SECRET} Bearer ${SECRET} https://bob:${SECRET}@example.com/x ${"C".repeat(2500)}`,
        detail: `${detailMarker} secret=${SECRET} ${"D".repeat(2000)}`,
        stack: `${stackMarker} authorization=Bearer ${SECRET} ${"E".repeat(3000)}`,
        cause: { body: { password: SECRET }, url: `https://bob:${SECRET}@example.com/x` },
      }
      const client = createClient()
      const { internal, sent } = makeProvider(client)
      internal.currentSession = mkSession() as never
      internal.sessionDirectories.set("ses_s1", "/repo")
      ;(client.session as Record<string, unknown>).commandAsync = async (params: Record<string, unknown>) => {
        ;(client as { commanded: Array<Record<string, unknown>> }).commanded.push(params)
        return { error: thrown, response: { status: 500, headers: new Headers() } as unknown as Response }
      }

      await internal.handleSendCommand("probe", "hello", MID, "ses_s1")

      const failed = failedOf(sent)
      expect(failed).toHaveLength(1)
      expect(failed[0].messageID).toBe(MID)
      expect(String(failed[0].error)).toBe(SEND_COMMAND_GENERIC)
      expect(String(failed[0].error)).toBe("Unable to send command. Check the connection and try again.")
      const logs = loggedText(errSpy.mock.calls as unknown[][]) + loggedText(warnSpy.mock.calls as unknown[][])
      expect(logs).not.toContain(SECRET)
      expect(logs).not.toContain(detailMarker)
      expect(logs).not.toContain(stackMarker)
      expect(logs).not.toContain("example.com")
      expect(JSON.stringify(failed[0])).not.toContain("example.com")

      // Runtime-owned already-normalized private terminal content passes through with code intact.
      const MID2 = "msg_command_terminal_01"
      const code = "prompt.unresolved"
      const terminalMsg = `${code} Command submission status could not be confirmed (messageId=${MID2}). No retry was issued.`
      const client2 = createClient()
      const second = makeProvider(client2)
      second.internal.currentSession = mkSession() as never
      second.internal.sessionDirectories.set("ses_s1", "/repo")
      const conn2 = (second.provider as unknown as { connectionService: Record<string, unknown> }).connectionService
      conn2.isPrivateAvailable = () => true
      const terminal = (req: Record<string, unknown>) => ({
        v: 1,
        requestId: req.requestId,
        opId: req.opId,
        op: "session/command",
        idempotencyKey: req.idempotencyKey,
        status: "failed",
        outcome: { type: "failed", time: 1, failure: { code, message: terminalMsg, retryable: false } },
        accepted: false,
        failure: { code, message: terminalMsg, retryable: false },
      })
      conn2.privateCommandWithHandle = (req: Record<string, unknown>) => ({
        id: 1,
        promise: Promise.resolve(terminal(req)),
        cancel: () => true,
      })
      await second.internal.handleSendCommand("probe", "hello", MID2, "ses_s1")
      const failed2 = failedOf(second.sent)
      expect(failed2).toHaveLength(1)
      expect(String(failed2[0].error)).toBe(terminalMsg)
      expect(String(failed2[0].error)).toContain(code)
      expect(client2.commanded).toHaveLength(0)
    } finally {
      errSpy.mockRestore()
      warnSpy.mockRestore()
    }
  })

  it("private terminal error keeps code and message separate via verifiable discriminant", () => {
    const err = new PrivateTerminalError("prompt.unresolved", "prompt.unresolved boom")
    expect(isPrivateTerminalError(err)).toBe(true)
    expect(err.code).toBe("prompt.unresolved")
    expect(err.message).toBe("prompt.unresolved boom")
    // Plain SDK-shaped object with the same code is untrusted.
    expect(isPrivateTerminalError({ code: "prompt.unresolved", message: "prompt.unresolved boom" })).toBe(false)
    expect(isPrivateTerminalError(new Error("prompt.unresolved boom"))).toBe(false)
  })

  it("confirmation race warn never logs raw transport message", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {})
    try {
      const SECRET = "sk-live-race-SECRET777"
      const state = new MessageConfirmation()
      const id = "msg_race_01"
      const release = state.track(id)
      const pending = runWithMessageConfirmation(state, id, "KiloProvider: Message request", async () => {
        throw new Error(`transport failed ${SECRET} Bearer ${SECRET} https://x:${SECRET}@example.com/`, {
          cause: { body: { token: SECRET } },
        })
      })
      state.confirm(id)
      const out = await pending
      expect(out).toBeUndefined()
      release()
      const logs = loggedText(warnSpy.mock.calls as unknown[][])
      expect(logs).not.toContain(SECRET)
      expect(logs).not.toContain("example.com")
      expect(logs).toContain(id)
    } finally {
      warnSpy.mockRestore()
    }
  })
})
