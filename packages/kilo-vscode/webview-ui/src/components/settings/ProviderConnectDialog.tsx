import { Button } from "@kilocode/kilo-ui/button"
import { useDialog } from "@kilocode/kilo-ui/context/dialog"
import { Dialog } from "@kilocode/kilo-ui/dialog"
import { IconButton } from "@kilocode/kilo-ui/icon-button"
import { Select } from "@kilocode/kilo-ui/select"
import { Spinner } from "@kilocode/kilo-ui/spinner"
import { TextField, TextFieldRoot } from "@kilocode/kilo-ui/text-field"
import { Tooltip } from "@kilocode/kilo-ui/tooltip"
import { showToast } from "@kilocode/kilo-ui/toast"
import type { ProviderAuthAuthorization, ProviderAuthMethod } from "@kilocode/sdk/v2/client"
import { Component, For, Match, Show, Switch, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "../../context/language"
import { useProvider } from "../../context/provider"
import { useVSCode } from "../../context/vscode"
import { createProviderAction } from "../../utils/provider-action"
import {
  ATOMIC_CHAT_PROVIDER_KEY,
  isLocalProviderOptionalApiKey,
  LOCAL_PROVIDER_API_KEY_PLACEHOLDER,
} from "../../utils/local-providers"
import AnacondaDesktopDialog from "./AnacondaDesktopDialog"

interface ProviderConnectDialogProps {
  providerID: string
  oauthOnly?: boolean
  /** When true, skip method selection and go directly to the API form (LOCK-035). */
  manageApiKey?: boolean
}

interface ViewState {
  methodIndex?: number
  authorization?: ProviderAuthAuthorization
  phase?: "authorizing" | "connecting"
  error?: string
  field?: string
  failed?: string
  /** LOCK-072: inline confirmation view within the same dialog instance */
  confirmingRemove?: boolean
  /** Credential reveal: loading state for on-demand key fetch */
  credentialLoading?: boolean
  /** Credential reveal: error state (generic sanitized message) */
  credentialError?: string
  /** Credential reveal: whether the password field shows plaintext */
  showKey?: boolean
}

type Prompt = NonNullable<ProviderAuthMethod["prompts"]>[number]

function fallbackMethods(label: string): ProviderAuthMethod[] {
  return [{ type: "api", label }]
}

function formatError(value: unknown, fallback: string): string {
  if (value && typeof value === "object" && "message" in value) {
    const message = (value as { message?: unknown }).message
    if (typeof message === "string" && message) return message
  }
  if (typeof value === "string" && value) return value
  return fallback
}

function visible(prompt: Prompt, values: Record<string, string>) {
  const rule = prompt.when
  if (!rule) return true
  const value = values[rule.key] ?? ""
  if (rule.op === "eq") return value === rule.value
  return value !== rule.value
}

const ProviderConnectDialog: Component<ProviderConnectDialogProps> = (props) => {
  if (props.providerID === "anaconda-desktop") return <AnacondaDesktopDialog />

  const dialog = useDialog()
  const language = useLanguage()
  const provider = useProvider()
  const vscode = useVSCode()
  const action = createProviderAction(vscode)

  const [state, setState] = createStore<ViewState>({})

  // LOCK-005: Credential reveal — local signal for the loaded plaintext key
  const [originalKey, setOriginalKey] = createSignal<string | null>(null)
  let pendingCredentialID: string | undefined
  // Direct callback ref for seeding ApiView's value without a side-effect memo
  let setApiKeyValue: ((v: string) => void) | undefined

  const item = createMemo(() => provider.providers()[props.providerID])
  const name = () => item()?.name ?? props.providerID
  const methods = createMemo<ProviderAuthMethod[]>(() => {
    const list =
      provider.authMethods()[props.providerID] ?? fallbackMethods(language.t("provider.connect.method.apiKey"))
    if (props.oauthOnly) return list.filter((item) => item.type === "oauth")
    return list
  })
  const method = createMemo(() => {
    const index = state.methodIndex
    return index === undefined ? undefined : methods()[index]
  })

  function promptLabel(prompt: Prompt) {
    if (props.providerID === "azure" && prompt.key === "endpointType") {
      return language.t("provider.connect.azure.endpointType.label")
    }
    if (props.providerID === "azure" && prompt.key === "resourceName") {
      return language.t("provider.connect.azure.resourceName.label")
    }
    if (props.providerID === "azure" && prompt.key === "baseURL") {
      return language.t("provider.connect.azure.baseURL.label")
    }
    return prompt.message
  }

  function promptPlaceholder(prompt: Prompt) {
    if (props.providerID === "azure" && prompt.key === "resourceName") {
      return language.t("provider.connect.azure.resourceName.placeholder")
    }
    if (props.providerID === "azure" && prompt.key === "baseURL") {
      return language.t("provider.connect.azure.baseURL.placeholder")
    }
    if (prompt.type === "text") return prompt.placeholder
    return undefined
  }

  function optionLabel(prompt: Prompt, option: { label: string; value: string; hint?: string }) {
    if (props.providerID === "azure" && prompt.key === "endpointType" && option.value === "resourceName") {
      return language.t("provider.connect.azure.endpointType.resourceName.label")
    }
    if (props.providerID === "azure" && prompt.key === "endpointType" && option.value === "baseURL") {
      return language.t("provider.connect.azure.endpointType.baseURL.label")
    }
    return option.label
  }

  function optionHint(prompt: Prompt, option: { label: string; value: string; hint?: string }) {
    if (props.providerID === "azure" && prompt.key === "endpointType" && option.value === "resourceName") {
      return language.t("provider.connect.azure.endpointType.resourceName.hint")
    }
    if (props.providerID === "azure" && prompt.key === "endpointType" && option.value === "baseURL") {
      return language.t("provider.connect.azure.endpointType.baseURL.hint")
    }
    return option.hint
  }

  function optionText(prompt: Prompt, option: { label: string; value: string; hint?: string }) {
    const label = optionLabel(prompt, option)
    const hint = optionHint(prompt, option)
    return hint ? `${label} (${hint})` : label
  }

  /** LOCK-003/004: Request the saved credential on-demand via provider action utility. */
  function requestCredential() {
    setState({ ...state, credentialLoading: true, credentialError: undefined })
    pendingCredentialID = action.send(
      { type: "getProviderCredential", providerID: props.providerID },
      {
        onCredentialLoaded: (message) => {
          // LOCK-004: stale response guard — only apply if request is still pending
          if (pendingCredentialID === undefined) return
          pendingCredentialID = undefined
          setOriginalKey(message.apiKey)
          // Direct assignment: seed the editable value synchronously
          setApiKeyValue?.(message.apiKey)
          setState({ ...state, credentialLoading: false, credentialError: undefined })
        },
        onCredentialError: (message) => {
          if (pendingCredentialID === undefined) return
          pendingCredentialID = undefined
          setState({
            ...state,
            credentialLoading: false,
            credentialError: message.error || language.t("provider.apiKey.manage.error"),
          })
        },
      },
    )
  }

  onCleanup(() => {
    // LOCK-007: Clear pending credential request and plaintext signal on cleanup
    pendingCredentialID = undefined
    setOriginalKey(null)
    action.dispose()
  })

  onMount(() => {
    // LOCK-035: manageApiKey forces the API method deterministically
    if (props.manageApiKey) {
      const apiIndex = methods().findIndex((m) => m.type === "api")
      if (apiIndex >= 0) {
        selectMethod(apiIndex)
        // LOCK-003/005: On-demand credential fetch for manage mode
        requestCredential()
        return
      }
      // No API method available — close silently
      dialog.close()
      return
    }
    if (methods().length !== 1) return
    selectMethod(0)
  })

  function openExternal(url: string) {
    vscode.postMessage({ type: "openExternal", url })
  }

  function reset() {
    action.clear()
    pendingCredentialID = undefined
    setOriginalKey(null)
    setState({
      methodIndex: undefined,
      authorization: undefined,
      phase: undefined,
      error: undefined,
      field: undefined,
      failed: undefined,
      confirmingRemove: undefined,
      credentialLoading: undefined,
      credentialError: undefined,
      showKey: undefined,
    })
  }

  function back() {
    if (props.manageApiKey || methods().length === 1) {
      dialog.close()
      return
    }
    reset()
  }

  function fail(message: string) {
    const failed = state.authorization?.method === "auto" || state.phase === "authorizing"
    setState({
      ...state,
      phase: undefined,
      error: failed ? undefined : message,
      field: undefined,
      failed: failed ? message : undefined,
    })
  }

  function succeed() {
    showToast({
      variant: "success",
      icon: "circle-check",
      title: language.t("provider.connect.toast.connected.title", { provider: name() }),
      description: language.t("provider.connect.toast.connected.description", { provider: name() }),
    })
    dialog.close()
  }

  /** LOCK-072/073: Switch to inline confirmation view (no nested dialog.show). */
  function removeApiKey() {
    setState({ ...state, confirmingRemove: true, error: undefined, field: undefined })
  }

  /** LOCK-073: Cancel confirmation returns to API management form. */
  function cancelRemove() {
    setState({ ...state, confirmingRemove: false, error: undefined })
  }

  /** LOCK-073: Execute the disconnect after confirmation. On failure, keep confirm view visible with error. */
  function executeRemove() {
    action.send(
      { type: "disconnectProvider", providerID: props.providerID },
      {
        onDisconnected: () => {
          showToast({
            variant: "success",
            icon: "circle-check",
            title: language.t("provider.apiKey.remove.toast.title", { provider: name() }),
            description: language.t("provider.apiKey.remove.toast.description", { provider: name() }),
          })
          dialog.close()
        },
        onError: (message) => {
          // LOCK-073: surface error, remain in confirm view so user can retry
          setState({ ...state, confirmingRemove: true, error: message.message, field: undefined })
        },
      },
    )
  }

  function selectMethod(index: number) {
    const current = methods()[index]
    action.clear()
    setState({
      methodIndex: index,
      authorization: undefined,
      phase: current?.type === "oauth" ? "authorizing" : undefined,
      error: undefined,
      field: undefined,
      failed: undefined,
    })
    if (current?.type !== "oauth") return

    action.send(
      {
        type: "authorizeProviderOAuth",
        providerID: props.providerID,
        method: index,
      },
      {
        onOAuthReady: (message) => {
          setState({
            ...state,
            authorization: message.authorization,
            phase: undefined,
            error: undefined,
            failed: undefined,
          })
        },
        onError: (message) => fail(message.message),
      },
    )
  }

  function connect(apiKey: string, metadata?: Record<string, string>) {
    setState({
      ...state,
      phase: "connecting",
      error: undefined,
      field: undefined,
      failed: undefined,
    })
    action.send(
      {
        type: "connectProvider",
        providerID: props.providerID,
        apiKey,
        metadata,
      },
      {
        onConnected: succeed,
        onError: (message) => fail(message.message),
      },
    )
  }

  function complete(code?: string) {
    const index = state.methodIndex
    if (index === undefined) return

    setState({
      ...state,
      phase: "connecting",
      error: undefined,
      field: undefined,
      failed: undefined,
    })
    action.send(
      {
        type: "completeProviderOAuth",
        providerID: props.providerID,
        method: index,
        code,
      },
      {
        onConnected: succeed,
        onError: (message) => fail(message.message),
      },
    )
  }

  const title = () =>
    props.manageApiKey
      ? language.t("provider.connect.title.manageApiKey", { provider: name() })
      : language.t("provider.connect.title", { provider: name() })

  const MethodSelection: Component = () => {
    return (
      <div class="dialog-confirm-body" style={{ display: "flex", "flex-direction": "column", gap: "12px" }}>
        <div class="provider-connect-body">{language.t("provider.connect.selectMethod", { provider: name() })}</div>
        <div style={{ display: "flex", "flex-direction": "column", gap: "8px" }}>
          <For each={methods()}>
            {(item, index) => (
              <Button variant="secondary" size="large" onClick={() => selectMethod(index())}>
                {item.type === "api" ? item.label || language.t("provider.connect.method.apiKey") : item.label}
              </Button>
            )}
          </For>
        </div>
        <div class="dialog-confirm-actions">
          <Button variant="ghost" size="large" onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
        </div>
      </div>
    )
  }

  const ApiView: Component = () => {
    const [value, setValue] = createSignal("")
    const [fields, setFields] = createStore<Record<string, string>>({})
    const prompts = createMemo(() => method()?.prompts?.filter((prompt) => visible(prompt, fields)) ?? [])
    const apiKeyOptional = () => isLocalProviderOptionalApiKey(props.providerID)

    // Register direct callback so onCredentialLoaded can seed the value without a side-effect memo
    setApiKeyValue = setValue
    onCleanup(() => {
      if (setApiKeyValue === setValue) setApiKeyValue = undefined
    })

    // LOCK-006: Whether the Update button should be disabled (unchanged value)
    const unchanged = () => props.manageApiKey && originalKey() !== null && value() === originalKey()
    // LOCK-006: Whether the value was cleared to empty (validation state, not removal)
    const emptyEdited = () => props.manageApiKey && originalKey() !== null && value() === "" && !apiKeyOptional()

    function apiKeyDescription() {
      if (props.manageApiKey) {
        return language.t("provider.apiKey.manage.description", { provider: name() })
      }
      if (props.providerID === ATOMIC_CHAT_PROVIDER_KEY) {
        return language.t("provider.connect.atomicChat.description")
      }
      if (apiKeyOptional()) {
        return language.t("provider.connect.apiKey.description.local", { provider: name() })
      }
      return language.t("provider.connect.apiKey.description", { provider: name() })
    }

    function apiKeyLabel() {
      if (apiKeyOptional()) {
        return language.t("provider.connect.apiKey.label.optional", { provider: name() })
      }
      return language.t("provider.connect.apiKey.label", { provider: name() })
    }

    function submit(e: SubmitEvent) {
      e.preventDefault()
      const trimmed = value().trim()
      const apiKey = trimmed || (apiKeyOptional() ? LOCAL_PROVIDER_API_KEY_PLACEHOLDER : "")
      if (!apiKey) {
        setState({ ...state, error: language.t("provider.connect.apiKey.required"), field: "apiKey" })
        return
      }
      const metadata: Record<string, string> = {}
      for (const prompt of prompts()) {
        const field = (fields[prompt.key] ?? "").trim()
        if (!field) {
          setState({
            ...state,
            error: language.t("provider.connect.prompt.required", { field: promptLabel(prompt) }),
            field: prompt.key,
          })
          return
        }
        metadata[prompt.key] = field
      }
      connect(apiKey, Object.keys(metadata).length > 0 ? metadata : undefined)
    }

    // LOCK-005: Toggle password visibility — no autofocus
    function toggleKeyVisibility() {
      setState({ ...state, showKey: !state.showKey })
    }

    return (
      <form
        class="dialog-confirm-body"
        style={{ display: "flex", "flex-direction": "column", gap: "16px" }}
        onSubmit={submit}
      >
        <div class="provider-connect-body">{apiKeyDescription()}</div>
        <Show when={state.credentialLoading}>
          <div class="provider-connect-status">
            <Spinner />
            <span>{language.t("provider.apiKey.manage.loading")}</span>
          </div>
        </Show>
        <Show when={state.credentialError}>
          <div style={{ color: "var(--vscode-errorForeground)", "font-size": "var(--kilo-font-size-13)" }}>
            {state.credentialError}
          </div>
        </Show>
        <Show when={!state.credentialLoading}>
          {props.manageApiKey && originalKey() !== null ? (
            /* LOCK-009: Local Kobalte composition — eye toggle as flex sibling inside input-wrapper */
            <TextFieldRoot
              data-component="input"
              data-variant="normal"
              value={value()}
              onChange={setValue}
              validationState={state.field === "apiKey" ? "invalid" : emptyEdited() ? "invalid" : undefined}
            >
              <TextFieldRoot.Label data-slot="input-label">{apiKeyLabel()}</TextFieldRoot.Label>
              <div data-slot="input-wrapper" class="provider-apikey-input-row">
                <TextFieldRoot.Input
                  data-slot="input-input"
                  type={state.showKey ? "text" : "password"}
                  placeholder={
                    apiKeyOptional()
                      ? language.t("provider.connect.apiKey.placeholder.optional")
                      : language.t("provider.connect.apiKey.placeholder")
                  }
                />
                <Tooltip
                  value={
                    state.showKey
                      ? language.t("provider.connect.apiKey.hide")
                      : language.t("provider.connect.apiKey.show")
                  }
                  placement="top"
                  gutter={4}
                >
                  <IconButton
                    type="button"
                    icon="eye"
                    variant="ghost"
                    size="small"
                    onClick={toggleKeyVisibility}
                    class="provider-apikey-eye-toggle"
                    aria-label={
                      state.showKey
                        ? language.t("provider.connect.apiKey.hide")
                        : language.t("provider.connect.apiKey.show")
                    }
                  />
                </Tooltip>
              </div>
              <TextFieldRoot.ErrorMessage data-slot="input-error">
                {state.field === "apiKey"
                  ? state.error
                  : emptyEdited()
                    ? language.t("provider.connect.apiKey.required")
                    : ""}
              </TextFieldRoot.ErrorMessage>
            </TextFieldRoot>
          ) : (
            <TextField
              type="password"
              label={apiKeyLabel()}
              placeholder={
                apiKeyOptional()
                  ? language.t("provider.connect.apiKey.placeholder.optional")
                  : language.t("provider.connect.apiKey.placeholder")
              }
              value={value()}
              onChange={setValue}
              validationState={state.field === "apiKey" ? "invalid" : undefined}
              error={state.field === "apiKey" ? state.error : undefined}
            />
          )}
        </Show>
        <For each={prompts()}>
          {(prompt) => (
            <Switch>
              <Match when={prompt.type === "text"}>
                <TextField
                  type="text"
                  label={promptLabel(prompt)}
                  placeholder={promptPlaceholder(prompt)}
                  value={fields[prompt.key] ?? ""}
                  onChange={(next) => setFields(prompt.key, next)}
                  validationState={state.field === prompt.key ? "invalid" : undefined}
                  error={state.field === prompt.key ? state.error : undefined}
                />
              </Match>
              <Match when={prompt.type === "select"}>
                <div style={{ display: "flex", "flex-direction": "column", gap: "4px" }}>
                  <label
                    style={{
                      "font-size": "var(--kilo-font-size-12)",
                      "font-weight": "500",
                      color: "var(--text-weak-base)",
                    }}
                  >
                    {promptLabel(prompt)}
                  </label>
                  <Select
                    options={prompt.type === "select" ? prompt.options : []}
                    current={
                      prompt.type === "select"
                        ? prompt.options.find((item) => item.value === fields[prompt.key])
                        : undefined
                    }
                    value={(item) => item.value}
                    label={(item) => optionText(prompt, item)}
                    onSelect={(item) => setFields(prompt.key, item?.value ?? "")}
                    variant="secondary"
                    size="small"
                    triggerVariant="settings"
                  />
                  <Show when={state.field === prompt.key && state.error}>
                    <span style={{ "font-size": "var(--kilo-font-size-12)", color: "var(--vscode-errorForeground)" }}>
                      {state.error}
                    </span>
                  </Show>
                </div>
              </Match>
            </Switch>
          )}
        </For>
        <Show when={state.error && !state.field}>
          <div style={{ color: "var(--vscode-errorForeground)", "font-size": "var(--kilo-font-size-13)" }}>
            {state.error}
          </div>
        </Show>
        <div class="provider-connect-byok">
          {language.t("provider.connect.kiloGateway.byok.prefix")}
          <a
            href="https://blog.kilo.ai/p/kilo-gateway-now-supports-byok-20-providers"
            onClick={(e) => {
              e.preventDefault()
              openExternal("https://blog.kilo.ai/p/kilo-gateway-now-supports-byok-20-providers")
            }}
            class="provider-connect-byok-link"
          >
            {language.t("provider.connect.kiloGateway.byok.link")}
          </a>
          {language.t("provider.connect.kiloGateway.byok.suffix")}
        </div>
        <div class="dialog-confirm-actions provider-connect-actions">
          <Show when={props.manageApiKey}>
            <Button variant="ghost" size="large" type="button" onClick={removeApiKey}>
              {language.t("settings.providers.action.remove")}
            </Button>
            <span class="provider-connect-spacer" />
          </Show>
          <Button variant="ghost" size="large" type="button" onClick={back}>
            {language.t(props.manageApiKey ? "common.cancel" : "common.goBack")}
          </Button>
          <Button
            variant="primary"
            size="large"
            type="submit"
            disabled={state.phase === "connecting" || state.credentialLoading || unchanged()}
          >
            {language.t(props.manageApiKey ? "settings.providers.action.update" : "common.submit")}
          </Button>
        </div>
      </form>
    )
  }

  const OAuthCodeView: Component = () => {
    const [value, setValue] = createSignal("")

    onMount(() => {
      if (!state.authorization?.url) return
      openExternal(state.authorization.url)
    })

    function submit(e: SubmitEvent) {
      e.preventDefault()
      const code = value().trim()
      if (!code) {
        setState({ ...state, error: language.t("provider.connect.oauth.code.required") })
        return
      }
      complete(code)
    }

    return (
      <form
        class="dialog-confirm-body"
        style={{ display: "flex", "flex-direction": "column", gap: "16px" }}
        onSubmit={submit}
      >
        <div class="provider-connect-body">
          {language.t("provider.connect.oauth.code.visit.prefix")}
          <a
            href={state.authorization?.url ?? "#"}
            onClick={(e) => {
              e.preventDefault()
              if (!state.authorization?.url) return
              openExternal(state.authorization.url)
            }}
          >
            {language.t("provider.connect.oauth.code.visit.link")}
          </a>
          {language.t("provider.connect.oauth.code.visit.suffix", { provider: name() })}
        </div>
        <TextField
          type="text"
          label={language.t("provider.connect.oauth.code.label", { method: method()?.label ?? "" })}
          placeholder={language.t("provider.connect.oauth.code.placeholder")}
          value={value()}
          onChange={setValue}
          validationState={state.error ? "invalid" : undefined}
          error={state.error}
        />
        <div class="dialog-confirm-actions">
          <Button variant="ghost" size="large" type="button" onClick={back}>
            {language.t("common.goBack")}
          </Button>
          <Button variant="primary" size="large" type="submit" disabled={state.phase === "connecting"}>
            {language.t("common.submit")}
          </Button>
        </div>
      </form>
    )
  }

  const OAuthAutoView: Component = () => {
    const code = createMemo(() => {
      const instructions = state.authorization?.instructions
      if (!instructions) return ""
      if (!instructions.includes(":")) return instructions
      return instructions.split(":")[1]?.trim() ?? instructions
    })

    onMount(() => {
      if (state.authorization?.url) openExternal(state.authorization.url)
      complete()
    })

    return (
      <div class="dialog-confirm-body" style={{ display: "flex", "flex-direction": "column", gap: "16px" }}>
        <div class="provider-connect-body">
          {language.t("provider.connect.oauth.auto.visit.prefix")}
          <a
            href={state.authorization?.url ?? "#"}
            onClick={(e) => {
              e.preventDefault()
              if (!state.authorization?.url) return
              openExternal(state.authorization.url)
            }}
          >
            {language.t("provider.connect.oauth.auto.visit.link")}
          </a>
          {language.t("provider.connect.oauth.auto.visit.suffix", { provider: name() })}
        </div>
        <Show when={code()}>
          <div>
            <div class="provider-connect-code-label">{language.t("provider.connect.oauth.auto.confirmationCode")}</div>
            <div class="provider-connect-code">{code()}</div>
          </div>
        </Show>
        <div class="provider-connect-status">
          <Spinner />
          <span>
            {state.error
              ? language.t("provider.connect.status.failed", { error: state.error })
              : language.t("provider.connect.status.waiting")}
          </span>
        </div>
        <div class="dialog-confirm-actions">
          <Button variant="ghost" size="large" type="button" onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
        </div>
      </div>
    )
  }

  /** LOCK-072/073: Inline confirmation view — rendered within the same Dialog instance. */
  const RemoveConfirmView: Component = () => {
    return (
      <div class="dialog-confirm-body" style={{ display: "flex", "flex-direction": "column", gap: "16px" }}>
        <div class="provider-connect-body">
          {language.t("provider.apiKey.remove.confirm.body", { provider: name() })}
        </div>
        <Show when={state.error}>
          <div style={{ color: "var(--vscode-errorForeground)", "font-size": "var(--kilo-font-size-13)" }}>
            {state.error}
          </div>
        </Show>
        <div class="dialog-confirm-actions">
          <Button variant="ghost" size="large" onClick={cancelRemove}>
            {language.t("common.cancel")}
          </Button>
          <Button variant="primary" size="large" onClick={executeRemove} disabled={state.phase === "connecting"}>
            {language.t("settings.providers.action.remove")}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <Dialog title={title()} fit>
      <Switch>
        <Match when={state.methodIndex === undefined}>
          <MethodSelection />
        </Match>
        <Match when={state.confirmingRemove}>
          <RemoveConfirmView />
        </Match>
        <Match when={state.phase === "authorizing"}>
          <div class="dialog-confirm-body">
            <div class="provider-connect-status">
              <Spinner />
              <span>{language.t("provider.connect.status.inProgress")}</span>
            </div>
          </div>
        </Match>
        <Match when={state.failed}>
          <div class="dialog-confirm-body" style={{ display: "flex", "flex-direction": "column", gap: "16px" }}>
            <div>{formatError(state.failed, language.t("common.requestFailed"))}</div>
            <div class="dialog-confirm-actions">
              <Button variant="ghost" size="large" onClick={back}>
                {language.t("common.goBack")}
              </Button>
            </div>
          </div>
        </Match>
        <Match when={method()?.type === "api"}>
          <ApiView />
        </Match>
        <Match when={state.authorization?.method === "code"}>
          <OAuthCodeView />
        </Match>
        <Match when={state.authorization?.method === "auto"}>
          <OAuthAutoView />
        </Match>
        <Match when={true}>
          <div class="dialog-confirm-body" style={{ display: "flex", "flex-direction": "column", gap: "16px" }}>
            <div>{formatError(state.error ?? state.failed, language.t("common.requestFailed"))}</div>
            <div class="dialog-confirm-actions">
              <Button variant="ghost" size="large" onClick={back}>
                {language.t("common.goBack")}
              </Button>
            </div>
          </div>
        </Match>
      </Switch>
    </Dialog>
  )
}

export default ProviderConnectDialog
