/**
 * Config context
 * Manages backend configuration state (permissions, agents, providers, etc.)
 * and exposes an updateConfig method to apply partial updates.
 *
 * Changes are accumulated in a local draft and only sent to the extension
 * when saveConfig() is called. This allows batching multiple settings
 * changes into a single write (which triggers disposeAll on the CLI).
 */

import { createContext, useContext, createSignal, createMemo, onCleanup } from "solid-js"
import type { ParentComponent, Accessor } from "solid-js"
import { useVSCode } from "./vscode"
import type { Config, ExtensionMessage, FeatureFlags } from "../types/messages"
import {
  configUnsetPaths,
  deepMerge,
  mergeScopedConfig,
  newSaveID,
  pruneConfigSet,
  stripNulls,
  resolveConfig,
  subtractSentDraft,
} from "../utils/config-utils"
import { splitConfigByScope } from "../utils/config-scope"

function has(value: Record<string, unknown>) {
  return Object.keys(value).length > 0
}

export interface SaveError {
  message: string
  details?: string
}

interface ConfigContextValue {
  config: Accessor<Config>
  globalConfig: Accessor<Config>
  projectConfig: Accessor<Config>
  settings: Accessor<Record<string, unknown>>
  features: Accessor<FeatureFlags>
  loading: Accessor<boolean>
  isDirty: Accessor<boolean>
  saving: Accessor<boolean>
  saveError: Accessor<SaveError | null>
  updateConfig: (partial: Partial<Config>) => void
  updateGlobalConfig: (partial: Partial<Config>) => void
  updateProjectConfig: (partial: Partial<Config>) => void
  updateSetting: (key: string, value: unknown) => void
  saveConfig: () => void
  discardConfig: () => void
}

export const ConfigContext = createContext<ConfigContextValue>()

export const ConfigProvider: ParentComponent = (props) => {
  const vscode = useVSCode()

  const [config, setConfig] = createSignal<Config>({})
  const [globalConfig, setGlobalConfig] = createSignal<Config>({})
  const [projectConfig, setProjectConfig] = createSignal<Config>({})
  const [settings, setSettings] = createSignal<Record<string, unknown>>({})
  const [features, setFeatures] = createSignal<FeatureFlags>({ sandboxControls: false })
  const [loading, setLoading] = createSignal(true)
  const [draft, setDraft] = createSignal<Partial<Config>>({})
  const [globalDraft, setGlobalDraft] = createSignal<Partial<Config>>({})
  const [projectDraft, setProjectDraft] = createSignal<Partial<Config>>({})
  const [settingsDraft, setSettingsDraft] = createSignal<Record<string, unknown>>({})
  const isDirty = createMemo(
    () =>
      has(draft() as Record<string, unknown>) ||
      has(globalDraft() as Record<string, unknown>) ||
      has(projectDraft() as Record<string, unknown>) ||
      has(settingsDraft()),
  )
  // Last config received from the server — used to revert on discard
  const [saved, setSaved] = createSignal<Config>({})
  const [savedGlobal, setSavedGlobal] = createSignal<Config>({})
  const [savedProject, setSavedProject] = createSignal<Config>({})
  const [savedSettings, setSavedSettings] = createSignal<Record<string, unknown>>({})
  // True while a saveConfig() write is in-flight — used to clear draft on success
  // and to guard against stale configLoaded messages overwriting optimistic state.
  const [saving, setSaving] = createSignal(false)
  // Identity of the in-flight save whose ack/failure we are waiting for.
  const [pendingSaveID, setPendingSaveID] = createSignal<string | null>(null)
  // Identity of the most recent successfully confirmed save — stale echoes of
  // older saves are ignored so they can't clobber newer drafts (LOCK-005).
  const [lastSavedID, setLastSavedID] = createSignal<string | null>(null)
  // Draft snapshots sent with each in-flight save, keyed by the save identity
  // (LOCK-002). The matching ack subtracts only paths whose current draft value
  // still equals the sent value, so same-field edits made after send survive.
  const sentByID = new Map<
    string,
    { changes: Partial<Config>; globals: Partial<Config>; projects: Partial<Config> }
  >()
  // Error from the most recent saveConfig() attempt, or null if no error.
  // Cleared when the user edits the draft again or starts a new save.
  const [saveError, setSaveError] = createSignal<SaveError | null>(null)

  function applyConfigUpdated(message: Extract<ExtensionMessage, { type: "configUpdated" }>) {
    const id = message.saveID
    const pending = pendingSaveID()
    const last = lastSavedID()
    const confirmed = id !== undefined && id === pending
    const echo = id !== undefined && id !== pending && id === last
    // LOCK-001: a stale save's data must never clear or overwrite a newer
    // draft. The stale ack releases only that save's sent snapshot (bookkeeping);
    // it never subtracts current draft paths — the still-pending newer save
    // owns the draft, and only its matching ack subtracts sent values.
    if (id !== undefined && !confirmed && !echo) {
      sentByID.delete(id)
      return
    }
    if (confirmed) {
      // This configUpdated is the acknowledgement of our saveConfig() write.
      // Drop the sent fields from the drafts — but only where the current
      // draft value still equals the value that save sent, so edits the user
      // made while the save was in flight stay pending and remain visible
      // (LOCK-002).
      setSaving(false)
      setPendingSaveID(null)
      setLastSavedID(id)
      const sent = sentByID.get(id)
      let rest = draft() as Partial<Config>
      let restGlobal = globalDraft() as Partial<Config>
      let restProject = projectDraft() as Partial<Config>
      if (sent !== undefined) {
        sentByID.delete(id)
        rest = subtractSentDraft(rest, sent.changes)
        restGlobal = subtractSentDraft(restGlobal, sent.globals)
        restProject = subtractSentDraft(restProject, sent.projects)
      }
      setDraft(rest)
      setGlobalDraft(restGlobal)
      setProjectDraft(restProject)
      setSaveError(null)
      setConfig(resolveConfig(message.config, rest, has(rest)))
      if (message.globalConfig !== undefined) {
        setGlobalConfig(mergeScopedConfig(message.globalConfig, restGlobal))
        setSavedGlobal(message.globalConfig)
      }
      if (message.projectConfig !== undefined) {
        setProjectConfig(mergeScopedConfig(message.projectConfig, restProject))
        setSavedProject(message.projectConfig)
      }
      setFeatures(message.features)
    } else {
      // configUpdated from a different source (e.g. PermissionDock save) or an
      // echo of the last confirmed save. Re-apply the draft on top so pending
      // settings changes are preserved.
      setConfig(resolveConfig(message.config, draft(), has(draft() as Record<string, unknown>)))
      if (message.globalConfig !== undefined) {
        setGlobalConfig(mergeScopedConfig(message.globalConfig, globalDraft()))
        setSavedGlobal(message.globalConfig)
      }
      if (message.projectConfig !== undefined) {
        setProjectConfig(mergeScopedConfig(message.projectConfig, projectDraft()))
        setSavedProject(message.projectConfig)
      }
      setFeatures(message.features)
    }
    if (message.settings) mergeSettings(message.settings)
    setSaved(message.config)
  }

  // Register handler immediately (not in onMount) so we never miss
  // a configLoaded message that arrives before the DOM mount.
  const unsubscribe = vscode.onMessage((message: ExtensionMessage) => {
    if (message.type === "configLoaded") {
      // Skip if a save is in-flight — a stale configLoaded must not overwrite
      // the optimistically-updated state while the write is being confirmed.
      if (saving()) return
      // Re-apply the draft on top so pending changes (e.g. a toggled switch the
      // user hasn't saved yet) stay visible instead of snapping back.
      setConfig(resolveConfig(message.config, draft(), has(draft() as Record<string, unknown>)))
      setFeatures(message.features)
      setSaved(message.config)
      if (message.settings) mergeSettings(message.settings)
      if (message.globalConfig !== undefined) {
        setGlobalConfig(mergeScopedConfig(message.globalConfig, globalDraft()))
        setSavedGlobal(message.globalConfig)
      }
      if (message.projectConfig !== undefined) {
        setProjectConfig(mergeScopedConfig(message.projectConfig, projectDraft()))
        setSavedProject(message.projectConfig)
      }
      setLoading(false)
      return
    }
    if (message.type === "globalConfigLoaded") {
      if (saving()) return
      setGlobalConfig(mergeScopedConfig(message.config, globalDraft()))
      setSavedGlobal(message.config)
      return
    }
    if (message.type === "configUpdated") {
      applyConfigUpdated(message)
      return
    }
    if (message.type === "configUpdateFailed") {
      // A stale failure for an older save must not disturb the active save;
      // it only releases that save's sent snapshot (the draft stays for retry).
      if (message.saveID !== undefined && message.saveID !== pendingSaveID()) {
        sentByID.delete(message.saveID)
        return
      }
      // The write was rejected (e.g. schema validation) — surface the error
      // and keep the draft + isDirty so the user can correct and retry. The
      // failed save's sent snapshot is released; its paths remain in the draft.
      setSaving(false)
      setPendingSaveID(null)
      if (message.saveID !== undefined) sentByID.delete(message.saveID)
      setSaveError({ message: message.message, details: message.details })
      return
    }
  })

  onCleanup(unsubscribe)

  function mergeSettings(patch: Record<string, unknown>) {
    setSavedSettings((prev) => ({ ...prev, ...patch }))
    setSettings((prev) => ({ ...prev, ...patch, ...settingsDraft() }))
  }

  const requestInitialData = () => {
    vscode.postMessage({ type: "requestConfig" })
  }

  // Request config immediately; if the extension's httpClient is not yet ready,
  // extensionDataReady will fire once initialization completes and we retry once.
  requestInitialData()

  const fallback = setTimeout(() => {
    if (loading()) {
      requestInitialData()
    }
  }, 3000)

  const unsubReady = vscode.onMessage((message: ExtensionMessage) => {
    if (message.type !== "extensionDataReady") return
    unsubReady()
    clearTimeout(fallback)
    if (loading()) {
      requestInitialData()
    }
  })

  onCleanup(() => {
    unsubReady()
    clearTimeout(fallback)
  })

  function updateConfig(partial: Partial<Config>) {
    // Optimistically update local state with deep merge + null stripping
    setConfig((prev) => stripNulls(deepMerge(prev, partial)))
    // Accumulate in draft — will be sent on saveConfig()
    setDraft((prev) => deepMerge(prev as Config, partial))
    // Clear any stale error from a previous failed save — the user is editing
    // again, so the old error message no longer reflects the current draft.
    setSaveError(null)
  }

  function updateGlobalConfig(partial: Partial<Config>) {
    setGlobalConfig((prev) => mergeScopedConfig(prev, partial))
    setGlobalDraft((prev) => deepMerge(prev as Config, partial))
    setSaveError(null)
  }

  function updateProjectConfig(partial: Partial<Config>) {
    setProjectConfig((prev) => mergeScopedConfig(prev, partial))
    setProjectDraft((prev) => deepMerge(prev as Config, partial))
    setSaveError(null)
  }

  function updateSetting(key: string, value: unknown) {
    setSettings((prev) => ({ ...prev, [key]: value }))
    setSettingsDraft((prev) => ({ ...prev, [key]: value }))
    setSaveError(null)
  }

  function saveConfig() {
    const changes = draft()
    const globals = globalDraft()
    const projects = projectDraft()
    const pending = settingsDraft()
    const configDirty = has(changes as Record<string, unknown>)
    const globalDirty = has(globals as Record<string, unknown>)
    const projectDirty = has(projects as Record<string, unknown>)
    const settingsDirty = has(pending)
    if (!configDirty && !globalDirty && !projectDirty && !settingsDirty) return
    // Settings apply immediately via updateSetting and never race the config
    // write, so they must not disturb an in-flight config save's pending state.
    setSaveError(null)
    if (settingsDirty) {
      for (const [key, value] of Object.entries(pending)) {
        vscode.postMessage({ type: "updateSetting", key, value })
      }
      setSavedSettings((prev) => ({ ...prev, ...pending }))
      setSettingsDraft({})
    }
    if (!configDirty && !globalDirty && !projectDirty) return
    // LOCK-001: globally unique save identity — no provider-local counter that
    // can collide across webview reloads or windows.
    const saveID = newSaveID()
    // Don't clear draft/isDirty yet — wait for configUpdated confirmation.
    // If the write fails, the save bar stays visible so the user can retry.
    setSaving(true)
    setPendingSaveID(saveID)
    // Split so per-project settings (e.g. commit_message.prompt) land in the
    // workspace's kilo.json instead of the global one. Send one message so the
    // extension confirms only after both scopes are saved.
    const split = splitConfigByScope(changes)
    const next = deepMerge(split.global as Config, globals)
    const project = deepMerge(split.project as Config, projects)
    // LOCK-002: snapshot exactly what was sent under the save identity so the
    // matching ack can preserve same-field edits made while the save flew.
    sentByID.set(saveID, { changes, globals, projects })
    vscode.postMessage({
      type: "updateConfig",
      config: pruneConfigSet(next) as Config,
      projectConfig: pruneConfigSet(project) as Config,
      globalUnset: configUnsetPaths(next),
      projectUnset: configUnsetPaths(project),
      saveID,
    })
  }

  function discardConfig() {
    setConfig(saved())
    setGlobalConfig(savedGlobal())
    setProjectConfig(savedProject())
    setDraft({})
    setGlobalDraft({})
    setProjectDraft({})
    setSettings(savedSettings())
    setSettingsDraft({})
    setSaveError(null)
  }

  const value: ConfigContextValue = {
    config,
    globalConfig,
    projectConfig,
    settings,
    features,
    loading,
    isDirty,
    saving,
    saveError,
    updateConfig,
    updateGlobalConfig,
    updateProjectConfig,
    updateSetting,
    saveConfig,
    discardConfig,
  }

  return <ConfigContext.Provider value={value}>{props.children}</ConfigContext.Provider>
}

export function useConfig(): ConfigContextValue {
  const context = useContext(ConfigContext)
  if (!context) {
    throw new Error("useConfig must be used within a ConfigProvider")
  }
  return context
}
