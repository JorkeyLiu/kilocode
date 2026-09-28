import { describe, expect, it } from "bun:test"
import {
  KNOWN_AGENT_TOOLS,
  isToolEnabled,
  listAgentTools,
  normalizeToolName,
  toggleAgentTool,
} from "../../webview-ui/src/components/settings/agent-tools"

describe("normalizeToolName", () => {
  it("accepts plugin/MCP style names", () => {
    expect(normalizeToolName("my-mcp-tool")).toBe("my-mcp-tool")
    expect(normalizeToolName("  bash  ")).toBe("bash")
  })

  it("rejects empty, unsafe, or malformed names", () => {
    expect(normalizeToolName("")).toBeNull()
    expect(normalizeToolName("has space")).toBeNull()
    expect(normalizeToolName("__proto__")).toBeNull()
    expect(normalizeToolName("constructor")).toBeNull()
  })
})

describe("isToolEnabled", () => {
  it("treats missing tools as enabled", () => {
    expect(isToolEnabled(undefined, "bash")).toBe(true)
  })

  it("treats false as disabled and preserves true", () => {
    expect(isToolEnabled({ bash: false }, "bash")).toBe(false)
    expect(isToolEnabled({ bash: true }, "bash")).toBe(true)
  })

  it("folds patch alias into apply_patch", () => {
    expect(isToolEnabled({ patch: false }, "apply_patch")).toBe(false)
    expect(isToolEnabled({ patch: false }, "edit")).toBe(false)
    expect(isToolEnabled({ patch: false }, "write")).toBe(false)
    expect(isToolEnabled({ patch: false }, "bash")).toBe(true)
  })

  it("keeps build and code as independent custom tool ids", () => {
    expect(isToolEnabled({ build: false }, "build")).toBe(false)
    expect(isToolEnabled({ build: false }, "code")).toBe(true)
    expect(isToolEnabled({ code: false }, "code")).toBe(false)
    expect(isToolEnabled({ code: false }, "build")).toBe(true)
    expect(isToolEnabled({ "*": false, build: true }, "build")).toBe(true)
    expect(isToolEnabled({ "*": false, build: true }, "code")).toBe(false)
  })

  it("treats edit/write/apply_patch as one execution group", () => {
    expect(isToolEnabled({ write: false }, "edit")).toBe(false)
    expect(isToolEnabled({ write: false }, "write")).toBe(false)
    expect(isToolEnabled({ write: false }, "apply_patch")).toBe(false)
    expect(isToolEnabled({ write: false }, "bash")).toBe(true)
  })

  it("keeps same-authored specific enable priority", () => {
    expect(isToolEnabled({ write: false, edit: true }, "edit")).toBe(true)
    expect(isToolEnabled({ write: false, edit: true }, "write")).toBe(true)
    expect(isToolEnabled({ write: false, edit: true }, "apply_patch")).toBe(true)
    expect(isToolEnabled({ "*": false, bash: true }, "bash")).toBe(true)
    expect(isToolEnabled({ "*": false, bash: true }, "read")).toBe(false)
  })

  it("honours wildcard disable with specific punch-through", () => {
    expect(isToolEnabled({ "*": false }, "bash")).toBe(false)
    expect(isToolEnabled({ "*": false }, "*")).toBe(false)
    expect(isToolEnabled({ "*": false, bash: true }, "bash")).toBe(true)
    expect(isToolEnabled({ bash: false, "*": true }, "bash")).toBe(false)
  })
})

describe("listAgentTools", () => {
  it("includes bash/edit/write and appends custom names", () => {
    const list = listAgentTools({ bash: false, "my-mcp-tool": false })
    expect(list).toContain("bash")
    expect(list).toContain("edit")
    expect(list).toContain("write")
    expect(list).toContain("my-mcp-tool")
    expect(KNOWN_AGENT_TOOLS).toContain("bash")
  })

  it("does not duplicate known tools", () => {
    const list = listAgentTools({ bash: false })
    expect(list.filter((name) => name === "bash")).toHaveLength(1)
  })

  it("folds patch alias into apply_patch without a separate row", () => {
    const list = listAgentTools({ patch: false })
    expect(list).toContain("apply_patch")
    expect(list).not.toContain("patch")
  })

  it("lists build and code as independent rows without folding", () => {
    const buildOnly = listAgentTools({ build: false })
    expect(buildOnly).toContain("build")
    expect(buildOnly).not.toContain("code")
    const codeOnly = listAgentTools({ code: false })
    expect(codeOnly).toContain("code")
    expect(codeOnly).not.toContain("build")
    expect(listAgentTools({ build: false, code: false })).toEqual(
      expect.arrayContaining(["build", "code"]),
    )
  })

  it("surfaces existing wildcard as a recoverable row", () => {
    const list = listAgentTools({ "*": false, bash: false })
    expect(list[0]).toBe("*")
    expect(list).toContain("bash")
  })

  it("hides wildcard row when no wildcard is authored", () => {
    expect(listAgentTools({ bash: false })).not.toContain("*")
    expect(listAgentTools(undefined)).not.toContain("*")
  })
})

describe("toggleAgentTool", () => {
  it("disables with false and preserves other authored entries", () => {
    const next = toggleAgentTool({ edit: true, "my-mcp-tool": true }, "bash", false)
    expect(next).toEqual({ edit: true, "my-mcp-tool": true, bash: false })
  })

  it("restores by deleting the key without touching others", () => {
    const next = toggleAgentTool({ bash: false, edit: true }, "bash", true)
    expect(next).toEqual({ edit: true })
    expect(next).not.toHaveProperty("bash")
  })

  it("returns undefined when nothing remains so frontmatter can clear", () => {
    expect(toggleAgentTool({ bash: false }, "bash", true)).toBeUndefined()
    expect(toggleAgentTool(undefined, "bash", true)).toBeUndefined()
  })

  it("removes the patch alias when recovering apply_patch", () => {
    const next = toggleAgentTool({ patch: false, bash: false }, "apply_patch", true)
    expect(next).toEqual({ bash: false })
    expect(next).not.toHaveProperty("patch")
  })

  it("leaves build disabled when recovering code", () => {
    const next = toggleAgentTool({ build: false }, "code", true)
    expect(next).toEqual({ build: false })
  })

  it("clears the whole edit group disable with one recovery", () => {
    const next = toggleAgentTool({ write: false, bash: false }, "edit", true)
    expect(next).toEqual({ bash: false })
  })

  it("adds an explicit enable when recovering under a wildcard", () => {
    const next = toggleAgentTool({ "*": false }, "bash", true)
    expect(next).toEqual({ "*": false, bash: true })
  })

  it("removes only the wildcard entry when recovering it", () => {
    const next = toggleAgentTool({ "*": false, bash: false }, "*", true)
    expect(next).toEqual({ bash: false })
  })

  it("removes an explicit enable instead of adding false when disabling under a wildcard", () => {
    const next = toggleAgentTool({ "*": false, bash: true }, "bash", false)
    expect(next).toEqual({ "*": false })
    expect(next).not.toHaveProperty("bash")
  })

  it("preserves unrelated true and unknown keys", () => {
    const next = toggleAgentTool({ write: false, bash: true, "extra-plugin": true }, "edit", true)
    expect(next).toEqual({ bash: true, "extra-plugin": true })
  })
})
