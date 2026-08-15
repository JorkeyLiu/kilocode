/**
 * Executable coverage for the P3.1 chat-target routing contract
 * (src/services/code-actions/chat-target.ts): target preference, cold-open
 * readiness success/failure, and no-post-on-failure. The extension wires the
 * real providers into this vscode-free helper, so these tests exercise the
 * exact readiness rules the toolbar commands, code/terminal actions, and
 * review-comment routing depend on.
 */

import { describe, expect, it } from "bun:test"
import {
  resolveChatTarget,
  waitForChatReady,
  type ChatSurface,
  type ChatTab,
} from "../../src/services/code-actions/chat-target"

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

function tab(posts: unknown[]) {
  return {
    waitForReady: async () => undefined,
    postMessage: (msg: unknown) => {
      posts.push(msg)
    },
  } as ChatTab
}

describe("resolveChatTarget — target preference", () => {
  it("prefers the active Agent Manager over an open tab", async () => {
    const am = surface({ active: true })
    const tabPosts: unknown[] = []

    const target = await resolveChatTarget(am, () => tab(tabPosts))

    expect(target).toBe(am)
    expect(tabPosts).toEqual([])
  })

  it("prefers the active tab when the Agent Manager is not active", async () => {
    const am = surface({ active: false })
    const tabPosts: unknown[] = []

    const target = await resolveChatTarget(am, () => tab(tabPosts))

    expect(target).not.toBe(am)
    target?.postMessage({ type: "action", action: "focusInput" })
    expect(tabPosts).toEqual([{ type: "action", action: "focusInput" }])
  })

  it("cold-opens the Agent Manager when nothing is focused", async () => {
    const opens = { calls: 0 }
    const am = surface({ active: false, opens })

    const target = await resolveChatTarget(am, () => undefined)

    expect(target).toBe(am)
    expect(opens.calls).toBe(1)
  })
})

describe("resolveChatTarget — cold-open readiness", () => {
  it("returns the opened Agent Manager after readiness succeeds", async () => {
    const opens = { calls: 0 }
    const posts: unknown[] = []
    const am = surface({ active: false, ready: true, opens, posts })

    const target = await resolveChatTarget(am, () => undefined)

    expect(target).toBe(am)
    expect(opens.calls).toBe(1)
    target?.postMessage({ type: "action", action: "newTab" })
    expect(posts).toEqual([{ type: "action", action: "newTab" }])
  })

  it("returns undefined and does not expose a postable target when readiness fails", async () => {
    const opens = { calls: 0 }
    const am = surface({ active: false, ready: false, opens })

    const target = await resolveChatTarget(am, () => undefined)

    expect(target).toBeUndefined()
    expect(opens.calls).toBe(1)
  })

  it("returns undefined when the active Agent Manager loses readiness", async () => {
    const am = surface({ active: true, ready: false })

    const target = await resolveChatTarget(am, () => undefined)

    expect(target).toBeUndefined()
  })
})

describe("resolveChatTarget — no-post-on-failure", () => {
  it("never posts into a target that failed readiness", async () => {
    const amPosts: unknown[] = []
    const am = surface({ active: true, ready: false, posts: amPosts })

    const target = await resolveChatTarget(am, () => undefined)

    expect(target).toBeUndefined()
    expect(amPosts).toEqual([])
  })

  it("does not open the Agent Manager when an active tab already serves", async () => {
    const opens = { calls: 0 }
    const am = surface({ active: false, opens })
    const tabPosts: unknown[] = []

    const target = await resolveChatTarget(am, () => tab(tabPosts))

    expect(target).toBeDefined()
    expect(opens.calls).toBe(0)
    expect(tabPosts).toEqual([])
  })
})

describe("waitForChatReady — bounded readiness wait", () => {
  it("resolves true when the readiness wait settles first", async () => {
    const wait = Promise.resolve()
    expect(await waitForChatReady(wait, 1_000)).toBe(true)
  })

  it("resolves false on timeout when the webview never becomes ready", async () => {
    const never = new Promise<void>(() => undefined)
    expect(await waitForChatReady(never, 10)).toBe(false)
  })

  it("resolves true when readiness lands before a later deadline", async () => {
    const late = new Promise<void>((resolve) => setTimeout(resolve, 5))
    expect(await waitForChatReady(late, 1_000)).toBe(true)
  })
})
