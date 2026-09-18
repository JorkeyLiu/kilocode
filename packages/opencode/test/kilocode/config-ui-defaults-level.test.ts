import { describe, expect, test } from "bun:test"
import { projectUiDefaults, validateUiDefaultsData } from "../../src/kilocode/config-ui-defaults"
import {
  AUTONOMOUS_PERMISSION_PRESET,
  REVIEW_PERMISSION_PRESET,
} from "@opencode-ai/core/kilocode/permission-presets"

describe("config/ui-defaults permissionLevel projection", () => {
  test("projects review/autonomous levels verbatim with preset classification", () => {
    const review = projectUiDefaults({ permission_level: "review", permission: REVIEW_PERMISSION_PRESET })
    expect(review.workStyle.permissionLevel).toBe("review")
    expect(review.workStyle.permissionPreset).toBe("review")
    const auto = projectUiDefaults({ permission_level: "autonomous", permission: AUTONOMOUS_PERMISSION_PRESET })
    expect(auto.workStyle.permissionLevel).toBe("autonomous")
    expect(auto.workStyle.permissionPreset).toBe("autonomous")
    expect(projectUiDefaults({}).workStyle.permissionPreset).toBe("absent")
  })

  test("stale level with drifted permission classifies custom", () => {
    const out = projectUiDefaults({ permission_level: "review", permission: { "*": "ask", edit: "allow" } })
    expect(out.workStyle.permissionLevel).toBe("review")
    expect(out.workStyle.permissionPreset).toBe("custom")
    expect(out.workStyle.hasPermission).toBe(true)
  })

  test("rejects arbitrary permission_level values without leaking rules", () => {
    expect(() => projectUiDefaults({ permission_level: "custom" })).toThrow()
    expect(() => projectUiDefaults({ permission_level: { "*": "allow" } })).toThrow()
    const out = projectUiDefaults({ permission: { "*": "ask" }, permission_level: "review" })
    expect(out.workStyle.hasPermission).toBe(true)
    expect(out.workStyle.permissionLevel).toBe("review")
    expect(JSON.stringify(out)).not.toContain("ask")
  })

  test("validates the permissionPreset wire shape", () => {
    const good = {
      workStyle: { hasPermission: true, permissionLevel: "autonomous", permissionPreset: "autonomous" },
      sandbox: { enabled: false },
    }
    expect(validateUiDefaultsData(good).workStyle.permissionPreset).toBe("autonomous")
    expect(() =>
      validateUiDefaultsData({
        workStyle: { hasPermission: false, permissionLevel: "custom", permissionPreset: "absent" },
        sandbox: { enabled: false },
      }),
    ).toThrow()
    expect(() =>
      validateUiDefaultsData({
        workStyle: { hasPermission: false, permissionPreset: "everything" },
        sandbox: { enabled: false },
      }),
    ).toThrow()
    expect(() =>
      validateUiDefaultsData({ workStyle: { hasPermission: false }, sandbox: { enabled: false } }),
    ).toThrow()
    expect(() =>
      validateUiDefaultsData({
        workStyle: { hasPermission: false, permission: { "*": "ask" }, permissionPreset: "absent" },
        sandbox: { enabled: false },
      }),
    ).toThrow()
  })
})
