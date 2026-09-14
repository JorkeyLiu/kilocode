import { describe, expect, test } from "bun:test"
import {
  buildNotebookListIdentity,
  buildNotebookRejectIdentity,
  buildNotebookReplyIdentity,
  listNotebooksPrivateFirst,
  rejectNotebookPrivateFirst,
  replyNotebookPrivateFirst,
} from "./notebook-privatefirst"
import {
  canonicalNotebookListOpId,
  canonicalNotebookOpId,
} from "../services/cli-backend/serve-private-notebook-contract"

const DIR = "/workspace/notebook-origin"
const RID = "nbr_test00000000000001"

const RESULT = {
  operation: "read",
  path: "b.ipynb",
  requestPath: "b.ipynb",
  revision: "content:2",
  cells: [],
} as unknown as import("@kilocode/sdk/v2/client").NotebookResult

const FAILURE = {
  code: "timeout",
  message: "timed out",
} as unknown as import("@kilocode/sdk/v2/client").NotebookFailure

function terminal(req: Record<string, unknown>) {
  return {
    kind: "terminal",
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    idempotencyKey: req.idempotencyKey,
    accepted: true,
    terminal: true,
    sessionID: "ses_root1",
    requestID: (req.context as Record<string, unknown>).requestID,
  }
}

function terminalFailure(req: Record<string, unknown>, code: string) {
  return {
    kind: "terminal-failure",
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    idempotencyKey: req.idempotencyKey,
    accepted: false,
    terminal: true,
    failure: { code, retryable: false, time: 1 },
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

function pendingEntry(id = RID) {
  return { id, sessionID: "ses_root1", operation: "read", path: "b.ipynb", includeOutputs: true }
}

function clientStub(
  opts: { replyError?: unknown; rejectError?: unknown; reply404?: boolean; pending?: unknown[] } = {},
) {
  const calls: { kind: string; args: unknown }[] = []
  const notFound = { status: 404, name: "NotFoundError" }
  const client = {
    kilocode: {
      notebook: {
        reply: async (args: unknown) => {
          calls.push({ kind: "reply", args })
          if (opts.replyError) throw opts.replyError
          if (opts.reply404) return { error: notFound }
          return { data: true }
        },
        reject: async (args: unknown) => {
          calls.push({ kind: "reject", args })
          if (opts.rejectError) throw opts.rejectError
          return { data: true }
        },
        list: async (args: unknown) => {
          calls.push({ kind: "list", args })
          return { data: opts.pending ?? [] }
        },
      },
    },
  }
  return { client, calls }
}

describe("notebook private-first", () => {
  test("identities bind the notebook tuple with opaque tokens", () => {
    const replyIds = buildNotebookReplyIdentity(RID)
    expect(replyIds.opId).toBe(replyIds.idempotencyKey)
    expect(replyIds.opId.startsWith(`notebook:${RID}:`)).toBeTrue()
    expect(canonicalNotebookOpId(RID, replyIds.opId.split(":")[2]!)).toBe(replyIds.opId)
    const rejectIds = buildNotebookRejectIdentity(RID)
    expect(rejectIds.opId.startsWith(`notebook:${RID}:`)).toBeTrue()
    const listIds = buildNotebookListIdentity()
    expect(listIds.opId).toBe(listIds.idempotencyKey)
    expect(canonicalNotebookListOpId(listIds.opId.split(":")[1]!)).toBe(listIds.opId)
  })

  test("private terminal reply settles with zero SDK calls", async () => {
    const seen: unknown[] = []
    const conn = {
      isPrivateAvailable: () => true,
      privateNotebookReplyWithHandle: (req: Record<string, unknown>) => {
        seen.push(req)
        return { id: 7, promise: Promise.resolve(terminal(req)), cancel: () => true }
      },
    } as never
    const { client, calls } = clientStub()
    const { outcome, req } = await replyNotebookPrivateFirst({
      connection: conn,
      client: client as never,
      directory: DIR,
      requestID: RID,
      result: RESULT,
    })
    expect(outcome).toEqual({ kind: "settled", stale: false })
    expect(calls).toHaveLength(0)
    expect(seen).toHaveLength(1)
    const sent = seen[0] as Record<string, unknown>
    expect(sent.op).toBe("notebook/reply")
    expect(sent.idempotencyKey).toBe(sent.opId)
    expect(String(sent.opId).startsWith(`notebook:${RID}:`)).toBeTrue()
    expect((sent.context as Record<string, unknown>).directory).toBe(DIR)
    expect((sent.context as Record<string, unknown>).requestID).toBe(RID)
    expect(req.context.directory).toBe(DIR)
  })

  test("private terminal reject settles with zero SDK calls", async () => {
    const conn = {
      isPrivateAvailable: () => true,
      privateNotebookRejectWithHandle: (req: Record<string, unknown>) => ({
        id: 3,
        promise: Promise.resolve(terminal(req)),
        cancel: () => true,
      }),
    } as never
    const { client, calls } = clientStub()
    const { outcome } = await rejectNotebookPrivateFirst({
      connection: conn,
      client: client as never,
      directory: DIR,
      requestID: RID,
      error: FAILURE,
    })
    expect(outcome).toEqual({ kind: "settled", stale: false })
    expect(calls).toHaveLength(0)
  })

  test("not_found returns stale accepted success with zero SDK", async () => {
    for (const op of ["reply", "reject"] as const) {
      const conn = {
        isPrivateAvailable: () => true,
        [op === "reply" ? "privateNotebookReplyWithHandle" : "privateNotebookRejectWithHandle"]: (
          req: Record<string, unknown>,
        ) => ({ id: 1, promise: Promise.resolve(terminalFailure(req, "notebook.not_found")), cancel: () => true }),
      } as never
      const { client, calls } = clientStub()
      const { outcome } =
        op === "reply"
          ? await replyNotebookPrivateFirst({
              connection: conn,
              client: client as never,
              directory: DIR,
              requestID: RID,
              result: RESULT,
            })
          : await rejectNotebookPrivateFirst({
              connection: conn,
              client: client as never,
              directory: DIR,
              requestID: RID,
              error: FAILURE,
            })
      expect(outcome).toEqual({ kind: "settled", stale: true })
      expect(calls).toHaveLength(0)
    }
  })

  test("invalid_reply and scope mismatch close with zero SDK as retry", async () => {
    for (const code of ["notebook.invalid_reply", "scope_mismatch"]) {
      const conn = {
        isPrivateAvailable: () => true,
        privateNotebookReplyWithHandle: (req: Record<string, unknown>) => ({
          id: 1,
          promise: Promise.resolve(terminalFailure(req, code)),
          cancel: () => true,
        }),
      } as never
      const { client, calls } = clientStub()
      const { outcome } = await replyNotebookPrivateFirst({
        connection: conn,
        client: client as never,
        directory: DIR,
        requestID: RID,
        result: RESULT,
      })
      expect(outcome).toEqual({ kind: "retry", code })
      expect(calls).toHaveLength(0)
    }
  })

  test("ambiguous private reply takes exactly one same-identity SDK call", async () => {
    const conn = {
      isPrivateAvailable: () => true,
      privateNotebookReplyWithHandle: (req: Record<string, unknown>) => ({
        id: 1,
        promise: Promise.resolve(vague(req)),
        cancel: () => true,
      }),
    } as never
    const { client, calls } = clientStub()
    const { outcome } = await replyNotebookPrivateFirst({
      connection: conn,
      client: client as never,
      directory: DIR,
      requestID: RID,
      result: RESULT,
    })
    expect(outcome).toEqual({ kind: "settled", stale: false })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.kind).toBe("reply")
    const args = calls[0]!.args as Record<string, unknown>
    expect(args.requestID).toBe(RID)
    expect(args.directory).toBe(DIR)
    expect(args.result).toBe(RESULT)
  })

  test("unavailable private takes the SDK path; SDK failure retries without private retry", async () => {
    const { client, calls } = clientStub({ replyError: new Error("offline") })
    const { outcome } = await replyNotebookPrivateFirst({
      connection: null,
      client: client as never,
      directory: DIR,
      requestID: RID,
      result: RESULT,
    })
    expect(outcome).toEqual({ kind: "retry" })
    expect(calls).toHaveLength(1)
  })

  test("SDK 404 for reply and reject returns stale accepted success", async () => {
    const { client, calls } = clientStub({ reply404: true })
    const reply = await replyNotebookPrivateFirst({
      connection: null,
      client: client as never,
      directory: DIR,
      requestID: RID,
      result: RESULT,
    })
    expect(reply.outcome).toEqual({ kind: "settled", stale: true })
    const reject404 = {
      kilocode: {
        notebook: {
          reply: async () => ({ data: true }),
          reject: async (args: unknown) => {
            calls.push({ kind: "reject", args })
            return { error: { status: 404 } }
          },
          list: async () => ({ data: [] }),
        },
      },
    }
    const reject = await rejectNotebookPrivateFirst({
      connection: null,
      client: reject404 as never,
      directory: DIR,
      requestID: RID,
      error: FAILURE,
    })
    expect(reject.outcome).toEqual({ kind: "settled", stale: true })
    expect(calls.filter((c) => c.kind === "reply")).toHaveLength(1)
    expect(calls.filter((c) => c.kind === "reject")).toHaveLength(1)
  })

  test("timeout cancels the private handle and falls back once", async () => {
    let cancelled = 0
    const conn = {
      isPrivateAvailable: () => true,
      privateNotebookReplyWithHandle: () => ({
        id: 9,
        promise: new Promise(() => {}),
        cancel: () => {
          cancelled += 1
          return true
        },
      }),
    } as never
    const { client, calls } = clientStub()
    const { outcome } = await replyNotebookPrivateFirst({
      connection: conn,
      client: client as never,
      directory: DIR,
      requestID: RID,
      result: RESULT,
    })
    expect(outcome).toEqual({ kind: "settled", stale: false })
    expect(cancelled).toBe(1)
    expect(calls).toHaveLength(1)
  })

  test("list returns private items per directory with zero SDK", async () => {
    const entries = [pendingEntry(), pendingEntry("nbr_other0000000002")]
    const seen: unknown[] = []
    const conn = {
      isPrivateAvailable: () => true,
      privateNotebookListWithHandle: (req: Record<string, unknown>) => {
        seen.push(req)
        return {
          id: 5,
          promise: Promise.resolve({
            kind: "valid",
            result: {
              v: 1,
              requestId: req.requestId,
              opId: req.opId,
              op: "notebook/list",
              idempotencyKey: req.idempotencyKey,
              status: "succeeded",
              outcome: { type: "succeeded", time: 1 },
              accepted: true,
              data: { notebooks: entries },
            },
          }),
          cancel: () => true,
        }
      },
    } as never
    const { client, calls } = clientStub()
    const { outcome, req } = await listNotebooksPrivateFirst({
      connection: conn,
      client: client as never,
      directory: DIR,
    })
    expect(outcome.kind).toBe("ok")
    if (outcome.kind === "ok") expect(outcome.items).toHaveLength(2)
    expect(calls).toHaveLength(0)
    expect((seen[0] as Record<string, unknown>).op).toBe("notebook/list")
    expect(req.context.directory).toBe(DIR)
  })

  test("list falls back to one SDK call on ambiguous private outcome", async () => {
    const entries = [pendingEntry()]
    const conn = {
      isPrivateAvailable: () => true,
      privateNotebookListWithHandle: (req: Record<string, unknown>) => ({
        id: 5,
        promise: Promise.resolve({
          kind: "valid",
          result: {
            v: 1,
            requestId: req.requestId,
            opId: req.opId,
            op: "notebook/list",
            idempotencyKey: req.idempotencyKey,
            status: "ambiguous",
            outcome: { type: "ambiguous", time: 1 },
            accepted: false,
            transportUnknown: true,
          },
        }),
        cancel: () => true,
      }),
    } as never
    const { client, calls } = clientStub({ pending: entries })
    const { outcome } = await listNotebooksPrivateFirst({ connection: conn, client: client as never, directory: DIR })
    expect(outcome.kind).toBe("ok")
    expect(calls).toHaveLength(1)
    expect((calls[0]!.args as Record<string, unknown>).directory).toBe(DIR)
  })

  test("list closes unknown when the SDK is unavailable", async () => {
    const { outcome } = await listNotebooksPrivateFirst({ connection: null, client: null, directory: DIR })
    expect(outcome).toEqual({ kind: "unknown" })
  })
})
