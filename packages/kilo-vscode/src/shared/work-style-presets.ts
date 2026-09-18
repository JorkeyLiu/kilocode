import {
  AUTONOMOUS_PERMISSION_PRESET,
  REVIEW_PERMISSION_PRESET,
  type PermissionMainLevel,
} from "@opencode-ai/core/kilocode/permission-presets"

export type { PermissionMainLevel }

type PermissionLevel = "allow" | "ask" | "deny"
type PermissionRule = PermissionLevel | null | Record<string, PermissionLevel | null>
type PermissionConfig = Partial<Record<string, PermissionRule>>

export interface WorkStyleConfig {
  permission?: PermissionConfig
  permission_level?: "review" | "autonomous"
  terminal_command_display?: "expanded" | "collapsed"
  auto_collapse_reasoning?: boolean
}

export type WorkStyle = "human-in-the-loop" | "autonomous"
export type WorkStyleState = WorkStyle | "skipped" | "unset"

/** Main surface state including the derived Custom state (never persisted). */
export type PermissionMainState = PermissionMainLevel | "custom"

export interface WorkStyleSettings {
  showTaskTimeline: boolean
}

export interface WorkStylePreset {
  style: WorkStyle
  level: PermissionMainLevel
  config: WorkStyleConfig
  settings: WorkStyleSettings
}

export interface WorkStyleApplyPlan {
  config: WorkStyleConfig
  settings: Partial<WorkStyleSettings>
}

function asPermissionConfig(preset: Record<string, unknown>): PermissionConfig {
  return preset as PermissionConfig
}

export const WORK_STYLE_CHOICES: WorkStyle[] = ["human-in-the-loop", "autonomous"]

export function levelForStyle(style: WorkStyle): PermissionMainLevel {
  return style === "human-in-the-loop" ? "review" : "autonomous"
}

export function styleForLevel(level: PermissionMainLevel): WorkStyle {
  return level === "review" ? "human-in-the-loop" : "autonomous"
}

export const WORK_STYLE_PRESETS: Record<WorkStyle, WorkStylePreset> = {
  "human-in-the-loop": {
    style: "human-in-the-loop",
    level: "review",
    config: {
      permission_level: "review",
      terminal_command_display: "expanded",
      auto_collapse_reasoning: false,
      permission: asPermissionConfig(REVIEW_PERMISSION_PRESET),
    },
    settings: {
      showTaskTimeline: true,
    },
  },
  autonomous: {
    style: "autonomous",
    level: "autonomous",
    config: {
      permission_level: "autonomous",
      terminal_command_display: "collapsed",
      auto_collapse_reasoning: true,
      permission: asPermissionConfig(AUTONOMOUS_PERMISSION_PRESET),
    },
    settings: {
      showTaskTimeline: false,
    },
  },
}

export function getWorkStylePreset(style: WorkStyle): WorkStylePreset {
  return WORK_STYLE_PRESETS[style]
}

export function getPresetForLevel(level: PermissionMainLevel): WorkStylePreset {
  return WORK_STYLE_PRESETS[styleForLevel(level)]
}

export function getInitialWorkStyle(hasSessions: boolean): WorkStyleState {
  return hasSessions ? "skipped" : "unset"
}

export function hasPermissionConfig(config: WorkStyleConfig): boolean {
  return Object.keys(config.permission ?? {}).length > 0
}

function stripPermission(config: PermissionConfig): PermissionConfig {
  const result: PermissionConfig = {}
  for (const [key, rule] of Object.entries(config)) {
    if (rule === null || rule === undefined) continue
    if (typeof rule === "string") {
      result[key] = rule
      continue
    }
    const next: Record<string, PermissionLevel | null> = {}
    for (const [pattern, action] of Object.entries(rule)) {
      if (action !== null && action !== undefined) next[pattern] = action
    }
    if (Object.keys(next).length > 0) result[key] = next as PermissionRule
  }
  return result
}

/**
 * Derive the main surface state from the backend `permissionPreset`
 * classification (global-only, rule content never crosses). Without a
 * classification, the legacy setting maps to its level for display only and
 * is written as canonical only on explicit apply — no implicit destructive
 * migration.
 */
export function resolveMainState(input: {
  preset?: unknown
  legacyStyle?: WorkStyleState
}): PermissionMainState | "unset" | "skipped" {
  const preset = input.preset
  if (preset === "review" || preset === "autonomous" || preset === "custom") return preset
  const legacy = input.legacyStyle
  if (legacy === "human-in-the-loop") return "review"
  if (legacy === "autonomous") return "autonomous"
  if (legacy === "skipped") return "skipped"
  return "unset"
}

/**
 * Level-switch gate for unsaved Advanced drafts. Switching levels writes the
 * preset-owned global permission plus level server-side; a pending permission
 * draft would be silently orphaned (and a later save would clobber the
 * switch), so a dirty draft blocks the switch until the user saves or
 * discards. Returns `blocked: true` exactly when `dirty` is true.
 */
export function levelSwitchGate(dirty: boolean): { blocked: boolean } {
  return { blocked: dirty }
}

export function buildWorkStyleApplyPlan(input: {
  style: WorkStyle
  config: WorkStyleConfig
  settingDefault?: (key: keyof WorkStyleSettings) => boolean
}): WorkStyleApplyPlan {
  const preset = getWorkStylePreset(input.style)
  const next: WorkStyleConfig = {}

  if (preset.config.permission && !hasPermissionConfig(input.config)) {
    next.permission = stripPermission(preset.config.permission)
  }
  if (preset.config.permission_level !== undefined) {
    next.permission_level = preset.config.permission_level
  }
  if (input.config.terminal_command_display === undefined) {
    next.terminal_command_display = preset.config.terminal_command_display
  }
  if (input.config.auto_collapse_reasoning === undefined) {
    next.auto_collapse_reasoning = preset.config.auto_collapse_reasoning
  }

  const settingDefault = input.settingDefault ?? (() => true)
  return {
    config: next,
    settings: {
      ...(settingDefault("showTaskTimeline") ? { showTaskTimeline: preset.settings.showTaskTimeline } : {}),
    },
  }
}

/**
 * Atomic switch plan for Review/Autonomous: always overwrites the canonical
 * global preset-owned permission plus the level field. Project, agent, and
 * session restrictions are never touched here.
 */
export function buildLevelApplyPlan(level: PermissionMainLevel): WorkStyleConfig {
  const preset = getPresetForLevel(level)
  return {
    permission: stripPermission(preset.config.permission ?? {}),
    permission_level: preset.config.permission_level,
    terminal_command_display: preset.config.terminal_command_display,
    auto_collapse_reasoning: preset.config.auto_collapse_reasoning,
  }
}
