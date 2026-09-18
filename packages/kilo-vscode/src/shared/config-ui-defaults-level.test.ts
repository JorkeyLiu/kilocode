import { describe, expect, it } from "bun:test"
import { validateUiDefaultsData } from "../../src/services/cli-backend/serve-private-config-ui-defaults-contract"
import { projectUiDefaultsFromSdk, toWorkStyleConfig } from "../../src/shared/config-ui-defaults-privatefirst"

describe("config/ui-defaults permissionLevel", () => {
  it("accepts review/autonomous and rejects anything else", () => {
    expect(
      validateUiDefaultsData({
        workStyle: { hasPermission: true, permissionLevel: "review", permissionPreset: "review" },
        sandbox: { enabled: false },
      }).workStyle.permissionLevel,
    ).toBe("review")
    expect(
      validateUiDefaultsData({
        workStyle: { hasPermission: false, permissionLevel: "autonomous", permissionPreset: "autonomous" },
        sandbox: { enabled: false },
      }).workStyle.permissionLevel,
    ).toBe("autonomous")
    expect(() =>
      validateUiDefaultsData({
        workStyle: { hasPermission: false, permissionLevel: "custom", permissionPreset: "absent" },
        sandbox: { enabled: false },
      }),
    ).toThrow()
    expect(() =>
      validateUiDefaultsData({
        workStyle: { hasPermission: false, permission: {}, permissionPreset: "absent" },
        sandbox: { enabled: false },
      }),
    ).toThrow()
  })

  it("projects SDK permission_level verbatim and classifies the preset", () => {
    expect(projectUiDefaultsFromSdk({ permission_level: "review" })?.workStyle.permissionLevel).toBe("review")
    expect(projectUiDefaultsFromSdk({ permission_level: "autonomous" })?.workStyle.permissionLevel).toBe("autonomous")
    expect(projectUiDefaultsFromSdk({})?.workStyle.permissionLevel).toBeUndefined()
    expect(projectUiDefaultsFromSdk({})?.workStyle.permissionPreset).toBe("absent")
    expect(
      projectUiDefaultsFromSdk({ permission: { "*": "ask" } })?.workStyle.permissionPreset,
    ).toBe("custom")
    expect(projectUiDefaultsFromSdk({ permission_level: "custom" })).toBeNull()
  })

  it("carries the canonical level into the work-style config without rule content", () => {
    const cfg = toWorkStyleConfig({
      workStyle: { hasPermission: true, permissionPreset: "autonomous" },
      sandbox: { enabled: false },
    })
    expect(cfg.permission_level).toBeUndefined()
    expect(cfg.permission).toEqual({ "*": "ask" })
  })
})
