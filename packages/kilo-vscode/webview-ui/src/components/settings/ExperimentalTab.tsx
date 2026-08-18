import { Component, For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { Switch } from "@kilocode/kilo-ui/switch"
import { Select } from "@kilocode/kilo-ui/select"
import { TextField } from "@kilocode/kilo-ui/text-field"
import { Card } from "@kilocode/kilo-ui/card"
import { useConfig } from "../../context/config"
import { useLanguage } from "../../context/language"
import { useVSCode } from "../../context/vscode"
import { useImageModels } from "../../context/image-models"
import type { ExtensionMessage } from "../../types/messages"
import { parseModelString } from "../../../../src/shared/provider-model"
import { ModelSelectorBase } from "../shared/ModelSelector"
import SettingsRow from "./SettingsRow"

interface ShareOption {
  value: string
  labelKey: string
}

const SHARE_OPTIONS: ShareOption[] = [
  { value: "manual", labelKey: "settings.experimental.share.manual" },
  { value: "auto", labelKey: "settings.experimental.share.auto" },
  { value: "disabled", labelKey: "settings.experimental.share.disabled" },
]

function unsupportedStyle(readonly: boolean) {
  return readonly
    ? { opacity: "0.6" }
    : { opacity: "1" }
}

const ExperimentalTab: Component = () => {
  const { config, updateConfig, saveError, canonical } = useConfig()
  const language = useLanguage()
  const imageModels = useImageModels()
  const vscode = useVSCode()
  const [active, setActive] = createSignal(false)

  const handler = (msg: ExtensionMessage) => {
    if (msg.type === "remoteStatus") {
      setActive(msg.enabled)
    }
  }

  onMount(() => {
    const unsub = vscode.onMessage(handler)
    vscode.postMessage({ type: "requestRemoteStatus" })
    onCleanup(unsub)
  })

  const experimental = createMemo(() => config().experimental ?? {})
  const readonly = () => canonical?.() === true

  const updateExperimental = (key: string, value: unknown) => {
    if (readonly()) return
    updateConfig({
      experimental: { ...experimental(), [key]: value },
    })
  }

  return (
    <div>
      <Show when={saveError()}>
        {(error) => <div role="alert" style={{ color: "var(--vscode-errorForeground)", "margin-bottom": "8px" }}>{error().message}</div>}
      </Show>
      <Show when={canonical?.()}>
        <div role="note" style={{ color: "var(--text-weak-base)", "margin-bottom": "8px" }}>Experimental, sharing, formatter, LSP, tools, and remote settings are read-only in canonical GUI configuration.</div>
      </Show>
      <div aria-disabled={canonical?.() === true} title={canonical?.() === true ? "Unsupported in canonical GUI config" : undefined} style={unsupportedStyle(canonical?.() === true)}>
      <Card>
        {/* Remote control */}
        <div data-component="remote-settings" aria-disabled="true" title="Unsupported in canonical GUI config">
          <div data-slot="remote-settings-header">
            <div data-slot="settings-row-label-title">{language.t("settings.experimental.remote.title")}</div>
            <div data-slot="settings-row-label-subtitle">{language.t("settings.experimental.remote.description")}</div>
          </div>
          <div data-slot="remote-settings-block">
            <div data-slot="remote-settings-row">
              <span data-slot="remote-settings-label">{language.t("settings.experimental.remote.current")}</span>
              <span data-slot="remote-settings-status" data-active={active()}>
                {active()
                  ? language.t("settings.experimental.remote.active")
                  : language.t("settings.experimental.remote.inactive")}
              </span>
            </div>
            <div data-slot="remote-settings-hint">{language.t("settings.experimental.remote.hint")}</div>
          </div>
          <div data-slot="remote-settings-row">
            <span data-slot="remote-settings-label">{language.t("settings.experimental.remote.startup")}</span>
             <Switch
               checked={config().remote_control ?? false}
                onChange={() => undefined}
                disabled={readonly()}
              hideLabel
            >
              {language.t("settings.experimental.remote.startup")}
            </Switch>
          </div>
        </div>

        {/* Share mode */}
         <div aria-disabled="true" title="Unsupported in canonical GUI config" style={{ opacity: "0.65" }}>
         <SettingsRow
          title={language.t("settings.experimental.share.title")}
          description={language.t("settings.experimental.share.description")}
        >
          <Select
            options={SHARE_OPTIONS}
            current={SHARE_OPTIONS.find((o) => o.value === (config().share ?? "manual"))}
            value={(o) => o.value}
            label={(o) => language.t(o.labelKey)}
            onSelect={() => undefined}
            disabled={readonly()}
            variant="secondary"
            size="small"
            triggerVariant="settings"
          />
         </SettingsRow>
         </div>

         <div aria-disabled="true" title="Unsupported in canonical GUI config" style={{ opacity: "0.65" }}>
         <SettingsRow
          title={language.t("settings.experimental.formatter.title")}
          description={language.t("settings.experimental.formatter.description")}
        >
          <Switch
            checked={config().formatter !== false}
             onChange={() => undefined}
             disabled={readonly()}
            hideLabel
          >
            {language.t("settings.experimental.formatter.title")}
          </Switch>
         </SettingsRow>
         </div>

         <div aria-disabled="true" title="Unsupported in canonical GUI config" style={{ opacity: "0.65" }}>
         <SettingsRow
          title={language.t("settings.experimental.lsp.title")}
          description={language.t("settings.experimental.lsp.description")}
        >
          <Switch
            checked={config().lsp !== false}
             onChange={() => undefined}
             disabled={readonly()}
            hideLabel
          >
            {language.t("settings.experimental.lsp.title")}
          </Switch>
         </SettingsRow>
         </div>

        <SettingsRow
          title={language.t("settings.experimental.batch.title")}
          description={language.t("settings.experimental.batch.description")}
        >
          <Switch
            checked={experimental().batch_tool ?? false}
             onChange={(checked) => { if (!readonly()) updateExperimental("batch_tool", checked) }}
             disabled={readonly()}
            hideLabel
          >
            {language.t("settings.experimental.batch.title")}
          </Switch>
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.experimental.codebaseSearch.title")}
          description={language.t("settings.experimental.codebaseSearch.description")}
        >
          <Switch
            checked={experimental().codebase_search ?? false}
             onChange={(checked) => { if (!readonly()) updateExperimental("codebase_search", checked) }}
             disabled={readonly()}
            hideLabel
          >
            {language.t("settings.experimental.codebaseSearch.title")}
          </Switch>
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.experimental.imageGeneration.title")}
          description={language.t("settings.experimental.imageGeneration.description")}
        >
          <Switch
            checked={experimental().image_generation ?? false}
             onChange={(checked) => { if (!readonly()) updateExperimental("image_generation", checked) }}
             disabled={readonly()}
            hideLabel
          >
            {language.t("settings.experimental.imageGeneration.title")}
          </Switch>
        </SettingsRow>

        <Show when={experimental().image_generation}>
          <SettingsRow
            title={language.t("settings.experimental.imageGenerationModel.title")}
            description={language.t("settings.experimental.imageGenerationModel.description")}
          >
            <Select
              options={imageModels.models().map((m) => ({ value: m.id, label: m.name }))}
              current={imageModels
                .models()
                .map((m) => ({ value: m.id, label: m.name }))
                .find((m) => m.value === experimental().image_generation_model)}
              value={(item) => item.value}
              label={(item) => item.label}
               onSelect={(item) => { if (!readonly()) updateExperimental("image_generation_model", item?.value ?? undefined) }}
               disabled={readonly()}
              variant="secondary"
              size="small"
              triggerVariant="settings"
              placeholder={language.t("settings.experimental.imageGenerationModel.placeholder")}
            />
          </SettingsRow>
        </Show>

        <SettingsRow
          title={language.t("settings.experimental.nativeNotebookTools.title")}
          description={language.t("settings.experimental.nativeNotebookTools.description")}
        >
          <Switch
            checked={experimental().native_notebook_tools ?? false}
            onChange={(checked) => { if (!readonly()) updateExperimental("native_notebook_tools", checked) }}
            disabled={readonly()}
            hideLabel
          >
            {language.t("settings.experimental.nativeNotebookTools.title")}
          </Switch>
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.experimental.continueOnDeny.title")}
          description={language.t("settings.experimental.continueOnDeny.description")}
        >
          <Switch
            checked={experimental().continue_loop_on_deny ?? false}
            onChange={(checked) => { if (!readonly()) updateExperimental("continue_loop_on_deny", checked) }}
            disabled={readonly()}
            hideLabel
          >
            {language.t("settings.experimental.continueOnDeny.title")}
          </Switch>
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.experimental.swePruner.title")}
          description={language.t("settings.experimental.swePruner.description")}
        >
          <Switch
            checked={experimental().swe_pruner ?? false}
            onChange={(checked) => { if (!readonly()) updateExperimental("swe_pruner", checked) }}
            disabled={readonly()}
            hideLabel
          >
            {language.t("settings.experimental.swePruner.title")}
          </Switch>
        </SettingsRow>

        <Show when={experimental().swe_pruner}>
          <SettingsRow
            title={language.t("settings.experimental.swePrunerModel.title")}
            description={language.t("settings.experimental.swePrunerModel.description")}
          >
            <ModelSelectorBase
              value={parseModelString(experimental().swe_pruner_model ?? undefined)}
               onSelect={(providerID, modelID) => {
                 if (!readonly()) updateExperimental("swe_pruner_model", providerID && modelID ? `${providerID}/${modelID}` : null)
               }}
               placement="bottom-start"
              allowClear
              clearLabel={language.t("settings.providers.notSet")}
              label={language.t("settings.experimental.swePrunerModel.title")}
              description={language.t("settings.experimental.swePrunerModel.description")}
            />
          </SettingsRow>
        </Show>

        {/* MCP timeout */}
        <SettingsRow
          title={language.t("settings.experimental.mcpTimeout.title")}
          description={language.t("settings.experimental.mcpTimeout.description")}
          last
        >
          <TextField
            value={String(experimental().mcp_timeout ?? 60000)}
             onChange={(val) => {
               if (readonly()) return
              const num = parseInt(val, 10)
              if (!isNaN(num) && num > 0) {
                updateExperimental("mcp_timeout", num)
              }
            }}
          />
        </SettingsRow>
      </Card>

      {/* Tool toggles */}
      <Show when={config().tools && Object.keys(config().tools ?? {}).length > 0}>
        <h4 style={{ "margin-top": "16px", "margin-bottom": "8px" }}>
          {language.t("settings.experimental.toolToggles")}
        </h4>
        <Card>
          <For each={Object.entries(config().tools ?? {})}>
            {([name, enabled], index) => (
              <SettingsRow title={name} description="" last={index() >= Object.keys(config().tools ?? {}).length - 1}>
                <Switch
                  checked={enabled}
                   onChange={(checked) => { if (!readonly()) updateConfig({ tools: { ...config().tools, [name]: checked } }) }}
                   disabled={readonly()}
                  hideLabel
                >
                  {name}
                </Switch>
              </SettingsRow>
            )}
          </For>
        </Card>
      </Show>
      </div>
    </div>
  )
}

export default ExperimentalTab
