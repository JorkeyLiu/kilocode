import { Button } from "@kilocode/kilo-ui/button"
import { Card } from "@kilocode/kilo-ui/card"
import { Collapsible } from "@kilocode/kilo-ui/collapsible"
import { useDialog } from "@kilocode/kilo-ui/context/dialog"
import { Dialog } from "@kilocode/kilo-ui/dialog"
import { Icon } from "@kilocode/kilo-ui/icon"
import { ProviderIcon } from "@kilocode/kilo-ui/provider-icon"
import { Switch } from "@kilocode/kilo-ui/switch"
import { Tag } from "@kilocode/kilo-ui/tag"
import { showToast } from "@kilocode/kilo-ui/toast"
import { Component, For, Show, createMemo, onCleanup } from "solid-js"
import { useConfig } from "../../context/config"
import { useLanguage } from "../../context/language"
import { useProvider } from "../../context/provider"
import { useServer } from "../../context/server"
import { useVSCode } from "../../context/vscode"
import type { Provider } from "../../types/messages"
import CustomProviderDialog from "./CustomProviderDialog"
import ProviderConnectDialog from "./ProviderConnectDialog"
import ProviderSelectDialog from "./ProviderSelectDialog"
import { isPopularProvider, providerIcon, providerNoteKey, sortProviders } from "./provider-catalog"
import { connectedNonDisabledIds, providersWithKiloFallback } from "./provider-visibility"
import { isCustomProviderPackage, KILO_PROVIDER_ID } from "../../../../src/shared/provider-model"
import { createProviderAction } from "../../utils/provider-action"

type ProviderSource = "env" | "api" | "config" | "custom"

const ProvidersTab: Component = () => {
  const dialog = useDialog()
  const { config, updateConfig } = useConfig()
  const provider = useProvider()
  const language = useLanguage()
  const server = useServer()
  const vscode = useVSCode()
  const action = createProviderAction(vscode)

  onCleanup(action.dispose)

  const kiloLoggedIn = createMemo(() => !!provider.authStates()[KILO_PROVIDER_ID])

  // disabledProviders and disabledIds must be declared before any memo that
  // reads them to avoid a temporal-dead-zone ReferenceError when Solid
  // eagerly evaluates createMemo during initialisation.
  const disabledProviders = createMemo(() => config().disabled_providers ?? [])
  const disabledIds = createMemo(() => new Set(disabledProviders()))
  const allProviders = createMemo(() => providersWithKiloFallback(provider.providers()))

  const connectedProviders = createMemo(() => {
    const ids = connectedNonDisabledIds(provider.connected(), provider.authStates(), disabledIds())
    const all = provider.providers()
    return ids.map((id) => all[id]).filter((item): item is Provider => !!item)
  })

  const popularProviders = createMemo(() => {
    const connected = new Set(provider.connected())
    const disabled = disabledIds()
    const all = Object.values(provider.providers())
    return sortProviders(
      all.filter(
        (item) =>
          item.id !== KILO_PROVIDER_ID && isPopularProvider(item) && !connected.has(item.id) && !disabled.has(item.id),
      ),
    )
  })

  const disabledProviderList = createMemo(() => {
    const all = allProviders()
    return disabledProviders()
      .map((id) => all[id])
      .filter((item): item is Provider => !!item)
  })

  function source(item: Provider): ProviderSource | undefined {
    if (!("source" in item)) return
    const value = (item as Provider & { source?: string }).source
    if (value === "env" || value === "api" || value === "config" || value === "custom") return value
    return
  }

  function sourceTag(item: Provider) {
    if (item.id === "anaconda-desktop") return language.t("settings.providers.tag.local")
    const current = source(item)
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

  function canDisconnect(item: Provider) {
    return source(item) !== "env"
  }

  function isCustom(item: Provider) {
    const cfg = config().provider?.[item.id]
    return isCustomProviderPackage(cfg?.npm)
  }

  function editProvider(item: Provider) {
    const cfg = config().provider?.[item.id]
    if (!cfg) return
    dialog.show(() => <CustomProviderDialog existing={{ providerID: item.id, name: item.name, config: cfg }} />)
  }

  function disconnect(providerID: string, name: string) {
    action.send(
      { type: "disconnectProvider", providerID },
      {
        onDisconnected: () => {
          showToast({
            variant: "success",
            icon: "circle-check",
            title: language.t("provider.disconnect.toast.disconnected.title", { provider: name }),
            description: language.t("provider.disconnect.toast.disconnected.description", { provider: name }),
          })
        },
        onError: (message) => {
          showToast({ title: language.t("common.requestFailed"), description: message.message })
        },
      },
    )
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
    if (source(item) === "custom") return false
    return (provider.authMethods()[item.id] ?? []).some((method) => method.type === "oauth")
  }

  return (
    <div>
      {/* Kilo Gateway — always visible with Switch */}
      <Card>
        <div
          style={{
            display: "flex",
            "align-items": "center",
            gap: "12px",
            "min-height": "56px",
            padding: "12px 0",
          }}
        >
          <Switch
            checked={!disabledIds().has(KILO_PROVIDER_ID)}
            onChange={() => toggleProvider(KILO_PROVIDER_ID)}
            aria-label={language.t("settings.providers.switch.label", { provider: "Kilo Gateway" })}
          />
          <ProviderIcon id={providerIcon(KILO_PROVIDER_ID)} width={20} height={20} />
          <span
            style={{
              "font-size": "var(--kilo-font-size-14)",
              "font-weight": "500",
              color: "var(--vscode-foreground)",
            }}
          >
            Kilo Gateway
          </span>
          <Show when={!disabledIds().has(KILO_PROVIDER_ID) && kiloLoggedIn()}>
            <Tag>{language.t("settings.providers.tag.gateway")}</Tag>
          </Show>
          <Show when={!disabledIds().has(KILO_PROVIDER_ID) && !kiloLoggedIn()}>
            <div style={{ flex: 1 }} />
            <Button size="small" variant="secondary" onClick={() => server.goToLogin()}>
              {language.t("common.signIn")}
            </Button>
          </Show>
        </div>
      </Card>

      {/* Connected providers (excluding Kilo) */}
      <h4 style={{ "margin-top": "16px", "margin-bottom": "8px" }}>
        {language.t("settings.providers.section.connected")}
      </h4>
      <Card>
        <Show
          when={connectedProviders().length > 0}
          fallback={
            <div
              style={{
                padding: "16px 0",
                "font-size": "var(--kilo-font-size-14)",
                color: "var(--text-weak-base, var(--vscode-descriptionForeground))",
              }}
            >
              {language.t("settings.providers.connected.empty")}
            </div>
          }
        >
          <For each={connectedProviders()}>
            {(item) => (
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
                <div style={{ display: "flex", "align-items": "center", gap: "12px", "min-width": 0 }}>
                  <Switch
                    checked={!disabledIds().has(item.id)}
                    onChange={() => toggleProvider(item.id)}
                    aria-label={language.t("settings.providers.switch.label", { provider: item.name })}
                  />
                  <ProviderIcon id={providerIcon(item)} width={20} height={20} />
                  <span
                    style={{
                      "font-size": "var(--kilo-font-size-14)",
                      "font-weight": "500",
                      color: "var(--vscode-foreground)",
                      overflow: "hidden",
                      "text-overflow": "ellipsis",
                      "white-space": "nowrap",
                    }}
                  >
                    {item.name}
                  </span>
                  <Tag>{sourceTag(item)}</Tag>
                </div>
                <div style={{ display: "flex", "align-items": "center", gap: "4px" }}>
                  <Show when={!canDisconnect(item)}>
                    <span
                      style={{
                        "font-size": "var(--kilo-font-size-14)",
                        color: "var(--text-base, var(--vscode-descriptionForeground))",
                        "padding-right": "12px",
                      }}
                    >
                      {language.t("settings.providers.connected.environmentDescription")}
                    </span>
                  </Show>
                  <Show when={chatgpt(item)}>
                    <Button size="large" variant="ghost" onClick={() => connectChatGPT(item)}>
                      {language.t("settings.providers.action.signInChatGPT")}
                    </Button>
                  </Show>
                  <Show when={item.id === "anaconda-desktop"}>
                    <Button size="large" variant="ghost" onClick={() => connectProvider(item)}>
                      {language.t("provider.anaconda.action.manage")}
                    </Button>
                  </Show>
                  <Show when={canDisconnect(item)}>
                    <Show when={isCustom(item)}>
                      <Button size="large" variant="ghost" onClick={() => editProvider(item)}>
                        {language.t("provider.custom.edit.title")}
                      </Button>
                    </Show>
                    <Button size="large" variant="ghost" onClick={() => disconnect(item.id, item.name)}>
                      {language.t("common.disconnect")}
                    </Button>
                    <Show when={isCustom(item)}>
                      <Button size="large" variant="ghost" onClick={() => deleteCustom(item.id, item.name)}>
                        {language.t("common.delete")}
                      </Button>
                    </Show>
                  </Show>
                </div>
              </div>
            )}
          </For>
        </Show>
      </Card>

      {/* Popular providers */}
      <h4 style={{ "margin-top": "24px", "margin-bottom": "8px" }}>
        {language.t("settings.providers.section.popular")}
      </h4>
      <Card>
        <For each={popularProviders()}>
          {(item) => {
            const noteKey = providerNoteKey(item)
            return (
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
                  <div style={{ display: "flex", "align-items": "center", gap: "12px" }}>
                    <Switch
                      checked={!disabledIds().has(item.id)}
                      onChange={() => toggleProvider(item.id)}
                      aria-label={language.t("settings.providers.switch.label", { provider: item.name })}
                    />
                    <ProviderIcon id={providerIcon(item)} width={20} height={20} />
                    <span
                      style={{
                        "font-size": "var(--kilo-font-size-14)",
                        "font-weight": "500",
                        color: "var(--vscode-foreground)",
                      }}
                    >
                      {item.name}
                    </span>
                  </div>
                  <Show when={noteKey}>
                    {(key) => (
                      <span
                        style={{
                          "font-size": "var(--kilo-font-size-12)",
                          color: "var(--text-weak-base, var(--vscode-descriptionForeground))",
                          "padding-left": "56px",
                        }}
                      >
                        {language.t(key())}
                      </span>
                    )}
                  </Show>
                </div>
                <Button size="large" variant="secondary" icon="plus-small" onClick={() => connectProvider(item)}>
                  {language.t("common.connect")}
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
              <span
                style={{
                  "font-size": "var(--kilo-font-size-14)",
                  "font-weight": "500",
                  color: "var(--vscode-foreground)",
                }}
              >
                {language.t("provider.custom.title")}
              </span>
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
            {language.t("common.connect")}
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

      {/* Disabled providers — collapsed by default */}
      <Show when={disabledProviderList().length > 0}>
        <div style={{ "margin-top": "24px" }}>
          <Collapsible variant="ghost">
            <Collapsible.Trigger>
              <span
                style={{
                  "font-size": "var(--kilo-font-size-12)",
                  "font-weight": "500",
                  color: "var(--text-weak-base, var(--vscode-descriptionForeground))",
                }}
              >
                {language.t("settings.providers.disabled")}
              </span>
              <Collapsible.Arrow />
            </Collapsible.Trigger>
            <Collapsible.Content>
              <Card style={{ "margin-top": "8px" }}>
                <For each={disabledProviderList()}>
                  {(item, index) => (
                    <div
                      style={{
                        display: "flex",
                        "flex-wrap": "wrap",
                        "align-items": "center",
                        "justify-content": "space-between",
                        gap: "16px",
                        "min-height": "56px",
                        padding: "12px 0",
                        "border-bottom":
                          index() < disabledProviderList().length - 1 ? "1px solid var(--border-weak-base)" : "none",
                      }}
                    >
                      <div style={{ display: "flex", "align-items": "center", gap: "12px", "min-width": 0 }}>
                        <Switch
                          checked={false}
                          onChange={() => toggleProvider(item.id)}
                          aria-label={language.t("settings.providers.switch.label", { provider: item.name })}
                        />
                        <ProviderIcon id={providerIcon(item)} width={20} height={20} />
                        <span
                          style={{
                            "font-size": "var(--kilo-font-size-14)",
                            "font-weight": "500",
                            color: "var(--vscode-foreground)",
                            overflow: "hidden",
                            "text-overflow": "ellipsis",
                            "white-space": "nowrap",
                          }}
                        >
                          {item.name}
                        </span>
                        <Tag>{language.t("settings.providers.disabled")}</Tag>
                      </div>
                    </div>
                  )}
                </For>
              </Card>
            </Collapsible.Content>
          </Collapsible>
        </div>
      </Show>
    </div>
  )
}

export default ProvidersTab
