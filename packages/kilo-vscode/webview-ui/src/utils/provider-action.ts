import type {
  AuthorizeProviderOAuthMessage,
  CompleteProviderOAuthMessage,
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
  ProviderOAuthReadyMessage,
  SaveCustomProviderMessage,
  WebviewMessage,
} from "../types/messages"

type ProviderRequest =
  | ConnectProviderMessage
  | AuthorizeProviderOAuthMessage
  | CompleteProviderOAuthMessage
  | DisconnectProviderMessage
  | DeleteCustomProviderMessage
  | SaveCustomProviderMessage

type ProviderRequestInput =
  | Omit<CanonicalConnectProviderMessage, "requestId">
  | Omit<AuthorizeProviderOAuthMessage, "requestId">
  | Omit<CompleteProviderOAuthMessage, "requestId">
  | Omit<DisconnectProviderMessage, "requestId">
  | Omit<CanonicalDeleteCustomProviderMessage, "requestId">
  | Omit<SaveCustomProviderMessage, "requestId">

type Transport = {
  postMessage: (message: WebviewMessage) => void
  onMessage: (handler: (message: ExtensionMessage) => void) => () => void
}

type Handlers = {
  onOAuthReady?: (message: ProviderOAuthReadyMessage) => void
  onConnected?: (message: ProviderConnectedMessage | CanonicalProviderConnectedMessage) => void
  onDisconnected?: (message: ProviderDisconnectedMessage | CanonicalProviderDisconnectedMessage) => void
  onDeleted?: (message: ProviderDeletedMessage | CanonicalProviderDeletedMessage) => void
  onError?: (
    message: ProviderActionErrorMessage | import("../types/messages").CanonicalProviderActionErrorMessage,
  ) => void
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

    if (message.type === "providerOAuthReady") {
      item.onOAuthReady?.(message)
      return
    }

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
