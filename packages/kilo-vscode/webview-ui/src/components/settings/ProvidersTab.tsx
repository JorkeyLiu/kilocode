import { Button } from "@kilocode/kilo-ui/button"
import { Card } from "@kilocode/kilo-ui/card"
import { useDialog } from "@kilocode/kilo-ui/context/dialog"
import { Dialog } from "@kilocode/kilo-ui/dialog"
import { Icon } from "@kilocode/kilo-ui/icon"
import { IconButton } from "@kilocode/kilo-ui/icon-button"
import { ProviderIcon } from "@kilocode/kilo-ui/provider-icon"
import { Switch } from "@kilocode/kilo-ui/switch"
import { Tag } from "@kilocode/kilo-ui/tag"
import { showToast } from "@kilocode/kilo-ui/toast"
import { Tooltip } from "@kilocode/kilo-ui/tooltip"
import { Component, For, Match, Show, Switch as SolidSwitch, createMemo, onCleanup } from "solid-js"
import { useConfig } from "../../context/config"
import { useLanguage } from "../../context/language"
import { useProvider } from "../../context/provider"
import { useServer } from "../../context/server"
import { useVSCode } from "../../context/vscode"
import type { Provider } from "../../types/messages"
import CustomProviderDialog from "./CustomProviderDialog"
import ProviderConnectDialog from "./ProviderConnectDialog"
import ProviderSelectDialog from "./ProviderSelectDialog"
import { providerIcon, providerNoteKey } from "./provider-catalog"
import { providersWithKiloFallback } from "./provider-visibility"
import { isCustomProviderPackage, KILO_PROVIDER_ID } from "../../../../src/shared/provider-model"
import { createProviderAction } from "../../utils/provider-action"
import {
  buildConfiguredList,
  buildAddList,
  allConfiguredIds,
  providerSource,
  showInlineApiKey,
  isKiloProvider,
  isCustomConfigured,
  resolvePrimarySlot,
} from "./provider-tab-helpers"

const ProvidersTab: Component = () => {
  const dialog = useDialog()
  const { config, updateConfig } = useConfig()
  const provider = useProvider()
  const language = useLanguage()
  const server = useServer()
  const vscode = useVSCode()
  const action = createProviderAction(vscode)

  onCleanup(action.dispose)

  // disabledProviders and disabledIds must be declared before any memo that
  // reads them to avoid a temporal-dead-zone ReferenceError when Solid
  // eagerly evaluates createMemo during initialisation. (LOCK-009)
  const disabledProviders = createMemo(() => config().disabled_providers ?? [])
  const disabledIds = createMemo(() => new Set(disabledProviders()))
  const allProviders = createMemo(() => providersWithKiloFallback(provider.providers()))

  // Configured IDs: connected + disabled + config entries + auth states
  const configuredIds = createMemo(() =>
    allConfiguredIds(provider.connected(), disabledIds(), config().provider, provider.authStates()),
  )

  const configured = createMemo(() =>
    buildConfiguredList(allProviders(), provider.connected(), disabledIds(), config().provider, provider.authStates()),
  )

  const addList = createMemo(() => buildAddList(allProviders(), configuredIds()))

  // ── Actions ──────────────────────────────────────────────────────────────

  function sourceTag(item: Provider) {
    if (item.id === KILO_PROVIDER_ID) return language.t("settings.providers.tag.gateway")
    if (item.id === "anaconda-desktop") return language.t("settings.providers.tag.local")
    const current = providerSource(item)
    if (current === "env") return language.t("settings.providers.tag.environment")
    if (current === "api") return language.t("provider.connect.method.apiKey")
    if (current === "config") {
      const cfg = config().provider?.[item.id]
      if (isCustomProviderPackage(cfg?.npm)) return language.t("settings.providers.tag.custom")
      return language.t("settings.providers.tag.config")
    }
    if (item.id === "openai" && current === "custom") return language.t("settings.providers.tag.chatgpt")
    if (current === "custom") return language.t("settings.providers.tag.custom")
    return language.t("settings.providers.tag.other")
  }

  function editProvider(item: Provider) {
    const cfg = config().provider?.[item.id]
    if (!cfg) return
    dialog.show(() => <CustomProviderDialog existing={{ providerID: item.id, name: item.name, config: cfg }} />)
  }

  function deleteCustom(providerID: string, name: string) {
    dialog.show(() => (
      <Dialog title={language.t("provider.delete.confirm.title", { provider: name })} fit>
        <div class="dialog-confirm-body">
          <span>{language.t("provider.delete.confirm.body")}</span>
          <div class="dialog-confirm-actions">
            <Button variant="ghost" size="large" onClick={() => dialog.close()}>
              {language.t("common.cancel")}
            </Button>
            <Button
              variant="primary"
              size="large"
              onClick={() => {
                action.send(
                  { type: "deleteCustomProvider", providerID },
                  {
                    onDeleted: () => {
                      showToast({
                        variant: "success",
                        icon: "circle-check",
                        title: language.t("provider.delete.toast.deleted.title", { provider: name }),
                        description: language.t("provider.delete.toast.deleted.description", { provider: name }),
                      })
                    },
                    onError: (message) => {
                      showToast({ title: language.t("common.requestFailed"), description: message.message })
                    },
                  },
                )
                dialog.close()
              }}
            >
              {language.t("common.delete")}
            </Button>
          </div>
        </div>
      </Dialog>
    ))
  }

  function toggleProvider(providerID: string) {
    const current = disabledProviders()
    const isDisabled = current.includes(providerID)
    if (isDisabled) {
      updateConfig({ disabled_providers: current.filter((id) => id !== providerID) })
    } else {
      updateConfig({ disabled_providers: [...current, providerID] })
    }
  }

  function connectProvider(item: Provider) {
    if (item.id === KILO_PROVIDER_ID) {
      server.goToLogin()
      return
    }
    dialog.show(() => <ProviderConnectDialog providerID={item.id} />)
  }

  function connectChatGPT(item: Provider) {
    dialog.show(() => <ProviderConnectDialog providerID={item.id} oauthOnly />)
  }

  function chatgpt(item: Provider) {
    if (item.id !== "openai") return false
    if (providerSource(item) === "custom") return false
    return (provider.authMethods()[item.id] ?? []).some((method) => method.type === "oauth")
  }

  /** Open the API Key management dialog (LOCK-035). */
  function manageApiKey(item: Provider) {
    dialog.show(() => <ProviderConnectDialog providerID={item.id} manageApiKey />)
  }

  // ── Control policy predicates (LOCK-045) ──────────────────────────────────

  function showAccountButton(item: Provider): boolean {
    return isKiloProvider(item)
  }

  function showEditButton(item: Provider): boolean {
    return isCustomConfigured(item, config().provider)
  }

  function showTrashButton(item: Provider): boolean {
    return isCustomConfigured(item, config().provider)
  }

  // ── Row styles ───────────────────────────────────────────────────────────

  const rowStyle = {
    display: "flex",
    "flex-wrap": "wrap",
    "align-items": "center",
    "justify-content": "space-between",
    gap: "16px",
    "min-height": "56px",
    padding: "12px 0",
    "border-bottom": "1px solid var(--border-weak-base)",
  } as const

  const nameStyle = {
    "font-size": "var(--kilo-font-size-14)",
    "font-weight": "500",
    color: "var(--vscode-foreground)",
    overflow: "hidden",
    "text-overflow": "ellipsis",
    "white-space": "nowrap",
  } as const

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div>
      {/* Configured providers */}
      <h4 style={{ "margin-top": "16px", "margin-bottom": "8px" }}>
        {language.t("settings.providers.section.configured")}
      </h4>
      <Card class="settings-provider-list">
        <Show
          when={configured().length > 0}
          fallback={
            <div
              style={{
                padding: "16px 0",
                "font-size": "var(--kilo-font-size-14)",
                color: "var(--text-weak-base, var(--vscode-descriptionForeground))",
              }}
            >
              {language.t("settings.providers.configured.empty")}
            </div>
          }
        >
          <For each={configured()}>
            {(item) => {
              const primary = () =>
                resolvePrimarySlot({
                  isKilo: showAccountButton(item),
                  isCustom: showEditButton(item),
                  hasApiKey: showInlineApiKey(item, provider.authStates()),
                  hasChatGPT: chatgpt(item),
                  isAnaconda: item.id === "anaconda-desktop",
                })
              return (
                <div class="settings-provider-row">
                  {/* Identity: icon + name + tag */}
                  <div class="settings-provider-row-identity">
                    <ProviderIcon id={providerIcon(item)} width={20} height={20} />
                    <span style={nameStyle}>{item.name}</span>
                    <Tag>{sourceTag(item)}</Tag>
                  </div>

                  {/* Controls: [primary slot] [switch] [final slot] (LOCK-052/053) */}
                  <div class="settings-provider-row-controls">
                    {/* Primary slot: exactly one child per row */}
                    <SolidSwitch>
                      <Match when={primary() === "account"}>
                        <div class="settings-provider-row-credential-slot settings-provider-row-credential-slot--icon">
                          <Tooltip value={language.t("settings.providers.action.account")}>
                            <IconButton
                              icon="person"
                              size="large"
                              variant="ghost"
                              aria-label={language.t("settings.providers.action.account")}
                              onClick={() => server.goToProfile()}
                            />
                          </Tooltip>
                        </div>
                      </Match>
                      <Match when={primary() === "edit"}>
                        <div class="settings-provider-row-credential-slot settings-provider-row-credential-slot--icon">
                          <Tooltip value={language.t("common.edit")}>
                            <IconButton
                              icon="edit"
                              size="large"
                              variant="ghost"
                              aria-label={language.t("common.edit")}
                              onClick={() => editProvider(item)}
                            />
                          </Tooltip>
                        </div>
                      </Match>
                      <Match when={primary() === "apiKey"}>
                        <div class="settings-provider-row-credential-slot settings-provider-row-credential-slot--icon">
                          <Tooltip value={language.t("settings.providers.action.apiKey")}>
                            <IconButton
                              icon="edit"
                              size="large"
                              variant="ghost"
                              aria-label={language.t("settings.providers.action.apiKey")}
                              onClick={() => manageApiKey(item)}
                            />
                          </Tooltip>
                        </div>
                      </Match>
                      <Match when={primary() === "chatgpt"}>
                        <Button
                          size="large"
                          variant="ghost"
                          onClick={() => connectChatGPT(item)}
                          class="settings-provider-row-credential-slot"
                        >
                          {language.t("settings.providers.action.signInChatGPT")}
                        </Button>
                      </Match>
                      <Match when={primary() === "anaconda"}>
                        <Button
                          size="large"
                          variant="ghost"
                          onClick={() => connectProvider(item)}
                          class="settings-provider-row-credential-slot"
                        >
                          {language.t("provider.anaconda.action.manage")}
                        </Button>
                      </Match>
                      <Match when={primary() === "placeholder"}>
                        <div class="settings-provider-row-credential-slot" aria-hidden="true" />
                      </Match>
                    </SolidSwitch>

                    <Switch
                      checked={!disabledIds().has(item.id)}
                      onChange={() => toggleProvider(item.id)}
                      aria-label={language.t("settings.providers.switch.label", { provider: item.name })}
                    />

                    {/* Final slot: custom trash icon | empty (LOCK-045) */}
                    <Show
                      when={showTrashButton(item)}
                      fallback={<div class="settings-provider-row-final-slot" aria-hidden="true" />}
                    >
                      {/* LOCK-077: wrapper provides 32×32 clickable target in the 32px slot */}
                      <div class="settings-provider-row-final-slot">
                        <Tooltip value={language.t("settings.providers.action.deleteProvider")}>
                          <IconButton
                            icon="close"
                            size="large"
                            variant="ghost"
                            aria-label={language.t("settings.providers.action.deleteProvider")}
                            onClick={() => deleteCustom(item.id, item.name)}
                          />
                        </Tooltip>
                      </div>
                    </Show>
                  </div>
                </div>
              )
            }}
          </For>
        </Show>
      </Card>

      {/* Add providers */}
      <h4 style={{ "margin-top": "24px", "margin-bottom": "8px" }}>{language.t("settings.providers.section.add")}</h4>
      <Card>
        <For each={addList()}>
          {(item) => {
            const noteKey = providerNoteKey(item)
            return (
              <div style={rowStyle}>
                <div style={{ display: "flex", "flex-direction": "column", "min-width": 0 }}>
                  <div style={{ display: "flex", "align-items": "center", gap: "12px" }}>
                    <ProviderIcon id={providerIcon(item)} width={20} height={20} />
                    <span style={nameStyle}>{item.name}</span>
                  </div>
                  <Show when={noteKey}>
                    {(key) => (
                      <span
                        style={{
                          "font-size": "var(--kilo-font-size-12)",
                          color: "var(--text-weak-base, var(--vscode-descriptionForeground))",
                          "padding-left": "32px",
                        }}
                      >
                        {language.t(key())}
                      </span>
                    )}
                  </Show>
                </div>
                <Button size="large" variant="secondary" icon="plus-small" onClick={() => connectProvider(item)}>
                  {item.id === KILO_PROVIDER_ID
                    ? language.t("common.signIn")
                    : language.t("settings.providers.action.configure")}
                </Button>
              </div>
            )
          }}
        </For>

        {/* Custom provider entry */}
        <div
          style={{
            display: "flex",
            "flex-wrap": "wrap",
            "align-items": "center",
            "justify-content": "space-between",
            gap: "16px",
            "min-height": "56px",
            padding: "12px 0",
            "border-bottom": "1px solid var(--border-weak-base)",
          }}
        >
          <div style={{ display: "flex", "flex-direction": "column", "min-width": 0 }}>
            <div style={{ display: "flex", "flex-wrap": "wrap", "align-items": "center", gap: "12px" }}>
              <ProviderIcon id="synthetic" width={20} height={20} />
              <span style={nameStyle}>{language.t("provider.custom.title")}</span>
              <Tag>{language.t("settings.providers.tag.custom")}</Tag>
            </div>
            <span
              style={{
                "font-size": "var(--kilo-font-size-12)",
                color: "var(--text-weak-base, var(--vscode-descriptionForeground))",
                "padding-left": "32px",
              }}
            >
              {language.t("settings.providers.custom.description")}
            </span>
          </div>
          <Button
            size="large"
            variant="secondary"
            icon="plus-small"
            onClick={() => dialog.show(() => <CustomProviderDialog />)}
          >
            {language.t("settings.providers.action.configure")}
          </Button>
        </div>

        {/* Show more providers */}
        <button
          type="button"
          onClick={() => dialog.show(() => <ProviderSelectDialog />)}
          style={{
            display: "flex",
            "align-items": "center",
            "justify-content": "space-between",
            gap: "16px",
            width: "100%",
            "min-height": "56px",
            padding: "12px 0",
            background: "none",
            border: "none",
            cursor: "pointer",
            "text-align": "left",
            color: "var(--vscode-foreground)",
            font: "inherit",
          }}
        >
          <div style={{ display: "flex", "align-items": "center", gap: "12px", "min-width": 0 }}>
            <Icon name="providers" size="small" />
            <span
              style={{
                "font-size": "var(--kilo-font-size-14)",
                "font-weight": "500",
              }}
            >
              {language.t("dialog.provider.viewAll")}
            </span>
          </div>
          <Icon name="chevron-right" size="small" />
        </button>
      </Card>
    </div>
  )
}

export default ProvidersTab
