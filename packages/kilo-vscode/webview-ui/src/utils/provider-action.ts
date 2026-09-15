import type {
  ConnectProviderMessage,
  CanonicalConnectProviderMessage,
  CanonicalDeleteCustomProviderMessage,
  DeleteCustomProviderMessage,
  DisconnectProviderMessage,
  ExtensionMessage,
  ProviderActionErrorMessage,
  ProviderConnectedMessage,
  CanonicalProviderConnectedMessage,
  ProviderDeletedMessage,
  CanonicalProviderDeletedMessage,
  ProviderDisconnectedMessage,
  CanonicalProviderDisconnectedMessage,
  SaveCustomProviderMessage,
  SetFallbackProviderMessage,
  ClearFallbackProviderMessage,
  ProbeFallbackProviderMessage,
  FallbackProviderChangedMessage,
  FallbackProviderErrorMessage,
  FallbackProbeResultMessage,
  WebviewMessage,
} from "../types/messages"

type ProviderRequest =
  | ConnectProviderMessage
  | DisconnectProviderMessage
  | DeleteCustomProviderMessage
  | SaveCustomProviderMessage
  | SetFallbackProviderMessage
  | ClearFallbackProviderMessage
  | ProbeFallbackProviderMessage

type ProviderRequestInput =
  | Omit<CanonicalConnectProviderMessage, "requestId">
  | Omit<DisconnectProviderMessage, "requestId">
  | Omit<CanonicalDeleteCustomProviderMessage, "requestId">
  | Omit<SaveCustomProviderMessage, "requestId">
  | Omit<SetFallbackProviderMessage, "requestId">
  | Omit<ClearFallbackProviderMessage, "requestId">
  | Omit<ProbeFallbackProviderMessage, "requestId">

type Transport = {
  postMessage: (message: WebviewMessage) => void
  onMessage: (handler: (message: ExtensionMessage) => void) => () => void
}

type Handlers = {
  onConnected?: (message: ProviderConnectedMessage | CanonicalProviderConnectedMessage) => void
  onDisconnected?: (message: ProviderDisconnectedMessage | CanonicalProviderDisconnectedMessage) => void
  onDeleted?: (message: ProviderDeletedMessage | CanonicalProviderDeletedMessage) => void
  onError?: (
    message: ProviderActionErrorMessage | import("../types/messages").CanonicalProviderActionErrorMessage,
  ) => void
  onFallbackChanged?: (message: FallbackProviderChangedMessage) => void
  onFallbackError?: (message: FallbackProviderErrorMessage) => void
  onProbeResult?: (message: FallbackProbeResultMessage) => void
}

export function createProviderAction(vscode: Transport) {
  const pending = new Map<string, Handlers>()
  const unsubscribe = vscode.onMessage((message) => {
    const raw = message as unknown as Record<string, unknown>
    const rid = typeof raw.requestId === "string" ? raw.requestId : ""
    if (!rid) return

    const item = pending.get(rid)
    if (!item) return
    pending.delete(rid)

    if (message.type === "providerConnected") {
      item.onConnected?.(message)
      return
    }

    if (message.type === "providerDisconnected") {
      item.onDisconnected?.(message)
      return
    }

    if (message.type === "providerDeleted") {
      item.onDeleted?.(message)
      return
    }

    if (message.type === "providerActionError") {
      item.onError?.(message)
      return
    }

    if (message.type === "fallbackProviderChanged") {
      item.onFallbackChanged?.(message)
      return
    }

    if (message.type === "fallbackProviderError") {
      item.onFallbackError?.(message)
      return
    }

    if (message.type === "fallbackProbeResult") {
      item.onProbeResult?.(message)
    }
  })

  function send(message: ProviderRequestInput, handlers: Handlers = {}) {
    const id = crypto.randomUUID()
    pending.set(id, handlers)
    const payload = { ...message, requestId: id }
    vscode.postMessage(payload as ProviderRequest)
    return id
  }

  function clear(requestId?: string) {
    if (requestId) {
      pending.delete(requestId)
      return
    }
    pending.clear()
  }

  function dispose() {
    clear()
    unsubscribe()
  }

  return { clear, send, dispose }
}
