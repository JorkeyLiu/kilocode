import { describe, expect, it } from "bun:test"
import { createProviderAction } from "../../webview-ui/src/utils/provider-action"
import type { ExtensionMessage, WebviewMessage } from "../../webview-ui/src/types/messages"

function createTransport() {
  const sent: WebviewMessage[] = []
  let handler: ((message: ExtensionMessage) => void) | undefined

  return {
    sent,
    receive(message: ExtensionMessage) {
      handler?.(message)
    },
    postMessage(message: WebviewMessage) {
      sent.push(message)
    },
    onMessage(next: (message: ExtensionMessage) => void) {
      handler = next
      return () => {
        if (handler === next) {
          handler = undefined
        }
      }
    },
  }
}

describe("createProviderAction", () => {
  it("routes terminal provider messages by request id", () => {
    const transport = createTransport()
    const action = createProviderAction(transport)
    const seen: string[] = []

    action.send(
      {
        type: "connectProvider",
        providerID: "openai",
        apiKey: "sk-test",
      },
      {
        onConnected: (message) => seen.push(`connected:${message.providerID}`),
      },
    )

    const sent = transport.sent[0]
    expect(sent?.type).toBe("connectProvider")
    expect("requestId" in (sent ?? {}) ? sent.requestId : "").toBeString()

    const requestId = "requestId" in (sent ?? {}) ? sent.requestId : ""
    transport.receive({
      type: "providerConnected",
      requestId,
      providerID: "openai",
    })
    transport.receive({
      type: "providerConnected",
      requestId,
      providerID: "openai",
    })

    expect(seen).toEqual(["connected:openai"])
    action.dispose()
  })

  it("keeps concurrent requests isolated", () => {
    const transport = createTransport()
    const action = createProviderAction(transport)
    const seen: string[] = []

    action.send(
      {
        type: "connectProvider",
        providerID: "anthropic",
        canonical: true,
        credentialRequested: true,
        stamp: { globalHash: null, projectHash: null, materializationVersion: 0, assetHash: null },
      },
      {
        onConnected: (message) => seen.push(`connected:${message.providerID}`),
      },
    )
    action.send(
      {
        type: "disconnectProvider",
        providerID: "openai",
      },
      {
        onDisconnected: (message) => seen.push(`disconnect:${message.providerID}`),
      },
    )

    const connected = transport.sent[0]
    const disconnect = transport.sent[1]
    const connectedId = "requestId" in (connected ?? {}) ? connected.requestId : ""
    const disconnectId = "requestId" in (disconnect ?? {}) ? disconnect.requestId : ""

    transport.receive({
      type: "providerDisconnected",
      requestId: disconnectId,
      providerID: "openai",
    })
    transport.receive({
      type: "providerConnected",
      requestId: connectedId,
      providerID: "anthropic",
    })

    expect(seen).toEqual(["disconnect:openai", "connected:anthropic"])
    action.dispose()
  })

  it("can drop stale requests", () => {
    const transport = createTransport()
    const action = createProviderAction(transport)
    const seen: string[] = []

    const requestId = action.send(
      {
        type: "saveCustomProvider",
        providerID: "myprovider",
        config: {
          name: "My Provider",
          options: { baseURL: "https://example.com/v1" },
          models: { "model-1": { name: "Model One" } },
        },
      },
      {
        onError: (message) => seen.push(message.message),
      },
    )

    action.clear(requestId)
    transport.receive({
      type: "providerActionError",
      requestId,
      providerID: "myprovider",
      action: "connect",
      message: "boom",
    })

    expect(seen).toEqual([])
    action.dispose()
  })

  it("routes providerDeleted messages", () => {
    const transport = createTransport()
    const action = createProviderAction(transport)
    const seen: string[] = []

    action.send(
      {
        type: "deleteCustomProvider",
        providerID: "myprovider",
      },
      {
        onDeleted: (message) => seen.push(`deleted:${message.providerID}`),
      },
    )

    const sent = transport.sent[0]
    const requestId = "requestId" in (sent ?? {}) ? sent.requestId : ""
    transport.receive({
      type: "providerDeleted",
      requestId,
      providerID: "myprovider",
    })

    expect(seen).toEqual(["deleted:myprovider"])
    action.dispose()
  })

  it("has no legacy credential request/response types", () => {
    const transport = createTransport()
    const action = createProviderAction(transport)
    // @ts-expect-error legacy credential request type is removed
    action.send({ type: "getProviderCredential", providerID: "openai" })
    const sent = transport.sent[0] as unknown as Record<string, unknown>
    // Unknown provider request kinds still get a requestId envelope without legacy requestID routing.
    expect(sent?.type).toBe("getProviderCredential")
    expect(sent).toHaveProperty("requestId")
    expect(sent).not.toHaveProperty("requestID")
    action.dispose()
  })

  it("ignores legacy providerCredentialLoaded/Error payloads", () => {
    const transport = createTransport()
    const action = createProviderAction(transport)
    const seen: string[] = []

    action.send(
      {
        type: "disconnectProvider",
        providerID: "openai",
      },
      {
        onDisconnected: (message) => seen.push(`disconnect:${message.providerID}`),
      },
    )

    const sent = transport.sent[0]
    const requestId = "requestId" in (sent ?? {}) ? sent.requestId : ""
    transport.receive({
      type: "providerCredentialLoaded",
      requestId,
      providerID: "openai",
    } as unknown as ExtensionMessage)
    transport.receive({
      type: "providerCredentialError",
      requestId,
      providerID: "openai",
      error: "Unable to load API key",
    } as unknown as ExtensionMessage)

    expect(seen).toEqual([])
    action.dispose()
  })
})
