import { describe, expect, test, spyOn } from "bun:test"
import {
  handleQuestionReject,
  handleQuestionReply,
  type QuestionContext,
} from "./handlers/question"
import { buildQuestionReplyIdentity, buildQuestionRejectIdentity } from "./question-privatefirst"
import { canonicalQuestionOpId } from "../services/cli-backend/serve-private-question-contract"
import type { QuestionRequest } from "@kilocode/sdk/v2/client"

const DIR = "/workspace/session-origin"
const RID = "que_test00000000000000001"

function item(id: string): QuestionRequest {
  return {
    id,
    sessionID: "ses-root",
    questions: [{ header: "Go", question: "Proceed?", options: [{ label: "Yes", description: "Go" }] }],
    blocking: false,
    tool: undefined,
  }
}

function terminalReply(req: Record<string, unknown>, answers: string[][] = [["Yes"]]) {
  return {
    kind: "terminal",
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    idempotencyKey: req.idempotencyKey,
    accepted: true,
    terminal: true,
    sessionID: "ses-root",
    requestID: (req.context as Record<string, unknown>).requestID,
    answers,
  }
}

function terminalReject(req: Record<string, unknown>) {
  return {
    kind: "terminal",
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    idempotencyKey: req.idempotencyKey,
    accepted: true,
    terminal: true,
    sessionID: "ses-root",
    requestID: (req.context as Record<string, unknown>).requestID,
  }
}

function notFound(req: Record<string, unknown>) {
  return {
    kind: "terminal-failure",
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    idempotencyKey: req.idempotencyKey,
    accepted: false,
    terminal: true,
    failure: { code: "question.not_found", retryable: false, time: 1 },
    sideEffect: false,
  }
}

function scopeMismatch(req: Record<string, unknown>) {
  return {
    kind: "terminal-failure",
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    idempotencyKey: req.idempotencyKey,
    accepted: false,
    terminal: true,
    failure: { code: "scope_mismatch", retryable: false, time: 1 },
    sideEffect: false,
  }
}

function vague(req: Record<string, unknown>) {
  return {
    kind: "ambiguous",
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    idempotencyKey: req.idempotencyKey,
    accepted: false,
    terminal: false,
    transportUnknown: true,
  }
}

function base(opts: {
  origin?: string
  pending?: Record<string, QuestionRequest[]>
  replyError?: unknown
  rejectError?: unknown
  conn?: QuestionContext["connection"]
}) {
  const messages: unknown[] = []
  const replies: unknown[] = []
  const rejects: unknown[] = []
  const dirs = new Map<string, string>()
  let revision = 0
  const client = {
    question: {
      list: async (args: { directory?: string }) => ({ data: opts.pending?.[args.directory ?? ""] ?? [] }),
      reply: async (args: unknown) => {
        replies.push(args)
        if (opts.replyError) throw opts.replyError
        return { data: true }
      },
      reject: async (args: unknown) => {
        rejects.push(args)
        if (opts.rejectError) throw opts.rejectError
        return { data: true }
      },
    },
  } as unknown as QuestionContext["client"]
  const fake: QuestionContext = {
    client,
    currentSessionId: "ses-root",
    trackedSessionIds: new Set(["ses-root"]),
    sessionDirectories: new Map([["ses-root", DIR]]),
    connection: opts.conn,
    postMessage: (msg) => messages.push(msg),
    getWorkspaceDirectory: () => DIR,
    recordQuestionDirectory: (id, dir) => dirs.set(id, dir),
    getQuestionDirectory: (id) => dirs.get(id),
    clearQuestionDirectory: (id) => {
      dirs.delete(id)
      revision += 1
    },
    getQuestionRevision: () => revision,
    pruneQuestionDirectories: (active, scanned) => {
      for (const [id, dir] of dirs) {
        if (active.has(id) || !scanned.has(dir)) continue
        dirs.delete(id)
      }
    },
  }
  if (opts.origin) dirs.set(RID, opts.origin)
  return { fake, messages, replies, rejects, dirs }
}

describe("question private-first", () => {
  test("identity binds question tuple", () => {
    const replyIds = buildQuestionReplyIdentity(RID)
    expect(replyIds.opId).toBe(replyIds.idempotencyKey)
    expect(replyIds.opId.startsWith(`question:${RID}:`)).toBeTrue()
    const token = replyIds.opId.split(":")[2]!
    expect(canonicalQuestionOpId(RID, token)).toBe(replyIds.opId)
    const rejectIds = buildQuestionRejectIdentity(RID)
    expect(rejectIds.opId).toBe(rejectIds.idempotencyKey)
    expect(rejectIds.opId.startsWith(`question:${RID}:`)).toBeTrue()
  })

  test("private terminal reply returns with zero SDK and clears", async () => {
    const seen: unknown[] = []
    let sdk = 0
    const conn = {
      isPrivateAvailable: () => true,
      privateQuestionReplyWithHandle: (req: Record<string, unknown>) => {
        seen.push(req)
        return { id: 7, promise: Promise.resolve(terminalReply(req)), cancel: () => true }
      },
    } as unknown as QuestionContext["connection"]
    const { fake, messages, dirs } = base({ origin: DIR, conn })
    const client = fake.client as unknown as { question: { reply: (a: unknown) => Promise<unknown> } }
    const orig = client.question.reply
    client.question.reply = async (a: unknown) => {
      sdk += 1
      return orig(a)
    }
    const ok = await handleQuestionReply(fake, RID, [["Yes"]], "ses-root")
    expect(ok).toBeTrue()
    expect(sdk).toBe(0)
    expect(seen).toHaveLength(1)
    const req = seen[0] as Record<string, unknown>
    expect(req.v).toBe(1)
    expect(req.op).toBe("question/reply")
    expect(req.idempotencyKey).toBe(req.opId)
    expect(String(req.opId).startsWith(`question:${RID}:`)).toBeTrue()
    expect((req.context as Record<string, unknown>).directory).toBe(DIR)
    expect((req.context as Record<string, unknown>).requestID).toBe(RID)
    expect((req.payload as Record<string, unknown>).answers).toEqual([["Yes"]])
    expect(dirs.has(RID)).toBeFalse()
    expect(messages).not.toContainEqual({ type: "questionError", requestID: RID })
  })

  test("private terminal reject returns with zero SDK and clears", async () => {
    let sdk = 0
    const conn = {
      isPrivateAvailable: () => true,
      privateQuestionRejectWithHandle: (req: Record<string, unknown>) => ({
        id: 3,
        promise: Promise.resolve(terminalReject(req)),
        cancel: () => true,
      }),
    } as unknown as QuestionContext["connection"]
    const { fake, dirs } = base({ origin: DIR, conn })
    const client = fake.client as unknown as { question: { reject: (a: unknown) => Promise<unknown> } }
    const orig = client.question.reject
    client.question.reject = async (a: unknown) => {
      sdk += 1
      return orig(a)
    }
    const ok = await handleQuestionReject(fake, RID, "ses-root")
    expect(ok).toBeTrue()
    expect(sdk).toBe(0)
    expect(dirs.has(RID)).toBeFalse()
  })

  test("not_found with origin takes stale path with zero SDK", async () => {
    let sdk = 0
    const conn = {
      isPrivateAvailable: () => true,
      privateQuestionReplyWithHandle: (req: Record<string, unknown>) => ({
        id: 1,
        promise: Promise.resolve(notFound(req)),
        cancel: () => true,
      }),
    } as unknown as QuestionContext["connection"]
    const { fake, messages, dirs } = base({ origin: DIR, conn })
    const client = fake.client as unknown as { question: { reply: (a: unknown) => Promise<unknown> } }
    const orig = client.question.reply
    client.question.reply = async (a: unknown) => {
      sdk += 1
      return orig(a)
    }
    const ok = await handleQuestionReply(fake, RID, [["Yes"]], "ses-root")
    expect(ok).toBeFalse()
    expect(sdk).toBe(0)
    expect(dirs.has(RID)).toBeFalse()
    expect(messages).toContainEqual({ type: "questionResolved", requestID: RID })
  })

  test("not_found without origin recovers with zero SDK when stale", async () => {
    let sdk = 0
    const conn = {
      isPrivateAvailable: () => true,
      privateQuestionRejectWithHandle: (req: Record<string, unknown>) => ({
        id: 1,
        promise: Promise.resolve(notFound(req)),
        cancel: () => true,
      }),
    } as unknown as QuestionContext["connection"]
    const { fake, messages } = base({ conn, pending: {} })
    const client = fake.client as unknown as { question: { reject: (a: unknown) => Promise<unknown> } }
    const orig = client.question.reject
    client.question.reject = async (a: unknown) => {
      sdk += 1
      return orig(a)
    }
    const ok = await handleQuestionReject(fake, RID, "ses-root")
    expect(ok).toBeFalse()
    expect(sdk).toBe(0)
    expect(messages).toContainEqual({ type: "questionResolved", requestID: RID })
  })

  test("not_found without origin keeps retryable when recovery incomplete", async () => {
    const conn = {
      isPrivateAvailable: () => true,
      privateQuestionReplyWithHandle: (req: Record<string, unknown>) => ({
        id: 1,
        promise: Promise.resolve(notFound(req)),
        cancel: () => true,
      }),
    } as unknown as QuestionContext["connection"]
    const { fake, messages } = base({ conn, pending: { [DIR]: [item(RID)] } })
    const spy = spyOn(console, "error").mockImplementation(() => {})
    const ok = await handleQuestionReply(fake, RID, [["Yes"]], "ses-root")
    spy.mockRestore()
    expect(ok).toBeFalse()
    expect(messages).toContainEqual({ type: "questionError", requestID: RID })
    expect(messages).not.toContainEqual({ type: "questionResolved", requestID: RID })
  })

  test("scope_mismatch closes with zero SDK and no clear", async () => {
    let sdk = 0
    const conn = {
      isPrivateAvailable: () => true,
      privateQuestionReplyWithHandle: (req: Record<string, unknown>) => ({
        id: 1,
        promise: Promise.resolve(scopeMismatch(req)),
        cancel: () => true,
      }),
    } as unknown as QuestionContext["connection"]
    const { fake, messages, dirs } = base({ origin: DIR, conn })
    const client = fake.client as unknown as { question: { reply: (a: unknown) => Promise<unknown> } }
    const orig = client.question.reply
    client.question.reply = async (a: unknown) => {
      sdk += 1
      return orig(a)
    }
    const spy = spyOn(console, "error").mockImplementation(() => {})
    const ok = await handleQuestionReply(fake, RID, [["Yes"]], "ses-root")
    spy.mockRestore()
    expect(ok).toBeFalse()
    expect(sdk).toBe(0)
    expect(dirs.get(RID)).toBe(DIR)
    expect(messages).toContainEqual({ type: "questionError", requestID: RID })
  })

  test("invalid, ambiguous, transport, closed each take exactly one SDK with same tuple", async () => {
    const cases: Array<{ label: string; make: (req: Record<string, unknown>) => unknown }> = [
      { label: "invalid", make: (req) => ({ ...terminalReply(req), answers: "broken" }) },
      { label: "ambiguous", make: (req) => vague(req) },
      {
        label: "failure-retryable",
        make: (req) => ({
          ...notFound(req),
          failure: { code: "internal", retryable: true, time: 1 },
        }),
      },
    ]
    for (const entry of cases) {
      const seen: unknown[] = []
      let sdk = 0
      const params: unknown[] = []
      const conn = {
        isPrivateAvailable: () => true,
        privateQuestionReplyWithHandle: (req: Record<string, unknown>) => {
          seen.push(req)
          return { id: 1, promise: Promise.resolve(entry.make(req)), cancel: () => true }
        },
      } as unknown as QuestionContext["connection"]
      const { fake, replies } = base({ origin: DIR, conn })
      const client = fake.client as unknown as { question: { reply: (a: unknown) => Promise<unknown> } }
      const orig = client.question.reply
      client.question.reply = async (a: unknown) => {
        sdk += 1
        params.push(a)
        return orig(a)
      }
      const ok = await handleQuestionReply(fake, RID, [["Yes"]], "ses-root")
      expect([entry.label, ok]).toEqual([entry.label, true])
      expect([entry.label, sdk]).toEqual([entry.label, 1])
      expect([entry.label, seen.length]).toEqual([entry.label, 1])
      expect(params[0]).toEqual({ requestID: RID, answers: [["Yes"]], directory: DIR })
      expect(replies).toHaveLength(1)
    }
    for (const label of ["transport", "closed"]) {
      let sdk = 0
      const conn = {
        isPrivateAvailable: () => true,
        privateQuestionReplyWithHandle: () => ({
          id: 1,
          promise: Promise.reject(new Error(label === "closed" ? "Peer closed" : "transport error")),
          cancel: () => true,
        }),
      } as unknown as QuestionContext["connection"]
      const { fake } = base({ origin: DIR, conn })
      const client = fake.client as unknown as { question: { reply: (a: unknown) => Promise<unknown> } }
      const orig = client.question.reply
      client.question.reply = async (a: unknown) => {
        sdk += 1
        return orig(a)
      }
      const ok = await handleQuestionReply(fake, RID, [["Yes"]], "ses-root")
      expect([label, ok]).toEqual([label, true])
      expect([label, sdk]).toEqual([label, 1])
    }
  })

  test("settled terminal after post-response drift still zero SDK", async () => {
    let sdk = 0
    const conn = {
      isPrivateAvailable: () => true,
      privateQuestionReplyWithHandle: (req: Record<string, unknown>) => ({
        id: 1,
        promise: Promise.resolve(terminalReply(req)),
        cancel: () => true,
      }),
    } as unknown as QuestionContext["connection"]
    const { fake, dirs } = base({ origin: DIR, conn })
    const client = fake.client as unknown as { question: { reply: (a: unknown) => Promise<unknown> } }
    const orig = client.question.reply
    client.question.reply = async (a: unknown) => {
      sdk += 1
      return orig(a)
    }
    const ok = await handleQuestionReply(fake, RID, [["Yes"]], "ses-root")
    expect(ok).toBeTrue()
    expect(sdk).toBe(0)
    expect(dirs.has(RID)).toBeFalse()
  })

  test("settled terminal-failure after post-response drift still zero SDK", async () => {
    let sdk = 0
    const conn = {
      isPrivateAvailable: () => true,
      privateQuestionReplyWithHandle: (req: Record<string, unknown>) => ({
        id: 1,
        promise: Promise.resolve(notFound(req)),
        cancel: () => true,
      }),
    } as unknown as QuestionContext["connection"]
    const { fake, messages, dirs } = base({ origin: DIR, conn })
    const client = fake.client as unknown as { question: { reply: (a: unknown) => Promise<unknown> } }
    const orig = client.question.reply
    client.question.reply = async (a: unknown) => {
      sdk += 1
      return orig(a)
    }
    const ok = await handleQuestionReply(fake, RID, [["Yes"]], "ses-root")
    expect(ok).toBeFalse()
    expect(sdk).toBe(0)
    expect(dirs.has(RID)).toBeFalse()
    expect(messages).toContainEqual({ type: "questionResolved", requestID: RID })
  })

  test("unresolved epoch drift takes exactly one SDK", async () => {
    let sdk = 0
    const drift = {
      isPrivateAvailable: () => true,
      privateQuestionReplyWithHandle: (req: Record<string, unknown>) => ({
        id: 1,
        promise: Promise.resolve(vague(req)),
        cancel: () => true,
      }),
    } as unknown as QuestionContext["connection"]
    const { fake } = base({ origin: DIR, conn: drift })
    const client = fake.client as unknown as { question: { reply: (a: unknown) => Promise<unknown> } }
    const orig = client.question.reply
    client.question.reply = async (a: unknown) => {
      sdk += 1
      return orig(a)
    }
    const ok = await handleQuestionReply(fake, RID, [["Yes"]], "ses-root")
    expect(ok).toBeTrue()
    expect(sdk).toBe(1)
  })

  test("malformed terminal with drift still falls back without fail-open", async () => {
    let sdk = 0
    const conn = {
      isPrivateAvailable: () => true,
      privateQuestionReplyWithHandle: (req: Record<string, unknown>) => ({
        id: 1,
        promise: Promise.resolve({ ...terminalReply(req), answers: "broken" }),
        cancel: () => true,
      }),
    } as unknown as QuestionContext["connection"]
    const { fake } = base({ origin: DIR, conn })
    const client = fake.client as unknown as { question: { reply: (a: unknown) => Promise<unknown> } }
    const orig = client.question.reply
    client.question.reply = async (a: unknown) => {
      sdk += 1
      return orig(a)
    }
    const ok = await handleQuestionReply(fake, RID, [["Yes"]], "ses-root")
    expect(ok).toBeTrue()
    expect(sdk).toBe(1)
  })

  test("timeout cancels exact id and takes exactly one SDK", async () => {
    let cancelled: number | null = null
    let sdk = 0
    const conn = {
      isPrivateAvailable: () => true,
      privateQuestionReplyWithHandle: () => ({
        id: 42,
        promise: new Promise(() => {}),
        cancel: () => {
          cancelled = 42
          return true
        },
      }),
    } as unknown as QuestionContext["connection"]
    const { fake } = base({ origin: DIR, conn })
    const client = fake.client as unknown as { question: { reply: (a: unknown) => Promise<unknown> } }
    const orig = client.question.reply
    client.question.reply = async (a: unknown) => {
      sdk += 1
      return orig(a)
    }
    const ok = await handleQuestionReply(fake, RID, [["Yes"]], "ses-root")
    expect(ok).toBeTrue()
    expect(sdk).toBe(1)
    expect(cancelled).toBe(42)
  })

  test("unavailable and missing capability each take exactly one SDK", async () => {
    {
      let sdk = 0
      const conn = {
        isPrivateAvailable: () => false,
        privateQuestionReplyWithHandle: () => {
          throw new Error("must not be called")
        },
      } as unknown as QuestionContext["connection"]
      const { fake } = base({ origin: DIR, conn })
      const client = fake.client as unknown as { question: { reply: (a: unknown) => Promise<unknown> } }
      const orig = client.question.reply
      client.question.reply = async (a: unknown) => {
        sdk += 1
        return orig(a)
      }
      await handleQuestionReply(fake, RID, [["Yes"]], "ses-root")
      expect(sdk).toBe(1)
    }
    {
      let sdk = 0
      const conn = {
        isPrivateAvailable: () => true,
        privateQuestionReplyWithHandle: () => {
          throw new Error("Private peer missing question/reply capability")
        },
      } as unknown as QuestionContext["connection"]
      const { fake } = base({ origin: DIR, conn })
      const client = fake.client as unknown as { question: { reply: (a: unknown) => Promise<unknown> } }
      const orig = client.question.reply
      client.question.reply = async (a: unknown) => {
        sdk += 1
        return orig(a)
      }
      await handleQuestionReply(fake, RID, [["Yes"]], "ses-root")
      expect(sdk).toBe(1)
    }
  })

  test("fallback 404 preserves stale and recover semantics", async () => {
    const notFoundErr = new Error("missing", { cause: { status: 404, body: { name: "NotFoundError" } } })
    const vagueConn = {
      isPrivateAvailable: () => true,
      privateQuestionReplyWithHandle: (req: Record<string, unknown>) => ({
        id: 1,
        promise: Promise.resolve(vague(req)),
        cancel: () => true,
      }),
      privateQuestionRejectWithHandle: (req: Record<string, unknown>) => ({
        id: 1,
        promise: Promise.resolve(vague(req)),
        cancel: () => true,
      }),
    } as unknown as QuestionContext["connection"]
    {
      const { fake, messages, dirs } = base({ origin: DIR, conn: vagueConn, replyError: notFoundErr })
      const ok = await handleQuestionReply(fake, RID, [["Yes"]], "ses-root")
      expect(ok).toBeFalse()
      expect(dirs.has(RID)).toBeFalse()
      expect(messages).toContainEqual({ type: "questionResolved", requestID: RID })
    }
    {
      const { fake, messages } = base({ conn: vagueConn, rejectError: notFoundErr, pending: {} })
      const ok = await handleQuestionReject(fake, RID, "ses-root")
      expect(ok).toBeFalse()
      expect(messages).toContainEqual({ type: "questionResolved", requestID: RID })
    }
  })
})
