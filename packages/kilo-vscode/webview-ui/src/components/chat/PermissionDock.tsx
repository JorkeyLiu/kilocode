/**
 * PermissionDock component
 * Displays permission requests from the AI assistant in the dock above the prompt input.
 * Uses kilo-ui's DockPrompt component for proper surface styling.
 *
 * Per-rule toggles allow users to approve/deny individual permission rules for future requests.
 * For bash, the hierarchical rules from metadata.rules are shown.
 * For other tools, the always array is shown so users can configure per-tool permissions.
 * The command buttons (Deny / Run) control the current command.
 */

import { Component, For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { Button } from "@kilocode/kilo-ui/button"
import { DockPrompt } from "@kilocode/kilo-ui/dock-prompt"
import { Icon } from "@kilocode/kilo-ui/icon"
import { Tooltip } from "@kilocode/kilo-ui/tooltip"
import { useSession } from "../../context/session"
import { useLanguage } from "../../context/language"
import { useConfig } from "../../context/config"
import {
  describePatterns,
  describeRule,
  isConfigProtected,
  protectedAgentName,
  protectedRequestPaths,
  savedRuleStates,
  type RuleDecision,
} from "./permission-dock-utils"
import {
  CEILING_KEYS,
  DECISION_LABEL_KEYS,
  REASON_KEYS,
  SOURCE_LABEL_KEYS,
  projectProvenance,
} from "./permission-provenance"
import { PermissionCommand } from "./PermissionCommand"
import { PermissionDiff } from "./PermissionDiff"
import { permissionDiffs } from "./permission-diff-utils"
import { normalizeUrls } from "../../../../../opencode/src/kilocode/util/url"
import type { PermissionRequest } from "../../types/messages"
import { isEnterKeyCommitNotIme } from "../../utils/ime-enter"

let rulesExpandedPreference = false

export const PermissionDock: Component<{
  request: PermissionRequest
  responding: boolean
  onDecide: (response: "once" | "reject", approvedAlways: string[], deniedAlways: string[]) => void
}> = (props) => {
  const session = useSession()
  const language = useLanguage()
  const { config } = useConfig()

  const fromChild = () => props.request.sessionID !== session.currentSessionID()
  // Protected config-file requests (backend metadata): persistence is scoped to
  // the current agent and exact request paths, never global edit auto-approval.
  const configProtected = () => isConfigProtected(props.request.args)
  const protectedAgent = () => protectedAgentName(props.request.args)
  const protectedScope = () =>
    language.t("ui.permission.configProtected.scope", {
      agent: protectedAgent() ?? language.t("ui.permission.configProtected.thisAgent"),
    })
  const protectedHeading = () =>
    language.t(
      props.request.toolName === "edit"
        ? "ui.permission.configProtected.edit"
        : "ui.permission.configProtected.access",
    )
  // Bash sends fine-grained rules via metadata.rules; other tools use the always array.
  const rules = () => props.request.args?.rules ?? props.request.always ?? []
  // Rules like "git *" or "git log *" — strip the trailing wildcard for display.
  // A bare "*" (global wildcard) becomes empty so only the tool name shows.
  const label = (rule: string) => (rule === "*" ? "" : rule.replace(/ \*$/, ""))
  const command = () => {
    const cmd = props.request.args?.command
    if (typeof cmd !== "string") return undefined
    // Normalize IDN/Unicode hostnames to punycode ASCII to prevent homograph attacks.
    return normalizeUrls(cmd)
  }
  const text = (rule: string) => {
    // Protected config-file requests persist by exact path: translate the UI
    // "*" wildcard to the real request paths so the row shows the exact scope.
    if (configProtected() && rule === "*") {
      const paths = protectedRequestPaths(props.request).join(", ")
      if (paths) return paths
    }
    return command() ? label(rule) : describeRule(props.request.toolName, rule, language.t)
  }
  const external = () => props.request.toolName === "external_directory"
  const cmdDescription = () => {
    const val = props.request.args?.description
    return typeof val === "string" && val.length > 0 ? val : undefined
  }
  const description = createMemo(() =>
    command() ? null : describePatterns(props.request.toolName, props.request.patterns, language.t),
  )

  const diffs = createMemo(() => permissionDiffs(props.request))

  // Pre-populate toggle states from existing config rules so previously
  // approved/denied patterns show their saved state immediately.
  const saved = config().permission?.[props.request.toolName]
  const loadState = savedRuleStates(rules(), saved)
  const [decisions, setDecisions] = createSignal<Record<number, RuleDecision>>(loadState)
  const [expanded, setExpanded] = createSignal(rulesExpandedPreference)
  // Provenance explanation stays collapsed by default and is never persisted;
  // it only renders the redacted projector output (safe labels, no raw paths).
  const [whyOpen, setWhyOpen] = createSignal(false)
  const provenance = () => projectProvenance(props.request.args)

  let root!: HTMLDivElement

  const hasRules = () => rules().length > 0

  const toggleExpanded = () => {
    const next = !expanded()
    rulesExpandedPreference = next
    setExpanded(next)
  }

  const collectRules = () => {
    const all = rules()
    const approved: string[] = []
    const denied: string[] = []
    for (const [i, d] of Object.entries(decisions())) {
      const rule = all[Number(i)]
      if (!rule) continue
      if (d === "approved") approved.push(rule)
      else if (d === "denied") denied.push(rule)
    }
    return { approved, denied }
  }

  const toggleRule = (index: number, decision: RuleDecision) => {
    const current = decisions()[index]
    const next = current === decision ? "pending" : decision
    const updated = { ...decisions(), [index]: next }
    setDecisions(updated)
  }

  const decision = (index: number): RuleDecision => decisions()[index] ?? "pending"

  const approveTooltip = (index: number) => {
    if (decision(index) === "approved") {
      return configProtected()
        ? language.t("ui.permission.configProtected.removeFromAllowed")
        : language.t("ui.permission.rule.removeFromAllowed")
    }
    return configProtected()
      ? language.t("ui.permission.configProtected.addToAllowed")
      : language.t("ui.permission.rule.addToAllowed")
  }

  const denyTooltip = (index: number) => {
    if (decision(index) === "denied") {
      return configProtected()
        ? language.t("ui.permission.configProtected.removeFromDenied")
        : language.t("ui.permission.rule.removeFromDenied")
    }
    return configProtected()
      ? language.t("ui.permission.configProtected.addToDenied")
      : language.t("ui.permission.rule.addToDenied")
  }

  const toolDescription = () => {
    const key = `settings.permissions.tool.${props.request.toolName}.description`
    const value = language.t(key as Parameters<typeof language.t>[0])
    if (value === key) return ""
    return value
  }

  const title = () =>
    fromChild() ? language.t("notification.permission.titleSubagent") : language.t("notification.permission.title")

  const focusPrompt = () => requestAnimationFrame(() => window.dispatchEvent(new Event("focusPrompt")))

  const submit = (response: "once" | "reject") => {
    if (props.responding) return
    const { approved, denied } = collectRules()
    props.onDecide(response, approved, denied)
    focusPrompt()
  }

  const element = (e: KeyboardEvent) => (e.target instanceof Element ? e.target : undefined)

  const control = (target: Element | undefined) =>
    !!target?.closest(
      "button, input, select, textarea, a[href], [contenteditable='true'], [role='button'], [role='menu'], [role='menuitem'], [role='listbox'], [role='option'], [role='combobox'], [role='textbox']",
    )

  const plain = (e: KeyboardEvent) => isEnterKeyCommitNotIme(e) && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey

  const skip = (e: KeyboardEvent, target: Element | undefined) => {
    const local = !!target?.closest("[data-component='permission-shortcuts']")
    const prompt = !!target?.closest("textarea.prompt-input")
    const modal = !!target?.closest("[data-component='dialog'], [data-component='dropdown-menu-content']")
    if (local) return e.key === "Enter"
    if (modal) return true
    if (prompt) return false
    return control(target)
  }

  const handle = (e: KeyboardEvent, response: "once" | "reject") => {
    e.preventDefault()
    e.stopPropagation()
    submit(response)
  }

  const onRoot = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      handle(e, "reject")
      return
    }
  }

  const onKey = (e: KeyboardEvent) => {
    if (!document.hasFocus()) return
    if (e.defaultPrevented) return
    if (root.getClientRects().length === 0) return

    const target = element(e)

    // Preserve normal Enter behavior for controls inside the permission card,
    // while allowing the shortcut when the prompt input still has focus.
    if (skip(e, target)) return

    if (e.key === "Escape") {
      handle(e, "reject")
      return
    }

    if (plain(e)) {
      handle(e, "once")
      return
    }
  }

  // Listen only while this permission is rendered. This keeps shortcuts working
  // when the prompt input owns focus without forcing focus onto the dock.
  createEffect(() => {
    void props.request.id
    document.addEventListener("keydown", onKey, true)
    onCleanup(() => document.removeEventListener("keydown", onKey, true))
  })

  return (
    <div ref={root} data-component="permission-shortcuts" onKeyDown={onRoot}>
      <DockPrompt
        kind="permission"
        header={
          <div data-slot="permission-row" data-variant="header">
            <span data-slot="permission-icon">
              <Icon name="warning" size="small" />
            </span>
            <div data-slot="permission-header-title">{title()}</div>
          </div>
        }
        footer={
          <Show when={hasRules()}>
            <div data-slot="permission-rules-section">
              <button
                type="button"
                data-slot="permission-rules-header"
                data-open={expanded() ? "" : undefined}
                onClick={toggleExpanded}
                aria-expanded={expanded()}
              >
                <span data-slot="permission-rules-header-chevron" data-open={expanded() ? "" : undefined}>
                  <Icon name="chevron-down" size="small" />
                </span>
                <span data-slot="permission-rules-header-title">{language.t("ui.permission.manageAutoApprove")}</span>
              </button>

              <div data-slot="permission-rules-collapse" data-open={expanded() ? "" : undefined}>
                <div data-slot="permission-rules-collapse-inner">
                  <div data-slot="permission-rules">
                    <For each={rules()}>
                      {(rule, index) => (
                        <div data-slot="permission-rule-row" data-decision={decision(index())}>
                          <div data-slot="permission-rule-actions">
                            <Tooltip value={approveTooltip(index())} placement="top">
                              <button
                                data-slot="permission-rule-toggle"
                                data-variant="approve"
                                data-active={decision(index()) === "approved" ? "" : undefined}
                                disabled={props.responding}
                                onClick={() => toggleRule(index(), "approved")}
                                aria-label={approveTooltip(index())}
                              >
                                <Icon name="check-small" size="small" />
                              </button>
                            </Tooltip>
                            <Tooltip value={denyTooltip(index())} placement="top">
                              <button
                                data-slot="permission-rule-toggle"
                                data-variant="deny"
                                data-active={decision(index()) === "denied" ? "" : undefined}
                                disabled={props.responding}
                                onClick={() => toggleRule(index(), "denied")}
                                aria-label={denyTooltip(index())}
                              >
                                <Icon name="close-small" size="small" />
                              </button>
                            </Tooltip>
                          </div>
                          <code
                            data-slot="permission-rule"
                            data-wrap={external() || configProtected() ? "" : undefined}
                            title={text(rule)}
                          >
                            <Show when={external() && rule !== "*"} fallback={text(rule)}>
                              <span data-slot="permission-rule-label">
                                {language.t("ui.permission.toolLabel.externalDirectory")}{" "}
                              </span>
                              <span data-slot="permission-rule-path">{rule}</span>
                            </Show>
                          </code>
                        </div>
                      )}
                    </For>
                  </div>
                </div>
              </div>
            </div>
          </Show>
        }
      >
        <Show when={configProtected()}>
          <div data-slot="permission-protected">
            <div data-slot="permission-protected-title">{protectedHeading()}</div>
            <div data-slot="permission-protected-scope">{protectedScope()}</div>
          </div>
        </Show>
        <Show when={cmdDescription()}>{(desc) => <div data-slot="permission-hint">{desc()}</div>}</Show>
        <Show when={command()}>{(cmd) => <PermissionCommand command={cmd()} />}</Show>

        {(() => {
          const desc = description()
          if (!desc)
            return !command() && toolDescription() ? <div data-slot="permission-hint">{toolDescription()}</div> : null
          if (desc.kind === "single")
            return (
              <div
                data-slot="permission-hint"
                data-wrap={external() ? "" : undefined}
                title={external() ? desc.text : undefined}
              >
                {desc.text}
              </div>
            )
          return (
            <div data-slot="permission-patterns">
              <span data-slot="permission-patterns-title">{desc.title}</span>
              <For each={desc.paths}>{(path) => <code data-slot="permission-pattern">{path}</code>}</For>
            </div>
          )
        })()}

        <Show when={diffs().length > 0}>
          <div data-slot="permission-diffs" data-count={diffs().length}>
            <For each={diffs()}>{(diff) => <PermissionDiff filediff={diff} />}</For>
          </div>
        </Show>

        <Show when={provenance()}>
          {(info) => (
            <div data-slot="permission-provenance-section">
              <button
                type="button"
                data-slot="permission-provenance-header"
                data-open={whyOpen() ? "" : undefined}
                onClick={() => setWhyOpen(!whyOpen())}
                aria-expanded={whyOpen()}
              >
                <span data-slot="permission-provenance-header-chevron" data-open={whyOpen() ? "" : undefined}>
                  <Icon name="chevron-down" size="small" />
                </span>
                <span data-slot="permission-provenance-header-title">
                  {language.t("ui.permission.provenance.why")}
                </span>
              </button>

              <div
                data-slot="permission-provenance-collapse"
                data-open={whyOpen() ? "" : undefined}
                aria-hidden={!whyOpen()}>
                <div data-slot="permission-provenance-collapse-inner">
                  <div data-slot="permission-provenance-reason">{language.t(REASON_KEYS[info().result])}</div>
                  <div data-slot="permission-provenance-layers-title">
                    {language.t("ui.permission.provenance.layers")}
                  </div>
                  <div data-slot="permission-provenance-layers">
                    <For each={info().layers}>
                      {(layer) => (
                        <div data-slot="permission-provenance-layer">
                          <span data-slot="permission-provenance-layer-source">
                            {language.t(SOURCE_LABEL_KEYS[layer.source])}
                          </span>
                          <span data-slot="permission-provenance-layer-decision">
                            {language.t(DECISION_LABEL_KEYS[layer.decision])}
                          </span>
                        </div>
                      )}
                    </For>
                  </div>
                  <Show when={info().ceiling}>
                    {(top) => (
                      <div data-slot="permission-provenance-ceiling">{language.t(CEILING_KEYS[top()])}</div>
                    )}
                  </Show>
                </div>
              </div>
            </div>
          )}
        </Show>

        <div data-slot="permission-actions">
          <Button
            variant="primary"
            size="small"
            onClick={() => {
              const { approved, denied } = collectRules()
              props.onDecide("once", approved, denied)
            }}
            disabled={props.responding}
          >
            {language.t("ui.permission.allowOnce")}
          </Button>
          <Button
            variant="ghost"
            size="small"
            onClick={() => {
              const { approved, denied } = collectRules()
              props.onDecide("reject", approved, denied)
            }}
            disabled={props.responding}
          >
            {language.t("ui.permission.deny")}
          </Button>
        </div>
      </DockPrompt>
    </div>
  )
}
