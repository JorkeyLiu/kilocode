import { describe, it, expect } from "bun:test"
import { createHash } from "node:crypto"
import { isFrameDetachedError, captureLcFrames } from "../../script/e2e-probe-lifecycle"
import { validateLcTimeline } from "../../script/e2e-evidence"

function hash16(v: string): string {
  return createHash("sha256").update(v).digest("hex").slice(0, 16)
}

function makeBrowser(frames: unknown[]): unknown {
  return {
    contexts: () => [
      {
        pages: () => [
          {
            frames: () => frames,
          },
        ],
      },
    ],
  }
}

function makeFrame(opts: {
  url: string
  detached?: boolean
  theme?: string
  failTheme?: string
  failCount?: string
  failBody?: string
  isDetachedThrows?: string
  hasAm?: number
  hasChat?: number
  hasPrompt?: number
  hasHeader?: number
}): unknown {
  let countCalls = 0
  const detached = opts.detached ?? false
  return {
    url: () => opts.url,
    isDetached: () => {
      if (opts.isDetachedThrows) throw new Error(opts.isDetachedThrows)
      return detached
    },
    evaluate: async (fn: () => unknown) => {
      const src = fn.toString()
      if (src.includes("data-theme") && opts.failTheme) throw new Error(opts.failTheme)
      if (src.includes("data-theme")) return opts.theme ?? "kilo-vscode"
      if (src.includes("className") && opts.failBody) throw new Error(opts.failBody)
      if (src.includes("className")) return "cls"
      if (src.includes("am-layout") && src.includes("return")) return "kilo-welcome"
      if (src.includes("visibilityState")) return true
      return ""
    },
    locator: (sel: string) => ({
      count: async () => {
        if (opts.failCount) throw new Error(opts.failCount)
        if (sel === ".am-layout") return opts.hasAm ?? 0
        if (sel === ".chat-view") return opts.hasChat ?? 1
        if (sel === "textarea.prompt-input") return opts.hasPrompt ?? 1
        if (sel === '[data-slot="task-header-title-label"]') return opts.hasHeader ?? 0
        return 0
      },
    }),
  }
}

describe("isFrameDetachedError exact predicate", () => {
  it("matches case-insensitive Frame was detached", () => {
    expect(isFrameDetachedError(new Error("Frame was detached"))).toBeTrue()
    expect(isFrameDetachedError(new Error("frame was detached"))).toBeTrue()
    expect(isFrameDetachedError(new Error("FRAME WAS DETACHED"))).toBeTrue()
    expect(isFrameDetachedError(new Error("Error: Frame was detached: something"))).toBeTrue()
    expect(isFrameDetachedError("frame was detached")).toBeTrue()
  })
  it("does not broaden to execution context destroyed or target closed", () => {
    expect(isFrameDetachedError(new Error("Execution context was destroyed"))).toBeFalse()
    expect(isFrameDetachedError(new Error("Target closed"))).toBeFalse()
    expect(isFrameDetachedError(new Error("frame detached"))).toBeFalse()
    expect(isFrameDetachedError(new Error("random failure"))).toBeFalse()
    expect(isFrameDetachedError(new Error(""))).toBeFalse()
  })
})

describe("captureLcFrames per-frame isolation", () => {
  it("detached count error skipped and attached retained", async () => {
    const detachedFrame = makeFrame({
      url: "https://vscode-webview.example.com/a",
      failCount: "Frame was detached",
    })
    const good = makeFrame({
      url: "https://vscode-webview.example.com/b",
      hasAm: 1,
    })
    const browser = makeBrowser([detachedFrame, good]) as never
    const frames = (await captureLcFrames(browser as never)) as Record<string, unknown>[]
    expect(frames.length).toBe(1)
    expect(frames[0]!.urlHash).toBe(hash16("https://vscode-webview.example.com/b"))
    expect(frames[0]!.hasAm).toBeTrue()
  })

  it("theme detached skipped", async () => {
    const detachedTheme = makeFrame({
      url: "https://vscode-webview.example.com/a",
      failTheme: "Frame was detached",
    })
    const good = makeFrame({
      url: "https://vscode-webview.example.com/b",
    })
    const browser = makeBrowser([detachedTheme, good]) as never
    const frames = (await captureLcFrames(browser as never)) as Record<string, unknown>[]
    expect(frames.length).toBe(1)
    expect((frames[0] as Record<string, unknown>).urlHash).toBe(hash16("https://vscode-webview.example.com/b"))
  })

  it("pre-detached skipped without evaluate", async () => {
    const pre = makeFrame({ url: "https://vscode-webview.example.com/a", detached: true })
    const good = makeFrame({ url: "https://vscode-webview.example.com/b" })
    const browser = makeBrowser([pre, good]) as never
    const frames = (await captureLcFrames(browser as never)) as Record<string, unknown>[]
    expect(frames.length).toBe(1)
    expect((frames[0] as Record<string, unknown>).urlHash).toBe(hash16("https://vscode-webview.example.com/b"))
  })

  it("random DOM error still throws redacted", async () => {
    const bad = makeFrame({ url: "https://vscode-webview.example.com/a", failCount: "random failure" })
    const browser = makeBrowser([bad]) as never
    await expect(captureLcFrames(browser as never)).rejects.toThrow(/lc timeline frame dom failed \(redacted\)/)
  })

  it("random theme error still throws redacted", async () => {
    const bad = makeFrame({ url: "https://vscode-webview.example.com/a", failTheme: "random theme boom" })
    const browser = makeBrowser([bad]) as never
    await expect(captureLcFrames(browser as never)).rejects.toThrow(/lc timeline frame theme failed \(redacted\)/)
  })

  it("detached via isDetached after error also skipped", async () => {
    const frame = makeFrame({
      url: "https://vscode-webview.example.com/a",
      failCount: "transient not detached message",
      // but isDetached returns true after failure -> should still skip even though message not detached
    })
    // override isDetached to return true only after first call?
    let calls = 0
    const f = {
      url: () => "https://vscode-webview.example.com/a",
      isDetached: () => {
        calls++
        if (calls === 1) return false
        return true
      },
      evaluate: async () => "kilo-vscode",
      locator: () => ({
        count: async () => {
          throw new Error("some other error")
        },
      }),
    }
    void frame
    const browser = makeBrowser([f]) as never
    const frames = (await captureLcFrames(browser as never)) as unknown[]
    expect(frames.length).toBe(0)
  })

  it("all detached yields frames=[] and validator accepts complete timeline", async () => {
    const a = makeFrame({ url: "https://vscode-webview.example.com/a", detached: true })
    const b = makeFrame({ url: "https://vscode-webview.example.com/b", failCount: "Frame was detached" })
    const browser = makeBrowser([a, b]) as never
    const frames = (await captureLcFrames(browser as never)) as unknown[]
    expect(frames.length).toBe(0)
    // build timeline where every phase has frames=[] — pure Agent Manager /2 phases (LOCK-001)
    const base = Date.now()
    const phases = [
      "pre-panel-close",
      "post-panel-reopen",
      "pre-webview-reload",
      "post-webview-reload",
      "pre-session-switch",
      "switched-session",
      "post-session-switch",
      "final-done",
    ]
    const timeline = phases.map((p, i) => ({
      ts: base + i * 1000,
      iso: new Date(base + i * 1000).toISOString(),
      phase: p,
      auxiliaryBar: { exists: true, visible: true, width: 300, height: 600, focusWithin: false },
      chat: { exists: true, visible: true, inputVisible: true },
      editors: { tabCount: 1, groupCount: 1, tabHashes: [hash16("tab")] },
      frames: [],
    }))
    expect(validateLcTimeline(timeline)).toBeNull()
  })

  it("exhaustive iteration continues across ctx/page/frame without break", async () => {
    const good1 = makeFrame({ url: "https://vscode-webview.example.com/a" })
    const detached = makeFrame({ url: "https://vscode-webview.example.com/b", failCount: "Frame was detached" })
    const good2 = makeFrame({ url: "https://vscode-webview.example.com/c" })
    const browser = {
      contexts: () => [
        {
          pages: () => [
            { frames: () => [good1] },
            { frames: () => [detached, good2] },
          ],
        },
        {
          pages: () => [{ frames: () => [makeFrame({ url: "https://vscode-webview.example.com/d" })] }],
        },
      ],
    } as never
    const frames = (await captureLcFrames(browser)) as Record<string, unknown>[]
    expect(frames.length).toBe(3)
    const hashes = frames.map((f) => f.urlHash)
    expect(hashes).toContain(hash16("https://vscode-webview.example.com/a"))
    expect(hashes).toContain(hash16("https://vscode-webview.example.com/c"))
    expect(hashes).toContain(hash16("https://vscode-webview.example.com/d"))
  })
})
