import { describe, expect, test } from "bun:test"
import type { PermissionRequest } from "@kilocode/sdk/v2"
import {
  createPermissionBodyState,
  permissionAlwaysLines,
  permissionCancel,
  permissionEscape,
  permissionInfo,
  permissionReject,
  permissionRun,
} from "@/cli/cmd/run/permission.shared"
import { ConfigProtection } from "@/kilocode/permission/config-paths"

function req(input: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    id: "perm-1",
    sessionID: "session-1",
    permission: "read",
    patterns: [],
    metadata: {},
    always: [],
    ...input,
  }
}

describe("run permission shared", () => {
  test("replies immediately for allow once", () => {
    const out = permissionRun(createPermissionBodyState("perm-1"), "perm-1", "once")

    expect(out.reply).toEqual({
      requestID: "perm-1",
      reply: "once",
    })
  })

  test("requires confirmation for allow always", () => {
    const next = permissionRun(createPermissionBodyState("perm-1"), "perm-1", "always")
    expect(next.state.stage).toBe("always")
    expect(next.state.selected).toBe("confirm")
    expect(next.reply).toBeUndefined()

    expect(permissionRun(next.state, "perm-1", "confirm").reply).toEqual({
      requestID: "perm-1",
      reply: "always",
    })

    expect(permissionRun(next.state, "perm-1", "cancel").state).toMatchObject({
      stage: "permission",
      selected: "always",
    })
  })

  test("builds trimmed reject replies and stage transitions", () => {
    const next = permissionRun(createPermissionBodyState("perm-1"), "perm-1", "reject")
    expect(next.state.stage).toBe("reject")

    const out = permissionReject({ ...next.state, message: "  use rg  " }, "perm-1")
    expect(out).toEqual({
      requestID: "perm-1",
      reply: "reject",
      message: "use rg",
    })

    expect(permissionCancel(next.state)).toMatchObject({
      stage: "permission",
      selected: "reject",
    })

    expect(permissionEscape(createPermissionBodyState("perm-1"))).toMatchObject({
      stage: "reject",
      selected: "reject",
    })

    expect(permissionEscape({ ...next.state, stage: "always", selected: "confirm" })).toMatchObject({
      stage: "permission",
      selected: "always",
    })
  })

  test("maps supported permission types into display info", () => {
    expect(
      permissionInfo(
        req({
          permission: "bash",
          metadata: {
            input: {
              command: "git status --short",
            },
          },
        }),
      ),
    ).toMatchObject({
      title: "Shell command",
      lines: ["$ git status --short"],
    })

    expect(
      permissionInfo(
        req({
          permission: "task",
          metadata: {
            description: "investigate stream",
            subagent_type: "general",
          },
        }),
      ),
    ).toMatchObject({
      title: "General Task",
      lines: ["◉ investigate stream"],
    })

    expect(
      permissionInfo(
        req({
          permission: "external_directory",
          patterns: ["/tmp/work/**/*.ts", "/tmp/work/**/*.tsx"],
        }),
      ),
    ).toMatchObject({
      title: "Access external directory /tmp/work",
      lines: ["- /tmp/work/**/*.ts", "- /tmp/work/**/*.tsx"],
    })

    expect(permissionInfo(req({ permission: "doom_loop" }))).toMatchObject({
      title: "Continue after repeated failures",
    })

    expect(permissionInfo(req({ permission: "custom_tool" }))).toMatchObject({
      title: "Call tool custom_tool",
      lines: ["Tool: custom_tool"],
    })
  })

  test("formats always-allow copy for wildcard and explicit patterns", () => {
    expect(permissionAlwaysLines(req({ permission: "bash", always: ["*"] }))).toEqual([
      "This will allow bash until Kilo is restarted.",
    ])

    expect(permissionAlwaysLines(req({ always: ["src/**/*.ts", "src/**/*.tsx"] }))).toEqual([
      "This will allow the following patterns until Kilo is restarted.",
      "- src/**/*.ts",
      "- src/**/*.tsx",
    ])
  })

  test("formats protected always-allow copy with agent and exact path scope", () => {
    expect(
      permissionAlwaysLines(
        req({
          permission: "edit",
          patterns: ["AGENTS.md"],
          always: ["*"],
          metadata: {
            [ConfigProtection.CONFIG_PROTECTED_KEY]: true,
            [ConfigProtection.AGENT_KEY]: "code",
            filepath: "AGENTS.md",
          },
        }),
      ),
    ).toEqual([
      "Allow code to edit AGENTS.md without asking again. This approval is saved for code and this exact path only.",
    ])

    // glob/directory patterns are never persisted as exact approvals (LOCK-002)
    expect(
      permissionAlwaysLines(
        req({
          permission: "external_directory",
          patterns: ["/Users/x/.config/kilo/skills/**/*"],
          always: ["/Users/x/.config/kilo/skills/**/*"],
          metadata: {
            [ConfigProtection.CONFIG_PROTECTED_KEY]: true,
            [ConfigProtection.AGENT_KEY]: "code",
          },
        }),
      ),
    ).toEqual([
      "Allow code to access this request without asking again. Glob or directory patterns cannot be saved as exact path approvals.",
    ])
  })

  test("multi-path protected always approval names every persisted path", () => {
    expect(
      permissionAlwaysLines(
        req({
          permission: "edit",
          patterns: ["AGENTS.md", ".kilo/settings.json"],
          always: ["*"],
          metadata: {
            [ConfigProtection.CONFIG_PROTECTED_KEY]: true,
            [ConfigProtection.AGENT_KEY]: "code",
          },
        }),
      ),
    ).toEqual([
      "Allow code to edit the following protected paths without asking again. Each approval is saved for code and that exact path only.",
      "- AGENTS.md",
      "- .kilo/settings.json",
    ])

    // apply_patch shape: comma-joined metadata.filepath + files[] entries, deduped
    expect(
      permissionAlwaysLines(
        req({
          permission: "edit",
          patterns: ["AGENTS.md"],
          always: ["*"],
          metadata: {
            [ConfigProtection.CONFIG_PROTECTED_KEY]: true,
            [ConfigProtection.AGENT_KEY]: "code",
            filepath: "AGENTS.md, .kilo/commands/build.md",
            files: [{ movePath: ".kilocode/agents/planner.md" }],
          },
        }),
      ),
    ).toEqual([
      "Allow code to edit the following protected paths without asking again. Each approval is saved for code and that exact path only.",
      "- AGENTS.md",
      "- .kilo/commands/build.md",
      "- .kilocode/agents/planner.md",
    ])
  })
})
