import { describe, expect, test } from "bun:test"
import {
  AUTONOMOUS_PERMISSION_PRESET,
  REVIEW_PERMISSION_PRESET,
  classifyPermissionPreset,
  permissionMatchesPreset,
  presetForLevel,
} from "../../src/kilocode/permission-presets"

describe("permission-presets single source", () => {
  test("scalar vs wildcard presets match semantically without order sensitivity", () => {
    expect(permissionMatchesPreset("ask", { "*": "ask" })).toBe(true)
    expect(permissionMatchesPreset({ "*": "ask" }, "ask" as never)).toBe(true)
    expect(permissionMatchesPreset({ b: "ask", a: "allow" }, { a: "allow", b: "ask" })).toBe(true)
    expect(permissionMatchesPreset({ "*": "allow" }, { "*": "ask" })).toBe(false)
    expect(permissionMatchesPreset(REVIEW_PERMISSION_PRESET, REVIEW_PERMISSION_PRESET)).toBe(true)
    expect(permissionMatchesPreset(AUTONOMOUS_PERMISSION_PRESET, AUTONOMOUS_PERMISSION_PRESET)).toBe(true)
    expect(permissionMatchesPreset({ "*": "ask", edit: "allow" }, REVIEW_PERMISSION_PRESET)).toBe(false)
  })

  test("owned presets resolve by level", () => {
    expect(presetForLevel("review")).toBe(REVIEW_PERMISSION_PRESET)
    expect(presetForLevel("autonomous")).toBe(AUTONOMOUS_PERMISSION_PRESET)
  })

  test("classification requires level plus owned-preset match", () => {
    expect(classifyPermissionPreset({ permissionLevel: "review", permission: REVIEW_PERMISSION_PRESET })).toBe("review")
    expect(classifyPermissionPreset({ permissionLevel: "autonomous", permission: AUTONOMOUS_PERMISSION_PRESET })).toBe(
      "autonomous",
    )
    // Stale level with hand-drifted permission reads custom, never the level.
    expect(classifyPermissionPreset({ permissionLevel: "review", permission: { "*": "allow" } })).toBe("custom")
    expect(classifyPermissionPreset({ permissionLevel: "autonomous", permission: { "*": "ask" } })).toBe("custom")
    expect(classifyPermissionPreset({ permissionLevel: "review", permission: undefined })).toBe("custom")
  })

  test("absent level maps permission presence to custom/absent", () => {
    expect(classifyPermissionPreset({ permission: { "*": "ask" } })).toBe("custom")
    expect(classifyPermissionPreset({ permission: {} })).toBe("absent")
    expect(classifyPermissionPreset({})).toBe("absent")
    expect(classifyPermissionPreset({ permissionLevel: "custom", permission: { "*": "ask" } })).toBe("custom")
  })
})
