/** @jsxImportSource solid-js */
import type { Component } from "solid-js"
import { Button } from "@kilocode/kilo-ui/button"
import { Icon } from "@kilocode/kilo-ui/icon"
import { Tooltip } from "@kilocode/kilo-ui/tooltip"
import { useWorkStyle } from "../../context/work-style"
import { useVSCode } from "../../context/vscode"
import { useLanguage } from "../../context/language"

/**
 * PermissionLevelChip — icon-only permission-level entry for the chat
 * composer `hint-actions` row, next to the sandbox lock.
 *
 * Shield icon (never `lock`, never selector text) keeps permission identity
 * distinct from the sandbox control and from Agent/Model/Thinking selectors.
 * Shows the current main permission level (Review/Autonomous/Custom/Not set)
 * from the canonical `useWorkStyle()` state via aria/title/tooltip.
 * `skipped`/loading/`unset` render as Not set so the entry never disappears
 * or layout-shifts. It is navigation only: click/keyboard activation posts
 * exactly `{type:"openSettingsPanel", tab:"autoApprove"}` to open the
 * canonical settings surface and never mutates config.
 */
export const PermissionLevelChip: Component = () => {
  const work = useWorkStyle()
  const vscode = useVSCode()
  const language = useLanguage()

  const level = () => {
    const current = work.level()
    if (current === "review" || current === "autonomous" || current === "custom") return current
    return "unset"
  }
  const name = () => language.t(`workStyle.level.${level()}`)
  const label = () => language.t("permissionLevelChip.aria", { level: name() })
  const open = () => vscode.postMessage({ type: "openSettingsPanel", tab: "autoApprove" })

  return (
    <Tooltip value={label()} placement="top">
      <Button
        variant="ghost"
        size="small"
        onClick={open}
        aria-label={label()}
        data-testid="permission-level-chip"
        title={label()}
        class="prompt-status-button"
      >
        <Icon name="shield" size="small" />
      </Button>
    </Tooltip>
  )
}
