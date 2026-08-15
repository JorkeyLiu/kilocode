/**
 * Executable coverage for the P3.1 reload directory routing contract
 * (src/reload-directory.ts): active editor-tab session directory, Agent
 * Manager active-session directory, surface preference, and the fallback.
 * The extension wires the real providers' session facts into this vscode-free
 * helper, so these tests exercise the exact directory rules the
 * `kilo-code.new.reload` command depends on.
 */

import { describe, expect, it } from "bun:test"
import { resolveReloadDirectory, type SessionDirectorySource } from "../../src/reload-directory"

const FALLBACK = "/workspace"

function surface(sessionID: string | undefined, dirs: Record<string, string> = {}): SessionDirectorySource {
  return { sessionID, sessionDirectories: new Map(Object.entries(dirs)) }
}

describe("resolveReloadDirectory — active editor tab", () => {
  it("uses the active tab's current session directory for a worktree session", () => {
    const tab = surface("s1", { s1: "/workspace/.kilo/wt-s1" })
    expect(resolveReloadDirectory({ tab, agentManager: undefined, fallback: FALLBACK })).toBe("/workspace/.kilo/wt-s1")
  })

  it("falls back when the active tab's session is in the root (unmapped)", () => {
    const tab = surface("s1")
    expect(resolveReloadDirectory({ tab, agentManager: undefined, fallback: FALLBACK })).toBe(FALLBACK)
  })

  it("prefers the active tab session over the Agent Manager session", () => {
    const tab = surface("s1", { s1: "/workspace/.kilo/wt-s1" })
    const am = surface("s2", { s2: "/workspace/.kilo/wt-s2" })
    expect(resolveReloadDirectory({ tab, agentManager: am, fallback: FALLBACK })).toBe("/workspace/.kilo/wt-s1")
  })

  it("keeps the active tab's root session over an Agent Manager worktree session", () => {
    const tab = surface("s1")
    const am = surface("s2", { s2: "/workspace/.kilo/wt-s2" })
    expect(resolveReloadDirectory({ tab, agentManager: am, fallback: FALLBACK })).toBe(FALLBACK)
  })

  it("uses the Agent Manager session when the active tab has no session", () => {
    const tab = surface(undefined)
    const am = surface("s2", { s2: "/workspace/.kilo/wt-s2" })
    expect(resolveReloadDirectory({ tab, agentManager: am, fallback: FALLBACK })).toBe("/workspace/.kilo/wt-s2")
  })
})

describe("resolveReloadDirectory — Agent Manager", () => {
  it("uses the Agent Manager's active session directory when no tab is focused", () => {
    const am = surface("s2", { s2: "/workspace/.kilo/wt-s2" })
    expect(resolveReloadDirectory({ tab: undefined, agentManager: am, fallback: FALLBACK })).toBe(
      "/workspace/.kilo/wt-s2",
    )
  })

  it("falls back when the Agent Manager session is in the root (unmapped)", () => {
    const am = surface("s2")
    expect(resolveReloadDirectory({ tab: undefined, agentManager: am, fallback: FALLBACK })).toBe(FALLBACK)
  })
})

describe("resolveReloadDirectory — fallback", () => {
  it("uses the fallback when no surface applies", () => {
    expect(resolveReloadDirectory({ tab: undefined, agentManager: undefined, fallback: FALLBACK })).toBe(FALLBACK)
  })

  it("uses the fallback when the Agent Manager has no active session", () => {
    const am = surface(undefined)
    expect(resolveReloadDirectory({ tab: undefined, agentManager: am, fallback: FALLBACK })).toBe(FALLBACK)
  })
})
