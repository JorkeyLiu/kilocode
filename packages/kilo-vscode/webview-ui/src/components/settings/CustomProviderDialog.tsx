import { Button } from "@kilocode/kilo-ui/button"
import { useDialog } from "@kilocode/kilo-ui/context/dialog"
import { Dialog } from "@kilocode/kilo-ui/dialog"
import { IconButton } from "@kilocode/kilo-ui/icon-button"
import { ProviderIcon } from "@kilocode/kilo-ui/provider-icon"
import { Select } from "@kilocode/kilo-ui/select"
import { Spinner } from "@kilocode/kilo-ui/spinner"
import { TextField } from "@kilocode/kilo-ui/text-field"
import { showToast } from "@kilocode/kilo-ui/toast"
import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { useConfig } from "../../context/config"
import { useLanguage } from "../../context/language"
import { useProvider } from "../../context/provider"
import { useVSCode } from "../../context/vscode"
import type { ExtensionMessage, ProviderAuthState } from "../../types/messages"
import type { CanonicalAuthoredProviderConfig, ExistingProvider, ProviderConfig } from "../../types/messages/providers"
import { isCanonicalAuthoredConfig } from "../../types/messages/providers"
import { createProviderAction } from "../../utils/provider-action"
import { MASKED_CUSTOM_PROVIDER_KEY, resolveCustomProviderKey } from "../../../../src/shared/custom-provider"
import {
  CUSTOM_PROVIDER_PACKAGE,
  isCustomProviderPackage,
  type CustomProviderPackage,
} from "../../../../src/shared/provider-model"
import { ModelCard } from "./CustomProviderModelCard"
import type { Modalities, Modality, ModelEntry, VariantEntry } from "./CustomProviderModelCard"
import { validateCustomProvider, serializeCanonicalProvider, parseVariant } from "./CustomProviderValidation"
import {
  DEFAULT_CANONICAL_PROTOCOL,
  PROTOCOL_OPTIONS,
  canonicalEndpointFromConfig,
  packageForProtocol,
  resolveCanonicalProtocol,
} from "./CustomProviderValidation"
import type { FormErrors, FormState, HeaderRow } from "./CustomProviderValidation"
import type { CanonicalProviderVariantPayload } from "../../../../src/config/types"
const DEBOUNCE_MS = 500
const SEARCH_DEBOUNCE_MS = 150

const PACKAGE_OPTIONS: Array<{ value: CustomProviderPackage; label: string }> = [
  { value: "@ai-sdk/openai-compatible", label: "OpenAI Compatible" },
  { value: "@ai-sdk/openai", label: "OpenAI Responses" },
  { value: "@ai-sdk/anthropic", label: "Anthropic Messages" },
]

/** Subsequence fuzzy match — "gpt4o" matches "gpt-4o-mini". */
function fuzzy(query: string, target: string) {
  const q = query.toLowerCase()
  const t = target.toLowerCase()
  let qi = 0
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) qi++
  }
  return qi === q.length
}

type FetchedModel = { id: string; name: string }
type RawModel = {
  name?: string
  reasoning?: boolean
  modalities?: { input?: unknown; output?: unknown }
  variants?: Record<string, CanonicalProviderVariantPayload>
}

// Keep this aligned with the CLI provider schema; the UI only exposes image.
const MODES = new Set<Modality>(["text", "audio", "image", "video", "pdf"])

function list(raw: unknown): Modality[] | undefined {
  if (!Array.isArray(raw)) return
  const set = new Set<Modality>()
  raw.forEach((item) => {
    if (typeof item === "string" && MODES.has(item as Modality)) set.add(item as Modality)
  })
  return set.size ? [...set] : undefined
}

function modes(raw: unknown): Modalities {
  if (!raw || typeof raw !== "object") return {}
  const obj = raw as { input?: unknown; output?: unknown }
  const input = list(obj.input)
  const output = list(obj.output)
  return {
    ...(input ? { input } : {}),
    ...(output ? { output } : {}),
  }
}

type DialogConfig = CanonicalAuthoredProviderConfig | ProviderConfig

function initModels(cfg: DialogConfig | undefined): ModelEntry[] {
  const empty = { id: "", name: "", reasoning: false, supportsImages: false, modalities: {}, variants: [] }
  if (!cfg?.models || typeof cfg.models !== "object") return [{ ...empty }]
  const entries = Object.entries(cfg.models)
  if (entries.length === 0) return [{ ...empty }]
  return entries.map(([id, model]) => {
    const raw = model as RawModel
    const modalities = modes(raw.modalities)
    const input = modalities.input ?? []
    return {
      id,
      name: raw.name ?? id,
      reasoning: raw.reasoning ?? false,
      supportsImages: input.includes("image"),
      modalities,
      variants: Object.entries(raw.variants ?? {}).map(parseVariant),
    }
  })
}

function initHeaders(cfg: DialogConfig | undefined): HeaderRow[] {
  if (!cfg || isCanonicalAuthoredConfig(cfg)) return [{ key: "", value: "" }]
  const headers = cfg.options?.["headers"]
  if (!headers || typeof headers !== "object") return [{ key: "", value: "" }]
  const entries = Object.entries(headers as Record<string, unknown>)
  if (entries.length === 0) return [{ key: "", value: "" }]
  return entries.map(([key, value]) => ({ key, value: typeof value === "string" ? value : String(value ?? "") }))
}

function resolveAuth(existing: ExistingProvider | undefined, states: Record<string, ProviderAuthState>) {
  if (!existing) return
  const cfg = existing.config
  if ("env" in cfg && cfg.env?.length) return
  return states[existing.providerID]
}

function initProtocol(cfg: DialogConfig | undefined): FormState["protocol"] {
  if (!cfg || !isCanonicalAuthoredConfig(cfg)) return DEFAULT_CANONICAL_PROTOCOL
  return resolveCanonicalProtocol(cfg.protocol) ?? DEFAULT_CANONICAL_PROTOCOL
}

function initBaseURL(cfg: DialogConfig | undefined): string {
  if (!cfg) return ""
  if (isCanonicalAuthoredConfig(cfg)) return canonicalEndpointFromConfig(cfg)
  const base = cfg.options?.["baseURL"]
  return typeof base === "string" ? base : ""
}

function initNpm(cfg: DialogConfig | undefined, protocol: FormState["protocol"]): CustomProviderPackage {
  if (cfg && isCanonicalAuthoredConfig(cfg)) return packageForProtocol(protocol)
  const npm = cfg?.npm
  if (isCustomProviderPackage(npm)) return npm
  return CUSTOM_PROVIDER_PACKAGE
}

export function initForm(existing: ExistingProvider | undefined, auth: ProviderAuthState | undefined): FormState {
  const protocol = initProtocol(existing?.config)
  return {
    providerID: existing?.providerID ?? "",
    name: existing?.name ?? "",
    npm: initNpm(existing?.config, protocol),
    protocol,
    baseURL: initBaseURL(existing?.config),
    apiKey: resolveCustomProviderKey(auth),
    models: initModels(existing?.config),
    headers: initHeaders(existing?.config),
    saving: false,
  }
}

export interface CustomProviderDialogProps {
  onBack?: () => void
  /** When set, the dialog opens in edit mode with pre-filled values. */
  existing?: ExistingProvider
}

const CustomProviderDialog = (props: CustomProviderDialogProps) => {
  const dialog = useDialog()
  const { config, canonical: configCanonical } = useConfig()
  const provider = useProvider()
  const language = useLanguage()
  const vscode = useVSCode()
  const action = createProviderAction(vscode)
  onCleanup(action.dispose)
  const isCanonical = () => configCanonical?.() === true || provider.canonical?.() === true

  const editing = () => !!props.existing

  const auth = resolveAuth(props.existing, provider.authStates())
  const [form, setForm] = createStore<FormState>(initForm(props.existing, auth))

  const [errors, setErrors] = createStore<FormErrors>({
    providerID: undefined,
    name: undefined,
    baseURL: undefined,
    models: form.models.map((m) => ({ variants: m.variants.map(() => ({})) })),
    headers: form.headers.map(() => ({})),
  })
  const [apiTouched, setApiTouched] = createSignal(false)

  // ── Fallback channel state ──────────────────────────────────────────
  // Identity only: the credential never crosses into the webview. The
  // availability probe runs host-side on explicit action; nothing polls.

  const fallbackOptions = createMemo(() => form.models.map((m) => m.id.trim()).filter(Boolean))
  const [fallbackModel, setFallbackModel] = createSignal("")
  const fallbackPick = () => {
    const opts = fallbackOptions()
    const cur = fallbackModel()
    return cur && opts.includes(cur) ? cur : (opts[0] ?? "")
  }
  const [probeState, setProbeState] = createSignal<"idle" | "checking" | "usable" | "unavailable">("idle")
  const [probeText, setProbeText] = createSignal<string>()
  const activeFallback = () => provider.fallback?.()
  const activeForProvider = () => {
    const f = activeFallback()
    const pid = form.providerID.trim()
    return !!f && !!pid && f.providerID === pid ? f : undefined
  }
  const isActivePick = () => {
    const f = activeForProvider()
    return !!f && f.modelID === fallbackPick()
  }

  const unsubProbe = vscode.onMessage((msg: ExtensionMessage) => {
    if (msg.type !== "fallbackProbeResult") return
    if (msg.providerID !== form.providerID.trim()) return
    if (msg.modelID !== fallbackPick()) return
    if (msg.usable) {
      setProbeState("usable")
      setProbeText("Available as a fallback channel")
    } else {
      setProbeState("unavailable")
      setProbeText(msg.message ?? "Unavailable as a fallback channel")
    }
  })
  onCleanup(unsubProbe)

  function checkFallback() {
    const pid = form.providerID.trim()
    const mid = fallbackPick()
    if (!pid || !mid) return
    setProbeState("checking")
    setProbeText(undefined)
    vscode.postMessage({ type: "probeFallbackProvider", requestId: crypto.randomUUID(), providerID: pid, modelID: mid })
  }

  function setActiveFallback() {
    const stamp = provider.stamp?.()
    const pid = form.providerID.trim()
    const mid = fallbackPick()
    if (!stamp || !pid || !mid) return
    action.send(
      { type: "setFallbackProvider", providerID: pid, modelID: mid, stamp },
      {
        onFallbackChanged: () => {
          setProbeState("checking")
          setProbeText(undefined)
          showToast({
            variant: "success",
            icon: "circle-check",
            title: "Fallback channel active",
            description: `${pid}/${mid} takes over sessions on rate limits`,
          })
        },
        onFallbackError: (message) => {
          showToast({ title: language.t("common.requestFailed"), description: message.message })
        },
      },
    )
  }

  function clearActiveFallback() {
    const stamp = provider.stamp?.()
    if (!stamp) return
    action.send(
      { type: "clearFallbackProvider", stamp },
      {
        onFallbackChanged: () => {
          setProbeState("idle")
          setProbeText(undefined)
        },
        onFallbackError: (message) => {
          showToast({ title: language.t("common.requestFailed"), description: message.message })
        },
      },
    )
  }

  // ── Fetch models state ──────────────────────────────────────────────

  const [fetching, setFetching] = createSignal(false)
  const [fetchError, setFetchError] = createSignal<string>()
  const [fetchedModels, setFetchedModels] = createSignal<FetchedModel[]>()
  const [selected, setSelected] = createSignal<Set<string>>(new Set())
  const [fetchStatus, setFetchStatus] = createSignal<string>()

  // Search within fetched models
  const [search, setSearch] = createSignal("")
  const [debouncedSearch, setDebouncedSearch] = createSignal("")

  createEffect(() => {
    const q = search()
    const timer = setTimeout(() => setDebouncedSearch(q), SEARCH_DEBOUNCE_MS)
    onCleanup(() => clearTimeout(timer))
  })

  const filtered = createMemo(() => {
    const models = fetchedModels()
    if (!models) return []
    const q = debouncedSearch()
    if (!q) return models
    return models.filter((m) => fuzzy(q, m.id) || fuzzy(q, m.name))
  })

  // ── Auto-fetch on debounce ──────────────────────────────────────────

  // Dedicated signals for the URL and API key drive the auto-fetch effect.
  // We avoid reading form.baseURL / form.apiKey inside createEffect because
  // SolidJS store proxies track at the property level — any store write
  // (including setForm("models", ...)) invalidates effects that read from
  // the same store, causing unwanted re-runs that wipe the model picker.
  const [fetchPackage, setFetchPackage] = createSignal(form.npm)
  const [fetchURL, setFetchURL] = createSignal(form.baseURL)
  const [fetchKey, setFetchKey] = createSignal("")
  let fetchVersion = 0

  createEffect(() => {
    const npm = fetchPackage()
    const url = fetchURL()
    const key = fetchKey()
    void key // subscribe to key changes without using the value here

    // Clear previous results whenever URL or key changes
    setFetchedModels(undefined)
    setFetchError(undefined)
    setFetchStatus(undefined)
    setSearch("")

    if (npm === "@ai-sdk/anthropic" || !/^https?:\/\//.test(url.trim())) return

    fetchVersion++
    const version = fetchVersion
    const timer = setTimeout(() => {
      if (version === fetchVersion) doFetch()
    }, DEBOUNCE_MS)
    onCleanup(() => clearTimeout(timer))
  })

  // ── Core fetch logic ────────────────────────────────────────────────

  function doFetch() {
    // Snapshot all values from signals/store before entering async.
    // This avoids reading the store proxy inside callbacks, which could
    // subscribe to unrelated store properties and cause re-render loops.
    const url = fetchURL().trim()
    const raw = fetchKey().trim()
    const env = raw.match(/^\{env:([^}]+)\}$/)?.[1]?.trim()
    const apiKey = isCanonical() ? undefined : raw && !env ? raw : undefined
    // When editing an existing provider with the key field untouched, the
    // webview has no key to send — keys are stripped before provider data
    // reaches it. Send the providerID so the extension can authenticate the
    // fetch with the stored key (#10139). Anything typed into the field
    // (a key or {env:VAR} syntax) takes precedence.
    const providerID = !raw && props.existing ? props.existing.providerID : undefined
    const existing = new Set(form.models.map((m) => m.id.trim().toLowerCase()).filter(Boolean))

    const hdrs = form.headers
      .map((h) => ({ key: h.key.trim(), value: h.value.trim() }))
      .filter((h) => !!h.key && !!h.value)
    const headers = hdrs.length > 0 ? Object.fromEntries(hdrs.map((h) => [h.key, h.value])) : undefined

    // Bump version so any in-flight response from a previous fetch is ignored
    fetchVersion++
    const version = fetchVersion

    setFetching(true)
    setFetchError(undefined)
    setFetchedModels(undefined)
    setFetchStatus(undefined)
    setSearch("")

    const rid = crypto.randomUUID()
    const currentStamp = provider.stamp?.()
    if (isCanonical() && !currentStamp) return

    const unsub = vscode.onMessage((msg: ExtensionMessage) => {
      if (msg.type !== "customProviderModelsFetched") return
      if (!("requestId" in msg) || msg.requestId !== rid) return
      unsub()

      // Stale response — a newer fetch was triggered while this one was in-flight
      if (version !== fetchVersion) return

      setFetching(false)

      if (msg.error) {
        setFetchError(msg.auth ? language.t("provider.custom.models.fetch.authError") : msg.error)
        return
      }

      const models = msg.models ?? []
      if (models.length === 0) {
        setFetchError(language.t("provider.custom.models.fetch.empty"))
        return
      }

      // Filter using the snapshot taken at fetch time (trimmed, case-insensitive)
      const fresh = models.filter((m) => !existing.has(m.id.trim().toLowerCase()))

      if (fresh.length === 0) {
        setFetchStatus(language.t("provider.custom.models.fetch.allExist"))
        return
      }

      // Pre-select all and show the picker
      setSelected(new Set(fresh.map((m) => m.id)))
      setFetchedModels(fresh)
    })

    vscode.postMessage({
      type: "fetchCustomProviderModels",
      requestId: rid,
      baseURL: url,
      providerID,
      headers,
      ...(!isCanonical() ? { apiKey } : {}),
      ...(isCanonical()
        ? {
            canonical: true as const,
            credentialRequested: !!raw && !env,
            stamp: currentStamp!,
          }
        : {}),
    } as Parameters<typeof vscode.postMessage>[0])
  }

  // ── Model picker actions ────────────────────────────────────────────

  function toggleModel(id: string) {
    const next = new Set(selected())
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelected(next)
  }

  function selectAll() {
    const next = new Set(selected())
    for (const m of filtered()) next.add(m.id)
    setSelected(next)
  }

  function deselectAll() {
    const next = new Set(selected())
    for (const m of filtered()) next.delete(m.id)
    setSelected(next)
  }

  function count() {
    return selected().size
  }

  function addSelected() {
    const models = fetchedModels()
    if (!models) return
    const sel = selected()
    const picked = models.filter((m) => sel.has(m.id))
    if (picked.length === 0) return

    // Replace the single empty row or append
    const row = form.models[0]
    const empty = form.models.length === 1 && !!row && !row.id.trim() && !row.name.trim()
    // Dedup against models already in the form (trimmed, case-insensitive). The
    // picker is built from a fetch-time snapshot, so a model the user typed
    // manually after fetching hasn't been filtered out yet.
    const existing = new Set(form.models.map((m) => m.id.trim().toLowerCase()).filter(Boolean))
    const toAdd = picked.filter((m) => {
      const key = m.id.trim().toLowerCase()
      if (!key || existing.has(key)) {
        return false
      }
      existing.add(key)
      return true
    })

    const defaults = (m: FetchedModel): ModelEntry => ({
      ...m,
      reasoning: false,
      supportsImages: false,
      modalities: {},
      variants: [],
    })
    const merged = empty ? toAdd.map(defaults) : [...form.models, ...toAdd.map(defaults)]

    if (toAdd.length > 0) {
      setForm("models", merged)
      setErrors(
        "models",
        merged.map((m) => ({ variants: m.variants.map(() => ({})) })),
      )
    }

    // Keep the picker open with the un-picked models so the user can keep adding.
    // Remove every selected model, including ones skipped as duplicates, so the
    // user isn't re-prompted to add them. Only close when nothing is left.
    const pickedIds = new Set(picked.map((m) => m.id))
    const remaining = models.filter((m) => !pickedIds.has(m.id))

    if (toAdd.length > 0) {
      // Count only models actually added, not duplicates that were skipped.
      setFetchStatus(language.t("provider.custom.models.fetch.added", { count: String(toAdd.length) }))
    } else if (remaining.length === 0) {
      // Nothing added and nothing left in the picker; every fetched model exists.
      setFetchStatus(language.t("provider.custom.models.fetch.allExist"))
    } else {
      // The selected models already existed but other fetched models remain;
      // avoid implying everything was added. Dropping them from the picker is
      // the feedback. Clear any stale status from a prior add.
      setFetchStatus(undefined)
    }

    if (remaining.length === 0) {
      setFetchedModels(undefined)
      setSearch("")
    } else {
      setFetchedModels(remaining)
      setSelected(new Set<string>())
    }
  }

  function cancelFetch() {
    setFetchedModels(undefined)
    setSearch("")
  }

  // ── Form helpers ────────────────────────────────────────────────────

  function goBack() {
    if (props.onBack) {
      props.onBack()
      return
    }
    dialog.close()
  }

  function addModel() {
    setForm("models", (v) => [
      ...v,
      { id: "", name: "", reasoning: false, supportsImages: false, modalities: {}, variants: [] },
    ])
    setErrors("models", (v) => [...v, { variants: [] }])
  }

  function removeModel(index: number) {
    if (form.models.length <= 1) return
    setForm("models", (v) => v.filter((_, i) => i !== index))
    setErrors("models", (v) => v.filter((_, i) => i !== index))
  }

  function addHeader() {
    setForm("headers", (v) => [...v, { key: "", value: "" }])
    setErrors("headers", (v) => [...v, {}])
  }

  function removeHeader(index: number) {
    if (form.headers.length <= 1) return
    setForm("headers", (v) => v.filter((_, i) => i !== index))
    setErrors("headers", (v) => v.filter((_, i) => i !== index))
  }

  function addVariant(mi: number) {
    const blank: VariantEntry = {
      name: "",
      enableThinking: undefined,
      thinking: undefined,
      splitReasoning: undefined,
      reasoningEffort: undefined,
      outputEffort: undefined,
      chatTemplateArgs: undefined,
    }
    setForm("models", mi, "variants", (v) => [...v, blank])
    setErrors("models", mi, "variants", (v) => [...(v ?? []), {}])
  }

  function removeVariant(mi: number, vi: number) {
    setForm("models", mi, "variants", (v) => v.filter((_, i) => i !== vi))
    setErrors("models", mi, "variants", (v) => (v ?? []).filter((_, i) => i !== vi))
  }

  function validate() {
    const cfg = props.existing?.config
    const output = validateCustomProvider({
      form,
      t: language.t,
      editing: editing(),
      disabledProviders: config().disabled_providers ?? [],
      existingProviderIDs: new Set(Object.keys(provider.providers())),
      existingEnv: cfg && "env" in cfg ? cfg.env : undefined,
    })
    setErrors(reconcile(output.errors))
    return output.result
  }

  function save(e: SubmitEvent) {
    e.preventDefault()
    if (form.saving) return
    // Custom provider writes are canonical-only. Non-canonical UI must not
    // send the removed legacy message — surface an explicit unsupported error.
    if (!isCanonical()) {
      showToast({ title: language.t("common.requestFailed"), description: "Provider mutations are canonical-only" })
      return
    }
    const currentStamp = provider.stamp?.()
    if (!currentStamp) return

    const result = validate()
    if (!result) return

    setForm("saving", true)

    // Canonical path: serialize to {name, endpoint, protocol, models} directly.
    // Never invoke legacy serializer shape (npm/options/headers/env).
    const canonicalConfig = serializeCanonicalProvider(form)
    if (!canonicalConfig) {
      setForm("saving", false)
      return
    }

    action.send(
      {
        type: "saveCustomProvider",
        providerID: result.providerID,
        config: canonicalConfig,
        canonical: true as const,
        credentialRequested: apiTouched(),
        stamp: currentStamp,
      },
      {
        onConnected: () => {
          setForm("saving", false)
          dialog.close()
          showToast({
            variant: "success",
            icon: "circle-check",
            title: language.t("provider.connect.toast.connected.title", { provider: result.name }),
            description: language.t("provider.connect.toast.connected.description", { provider: result.name }),
          })
        },
        onError: (message) => {
          setForm("saving", false)
          showToast({ title: language.t("common.requestFailed"), description: message.message })
        },
      },
    )
  }

  // ── Render ──────────────────────────────────────────────────────────

  return (
    <Dialog
      title={
        <IconButton
          tabIndex={-1}
          icon="arrow-left"
          variant="ghost"
          onClick={goBack}
          aria-label={language.t("common.goBack")}
        />
      }
      size="x-large"
      class="custom-provider-dialog"
      transition
    >
      <div class="cpd-dialog-header">
        <ProviderIcon id="synthetic" width={20} height={20} />
        <div class="cpd-dialog-title">
          {editing() ? language.t("provider.custom.edit.title") : language.t("provider.custom.title")}
        </div>
      </div>

      <form onSubmit={save} class="cpd-form">
        <div class="cpd-description">
          {language.t("provider.custom.description.prefix")}
          <a
            href="https://kilo.ai/docs/ai-providers#custom-provider"
            onClick={(e) => {
              e.preventDefault()
              vscode.postMessage({
                type: "openExternal",
                url: "https://kilo.ai/docs/ai-providers#custom-provider",
              })
            }}
          >
            {language.t("provider.custom.description.link")}
          </a>
          {language.t("provider.custom.description.suffix")}
        </div>

        {/* Basic settings: 2-column grid that collapses at narrow widths */}
        <div class="cpd-basic-grid">
          <TextField
            autofocus={!editing()}
            label={language.t("provider.custom.field.providerID.label")}
            placeholder={language.t("provider.custom.field.providerID.placeholder")}
            description={language.t("provider.custom.field.providerID.description")}
            value={form.providerID}
            onChange={(v) => setForm("providerID", v)}
            validationState={errors.providerID ? "invalid" : undefined}
            error={errors.providerID}
            disabled={editing()}
          />
          <TextField
            label={language.t("provider.custom.field.name.label")}
            placeholder={language.t("provider.custom.field.name.placeholder")}
            value={form.name}
            onChange={(v) => setForm("name", v)}
            validationState={errors.name ? "invalid" : undefined}
            error={errors.name}
          />
          <div class="cpd-package-field">
            <label class="cpd-package-label">{language.t("provider.custom.field.package.label")}</label>
            <Show
              when={isCanonical()}
              fallback={
                <Select
                  options={PACKAGE_OPTIONS}
                  current={PACKAGE_OPTIONS.find((option) => option.value === form.npm)}
                  value={(option) => option.value}
                  label={(option) => option.label}
                  onSelect={(option) => {
                    if (!option) return
                    setForm("npm", option.value)
                    setFetchPackage(option.value)
                  }}
                  variant="secondary"
                  triggerVariant="settings"
                />
              }
            >
              <Select
                options={PROTOCOL_OPTIONS}
                current={PROTOCOL_OPTIONS.find((option) => option.value === form.protocol)}
                value={(option) => option.value}
                label={(option) => option.label}
                onSelect={(option) => {
                  if (!option) return
                  setForm("protocol", option.value)
                  const pkg = packageForProtocol(option.value)
                  setForm("npm", pkg)
                  setFetchPackage(pkg)
                }}
                variant="secondary"
                triggerVariant="settings"
              />
            </Show>
          </div>
          <TextField
            label={language.t("provider.custom.field.baseURL.label")}
            placeholder={language.t("provider.custom.field.baseURL.placeholder")}
            value={form.baseURL}
            onChange={(v) => {
              setForm("baseURL", v)
              setFetchURL(v)
            }}
            validationState={errors.baseURL ? "invalid" : undefined}
            error={errors.baseURL}
          />

          <Show when={isCanonical()}>
            <div
              class="cpd-api-key-row"
              aria-disabled="true"
              title="Credential input is collected by the extension host"
            >
              Credential input is collected securely by the extension host when this provider is saved.
            </div>
          </Show>
          <Show when={!isCanonical()}>
            {/* API key: full-width row spanning both columns. Existing credentials stay masked; typing replaces, untouched preserves. */}
            <div class="cpd-api-key-row">
              <TextField
                type="password"
                label={language.t("provider.custom.field.apiKey.label")}
                placeholder={language.t("provider.custom.field.apiKey.placeholder")}
                description={language.t("provider.custom.field.apiKey.description")}
                value={form.apiKey}
                onChange={(v) => {
                  const key = !apiTouched() && form.apiKey === MASKED_CUSTOM_PROVIDER_KEY ? v.replace(/^\*+/, "") : v
                  setApiTouched(true)
                  setForm("apiKey", key)
                  setFetchKey(key)
                }}
              />
            </div>
          </Show>
        </div>

        {/* Models section */}
        <div class="cpd-section">
          <hr class="cpd-divider" />
          <div class="cpd-section-label">
            <span>{language.t("provider.custom.models.label")}</span>
            <Show when={fetching()}>
              <Spinner style={{ width: "12px", height: "12px" }} />
            </Show>
          </div>

          {/* Configured models: user-added cards + add button */}
          <div class="cpd-configured">
            <For each={form.models}>
              {(m, i) => (
                <ModelCard
                  m={m}
                  i={i}
                  errors={errors.models[i()] ?? {}}
                  t={language.t}
                  canRemove={form.models.length > 1}
                  onChangeId={(v) => setForm("models", i(), "id", v)}
                  onChangeName={(v) => setForm("models", i(), "name", v)}
                  onChangeReasoning={(v) => setForm("models", i(), "reasoning", v)}
                  onChangeSupportsImages={(v) => setForm("models", i(), "supportsImages", v)}
                  onRemove={() => removeModel(i())}
                  onAddVariant={() => addVariant(i())}
                  onRemoveVariant={(vi) => removeVariant(i(), vi)}
                  onChangeVariantName={(vi, val) => setForm("models", i(), "variants", vi, "name", val)}
                  onChangeVariantEnableThinking={(vi, val) =>
                    setForm("models", i(), "variants", vi, "enableThinking", val)
                  }
                  onChangeVariantThinking={(vi, val) => setForm("models", i(), "variants", vi, "thinking", val)}
                  onChangeVariantSplitReasoning={(vi, val) =>
                    setForm("models", i(), "variants", vi, "splitReasoning", val)
                  }
                  onChangeVariantReasoningEffort={(vi, val) =>
                    setForm("models", i(), "variants", vi, "reasoningEffort", val)
                  }
                  onChangeVariantOutputEffort={(vi, val) => setForm("models", i(), "variants", vi, "outputEffort", val)}
                  onChangeVariantChatTemplateArgs={(vi, val) =>
                    setForm("models", i(), "variants", vi, "chatTemplateArgs", val)
                  }
                />
              )}
            </For>
            <Button
              type="button"
              size="small"
              variant="ghost"
              icon="plus-small"
              onClick={addModel}
              style={{ "align-self": "flex-start" }}
            >
              {language.t("provider.custom.models.add")}
            </Button>
          </div>

          {/* Available from API: fetched model picker */}
          <Show when={fetchedModels()}>
            {(models) => (
              <div class="cpd-available">
                <span class="cpd-available-label">{language.t("provider.custom.models.fetch.available")}</span>

                <div class="cpd-picker">
                  {/* Header with count + toggle */}
                  <div class="cpd-picker-toolbar">
                    <span
                      style={{
                        "font-size": "var(--kilo-font-size-12)",
                        "font-weight": "500",
                        color: "var(--text-weak-base)",
                      }}
                    >
                      <Show
                        when={debouncedSearch()}
                        fallback={language.t("provider.custom.models.fetch.found", {
                          count: String(models().length),
                        })}
                      >
                        {language.t("provider.custom.models.fetch.showing", {
                          shown: String(filtered().length),
                          total: String(models().length),
                        })}
                      </Show>
                    </span>
                    <div class="cpd-picker-actions">
                      <Button type="button" size="small" variant="ghost" onClick={selectAll}>
                        {language.t("provider.custom.models.fetch.selectAll")}
                      </Button>
                      <Button type="button" size="small" variant="ghost" onClick={deselectAll}>
                        {language.t("provider.custom.models.fetch.deselectAll")}
                      </Button>
                    </div>
                  </div>

                  {/* Search */}
                  <Show when={models().length > 10}>
                    <TextField
                      label={language.t("provider.custom.models.fetch.search")}
                      hideLabel
                      placeholder={language.t("provider.custom.models.fetch.search")}
                      value={search()}
                      onChange={setSearch}
                    />
                  </Show>

                  {/* Model list — multi-column grid */}
                  <div class="cpd-model-list">
                    <For each={filtered()}>
                      {(m) => (
                        <label class="cpd-model-list-item">
                          <input
                            type="checkbox"
                            checked={selected().has(m.id)}
                            onChange={() => toggleModel(m.id)}
                            style={{ cursor: "pointer" }}
                          />
                          <span>{m.id}</span>
                        </label>
                      )}
                    </For>
                  </div>

                  {/* Actions */}
                  <div class="cpd-picker-actions">
                    <Button type="button" size="small" variant="primary" onClick={addSelected} disabled={count() === 0}>
                      {language.t("provider.custom.models.fetch.add", { count: String(count()) })}
                    </Button>
                    <Button type="button" size="small" variant="ghost" onClick={cancelFetch}>
                      {language.t("common.cancel")}
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </Show>

          {/* Fetch error */}
          <Show when={fetchError()}>
            {(err) => (
              <span
                style={{ "font-size": "var(--kilo-font-size-12)", color: "var(--vscode-errorForeground, #f14c4c)" }}
              >
                {err()}
              </span>
            )}
          </Show>

          {/* Fetch status (success/info messages) */}
          <Show when={!fetchError() && fetchStatus()}>
            {(status) => (
              <span
                style={{
                  "font-size": "var(--kilo-font-size-12)",
                  color: "var(--text-weak-base, var(--vscode-descriptionForeground))",
                }}
              >
                {status()}
              </span>
            )}
          </Show>
        </div>

        {/* Fallback channel section (canonical, saved providers only) */}
        <Show when={isCanonical() && editing()}>
          <div class="cpd-section">
            <hr class="cpd-divider" />
            <div class="cpd-section-label">
              <span>Fallback channel</span>
              <Show when={probeState() === "checking"}>
                <Spinner style={{ width: "12px", height: "12px" }} />
              </Show>
            </div>
            <div
              style={{
                "font-size": "var(--kilo-font-size-12)",
                color: "var(--text-weak-base, var(--vscode-descriptionForeground))",
                "margin-bottom": "8px",
              }}
            >
              One custom channel can stay armed as the session fallback for rate limits. Other providers keep working as
              ordinary models; this choice never changes the default model.
            </div>
            <Show
              when={fallbackOptions().length > 0}
              fallback={
                <div
                  style={{
                    "font-size": "var(--kilo-font-size-12)",
                    color: "var(--text-weak-base, var(--vscode-descriptionForeground))",
                  }}
                >
                  Add a model above to arm this provider as a fallback.
                </div>
              }
            >
              <div style={{ display: "flex", gap: "8px", "align-items": "center", "flex-wrap": "wrap" }}>
                <Select
                  options={fallbackOptions().map((id) => ({ value: id, label: id }))}
                  current={fallbackOptions()
                    .map((id) => ({ value: id, label: id }))
                    .find((option) => option.value === fallbackPick())}
                  value={(option) => option.value}
                  label={(option) => option.label}
                  onSelect={(option) => {
                    if (!option) return
                    setFallbackModel(option.value)
                  }}
                  variant="secondary"
                  triggerVariant="settings"
                />
                <Button
                  type="button"
                  size="small"
                  variant="ghost"
                  onClick={checkFallback}
                  disabled={probeState() === "checking" || !fallbackPick()}
                >
                  Check availability
                </Button>
              </div>
              <Show when={probeState() !== "idle" && probeText()}>
                {(text) => (
                  <span
                    style={{
                      "font-size": "var(--kilo-font-size-12)",
                      color:
                        probeState() === "usable"
                          ? "var(--vscode-testing-iconPassed, #73c991)"
                          : probeState() === "checking"
                            ? "var(--text-weak-base, var(--vscode-descriptionForeground))"
                            : "var(--vscode-errorForeground, #f14c4c)",
                    }}
                  >
                    {probeState() === "checking" ? "Checking availability…" : text()}
                  </span>
                )}
              </Show>
              <Show when={activeForProvider()}>
                {(f) => (
                  <div
                    style={{
                      display: "flex",
                      gap: "8px",
                      "align-items": "center",
                      "margin-top": "8px",
                      "font-size": "var(--kilo-font-size-12)",
                    }}
                  >
                    <span>
                      Active fallback: {f().providerID}/{f().modelID}
                    </span>
                    <Button type="button" size="small" variant="ghost" onClick={clearActiveFallback}>
                      Clear
                    </Button>
                  </div>
                )}
              </Show>
              <Show when={!isActivePick() && !!fallbackPick()}>
                <div style={{ "margin-top": "8px" }}>
                  <Button type="button" size="small" variant="primary" onClick={setActiveFallback}>
                    Set as active fallback
                  </Button>
                </div>
              </Show>
            </Show>
          </div>
        </Show>

        {/* Headers section */}
        <Show when={!isCanonical()}>
          <div class="cpd-section">
            <hr class="cpd-divider" />
            <label class="cpd-section-label">{language.t("provider.custom.headers.label")}</label>
            <For each={form.headers}>
              {(h, i) => (
                <div style={{ display: "flex", gap: "8px", "align-items": "start" }}>
                  <div style={{ flex: 1 }}>
                    <TextField
                      label={language.t("provider.custom.headers.key.label")}
                      hideLabel
                      placeholder={language.t("provider.custom.headers.key.placeholder")}
                      value={h.key}
                      onChange={(v) => setForm("headers", i(), "key", v)}
                      validationState={errors.headers[i()]?.key ? "invalid" : undefined}
                      error={errors.headers[i()]?.key}
                    />
                  </div>
                  <div style={{ flex: 1 }}>
                    <TextField
                      label={language.t("provider.custom.headers.value.label")}
                      hideLabel
                      placeholder={language.t("provider.custom.headers.value.placeholder")}
                      value={h.value}
                      onChange={(v) => setForm("headers", i(), "value", v)}
                      validationState={errors.headers[i()]?.value ? "invalid" : undefined}
                      error={errors.headers[i()]?.value}
                    />
                  </div>
                  <IconButton
                    type="button"
                    icon="trash"
                    variant="ghost"
                    onClick={() => removeHeader(i())}
                    disabled={form.headers.length <= 1}
                    aria-label={language.t("provider.custom.headers.remove")}
                    style={{ "margin-top": "6px" }}
                  />
                </div>
              )}
            </For>
            <Button type="button" size="small" variant="ghost" icon="plus-small" onClick={addHeader}>
              {language.t("provider.custom.headers.add")}
            </Button>
          </div>
        </Show>

        {/* Sticky footer */}
        <div class="cpd-footer">
          <Button type="submit" size="large" variant="primary" disabled={form.saving}>
            {form.saving ? language.t("common.saving") : language.t("common.submit")}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

export default CustomProviderDialog
