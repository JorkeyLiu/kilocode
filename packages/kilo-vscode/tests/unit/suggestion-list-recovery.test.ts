import { describe, expect, it, spyOn } from "bun:test"
import {
  fetchAndSendPendingSuggestions,
  type RecoverableSuggestion,
  type SuggestionContext,
} from "../../src/kilo-provider/handlers/suggestion"

function pending(id: string, sessionID: string): RecoverableSuggestion {
  return {
    id,
    sessionID,
    text: "Run tests?",
    actions: [{ label: "Run tests", prompt: "Run the test suite" }],
  } as RecoverableSuggestion
}

function succeeded(req: Record<string, unknown>, items: unknown[]) {
  return {
    kind: "valid",
    result: {
      v: 1,
      requestId: req.requestId,
      opId: req.opId,
      op: "suggestion/list",
      idempotencyKey: req.idempotencyKey,
      status: "succeeded",
      outcome: { type: "succeeded", time: 1 },
      accepted: true,
      data: { suggestions: items },
    },
  }
}

function terminal(req: Record<string, unknown>) {
  return {
    kind: "valid",
    result: {
      v: 1,
      requestId: req.requestId,
      opId: req.opId,
      op: "suggestion/list",
      idempotencyKey: req.idempotencyKey,
      status: "failed",
      outcome: { type: "failed", time: 1, failure: { code: "validation.failed", message: "m", retryable: false } },
      accepted: false,
      failure: { code: "validation.failed", message: "m", retryable: false },
    },
  }
}

function fence(req: Record<string, unknown>) {
  return {
    kind: "valid",
    result: {
      v: 1,
      requestId: req.requestId,
      opId: req.opId,
      op: "suggestion/list",
      idempotencyKey: req.idempotencyKey,
      status: "failed",
      outcome: {
        type: "failed",
        time: 1,
        failure: { code: "InstanceUnavailableDuringConfigRebuild", message: "m", retryable: true },
      },
      accepted: false,
      failure: { code: "InstanceUnavailableDuringConfigRebuild", message: "m", retryable: true },
    },
  }
}

function vague(req: Record<string, unknown>) {
  return {
    kind: "valid",
    result: {
      v: 1,
      requestId: req.requestId,
      opId: req.opId,
      op: "suggestion/list",
      idempotencyKey: req.idempotencyKey,
      status: "ambiguous",
      outcome: { type: "ambiguous", time: 1 },
      accepted: false,
      transportUnknown: true,
    },
  }
}

function setup(opts: {
  tracked: string[]
  dirs: Map<string, string>
  workspace?: string
  privateByDir?: Record<string, "ok" | "terminal" | "fence" | "fallback">
  privateItems?: Record<string, RecoverableSuggestion[]>
  sdkItems?: Record<string, RecoverableSuggestion[]>
  sdkErrors?: Record<string, unknown>
}) {
  const messages: unknown[] = []
  const queries: string[] = []
  const privateCalls: string[] = []
  const conn = {
    isPrivateAvailable: () => true,
    getPrivatePeer: () => null,
    getPrivateEpoch: () => 1,
    privateSuggestionListOutcomeWithHandle: (req: Record<string, unknown>) => {
      const dir = (req.context as Record<string, unknown>).directory as string
      privateCalls.push(dir)
      const mode = opts.privateByDir?.[dir] ?? "fallback"
      if (mode === "ok") return { id: 1, promise: Promise.resolve(succeeded(req, opts.privateItems?.[dir] ?? [])), cancel: () => true }
      if (mode === "terminal") return { id: 1, promise: Promise.resolve(terminal(req)), cancel: () => true }
      if (mode === "fence") return { id: 1, promise: Promise.resolve(fence(req)), cancel: () => true }
      return { id: 1, promise: Promise.resolve(vague(req)), cancel: () => true }
    },
  } as unknown as SuggestionContext["connection"]
  const client = {
    suggestion: {
      list: async (args?: { directory?: string }) => {
        const dir = args?.directory ?? ""
        queries.push(dir)
        const err = opts.sdkErrors?.[dir]
        if (err) throw err
        return { data: opts.sdkItems?.[dir] ?? [] }
      },
      accept: async () => ({ data: true }),
      dismiss: async () => ({ data: true }),
    },
  } as unknown as SuggestionContext["client"]
  const fake: SuggestionContext = {
    client,
    currentSessionId: undefined,
    trackedSessionIds: new Set(opts.tracked),
    sessionDirectories: opts.dirs,
    connection: conn,
    postMessage: (msg) => messages.push(msg),
    getWorkspaceDirectory: () => opts.workspace ?? "/workspace",
  }
  return { fake, messages, queries, privateCalls }
}

describe("suggestion-list recovery", () => {
  it("global repeats dedupe first-wins with zero SDK", async () => {
    const dirs = new Map([["ses_1", "/wt"]])
    const dup = pending("sug_dup00000000000000001", "ses_1")
    const { fake, messages, queries, privateCalls } = setup({
      tracked: ["ses_1"],
      dirs,
      workspace: "/workspace",
      privateByDir: { "/workspace": "ok", "/wt": "ok" },
      privateItems: {
        "/workspace": [dup],
        "/wt": [dup, pending("sug_wt000000000000000002", "ses_1")],
      },
    })
    await fetchAndSendPendingSuggestions(fake)
    expect(privateCalls).toEqual(["/workspace", "/wt"])
    expect(queries).toEqual([])
    const ids = (messages as Array<{ type: string; suggestion: { id: string } }>)
      .filter((m) => m.type === "suggestionRequest")
      .map((m) => m.suggestion.id)
    expect(ids.filter((id) => id === "sug_dup00000000000000001")).toHaveLength(1)
    expect(ids).toContain("sug_wt000000000000000002")
    expect(ids).toHaveLength(2)
  })

  it("authoritative empty success posts nothing with zero SDK", async () => {
    const dirs = new Map([["ses_1", "/a"]])
    const { fake, messages, queries } = setup({
      tracked: ["ses_1"],
      dirs,
      privateByDir: { "/workspace": "ok", "/a": "ok" },
      privateItems: { "/workspace": [], "/a": [] },
    })
    await fetchAndSendPendingSuggestions(fake)
    expect(queries).toEqual([])
    expect(messages).toEqual([])
  })

  it("nonretryable failure falls back to SDK and posts when SDK succeeds", async () => {
    const dirs = new Map([["ses_1", "/a"]])
    const { fake, messages, queries } = setup({
      tracked: ["ses_1"],
      dirs,
      privateByDir: { "/workspace": "terminal", "/a": "ok" },
      privateItems: { "/a": [pending("sug_a00000000000000000001", "ses_1")] },
      sdkItems: { "/workspace": [pending("sug_ws000000000000000001", "ses_1")] },
    })
    await fetchAndSendPendingSuggestions(fake)
    expect(queries).toEqual(["/workspace"])
    expect(messages).toHaveLength(2)
  })

  it("SDK failure after private failure skips dir as unknown", async () => {
    const dirs = new Map([["ses_1", "/a"]])
    const { fake, messages, queries } = setup({
      tracked: ["ses_1"],
      dirs,
      privateByDir: { "/workspace": "terminal", "/a": "ok" },
      privateItems: { "/a": [pending("sug_a00000000000000000001", "ses_1")] },
      sdkErrors: { "/workspace": new Error("sdk down") },
    })
    await fetchAndSendPendingSuggestions(fake)
    expect(queries).toEqual(["/workspace"])
    expect(messages).toHaveLength(1)
  })

  it("fallback-eligible dirs take exactly one same-directory SDK list each", async () => {
    const spy = spyOn(console, "error").mockImplementation(() => {})
    try {
      const dirs = new Map([
        ["ses_1", "/good"],
        ["ses_2", "/fence"],
      ])
      const dup = pending("sug_dup00000000000000001", "ses_1")
      const { fake, messages, queries } = setup({
        tracked: ["ses_1", "ses_2"],
        dirs,
        workspace: "/workspace",
        privateByDir: { "/workspace": "ok", "/good": "fallback", "/fence": "fence" },
        privateItems: { "/workspace": [dup] },
        sdkItems: {
          "/good": [dup, pending("sug_good0000000000000002", "ses_1")],
          "/fence": [pending("sug_fence0000000000000001", "ses_2")],
        },
      })
      await fetchAndSendPendingSuggestions(fake)
      expect(queries).toEqual(["/good", "/fence"])
      const ids = (messages as Array<{ type: string; suggestion: { id: string } }>)
        .filter((m) => m.type === "suggestionRequest")
        .map((m) => m.suggestion.id)
      expect(ids.filter((id) => id === "sug_dup00000000000000001")).toHaveLength(1)
      expect(ids).toContain("sug_good0000000000000002")
      expect(ids).toContain("sug_fence0000000000000001")
    } finally {
      spy.mockRestore()
    }
  })

  it("unavailable connection takes exactly one SDK list per dir with no retry", async () => {
    const messages: unknown[] = []
    const queries: string[] = []
    const client = {
      suggestion: {
        list: async (args?: { directory?: string }) => {
          queries.push(args?.directory ?? "")
          return { data: [pending("sug_sdk00000000000000001", "ses_1")] }
        },
        accept: async () => ({ data: true }),
        dismiss: async () => ({ data: true }),
      },
    } as unknown as SuggestionContext["client"]
    const fake: SuggestionContext = {
      client,
      currentSessionId: undefined,
      trackedSessionIds: new Set(["ses_1"]),
      sessionDirectories: new Map([["ses_1", "/wt"]]),
      connection: null,
      postMessage: (msg) => messages.push(msg),
      getWorkspaceDirectory: () => "/workspace",
    }
    await fetchAndSendPendingSuggestions(fake)
    expect(queries).toEqual(["/workspace", "/wt"])
    const ids = (messages as Array<{ type: string; suggestion: { id: string } }>)
      .filter((m) => m.type === "suggestionRequest")
      .map((m) => m.suggestion.id)
    expect(ids).toHaveLength(1)
  })

  it("untracked sessions are filtered and SDK errors skip without duplicate posts", async () => {
    const spy = spyOn(console, "error").mockImplementation(() => {})
    try {
      const dirs = new Map([["ses_1", "/wt"]])
      const { fake, messages } = setup({
        tracked: ["ses_1"],
        dirs,
        privateByDir: { "/workspace": "fallback", "/wt": "fallback" },
        sdkItems: {
          "/workspace": [pending("sug_ws000000000000000001", "other")],
          "/wt": [pending("sug_ws000000000000000001", "other"), pending("sug_ok000000000000000001", "ses_1")],
        },
      })
      await fetchAndSendPendingSuggestions(fake)
      const ids = (messages as Array<{ type: string; suggestion: { id: string } }>)
        .filter((m) => m.type === "suggestionRequest")
        .map((m) => m.suggestion.id)
      expect(ids).toEqual(["sug_ok000000000000000001"])
    } finally {
      spy.mockRestore()
    }
  })
})
