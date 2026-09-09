import { Component, Show, For, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"
import { TextField } from "@kilocode/kilo-ui/text-field"
import { Switch } from "@kilocode/kilo-ui/switch"
import { Card } from "@kilocode/kilo-ui/card"
import { Button } from "@kilocode/kilo-ui/button"
import { IconButton } from "@kilocode/kilo-ui/icon-button"

import { createAgentDraft, type AgentDraft } from "./agent-draft"
import { useConfig } from "../../context/config"
import { useProvider } from "../../context/provider"
import { useSession } from "../../context/session"
import { useLanguage } from "../../context/language"
import type { AgentConfig, AgentInfo, PermissionConfig, PermissionRuleItem } from "../../types/messages"
import { parseModelString } from "../../../../src/shared/provider-model"
import SettingsRow from "./SettingsRow"
import { buildExport } from "./mode-io"
import { modelPatch } from "./mode-model"
import { agentPatch } from "./agent-behaviour-patches"
import PermissionEditor from "./PermissionEditor"
import { ModelSelectorBase } from "../shared/ModelSelector"
import { ThinkingSelectorBase } from "../shared/ThinkingSelector"

interface Props {
  name: string
  onBack: () => void
  onRemove: (agent: AgentInfo) => void
}

const ModeEditView: Component<Props> = (props) => {
  const language = useLanguage()
  const { config, updateConfig } = useConfig()
  const provider = useProvider()
  const session = useSession()

  // agent() may be undefined for modes that only exist in the config draft (just
  // created, not yet saved). This is fine — native defaults to false (correct for
  // custom modes) and all fields read from shown() below.
  const agent = () => session.allAgents().find((a) => a.name === props.name)
  const native = () => agent()?.native ?? false
  const [expanded, setExpanded] = createSignal(false)

  const cfg = createMemo<AgentConfig>(() => {
    const item = agent()
    return item ? ({ ...(item.frontmatter ?? {}), prompt: item.body ?? "" } as AgentConfig) : {}
  })

  // Local draft (see agent-draft.ts): typing updates overrides immediately
  // for stable display and coalesces into the serial coordinator. Server
  // truth (cfg) wins again once the confirmed asset hash advances while
  // idle. An agent switch always resets, even with an identical assetHash.
  const draft: AgentDraft = createAgentDraft((target, patch) => {
    // Fire-and-forget: this view owns no settlement signals (display reads
    // the local draft; failures surface via the provider-level diagnostic),
    // so no owner guard is needed here.
    void session.scheduleAgentEdit(target, patch)
  })
  const shown = (): AgentConfig => draft.shown(cfg())
  const seenHash = createMemo(() => agent()?.assetHash ?? null)
  const syncDraft = (pending: boolean): void => {
    draft.sync({ name: props.name, hash: agent()?.assetHash ?? null, server: cfg() }, pending)
  }
  createEffect(
    on(seenHash, () => {
      syncDraft(session.isAgentPending(props.name))
    }),
  )

  const model = createMemo(() => parseModelString(shown().model ?? undefined))
  const variants = createMemo(() => {
    const sel = model()
    if (!sel) return []
    return Object.keys(provider.findModel(sel)?.variants ?? {})
  })
  const showVariant = () => variants().length > 0 || !!shown().variant

  // Flush coalesced keystrokes when leaving the view or switching agents so
  // field switches never drop updates. Dispose/session switch cancels waits
  // via the coordinator without resending accepted operations. The flush
  // result reports to the provider-level diagnostic, never to this
  // (possibly unmounted) view — it owns no settlement signals.
  onCleanup(() => {
    session.flushAgentEdits(props.name)
  })
  createEffect(
    on(
      () => props.name,
      (next, prev) => {
        // Flush the previous agent first, then isolate: the new agent always
        // starts from its own server snapshot, never the old draft.
        if (prev !== undefined && prev !== next) session.flushAgentEdits(prev)
        syncDraft(session.isAgentPending(next))
      },
    ),
  )

  // Native/system agents have no file-backed identity and are never mutated;
  // missing scope/assetHash is blocked in the coordinator with a diagnostic.
  const update = (partial: Partial<AgentConfig>) => {
    if (native()) return
    draft.set(partial)
  }

  const selectModel = (providerID: string, modelID: string) => {
    if (native()) return
    const sel = { providerID, modelID }
    const list = Object.keys(provider.findModel(sel)?.variants ?? {})
    update(modelPatch(providerID, modelID, list, shown().variant))
  }

  const selectVariant = (value: string) => {
    if (native()) return
    update({ variant: value })
  }

  const clearVariant = () => {
    if (native()) return
    update({ variant: null })
  }

  const updatePermission = (patch: PermissionConfig) => {
    if (native()) return
    update({ permission: patch })
  }

  const exportMode = () => {
    const data = buildExport(props.name, shown())
    const json = JSON.stringify(data, null, 2)
    const blob = new Blob([json], { type: "application/json" })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = `${props.name}.agent.json`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  return (
      <div>
      <div
        style={{
          display: "flex",
          "align-items": "center",
          "justify-content": "space-between",
          "margin-bottom": "16px",
        }}
      >
        <div style={{ display: "flex", "align-items": "center" }}>
          <IconButton size="small" variant="ghost" icon="arrow-left" onClick={props.onBack} />
          <span style={{ "font-weight": "600", "font-size": "var(--kilo-font-size-14)", "margin-left": "8px" }}>
            {language.t("settings.agentBehaviour.editMode")} — {props.name}
          </span>
        </div>
        <Show when={!native()}>
          <div style={{ display: "flex", gap: "4px" }}>
            <IconButton
              size="small"
              variant="ghost"
              icon="download"
              title={language.t("settings.agentBehaviour.exportMode")}
              onClick={exportMode}
            />
            <IconButton
              size="small"
              variant="ghost"
              icon="close"
              onClick={() => {
                const a = agent()
                if (a) props.onRemove(a)
              }}
            />
          </div>
        </Show>
      </div>

      <Show when={native()}>
        <Card style={{ "margin-bottom": "12px" }}>
          <div
            style={{
              "font-size": "var(--kilo-font-size-12)",
              color: "var(--text-weak-base, var(--vscode-descriptionForeground))",
              padding: "4px 0",
            }}
          >
            {language.t("settings.agentBehaviour.editMode.native")}
          </div>
        </Card>
      </Show>

      {/* Description (full-width, custom modes only) */}
      <Show when={!native()}>
        <Card style={{ "margin-bottom": "12px" }}>
          <div data-slot="settings-row-label-title" style={{ "margin-bottom": "8px" }}>
            {language.t("settings.agentBehaviour.editMode.description")}
          </div>
          <TextField
            value={shown().description ?? ""}
            placeholder={language.t("settings.agentBehaviour.createMode.description.placeholder")}
            onChange={(val) => update({ description: val || undefined })}
          />
        </Card>
      </Show>

      {/* Prompt (full-width, auto-resizing) */}
      <Card style={{ "margin-bottom": "12px" }}>
        <div data-slot="settings-row-label-title" style={{ "margin-bottom": "8px" }}>
          {native()
            ? language.t("settings.agentBehaviour.editMode.promptOverride")
            : language.t("settings.agentBehaviour.editMode.prompt")}
        </div>
        <TextField
          value={shown().prompt ?? ""}
          placeholder={language.t("settings.agentBehaviour.createMode.prompt.placeholder")}
          multiline
          onChange={(val) => update({ prompt: val })}
          disabled={native()}
        />
      </Card>

      {/* Config overrides (wider inputs) */}
      <Card data-variant="wide-input" style={{ "margin-bottom": "12px" }}>
        <SettingsRow
          title={language.t("settings.agentBehaviour.modelOverride.title")}
          description={language.t("settings.agentBehaviour.modelOverride.description")}
        >
          <ModelSelectorBase
            value={model()}
            onSelect={selectModel}
            placement="bottom-start"
            allowClear
            clearLabel={language.t("settings.providers.notSet")}
            label={language.t("settings.agentBehaviour.modelOverride.title")}
            description={language.t("settings.agentBehaviour.modelOverride.description")}
          />
        </SettingsRow>

        <Show when={showVariant()}>
          <SettingsRow
            title={language.t("settings.agentBehaviour.variantOverride.title")}
            description={language.t("settings.agentBehaviour.variantOverride.description")}
          >
            <ThinkingSelectorBase
              variants={variants()}
              value={shown().variant ?? undefined}
              onSelect={selectVariant}
              onClear={clearVariant}
              allowClear
              clearLabel={language.t("settings.providers.notSet")}
              placement="bottom-start"
              globalTrigger={false}
            />
          </SettingsRow>
        </Show>

        <SettingsRow
          title={language.t("settings.agentBehaviour.temperature.title")}
          description={language.t("settings.agentBehaviour.temperature.description")}
        >
          <TextField
            value={draft.text("temperature")}
            placeholder={language.t("common.default")}
              onChange={(val) => {
              if (native()) return
              draft.setNumeric("temperature", val)
            }}
            disabled={native()}
          />
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.agentBehaviour.topP.title")}
          description={language.t("settings.agentBehaviour.topP.description")}
        >
          <TextField
            value={draft.text("top_p")}
            placeholder={language.t("common.default")}
              onChange={(val) => {
              if (native()) return
              draft.setNumeric("top_p", val)
            }}
            disabled={native()}
          />
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.agentBehaviour.maxSteps.title")}
          description={language.t("settings.agentBehaviour.maxSteps.description")}
        >
          <TextField
            value={draft.text("steps")}
            placeholder={language.t("common.default")}
            onChange={(val) => {
              if (native()) return
              draft.setNumeric("steps", val)
            }}
            disabled={native()}
          />
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.agentBehaviour.hidden.title")}
          description={language.t("settings.agentBehaviour.hidden.description")}
        >
          <Switch
            checked={shown().hidden ?? false}
            onChange={(val) => {
              if (native()) return
              // Send explicit `false` (not `undefined`) so deepMerge can overwrite a previously-saved `true`.
              update({ hidden: val })
              // Clear default_agent if hiding the current default (null = delete sentinel).
              if (val && config().default_agent === props.name) {
                updateConfig({ default_agent: null })
              }
            }}
            disabled={native()}
            hideLabel
          >
            {language.t("settings.agentBehaviour.hidden.title")}
          </Switch>
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.agentBehaviour.disable.title")}
          description={language.t("settings.agentBehaviour.disable.description")}
          last
        >
          <Switch
            checked={shown().disable ?? false}
            onChange={(val) => {
              if (native()) return
              // Send explicit `false` (not `undefined`) so deepMerge can overwrite a previously-saved `true`.
              update({ disable: val })
              // Clear default_agent if disabling the current default (null = delete sentinel).
              if (val && config().default_agent === props.name) {
                updateConfig({ default_agent: null })
              }
            }}
            disabled={native()}
            hideLabel
          >
            {language.t("settings.agentBehaviour.disable.title")}
          </Switch>
        </SettingsRow>
      </Card>

      <Show when={!native()}>
        <Card
          style={{
            "margin-bottom": "12px",
            padding: "0",
            overflow: "hidden",
            border: "1px solid var(--border-base, var(--vscode-panel-border))",
          }}
        >
          <div
            style={{
              padding: "14px 16px 12px",
              "border-bottom": "1px solid var(--border-weak-base, var(--vscode-panel-border))",
              background: "var(--bg-subtle-base, var(--vscode-editorWidget-background))",
            }}
          >
            <div data-slot="settings-row-label-title" style={{ "margin-bottom": "6px" }}>
              Per-Agent Permissions
            </div>
            <div
              style={{
                "font-size": "var(--kilo-font-size-12)",
                color: "var(--text-weak-base, var(--vscode-descriptionForeground))",
                "line-height": "1.45",
              }}
            >
              These settings only apply to this custom agent. Change a dropdown from Default to create an override, or
              use Add path/Add command for tool-specific exceptions.
            </div>
          </div>
          <div style={{ padding: "0 16px 4px" }}>
            <PermissionEditor
              permissions={shown().permission}
              rules={agent()?.permission}
              component="agent-permission-settings"
              inherited
              onChange={updatePermission}
            />
          </div>
        </Card>
      </Show>

      {/* Calculated permissions (read-only, collapsible) */}
      <Show when={agent()?.permission} keyed>
        {(rules) => (
          <PermissionRuleset
            agent={props.name}
            rules={rules}
            expanded={expanded()}
            onToggle={() => setExpanded((v) => !v)}
          />
        )}
      </Show>

      <div style={{ display: "flex", "justify-content": "flex-end" }}>
        <Button variant="ghost" onClick={props.onBack}>
          {language.t("settings.agentBehaviour.editMode.back")}
        </Button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Collapsible permissions ruleset display
// ---------------------------------------------------------------------------

const ACTION_COLORS: Record<string, { bg: string; fg: string }> = {
  allow: { bg: "var(--vscode-terminal-ansiGreen, #3fb950)", fg: "var(--vscode-editor-background, #1e1e1e)" },
  ask: { bg: "var(--vscode-editorWarning-foreground, #cca700)", fg: "var(--vscode-editor-background, #1e1e1e)" },
  deny: { bg: "var(--vscode-errorForeground, #f85149)", fg: "var(--vscode-editor-background, #fff)" },
  unknown: { bg: "var(--vscode-descriptionForeground, #8b949e)", fg: "var(--vscode-editor-background, #1e1e1e)" },
}

interface RulesetProps {
  agent: string
  rules: PermissionRuleItem[]
  expanded: boolean
  onToggle: () => void
}

const PermissionRuleset: Component<RulesetProps> = (props) => {
  const language = useLanguage()
  const [copied, setCopied] = createSignal(false)

  // Compute effective action per unique tool by finding the last rule with pattern "*"
  // NOTE: This assumes the CLI uses "*" as the wildcard pattern for catch-all rules.
  // If the CLI convention changes (e.g. to "**" or another pattern), this will need updating.
  const summary = createMemo(() => {
    const tools = new Map<string, PermissionRuleItem["action"]>()
    for (const rule of props.rules) {
      if (rule.pattern === "*") {
        tools.set(rule.permission, rule.action)
      }
    }
    return [...tools.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  })

  const copy = (e: MouseEvent) => {
    e.stopPropagation()
    const data = { agent: props.agent, rules: props.rules }
    navigator.clipboard.writeText(JSON.stringify(data, null, 2))
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <Card style={{ "margin-bottom": "12px" }}>
      <div
        style={{ display: "flex", "align-items": "center", cursor: "pointer", "user-select": "none" }}
        onClick={props.onToggle}
      >
        <IconButton
          size="small"
          variant="ghost"
          icon={props.expanded ? "chevron-down" : "chevron-right"}
          onClick={(e: MouseEvent) => {
            e.stopPropagation()
            props.onToggle()
          }}
        />
        <span data-slot="settings-row-label-title" style={{ "margin-left": "4px" }}>
          {language.t("settings.agentBehaviour.permissions.title")}
        </span>
        <span
          style={{
            "margin-left": "8px",
            "font-size": "var(--kilo-font-size-11)",
            color: "var(--text-weak-base, var(--vscode-descriptionForeground))",
          }}
        >
          {language.t("settings.agentBehaviour.permissions.count", { count: String(props.rules.length) })}
        </span>
        <div style={{ "margin-left": "auto" }}>
          <IconButton
            size="small"
            variant="ghost"
            icon={copied() ? "check" : "copy"}
            title={language.t("settings.agentBehaviour.permissions.copy")}
            onClick={copy}
          />
        </div>
      </div>

      <Show when={props.expanded}>
        {/* Summary: effective action per tool for wildcard pattern */}
        <Show when={summary().length > 0}>
          <div style={{ "margin-top": "8px", "margin-bottom": "8px" }}>
            <div
              style={{
                "font-size": "var(--kilo-font-size-11)",
                color: "var(--text-weak-base, var(--vscode-descriptionForeground))",
                "margin-bottom": "4px",
              }}
            >
              {language.t("settings.agentBehaviour.permissions.effective")}
            </div>
            <div style={{ display: "flex", "flex-wrap": "wrap", gap: "4px" }}>
              <For each={summary()}>
                {([tool, action]) => {
                  const colors = ACTION_COLORS[action] ?? ACTION_COLORS.unknown
                  return (
                    <span
                      style={{
                        "font-size": "var(--kilo-font-size-11)",
                        padding: "2px 6px",
                        "border-radius": "3px",
                        background: colors.bg,
                        color: colors.fg,
                        "font-family": "var(--vscode-editor-font-family, monospace)",
                      }}
                    >
                      {tool}: {action}
                    </span>
                  )
                }}
              </For>
            </div>
          </div>
        </Show>

        {/* Full ruleset table */}
        <div
          style={{
            "margin-top": "8px",
            "font-size": "var(--kilo-font-size-11)",
            "font-family": "var(--vscode-editor-font-family, monospace)",
            "max-height": "300px",
            "overflow-y": "auto",
            border: "1px solid var(--border-weak-base, var(--vscode-panel-border))",
            "border-radius": "4px",
          }}
        >
          <table style={{ width: "100%", "border-collapse": "collapse" }}>
            <thead>
              <tr
                style={{
                  background: "var(--bg-subtle-base, var(--vscode-editorWidget-background))",
                  position: "sticky",
                  top: "0",
                }}
              >
                <th style={{ padding: "4px 8px", "text-align": "left", "font-weight": "600" }}>
                  {language.t("settings.agentBehaviour.permissions.col.tool")}
                </th>
                <th style={{ padding: "4px 8px", "text-align": "left", "font-weight": "600" }}>
                  {language.t("settings.agentBehaviour.permissions.col.pattern")}
                </th>
                <th style={{ padding: "4px 8px", "text-align": "left", "font-weight": "600" }}>
                  {language.t("settings.agentBehaviour.permissions.col.action")}
                </th>
              </tr>
            </thead>
            <tbody>
              <For each={props.rules}>
                {(rule, idx) => {
                  const colors = ACTION_COLORS[rule.action] ?? ACTION_COLORS.unknown
                  return (
                    <tr
                      style={{
                        "border-top":
                          idx() > 0 ? "1px solid var(--border-weak-base, var(--vscode-panel-border))" : "none",
                      }}
                    >
                      <td style={{ padding: "3px 8px" }}>{rule.permission}</td>
                      <td style={{ padding: "3px 8px", color: "var(--text-weak-base)" }}>{rule.pattern}</td>
                      <td style={{ padding: "3px 8px" }}>
                        <span
                          style={{
                            padding: "1px 4px",
                            "border-radius": "2px",
                            background: colors.bg,
                            color: colors.fg,
                          }}
                        >
                          {rule.action}
                        </span>
                      </td>
                    </tr>
                  )
                }}
              </For>
            </tbody>
          </table>
        </div>

        <div
          style={{
            "margin-top": "6px",
            "font-size": "var(--kilo-font-size-10)",
            color: "var(--text-weak-base, var(--vscode-descriptionForeground))",
          }}
        >
          {language.t("settings.agentBehaviour.permissions.hint")}
        </div>
      </Show>
    </Card>
  )
}

export default ModeEditView
