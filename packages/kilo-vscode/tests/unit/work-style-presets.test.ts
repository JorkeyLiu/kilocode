import { describe, expect, it } from "bun:test"
import {
  AUTONOMOUS_PERMISSION_PRESET,
  REVIEW_PERMISSION_PRESET,
} from "@opencode-ai/core/kilocode/permission-presets"
import {
  buildLevelApplyPlan,
  buildWorkStyleApplyPlan,
  getInitialWorkStyle,
  levelSwitchGate,
  resolveMainState,
  WORK_STYLE_PRESETS,
} from "../../src/shared/work-style-presets"

describe("work style presets", () => {
  it("shows onboarding for users without sessions", () => {
    expect(getInitialWorkStyle(false)).toBe("unset")
  })

  it("skips onboarding for users with existing sessions", () => {
    expect(getInitialWorkStyle(true)).toBe("skipped")
  })

  it("writes presets from the shared core single source", () => {
    expect(WORK_STYLE_PRESETS["human-in-the-loop"].config.permission).toEqual(REVIEW_PERMISSION_PRESET)
    expect(WORK_STYLE_PRESETS["human-in-the-loop"].config.permission_level).toBe("review")
    expect(WORK_STYLE_PRESETS["human-in-the-loop"].config.terminal_command_display).toBe("expanded")
    expect(WORK_STYLE_PRESETS["human-in-the-loop"].config.auto_collapse_reasoning).toBe(false)
    expect(WORK_STYLE_PRESETS["human-in-the-loop"].settings).toEqual({ showTaskTimeline: true })
    expect(WORK_STYLE_PRESETS.autonomous.config.permission).toEqual(AUTONOMOUS_PERMISSION_PRESET)
    expect(WORK_STYLE_PRESETS.autonomous.config.permission_level).toBe("autonomous")
    expect(WORK_STYLE_PRESETS.autonomous.config.terminal_command_display).toBe("collapsed")
    expect(WORK_STYLE_PRESETS.autonomous.config.auto_collapse_reasoning).toBe(true)
    expect(WORK_STYLE_PRESETS.autonomous.settings).toEqual({ showTaskTimeline: false })
  })

  it("derives the main state from the backend classification, never rule matching", () => {
    expect(resolveMainState({ preset: "review" })).toBe("review")
    expect(resolveMainState({ preset: "autonomous" })).toBe("autonomous")
    expect(resolveMainState({ preset: "custom" })).toBe("custom")
    // Absent classification falls back to the legacy setting for display
    // only; canonical is written solely on explicit apply.
    expect(resolveMainState({ preset: "absent", legacyStyle: "human-in-the-loop" })).toBe("review")
    expect(resolveMainState({ preset: "absent", legacyStyle: "autonomous" })).toBe("autonomous")
    expect(resolveMainState({ preset: "absent", legacyStyle: "skipped" })).toBe("skipped")
    expect(resolveMainState({ preset: "absent", legacyStyle: "unset" })).toBe("unset")
    expect(resolveMainState({})).toBe("unset")
  })

  it("does not overwrite existing new-user settings except the canonical level", () => {
    const plan = buildWorkStyleApplyPlan({
      style: "human-in-the-loop",
      config: { permission: { edit: "allow" }, terminal_command_display: "collapsed", auto_collapse_reasoning: true },
      settingDefault: () => false,
    })
    expect(plan).toEqual({ config: { permission_level: "review" }, settings: {} })
  })

  it("builds an atomic level switch plan that always overwrites preset-owned permission", () => {
    const plan = buildLevelApplyPlan("autonomous")
    expect(plan.permission_level).toBe("autonomous")
    expect(plan.permission).toEqual(AUTONOMOUS_PERMISSION_PRESET)
  })

  it("blocks level switches while an Advanced draft is dirty", () => {
    expect(levelSwitchGate(true)).toEqual({ blocked: true })
    expect(levelSwitchGate(false)).toEqual({ blocked: false })
  })
})
