import { describe, it, expect } from "bun:test"
import { KiloProvider } from "../../src/KiloProvider"
import { ServerStartupError, toErrorMessage } from "../../src/services/cli-backend/server-manager"

type State = "connecting" | "connected" | "disconnected" | "error"

type Internals = {
  connectionState: State
  webview: { postMessage: (message: unknown) => Promise<unknown> } | null
  postConnectionState: (error?: Error | null) => void
}

function createConnection(error: Error | null) {
  return {
    connect: async () => {},
    getClient: () => {
      throw new Error("Not connected")
    },
    onEventFiltered: () => () => undefined,
    onStateChange: () => () => undefined,
    onLanguageChanged: () => () => undefined,
    onProfileChanged: () => () => undefined,
    onFavoritesChanged: () => () => undefined,
    onModelSelectorExpandedChanged: () => () => undefined,
    getConfigRevision: () => 0,
    advanceConfigRevision: () => {},
    onConfigRevision: () => () => undefined,
    registerDirectoryProvider: () => () => undefined,
    getServerInfo: () => null,
    getServerConfig: () => null,
    getConnectionState: () => "error" as const,
    getConnectionError: () => error,
    resolveEventSessionId: () => undefined,
    recordMessageSessionId: () => undefined,
  }
}

function createProvider(error: Error | null) {
  const connection = createConnection(error)
  const provider = new KiloProvider({} as never, connection as never)
  const internal = provider as unknown as Internals
  const sent: unknown[] = []
  internal.webview = {
    postMessage: async (message: unknown) => {
      sent.push(message)
      return {}
    },
  }
  internal.connectionState = "error"
  return { internal, sent }
}

describe("connectionState ServerStartupError forwarding", () => {
  it("preserves structured userMessage/userDetails instead of the full blob", () => {
    const derived = toErrorMessage("Server startup timeout after 30 seconds", [
      "INFO  2026-09-17T00:00:00 +5ms service=config loaded",
      "INFO  2026-09-17T00:00:01 +1ms service=runtime ready=false",
    ])
    const failure = new ServerStartupError(derived.userMessage, derived.userDetails)
    const { internal, sent } = createProvider(failure)
    internal.postConnectionState()
    const message = sent.find((m) => (m as { type?: string }).type === "connectionState") as
      | { type: string; state: State; error?: string; userMessage?: string; userDetails?: string }
      | undefined
    expect(message).toBeDefined()
    expect(message!.state).toBe("error")
    expect(message!.userMessage).toBe("Server startup timeout after 30 seconds")
    expect(message!.userMessage).not.toContain("service=config")
    expect(message!.userDetails).toContain("service=config")
    expect(typeof message!.error).toBe("string")
  })

  it("leaves generic errors without structured fields", () => {
    const { internal, sent } = createProvider(new Error("boom"))
    internal.postConnectionState()
    const message = sent.find((m) => (m as { type?: string }).type === "connectionState") as
      | { type: string; state: State; error?: string; userMessage?: string }
      | undefined
    expect(message).toBeDefined()
    expect(message!.error).toBe("boom")
    expect(message!.userMessage).toBeUndefined()
  })
})
