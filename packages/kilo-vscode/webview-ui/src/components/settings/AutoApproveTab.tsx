import { Component, Show, createMemo, createSignal } from "solid-js"
import { Card } from "@kilocode/kilo-ui/card"
import { TextField } from "@kilocode/kilo-ui/text-field"
import { Button } from "@kilocode/kilo-ui/button"
import { classifyPermissionPreset } from "@opencode-ai/core/kilocode/permission-presets"

import { useConfig } from "../../context/config"
import { useLanguage } from "../../context/language"
import { useVSCode } from "../../context/vscode"
import { levelSwitchGate } from "../../../../src/shared/work-style-presets"
import PermissionEditor from "./PermissionEditor"
import { DEFAULT_RULES } from "./permission-utils"
import SettingsRow from "./SettingsRow"

const AutoApproveTab: Component = () => {
  const { config, settings, isDirty, updateConfig, updateSetting } = useConfig()
  const language = useLanguage()
  const vscode = useVSCode()
  const [advanced, setAdvanced] = createSignal(false)
  const [switchBlocked, setSwitchBlocked] = createSignal(false)

  const permissions = createMemo(() => config().permission ?? {})
  // Derived from the effective config (saved + unsaved Advanced draft), so an
  // Advanced edit reads Custom before save, and save/discard regress
  // correctly. Rule content is already held by the canonical config service;
  // the shared core classifier is the single matching source.
  const level = createMemo(() => {
    const state = classifyPermissionPreset({
      permissionLevel: (config() as Record<string, unknown>).permission_level,
      permission: config().permission,
    })
    return state
  })
  const cost = createMemo(() => {
    const value = settings().maxCost
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.ceil(value) : 0
  })

  const updateCost = (value: string) => {
    const trimmed = value.trim()
    if (!trimmed) {
      updateSetting("maxCost", 0)
      return
    }
    if (!/^\d+$/.test(trimmed)) return
    const next = Number(trimmed)
    if (Number.isFinite(next) && next >= 0) updateSetting("maxCost", next)
  }

  const applyLevel = (next: "review" | "autonomous") => {
    // A pending Advanced draft would be orphaned by the server-side preset
    // overwrite (and a later save would clobber the switch), so block until
    // the user saves or discards — never silently drop edits.
    if (levelSwitchGate(isDirty()).blocked) {
      setSwitchBlocked(true)
      return
    }
    setSwitchBlocked(false)
    vscode.postMessage({ type: "applyWorkStyle", style: next === "review" ? "human-in-the-loop" : "autonomous" })
  }

  const levelLabel = createMemo(() => {
    const v = level()
    if (v === "review") return language.t("workStyle.level.review")
    if (v === "autonomous") return language.t("workStyle.level.autonomous")
    if (v === "custom") return language.t("workStyle.level.custom")
    return language.t("workStyle.level.unset")
  })

  return (
    <div>
      <Card>
        <SettingsRow
          title={language.t("workStyle.main.title")}
          description={`${language.t("workStyle.main.description")} — ${levelLabel()}`}
          last
        >
          <div style={{ display: "flex", gap: "8px", "flex-wrap": "wrap" }}>
            <Button
              variant={level() === "review" ? "primary" : "secondary"}
              onClick={() => applyLevel("review")}
            >
              {language.t("workStyle.level.review")}
            </Button>
            <Button
              variant={level() === "autonomous" ? "primary" : "secondary"}
              onClick={() => applyLevel("autonomous")}
            >
              {language.t("workStyle.level.autonomous")}
            </Button>
            <Button variant="ghost" onClick={() => setAdvanced((v) => !v)}>
              {advanced()
                ? language.t("workStyle.advanced.hide")
                : language.t("workStyle.advanced.show")}
            </Button>
          </div>
        </SettingsRow>
        <Show when={level() === "custom"}>
          <SettingsRow
            title={language.t("workStyle.level.custom")}
            description={language.t("workStyle.level.customDescription")}
            last
          >
            <span />
          </SettingsRow>
        </Show>
        <Show when={switchBlocked()}>
          <SettingsRow
            title={language.t("workStyle.switchBlocked.title")}
            description={language.t("workStyle.switchBlocked.description")}
            last
          >
            <span />
          </SettingsRow>
        </Show>
      </Card>

      <div style={{ height: "12px" }} />

      <Show when={advanced()}>
        <Card>
          <SettingsRow
            title={language.t("settings.autoApprove.maxCost.title")}
            description={language.t("settings.autoApprove.maxCost.description")}
            last
          >
            <TextField
              type="number"
              inputMode="numeric"
              min="0"
              step="1"
              value={cost() ? String(cost()) : ""}
              placeholder="5"
              onChange={updateCost}
              hideLabel
              label={language.t("settings.autoApprove.maxCost.title")}
            />
          </SettingsRow>
        </Card>

        <div style={{ height: "12px" }} />

        <PermissionEditor
          permissions={permissions()}
          rules={DEFAULT_RULES}
          description={language.t("settings.autoApprove.description")}
          inherited
          showDefaultLevel
          onChange={(patch) => updateConfig({ permission: patch, permission_level: null } as never)}
        />
      </Show>
      <Show when={!advanced()}>
        <Card>
          <SettingsRow
            title={language.t("settings.autoApprove.title")}
            description={language.t("workStyle.advanced.hint")}
            last
          >
            <Button variant="secondary" onClick={() => setAdvanced(true)}>
              {language.t("workStyle.advanced.show")}
            </Button>
          </SettingsRow>
        </Card>
      </Show>
    </div>
  )
}

export default AutoApproveTab
