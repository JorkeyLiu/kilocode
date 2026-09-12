import { describe, expect, it, spyOn } from "bun:test"
import {
  fetchAndSendPendingQuestions,
  type QuestionContext,
} from "../../src/kilo-provider/handlers/question"
import type { QuestionRequest } from "@kilocode/sdk/v2/client"

function pending(id: string, sessionID: string): QuestionRequest {
  return {
    id,
    sessionID,
    questions: [{ header: "Go", question: "Proceed?", options: [{ label: "Yes", description: "Go" }] }],
    blocking: false,
    tool: undefined,
  }
}

function succeeded(req: Record<string, unknown>, items: unknown[]) {
  return {
    kind: "valid",
    result: {
      v: 1,
      requestId: req.requestId,
      opId: req.opId,
      op: "question/list",
      idempotencyKey: req.idempotencyKey,
      status: "succeeded",
      outcome: { type: "succeeded", time: 1 },
      accepted: true,
      data: { questions: items },
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
      op: "question/list",
      idempotencyKey: req.idempotencyKey,
      status: "failed",
      outcome: { type: "failed", time: 1, failure: { code: "validation.failed", message: "m", retryable: false } },
      accepted: false,
      failure: { code: "validation.failed", message: "m", retryable: false },
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
      op: "question/list",
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
  privateByDir?: Record<string, "ok" | "terminal" | "fallback">
  privateItems?: Record<string, QuestionRequest[]>
  sdkItems?: Record<string, QuestionRequest[]>
  sdkErrors?: Record<string, unknown>
}) {
  const messages: unknown[] = []
  const queries: string[] = []
  const questionDirs = new Map<string, string>()
  const privateCalls: string[] = []
  let revision = 0
  const conn = {
    isPrivateAvailable: () => true,
    getPrivatePeer: () => null,
    getPrivateEpoch: () => 1,
    privateQuestionListOutcomeWithHandle: (req: Record<string, unknown>) => {
      const dir = (req.context as Record<string, unknown>).directory as string
      privateCalls.push(dir)
      const mode = opts.privateByDir?.[dir] ?? "fallback"
      if (mode === "ok") return { id: 1, promise: Promise.resolve(succeeded(req, opts.privateItems?.[dir] ?? [])), cancel: () => true }
      if (mode === "terminal") return { id: 1, promise: Promise.resolve(terminal(req)), cancel: () => true }
      return { id: 1, promise: Promise.resolve(vague(req)), cancel: () => true }
    },
  } as unknown as QuestionContext["connection"]
  const client = {
    question: {
      list: async (args?: { directory?: string }) => {
        const dir = args?.directory ?? ""
        queries.push(dir)
        const err = opts.sdkErrors?.[dir]
        if (err) return { data: undefined, error: err }
        return { data: opts.sdkItems?.[dir] ?? [], error: undefined }
      },
      reply: async () => ({ data: true }),
      reject: async () => ({ data: true }),
    },
  } as unknown as QuestionContext["client"]
  const fake: QuestionContext = {
    client,
    currentSessionId: "ses-root",
    trackedSessionIds: new Set(opts.tracked),
    sessionDirectories: opts.dirs,
    connection: conn,
    postMessage: (msg) => messages.push(msg),
    getWorkspaceDirectory: () => opts.workspace ?? "/workspace",
    recordQuestionDirectory: (id, dir) => questionDirs.set(id, dir),
    getQuestionDirectory: (id) => questionDirs.get(id),
    clearQuestionDirectory: (id) => {
      questionDirs.delete(id)
      revision += 1
    },
    getQuestionRevision: () => revision,
    pruneQuestionDirectories: (active, scanned) => {
      for (const [key, dir] of questionDirs) {
        if (active.has(key)) continue
        if (!scanned.has(dir)) continue
        questionDirs.delete(key)
      }
    },
  }
  return { fake, messages, queries, questionDirs, privateCalls }
}

describe("question-list recovery", () => {
  it("mixed success and failure preserves failed-dir mappings and keeps first-wins order", async () => {
    const spy = spyOn(console, "error").mockImplementation(() => {})
    try {
      const dirs = new Map([
        ["ses_1", "/good"],
        ["ses_2", "/bad"],
      ])
      const dup = pending("que_dup00000000000000001", "ses_1")
      const { fake, messages, queries, questionDirs, privateCalls } = setup({
        tracked: ["ses_1", "ses_2"],
        dirs,
        workspace: "/workspace",
        privateByDir: { "/workspace": "ok", "/good": "fallback", "/bad": "terminal" },
        privateItems: { "/workspace": [dup] },
        sdkItems: { "/good": [dup, pending("que_good0000000000000002", "ses_1")] },
      })
      questionDirs.set("que_stale_bad0000000000001", "/bad")
      questionDirs.set("que_stale_ws00000000000001", "/workspace")

      const out = await fetchAndSendPendingQuestions(fake)

      expect(privateCalls).toEqual(["/workspace", "/good", "/bad"])
      expect(queries).toEqual(["/good"])
      expect(questionDirs.get("que_dup00000000000000001")).toBe("/workspace")
      expect(questionDirs.get("que_stale_bad0000000000001")).toBe("/bad")
      expect(questionDirs.has("que_stale_ws00000000000001")).toBe(false)
      const ids = (messages as Array<{ type: string; question: { id: string } }>)
        .filter((m) => m.type === "questionRequest")
        .map((m) => m.question.id)
      expect(ids.filter((id) => id === "que_dup00000000000000001")).toHaveLength(1)
      expect(ids).toContain("que_good0000000000000002")
      expect(out?.complete).toBeFalse()
    } finally {
      spy.mockRestore()
    }
  })

  it("successful empty prunes only that dir while failed dir stays", async () => {
    const spy = spyOn(console, "error").mockImplementation(() => {})
    try {
      const dirs = new Map([["ses_1", "/failing"]])
      const { fake, questionDirs } = setup({
        tracked: ["ses_1"],
        dirs,
        privateByDir: { "/workspace": "ok", "/failing": "fallback" },
        privateItems: { "/workspace": [] },
        sdkErrors: { "/failing": new Error("boom") },
      })
      questionDirs.set("workspace-stale", "/workspace")
      questionDirs.set("worktree-pending", "/failing")

      const out = await fetchAndSendPendingQuestions(fake)

      expect(questionDirs.has("workspace-stale")).toBe(false)
      expect(questionDirs.get("worktree-pending")).toBe("/failing")
      expect(out?.complete).toBeFalse()
    } finally {
      spy.mockRestore()
    }
  })

  it("one directory failure does not suppress another directory success", async () => {
    const dirs = new Map([["ses_1", "/a"]])
    const { fake, messages } = setup({
      tracked: ["ses_1"],
      dirs,
      privateByDir: { "/workspace": "terminal", "/a": "ok" },
      privateItems: { "/a": [pending("que_a00000000000000000001", "ses_1")] },
    })
    const out = await fetchAndSendPendingQuestions(fake)
    expect(messages).toHaveLength(1)
    expect(out?.complete).toBeFalse()
  })

  it("authoritative empty success counts as scanned and complete when all succeed", async () => {
    const dirs = new Map([["ses_1", "/a"]])
    const { fake, queries } = setup({
      tracked: ["ses_1"],
      dirs,
      privateByDir: { "/workspace": "ok", "/a": "ok" },
      privateItems: { "/workspace": [], "/a": [] },
    })
    const out = await fetchAndSendPendingQuestions(fake)
    expect(queries).toEqual([])
    expect(out?.complete).toBeTrue()
    expect(out?.seen.size).toBe(0)
  })
})
