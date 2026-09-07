/**
 * Provider/model context
 * Manages available providers, models, and the global default selection.
 * Selection is now per-session — see session.tsx.
 */

import { createContext, useContext, createSignal, createMemo, onCleanup } from "solid-js"
import type { ParentComponent, Accessor } from "solid-js"
import { useVSCode } from "./vscode"
import type {
  ProviderView,
  ProviderModel,
  ModelSelection,
  ExtensionMessage,
  ProviderAuthState,
} from "../types/messages"
import type { ProviderAuthMethod } from "@kilocode/sdk/v2/client"
import { flattenModels, findModel as _findModel, isModelValid as isValid } from "./provider-utils"
import type { CanonicalStamp } from "../../../src/config/types"

export type EnrichedModel = ProviderModel & { providerID: string; providerName: string }

interface ProviderDiagnostics {
  action: string
  message: string
  kind?: string
  retry?: {
    type: "retryProviderCleanup"
    mode: "delete" | "restore"
    scope: "global" | "project"
    stamp: CanonicalStamp
    retryID: string
  }
}

interface ProviderContextValue {
  providers: Accessor<Record<string, ProviderView>>
  connected: Accessor<string[]>
  defaults: Accessor<Record<string, string>>
  defaultSelection: Accessor<ModelSelection>
  models: Accessor<EnrichedModel[]>
  findModel: (selection: ModelSelection | null) => EnrichedModel | undefined
  authMethods: Accessor<Record<string, ProviderAuthMethod[]>>
  authStates: Accessor<Record<string, ProviderAuthState>>
  diagnostics?: Accessor<ProviderDiagnostics | Record<string, unknown> | null>
  canonical?: Accessor<boolean>
  canonicalMode?: Accessor<boolean>
  stamp?: Accessor<CanonicalStamp | undefined>
  isModelValid: (selection: ModelSelection | null) => boolean
  retryProviderCleanup?: (retry: {
    type: "retryProviderCleanup"
    mode: "delete" | "restore"
    scope: "global" | "project"
    stamp: CanonicalStamp
    retryID: string
  }) => void
  clearDiagnostics?: () => void
}

export const ProviderContext = createContext<ProviderContextValue>()

export const ProviderProvider: ParentComponent = (props) => {
  const vscode = useVSCode()

  const [providers, setProviders] = createSignal<Record<string, ProviderView>>({})
  const [connected, setConnected] = createSignal<string[]>([])
  const [defaults, setDefaults] = createSignal<Record<string, string>>({})
  // Canonical state starts not-ready/empty — never KILO_AUTO before canonical
  // readiness. Legacy KILO_AUTO only ever arrives via an explicit canonical:false
  // providersLoaded payload after readiness.
  const [defaultSelection, setDefaultSelection] = createSignal<ModelSelection>({ providerID: "", modelID: "" })
  const [authMethods, setAuthMethods] = createSignal<Record<string, ProviderAuthMethod[]>>({})
  const [authStates, setAuthStates] = createSignal<Record<string, ProviderAuthState>>({})
  const [diagnostics, setDiagnostics] = createSignal<Record<string, unknown> | null>(null)
  const [stamp, setStamp] = createSignal<CanonicalStamp>()
  const [canonical, setCanonical] = createSignal(false)
  const [canonicalMode, setCanonicalMode] = createSignal(false)

  const models = createMemo<EnrichedModel[]>(() => flattenModels(providers()))

  function findModel(selection: ModelSelection | null): EnrichedModel | undefined {
    return _findModel(models(), selection)
  }

  function isModelValid(selection: ModelSelection | null): boolean {
    return isValid(providers(), connected(), selection)
  }

  function handleProvidersLoaded(message: Extract<ExtensionMessage, { type: "providersLoaded" }>) {
    if (
      message.canonical &&
      message.materializationVersion !== undefined &&
      message.materializationVersion < (stamp()?.materializationVersion ?? -1)
    )
      return

    // P4.1: canonical mode is sticky — once established, noncanonical providers
    // are ignored so legacy updates cannot reset mode or overwrite canonical state.
    if (message.canonical) setCanonicalMode(true)
    else if (canonicalMode()) return

    const views = Object.fromEntries(
      Object.entries(message.providers).map(([id, item]) => {
        const models = Object.fromEntries(
          Object.entries(item.models).map(([modelID, model]) => {
            const view = model as { id?: unknown; name?: unknown; variants?: unknown }
            const variants =
              view.variants && typeof view.variants === "object" && !Array.isArray(view.variants)
                ? (view.variants as Record<string, Record<string, unknown>>)
                : undefined
            if (typeof view.id !== "string" || typeof view.name !== "string")
              return [modelID, { id: modelID, name: modelID, ...(variants ? { variants } : {}) }]
            return [modelID, { id: view.id, name: view.name, ...(variants ? { variants } : {}) }]
          }),
        )
        return [id, { id: item.id, name: item.name, hasCredential: item.hasCredential, models }]
      }),
    )
    setProviders(views)
    setConnected([...message.connected])
    setDefaults({ ...message.defaults })
    setDefaultSelection(message.defaultSelection)
    setAuthMethods(message.canonical ? {} : message.authMethods)
    setAuthStates(message.canonical ? {} : message.authStates)
    setDiagnostics(message.diagnostics ?? null)
    // P4.1: ready:false closes readiness; ready:true/error-free opens it.
    // prettier-ignore
    if (message.canonical && message.materializationVersion !== undefined && message.materializationVersion > 0 && message.ready !== false) setCanonical(true)
    else if (message.canonical && message.ready === false) setCanonical(false)
    if (message.canonical && "stamp" in message) setStamp(message.stamp)
  }

  // Register handler immediately (not in onMount) so we never miss
  // a providersLoaded message that arrives before the DOM mount.
  const unsubscribe = vscode.onMessage((message: ExtensionMessage) => {
    if (message.type === "providerActionError") {
      setDiagnostics({ action: message.action, message: message.message, kind: message.kind, retry: message.retry })
      return
    }
    // P4.1: canonicalConfigError closes readiness; retain canonicalMode so the
    // webview can recover when a later ready:true arrives.
    if (message.type === "canonicalConfigError") {
      setCanonical(false)
      if ("stamp" in message) setStamp(message.stamp)
      return
    }
    if (message.type !== "providersLoaded") return
    handleProvidersLoaded(message)
  })

  onCleanup(unsubscribe)

  // P4.4-T22: provider selector readiness is canonical-first. Request
  // immediately; HTTP/SSE/generated-SDK is background reconciliation only.
  // Fallback covers legacy noncanonical slow-init (bridge still posts
  // providersLoaded via fetchAndSend).
  vscode.postMessage({ type: "requestProviders" })

  const fallback = setTimeout(() => {
    if (Object.keys(providers()).length === 0) {
      vscode.postMessage({ type: "requestProviders" })
    }
  }, 3000)

  onCleanup(() => {
    clearTimeout(fallback)
  })

  const retryProviderCleanup = (retry: {
    type: "retryProviderCleanup"
    mode: "delete" | "restore"
    scope: "global" | "project"
    stamp: CanonicalStamp
    retryID: string
  }) => {
    // Host-owned: the request carries the opaque retryID only — no authority
    // refs. The host looks up its stored record for scope/mode/ref/stamp.
    vscode.postMessage({ type: "retryProviderCleanup", requestId: retry.retryID, retryID: retry.retryID })
    setDiagnostics(null)
  }

  const clearDiagnostics = () => setDiagnostics(null)

  const value: ProviderContextValue = {
    providers,
    connected,
    defaults,
    defaultSelection,
    models,
    findModel,
    authMethods,
    authStates,
    diagnostics,
    canonical,
    canonicalMode,
    stamp,
    isModelValid,
    retryProviderCleanup,
    clearDiagnostics,
  }

  return <ProviderContext.Provider value={value}>{props.children}</ProviderContext.Provider>
}

export function useProvider(): ProviderContextValue {
  const context = useContext(ProviderContext)
  if (!context) {
    throw new Error("useProvider must be used within a ProviderProvider")
  }
  return context
}
