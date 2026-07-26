import type {
  AuthorizeProviderOAuthMessage,
  CompleteProviderOAuthMessage,
  ConnectProviderMessage,
  DeleteCustomProviderMessage,
  DisconnectProviderMessage,
  ExtensionMessage,
  GetProviderCredentialMessage,
  ProviderActionErrorMessage,
  ProviderConnectedMessage,
  ProviderCredentialErrorMessage,
  ProviderCredentialLoadedMessage,
  ProviderDeletedMessage,
  ProviderDisconnectedMessage,
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
  | GetProviderCredentialMessage

type ProviderRequestInput =
  | Omit<ConnectProviderMessage, "requestId">
  | Omit<AuthorizeProviderOAuthMessage, "requestId">
  | Omit<CompleteProviderOAuthMessage, "requestId">
  | Omit<DisconnectProviderMessage, "requestId">
  | Omit<DeleteCustomProviderMessage, "requestId">
  | Omit<SaveCustomProviderMessage, "requestId">
  | (Omit<GetProviderCredentialMessage, "requestID"> & { requestID?: string })

type Transport = {
  postMessage: (message: WebviewMessage) => void
  onMessage: (handler: (message: ExtensionMessage) => void) => () => void
}

type Handlers = {
  onOAuthReady?: (message: ProviderOAuthReadyMessage) => void
  onConnected?: (message: ProviderConnectedMessage) => void
  onDisconnected?: (message: ProviderDisconnectedMessage) => void
  onDeleted?: (message: ProviderDeletedMessage) => void
  onError?: (message: ProviderActionErrorMessage) => void
  onCredentialLoaded?: (message: ProviderCredentialLoadedMessage) => void
  onCredentialError?: (message: ProviderCredentialErrorMessage) => void
}

export function createProviderAction(vscode: Transport) {
  const pending = new Map<string, Handlers>()
  const unsubscribe = vscode.onMessage((message) => {
    const raw = message as unknown as Record<string, unknown>
    const rid =
      (typeof raw.requestId === "string" ? raw.requestId : "") ||
      (typeof raw.requestID === "string" ? raw.requestID : "")
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
      return
    }

    if (message.type === "providerCredentialLoaded") {
      item.onCredentialLoaded?.(message)
      return
    }

    if (message.type === "providerCredentialError") {
      item.onCredentialError?.(message)
    }
  })

  function send(message: ProviderRequestInput, handlers: Handlers = {}) {
    const id = crypto.randomUUID()
    pending.set(id, handlers)
    // Credential messages use requestID (uppercase); other provider messages use requestId.
    const useUpper = message.type === "getProviderCredential"
    const payload = useUpper ? { ...message, requestID: id } : { ...message, requestId: id }
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
