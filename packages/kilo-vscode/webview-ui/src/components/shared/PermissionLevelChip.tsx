/** @jsxImportSource solid-js */
import type { Component } from "solid-js"
import { Button } from "@kilocode/kilo-ui/button"
import { Tooltip } from "@kilocode/kilo-ui/tooltip"
import { useWorkStyle } from "../../context/work-style"
import { useVSCode } from "../../context/vscode"
import { useLanguage } from "../../context/language"

/**
 * PermissionLevelChip — compact read-only permission-level indicator for every
 * Agent Manager chat composer selector row.
 *
 * Shows the current main permission level (Review/Autonomous/Custom/Not set)
 * from the canonical `useWorkStyle()` state. `skipped`/loading/`unset` render
 * as Not set so the chip never disappears or layout-shifts. It is navigation
 * only: click/keyboard activation posts exactly
 * `{type:"openSettingsPanel", tab:"autoApprove"}` to open the canonical
 * settings surface and never mutates config.
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
  const text = () => language.t(`workStyle.level.${level()}`)
  const open = () => vscode.postMessage({ type: "openSettingsPanel", tab: "autoApprove" })

  return (
    <Tooltip value={language.t("permissionLevelChip.tooltip")} placement="top">
      <Button
        variant="ghost"
        size="small"
        onClick={open}
        aria-label={language.t("permissionLevelChip.aria", { level: text() })}
        data-testid="permission-level-chip"
      >
        {text()}
      </Button>
    </Tooltip>
  )
}
