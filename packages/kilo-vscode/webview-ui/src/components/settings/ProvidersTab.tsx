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
import { useVSCode } from "../../context/vscode"
import type { ProviderView } from "../../types/messages"
import CustomProviderDialog from "./CustomProviderDialog"
import ProviderConnectDialog from "./ProviderConnectDialog"
import ProviderSelectDialog from "./ProviderSelectDialog"
import { providerIcon, providerNoteKey } from "./provider-catalog"
import { isCustomProviderPackage } from "../../../../src/shared/provider-model"
import { createProviderAction } from "../../utils/provider-action"
import {
  buildConfiguredList,
  buildAddList,
  allConfiguredIds,
  providerSource,
  showInlineApiKey,
  isCustomConfigured,
  resolvePrimarySlot,
} from "./provider-tab-helpers"

const ProvidersTab: Component = () => {
  const dialog = useDialog()
  const { config, updateConfig } = useConfig()
  const provider = useProvider()
  const language = useLanguage()
  const vscode = useVSCode()
  const action = createProviderAction(vscode)
  const canonicalMode = () => provider.canonical?.() === true

  onCleanup(action.dispose)

  // disabledProviders and disabledIds must be declared before any memo that
  // reads them to avoid a temporal-dead-zone ReferenceError when Solid
  // eagerly evaluates createMemo during initialisation. (LOCK-009)
  const disabledProviders = createMemo(() => config().disabled_providers ?? [])
  const disabledIds = createMemo(() => new Set(disabledProviders()))
  const allProviders = createMemo(() => Object.values(provider.providers()))
  const providerMap = createMemo(() => Object.fromEntries(allProviders().map((item) => [item.id, item])) as Record<string, ProviderView>)

  // Configured IDs: connected + disabled + config entries + auth states
  const configuredIds = createMemo(() =>
    allConfiguredIds(provider.connected(), disabledIds(), config().provider, provider.authStates()),
  )

  const configured = createMemo(() =>
    buildConfiguredList(providerMap(), provider.connected(), disabledIds(), config().provider, provider.authStates()),
  )

  const addList = createMemo(() => buildAddList(providerMap(), configuredIds()))

  // ── Actions ──────────────────────────────────────────────────────────────

  function sourceTag(item: ProviderView) {
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

  function editProvider(item: ProviderView) {
    const cfg = config().provider?.[item.id]
    if (!cfg) return
    dialog.show(() => <CustomProviderDialog existing={{ providerID: item.id, name: item.name, config: cfg }} />)
  }

  function deleteCustom(providerID: string, name: string) {
    if (canonicalMode()) return
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
                const done = () => {
                  showToast({
                    variant: "success",
                    icon: "circle-check",
                    title: language.t("provider.delete.toast.deleted.title", { provider: name }),
                    description: language.t("provider.delete.toast.deleted.description", { provider: name }),
                  })
                }
                const error = (message: { message: string }) => {
                  showToast({ title: language.t("common.requestFailed"), description: message.message })
                }
                if (!canonicalMode()) {
                  action.send({ type: "deleteCustomProvider", providerID, canonical: false }, { onDeleted: done, onError: error })
                  dialog.close()
                  return
                }
                const stamp = provider.stamp?.()
                if (!stamp) return
                action.send({ type: "deleteCustomProvider", providerID, canonical: true, stamp }, { onDeleted: done, onError: error })
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
    if (canonicalMode()) return
    const current = disabledProviders()
    const isDisabled = current.includes(providerID)
    if (isDisabled) {
      updateConfig({ disabled_providers: current.filter((id) => id !== providerID) })
    } else {
      updateConfig({ disabled_providers: [...current, providerID] })
    }
  }

  function connectProvider(item: ProviderView) {
    if (canonicalMode()) return
    dialog.show(() => <ProviderConnectDialog providerID={item.id} />)
  }

  function connectChatGPT(item: ProviderView) {
    if (canonicalMode()) return
    dialog.show(() => <ProviderConnectDialog providerID={item.id} oauthOnly />)
  }

  function chatgpt(item: ProviderView) {
    if (item.id !== "openai") return false
    if (providerSource(item) === "custom") return false
    return (provider.authMethods()[item.id] ?? []).some((method) => method.type === "oauth")
  }

  /** Open the API Key management dialog (LOCK-035). */
  function manageApiKey(item: ProviderView) {
    if (canonicalMode()) return
    dialog.show(() => <ProviderConnectDialog providerID={item.id} manageApiKey />)
  }

  // ── Control policy predicates ──────────────────────────────────────────
  function showEditButton(item: ProviderView): boolean {
    return isCustomConfigured(item, config().provider)
  }

  function showTrashButton(item: ProviderView): boolean {
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
      <Show when={provider.diagnostics?.()}>
        {(diagnostics) => {
          const d = diagnostics() as { action?: string; message?: string; kind?: string; retry?: { type: "retryProviderCleanup"; mode: "delete" | "restore"; scope: "global" | "project"; stamp: import("../../../../src/config/types").CanonicalStamp; retryID: string } }
          return (
            <div role="alert" style={{ color: "var(--vscode-errorForeground)", "margin-bottom": "8px", display: "flex", "align-items": "center", gap: "8px" }}>
              <span>{d.message ?? JSON.stringify(d)}</span>
              <Show when={d.retry}>
                <Button variant="secondary" size="small" onClick={() => provider.retryProviderCleanup?.(d.retry!)}>
                  Retry
                </Button>
              </Show>
            </div>
          )
        }}
      </Show>
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
                      <Match when={primary() === "edit"}>
                        <div class="settings-provider-row-credential-slot settings-provider-row-credential-slot--icon">
                          <Tooltip value={language.t("common.edit")}>
                            <IconButton
                              icon="edit"
                              size="large"
                              variant="ghost"
                              aria-label={language.t("common.edit")}
                             onClick={() => { if (!canonicalMode()) editProvider(item) }}
                             disabled={canonicalMode() === true}
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
                           onClick={() => { if (!canonicalMode()) connectChatGPT(item) }}
                           disabled={canonicalMode() === true}
                          class="settings-provider-row-credential-slot"
                        >
                          {language.t("settings.providers.action.signInChatGPT")}
                        </Button>
                      </Match>
                      <Match when={primary() === "anaconda"}>
                        <Button
                          size="large"
                          variant="ghost"
                           onClick={() => { if (!canonicalMode()) connectProvider(item) }}
                           disabled={canonicalMode() === true}
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
                      onChange={() => { if (!canonicalMode()) toggleProvider(item.id) }}
                      disabled={canonicalMode() === true}
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
                             disabled={canonicalMode() === true}
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
                 <Button size="large" variant="secondary" icon="plus-small" onClick={() => connectProvider(item)} disabled={canonicalMode() === true}>
                  {language.t("settings.providers.action.configure")}
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
             onClick={() => { if (!canonicalMode()) dialog.show(() => <CustomProviderDialog />) }}
             disabled={canonicalMode() === true}
          >
            {language.t("settings.providers.action.configure")}
          </Button>
        </div>

        {/* Show more providers */}
        <button
          type="button"
           onClick={() => { if (!canonicalMode()) dialog.show(() => <ProviderSelectDialog />) }}
           disabled={canonicalMode() === true}
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
