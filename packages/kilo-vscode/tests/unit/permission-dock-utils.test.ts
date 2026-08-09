import { describe, it, expect } from "bun:test"
import {
  isConfigProtected,
  protectedAgentName,
  protectedRequestPaths,
  savedRuleStates,
} from "../../webview-ui/src/components/chat/permission-dock-utils"

describe("savedRuleStates", () => {
  it("returns empty map when rule is undefined", () => {
    expect(savedRuleStates(["npm *", "git *"], undefined)).toEqual({})
  })

  it("returns empty map when rules array is empty", () => {
    expect(savedRuleStates([], { "npm *": "allow" })).toEqual({})
  })

  it("populates approved entries from config", () => {
    const result = savedRuleStates(["npm *", "git *", "rm *"], { "npm *": "allow", "rm *": "allow" })
    expect(result).toEqual({ 0: "approved", 2: "approved" })
  })

  it("populates denied entries from config", () => {
    const result = savedRuleStates(["npm *", "rm *"], { "rm *": "deny" })
    expect(result).toEqual({ 1: "denied" })
  })

  it("populates mixed approved and denied", () => {
    const result = savedRuleStates(["npm *", "git *", "rm *"], {
      "npm *": "allow",
      "git *": "deny",
    })
    expect(result).toEqual({ 0: "approved", 1: "denied" })
  })

  it("skips ask entries (they stay pending)", () => {
    const result = savedRuleStates(["npm *", "git *"], { "npm *": "ask", "git *": "allow" })
    expect(result).toEqual({ 1: "approved" })
  })

  it("handles scalar rule with wildcard in rules array", () => {
    const result = savedRuleStates(["*"], "allow")
    expect(result).toEqual({ 0: "approved" })
  })

  it("handles scalar rule with non-wildcard patterns (all pending)", () => {
    const result = savedRuleStates(["npm *", "git *"], "allow")
    expect(result).toEqual({})
  })

  it("returns empty map for scalar ask with wildcard", () => {
    const result = savedRuleStates(["*"], "ask")
    expect(result).toEqual({})
  })

  it("returns denied for scalar deny with wildcard", () => {
    const result = savedRuleStates(["*"], "deny")
    expect(result).toEqual({ 0: "denied" })
  })

  it("returns pending for patterns not in config object", () => {
    const result = savedRuleStates(["npm *", "git *"], { "npm *": "allow" })
    expect(result).toEqual({ 0: "approved" })
  })

  it("returns empty map for empty config object", () => {
    const result = savedRuleStates(["npm *"], {})
    expect(result).toEqual({})
  })
})

describe("isConfigProtected", () => {
  it("is false when args are undefined", () => {
    expect(isConfigProtected(undefined)).toBe(false)
  })

  it("is false when args are empty", () => {
    expect(isConfigProtected({})).toBe(false)
  })

  it("is false when configProtected is absent", () => {
    expect(isConfigProtected({ filepath: ".kilo/kilo.json" })).toBe(false)
  })

  it("is false when configProtected is a non-boolean value", () => {
    expect(isConfigProtected({ configProtected: "yes" })).toBe(false)
  })

  it("is true when configProtected is true", () => {
    expect(isConfigProtected({ configProtected: true })).toBe(true)
  })
})

describe("protectedAgentName", () => {
  it("is undefined when args are undefined", () => {
    expect(protectedAgentName(undefined)).toBeUndefined()
  })

  it("is undefined when protectedAgent is absent", () => {
    expect(protectedAgentName({ configProtected: true })).toBeUndefined()
  })

  it("is undefined when protectedAgent is empty", () => {
    expect(protectedAgentName({ protectedAgent: "" })).toBeUndefined()
  })

  it("is undefined when protectedAgent is not a string", () => {
    expect(protectedAgentName({ protectedAgent: 42 })).toBeUndefined()
  })

  it("returns the agent name", () => {
    expect(protectedAgentName({ protectedAgent: "coder" })).toBe("coder")
  })
})

describe("protectedRequestPaths", () => {
  it("returns protected request patterns, skipping bare wildcards", () => {
    const result = protectedRequestPaths({ patterns: [".kilo/kilo.json", "*"], args: {} })
    expect(result).toEqual([".kilo/kilo.json"])
  })

  it("uses metadata filepath when patterns are only wildcards", () => {
    const result = protectedRequestPaths({
      patterns: ["*"],
      args: { filepath: ".kilo/kilo.json" },
    })
    expect(result).toEqual([".kilo/kilo.json"])
  })

  it("splits comma-joined filepath into separate paths", () => {
    const result = protectedRequestPaths({
      patterns: [],
      args: { filepath: ".kilo/a.json, .kilo/b.json" },
    })
    expect(result).toEqual([".kilo/a.json", ".kilo/b.json"])
  })

  it("collects filePath and movePath from files metadata", () => {
    const result = protectedRequestPaths({
      patterns: [],
      args: {
        files: [
          { filePath: ".kilo/agents/a.md" },
          { filePath: ".kilo/agents/b.md", movePath: ".kilo/agents/c.md" },
          { filePath: "src/plain.ts" },
        ],
      },
    })
    expect(result).toEqual([".kilo/agents/a.md", ".kilo/agents/b.md", ".kilo/agents/c.md"])
  })

  it("unions patterns with metadata paths", () => {
    const result = protectedRequestPaths({
      patterns: [".kilo/a.json"],
      args: { filepath: ".kilo/b.json" },
    })
    expect(result).toEqual([".kilo/a.json", ".kilo/b.json"])
  })

  it("filters out unprotected patterns and glob syntax", () => {
    const result = protectedRequestPaths({
      patterns: ["src/app.ts", ".kilo/kilo.json", "~/.config/kilo/*", "AGENTS.md"],
      args: { filepath: "/Users/dev/.config/kilo/kilo.json" },
    })
    expect(result).toEqual([".kilo/kilo.json", "AGENTS.md"])
  })

  it("skips paths under the excluded plans directory", () => {
    const result = protectedRequestPaths({
      patterns: [".kilo/plans/plan.md", ".kilocode/plans/plan.md"],
      args: {},
    })
    expect(result).toEqual([])
  })

  it("recognizes nested and bare config dir forms", () => {
    const result = protectedRequestPaths({
      patterns: ["packages/sub/.kilo/kilo.json", ".kilocode", "src/lib/.kilo"],
      args: {},
    })
    expect(result).toEqual(["packages/sub/.kilo/kilo.json", ".kilocode", "src/lib/.kilo"])
  })

  it("never shows unverifiable absolute paths without backend metadata", () => {
    const result = protectedRequestPaths({
      patterns: ["*"],
      args: { filepath: "/Users/dev/app/.kilo/kilo.json" },
    })
    expect(result).toEqual([])
  })

  it("uses the backend-provided canonical path list verbatim when present", () => {
    const result = protectedRequestPaths({
      patterns: ["src/app.ts", "*"],
      args: {
        protectedPaths: ["/Users/dev/.config/kilo/kilo.json", "/Users/dev/.config/kilo/kilo.json"],
      },
    })
    expect(result).toEqual(["/Users/dev/.config/kilo/kilo.json"])
  })

  it("honors an empty backend list for glob-only protected requests", () => {
    const result = protectedRequestPaths({
      patterns: ["~/.config/kilo/*"],
      args: { protectedPaths: [] },
    })
    expect(result).toEqual([])
  })

  it("ignores non-string entries in the backend list", () => {
    const result = protectedRequestPaths({
      patterns: [],
      args: { protectedPaths: [42, ".kilo/kilo.json", null] },
    })
    expect(result).toEqual([".kilo/kilo.json"])
  })

  it("dedupes repeated paths", () => {
    const result = protectedRequestPaths({
      patterns: ["src/a.ts", ".kilo/kilo.json", ".kilo/kilo.json"],
      args: {},
    })
    expect(result).toEqual([".kilo/kilo.json"])
  })

  it("returns an empty array when there are no protected exact paths", () => {
    expect(protectedRequestPaths({ patterns: ["*"], args: {} })).toEqual([])
    expect(protectedRequestPaths({ patterns: [], args: {} })).toEqual([])
  })
})
