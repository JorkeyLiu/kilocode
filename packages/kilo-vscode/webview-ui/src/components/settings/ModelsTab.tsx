import { Component, For, Show, createMemo } from "solid-js"
import type { ParentComponent } from "solid-js"
import { Card } from "@kilocode/kilo-ui/card"
import { Select } from "@kilocode/kilo-ui/select"
import { Switch } from "@kilocode/kilo-ui/switch"
import { Tooltip } from "@kilocode/kilo-ui/tooltip"
import { useConfig } from "../../context/config"
import { useLanguage } from "../../context/language"
import { useProvider } from "../../context/provider"
import { useSession } from "../../context/session"
import { parseModelString } from "../../../../src/shared/provider-model"
import { ModelSelectorBase } from "../shared/ModelSelector"
import { ThinkingSelectorBase } from "../shared/ThinkingSelector"
import SettingsRow from "./SettingsRow"
import { DEFAULT_SPEECH_TO_TEXT_MODEL } from "../../../../src/speech-to-text/models"
import { hasSpeechToTextAccess, selectedSpeechToTextModel } from "../speech-to-text/availability"
import { SPEECH_TO_TEXT_MODEL_OPTIONS } from "../speech-to-text/model-selector"

function updateIfEditable(readonly: boolean, update: (partial: Partial<import("../../types/messages").Config>) => void, partial: Partial<import("../../types/messages").Config>): void {
  if (!readonly) update(partial)
}

const ReadOnly: ParentComponent<{ value: boolean }> = (props) => (
  <div aria-disabled={props.value} title={props.value ? "Unsupported in canonical GUI config" : undefined} style={{ opacity: props.value ? "0.6" : "1" }}>
    {props.children}
  </div>
)

const ModelsTab: Component = () => {
  const { config, updateConfig, canonical } = useConfig()
  const language = useLanguage()
  const provider = useProvider()
  const session = useSession()
  const readonly = () => canonical?.() === true

  function handleModelSelect(configKey: "model" | "small_model") {
    return (providerID: string, modelID: string) => {
      if (readonly()) return
      if (!providerID || !modelID) {
        updateConfig({ [configKey]: null })
        return
      }
      updateConfig({ [configKey]: `${providerID}/${modelID}` })
    }
  }

  const defaultModel = createMemo(() => parseModelString(config().model ?? undefined))
  const defaultModelKey = createMemo(() => config().model ?? undefined)
  const defaultModelVariants = createMemo(() => Object.keys(provider.findModel(defaultModel())?.variants ?? {}))
  const defaultModelVariant = createMemo(() => {
    const key = defaultModelKey()
    if (!key) return undefined
    const supported = defaultModelVariants()
    if (supported.length === 0) return undefined
    const value = config().model_variant_overrides?.[key]
    if (value && supported.includes(value)) return value
    const global = config().model_variant ?? undefined
    if (global && supported.includes(global)) return global
    return undefined
  })

  function updateDefaultModelVariant(value: string | null) {
    if (readonly()) return
    const key = defaultModelKey()
    if (!key) return
    // LOCK-005: per-model override update must not clear global model_variant.
    // The override map takes precedence in resolution; the global field
    // remains untouched so other models still benefit from it.
    updateConfig({
      model_variant_overrides: { [key]: value },
    })
  }

  const subagentModel = createMemo(() => parseModelString(config().subagent_model ?? undefined))
  const speechModel = createMemo(() => selectedSpeechToTextModel(config()))
  const speechOption = createMemo(() => SPEECH_TO_TEXT_MODEL_OPTIONS.find((item) => item.value === speechModel()))
  const kiloReady = createMemo(() => hasSpeechToTextAccess(config(), provider.authStates()))
  const variantKey = createMemo(() => config().subagent_model ?? undefined)
  const subagentVariants = createMemo(() => Object.keys(provider.findModel(subagentModel())?.variants ?? {}))
  const subagentVariant = createMemo(() => {
    const key = variantKey()
    if (!key) return undefined
    const supported = subagentVariants()
    if (supported.length === 0) return undefined
    // LOCK-007: valid override > valid global > unset
    const value = config().subagent_variant_overrides?.[key]
    if (value && supported.includes(value)) return value
    const global = config().subagent_variant ?? undefined
    if (global && supported.includes(global)) return global
    return undefined
  })

  function handleSubagentModelSelect(providerID: string, modelID: string) {
    if (readonly()) return
    if (!providerID || !modelID) {
      updateConfig({ subagent_model: null, subagent_variant: null })
      return
    }
    const value = `${providerID}/${modelID}`
    updateConfig({
      subagent_model: value,
      ...(config().subagent_model === value ? {} : { subagent_variant: null }),
    })
  }

  function updateSubagentVariant(value: string | null) {
    if (readonly()) return
    const key = variantKey()
    if (!key) return
    // LOCK-005: per-model override update must not clear global subagent_variant.
    updateConfig({
      subagent_variant_overrides: { [key]: value },
    })
  }

  const allAgents = createMemo(() => session.agents())

  function handleModeModelSelect(agentName: string) {
    return (providerID: string, modelID: string) => {
      // Model/variant delta through the shared latest-draft merge: only the
      // model key is committed, so a pending description/prompt draft from
      // the edit view is never overwritten. Flushed immediately because a
      // model pick is discrete (not keystrokes). Failures surface via the
      // shared agent diagnostic, success via agentsLoaded.
      const model = !providerID || !modelID ? null : `${providerID}/${modelID}`
      void session.scheduleAgentEdit(agentName, { frontmatter: { model } })
      session.flushAgentEdits(agentName)
    }
  }

  return (
    <div>
           <Card aria-disabled={readonly()} title={readonly() ? "Unsupported in canonical GUI config" : undefined}>
        <SettingsRow
          title={language.t("settings.providers.defaultModel.title")}
          description={language.t("settings.providers.defaultModel.description")}
        >
             <ModelSelectorBase
            value={parseModelString(config().model ?? undefined)}
             onSelect={handleModelSelect("model")}
             disabled={readonly()}
            placement="bottom-start"
            allowClear
            clearLabel={language.t("settings.providers.notSet")}
            label={language.t("settings.providers.defaultModel.title")}
            description={language.t("settings.providers.defaultModel.description")}
          />
          <Show when={defaultModelVariants().length > 0}>
             <ThinkingSelectorBase
              variants={defaultModelVariants()}
              value={defaultModelVariant()}
               onSelect={(value) => updateDefaultModelVariant(value)}
               onClear={() => updateDefaultModelVariant(null)}
              allowClear
              clearLabel={language.t("settings.providers.notSet")}
              placement="bottom-start"
                    globalTrigger={false}
                    disabled={readonly()}
            />
          </Show>
        </SettingsRow>
        <SettingsRow
          title={language.t("settings.providers.smallModel.title")}
          description={language.t("settings.providers.smallModel.description")}
        >
              <div aria-disabled={canonical?.() === true} title={canonical?.() === true ? "Unsupported in canonical GUI config" : undefined} style={{ opacity: canonical?.() === true ? "0.6" : "1" }}>
             <ModelSelectorBase
             value={parseModelString(config().small_model ?? undefined)}
             onSelect={handleModelSelect("small_model")}
             disabled={readonly()}
            placement="bottom-start"
            allowClear
            clearLabel={language.t("settings.providers.notSet")}
            includeAutoSmall
            label={language.t("settings.providers.smallModel.title")}
            description={language.t("settings.providers.smallModel.description")}
             />
             </div>
        </SettingsRow>
        <SettingsRow
          title={language.t("settings.providers.subagentModel.title")}
          description={language.t("settings.providers.subagentModel.description")}
        >
          <div style={{ display: "flex", "flex-direction": "column", "align-items": "flex-end", gap: "8px" }}>
              <div aria-disabled={canonical?.() === true} title={canonical?.() === true ? "Unsupported in canonical GUI config" : undefined} style={{ opacity: canonical?.() === true ? "0.6" : "1" }}>
             <ModelSelectorBase
             value={subagentModel()}
               onSelect={handleSubagentModelSelect}
               disabled={readonly()}
              placement="bottom-start"
              allowClear
              clearLabel={language.t("settings.providers.notSet")}
              label={language.t("settings.providers.subagentModel.title")}
              description={language.t("settings.providers.subagentModel.description")}
             />
             </div>
             <ReadOnly value={readonly()}>
               <Show when={subagentVariants().length > 0}>
                 <ThinkingSelectorBase
                   variants={subagentVariants()}
                   value={subagentVariant()}
                   onSelect={(value) => updateSubagentVariant(value)}
                   onClear={() => updateSubagentVariant(null)}
                   allowClear
                   clearLabel={language.t("settings.providers.notSet")}
                   placement="bottom-start"
                   globalTrigger={false}
                 />
               </Show>
             </ReadOnly>
          </div>
        </SettingsRow>
        <SettingsRow
          title={language.t("settings.models.speechToTextModel.title")}
          description={
            kiloReady()
              ? language.t("settings.models.speechToTextModel.description")
              : language.t("settings.models.speechToText.disabledDescription")
          }
        >
          <Tooltip
            value={language.t("settings.models.speechToText.disabledDescription")}
            placement="top"
            inactive={kiloReady()}
          >
            <Select
              options={SPEECH_TO_TEXT_MODEL_OPTIONS}
              current={speechOption()}
              value={(item) => item.value}
              label={(item) => `${item.label} (${item.provider})`}
              onSelect={(item) =>
                updateConfig({
                  experimental: {
                    ...config().experimental,
                    speech_to_text_model: item?.value ?? DEFAULT_SPEECH_TO_TEXT_MODEL.id,
                  },
                })
              }
              variant="secondary"
              size="small"
              triggerVariant="settings"
              triggerProps={{
                "aria-label": `${language.t("settings.models.speechToTextModel.title")}: ${speechOption()?.label}`,
              }}
               disabled={readonly() || !kiloReady()}
              placeholder={DEFAULT_SPEECH_TO_TEXT_MODEL.label}
            />
          </Tooltip>
        </SettingsRow>
        <SettingsRow
          title={language.t("settings.models.hidePromptTraining.title")}
          description={language.t("settings.models.hidePromptTraining.description")}
          last
        >
          <Switch
            checked={config().hide_prompt_training_models === true}
             onChange={(checked: boolean) => updateIfEditable(readonly(), updateConfig, { hide_prompt_training_models: checked })}
             disabled={readonly()}
            hideLabel
          >
            {language.t("settings.models.hidePromptTraining.title")}
          </Switch>
        </SettingsRow>
      </Card>

      <h4 style={{ "margin-top": "24px", "margin-bottom": "8px" }}>{language.t("settings.providers.modeModels")}</h4>
      <Card>
        <For each={allAgents()}>
          {(agent, index) => {
            const full = () => session.allAgents().find((a) => a.name === agent.name)
            const blocked = () => {
              const item = full()
              return item?.native === true || !item?.scope || !item?.assetHash || item?.assetHash === "absent"
            }
            return (
            <SettingsRow
              title={agent.name.charAt(0).toUpperCase() + agent.name.slice(1)}
              last={index() === allAgents().length - 1}
            >
              <ModelSelectorBase
               value={parseModelString(agent.frontmatter?.model as string | undefined)}
               onSelect={handleModeModelSelect(agent.name)}
               disabled={blocked()}
                placement="bottom-start"
                allowClear
                clearLabel={language.t("settings.providers.notSet")}
                label={`${language.t("settings.providers.modeModels")}: ${agent.name}`}
                description={language.t("settings.providers.modeModels.description")}
              />
            </SettingsRow>
            )
          }}
        </For>
      </Card>
    </div>
  )
}

export default ModelsTab
