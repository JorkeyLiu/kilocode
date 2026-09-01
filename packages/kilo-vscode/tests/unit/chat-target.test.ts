/**
 * Executable coverage for the Agent Manager-only chat-target routing contract
 * (src/services/code-actions/chat-target.ts): Agent Manager is sole surface.
 */

import { describe, expect, it } from "bun:test"
import { resolveChatTarget, type ChatSurface } from "../../src/services/code-actions/chat-target"

function surface(opts: { active?: boolean; ready?: boolean; posts?: unknown[]; opens?: { calls: number } }) {
  const active = opts.active ?? false
  const ready = opts.ready ?? true
  const posts = opts.posts ?? []
  const opens = opts.opens ?? { calls: 0 }
  return {
    isActive: () => active,
    waitForReady: async () => ready,
    openPanel: () => {
      opens.calls += 1
    },
    postMessage: (msg: unknown) => {
      posts.push(msg)
    },
  } as ChatSurface
}

describe("resolveChatTarget — Agent Manager only", () => {
  it("returns the active Agent Manager when ready", async () => {
    const am = surface({ active: true, ready: true })
    const target = await resolveChatTarget(am)
    expect(target).toBe(am)
  })

  it("cold-opens the Agent Manager when not active", async () => {
    const opens = { calls: 0 }
    const am = surface({ active: false, opens })
    const target = await resolveChatTarget(am)
    expect(target).toBe(am)
    expect(opens.calls).toBe(1)
  })

  it("returns the opened Agent Manager after readiness succeeds", async () => {
    const opens = { calls: 0 }
    const posts: unknown[] = []
    const am = surface({ active: false, ready: true, opens, posts })
    const target = await resolveChatTarget(am)
    expect(target).toBe(am)
    expect(opens.calls).toBe(1)
    target?.postMessage({ type: "action", action: "newTab" })
    expect(posts).toEqual([{ type: "action", action: "newTab" }])
  })

  it("returns undefined when readiness fails", async () => {
    const opens = { calls: 0 }
    const am = surface({ active: false, ready: false, opens })
    const target = await resolveChatTarget(am)
    expect(target).toBeUndefined()
    expect(opens.calls).toBe(1)
  })

  it("returns undefined when the active Agent Manager loses readiness", async () => {
    const am = surface({ active: true, ready: false })
    const target = await resolveChatTarget(am)
    expect(target).toBeUndefined()
  })
})

describe("resolveChatTarget — no-post-on-failure", () => {
  it("never posts into a target that failed readiness", async () => {
    const amPosts: unknown[] = []
    const am = surface({ active: true, ready: false, posts: amPosts })
    const target = await resolveChatTarget(am)
    expect(target).toBeUndefined()
    expect(amPosts).toEqual([])
  })
})
