import { describe, expect, test, spyOn } from "bun:test"
import {
  handlePermissionResponse,
  type PermissionContext,
} from "./handlers/permission-handler"
import {
  buildPermissionReplyIdentity,
  buildPermissionSaveIdentity,
  replyPermissionPrivateFirst,
} from "./permission-privatefirst"
import {
  canonicalPermissionOpId,
  validatePermissionReplyContractRequest,
  validatePermissionSaveContractRequest,
} from "../services/cli-backend/serve-private-permission-contract"

const DIR = "/workspace/perm-origin"
const PID = "per_test00000000000000001"

function terminalSave(req: Record<string, unknown>) {
  return {
    kind: "terminal",
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    idempotencyKey: req.idempotencyKey,
    accepted: true,
    terminal: true,
    requestID: (req.context as Record<string, unknown>).requestID,
  }
}

function terminalReply(req: Record<string, unknown>, reply: string = "once") {
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
    reply,
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
    failure: { code: "permission.not_found", retryable: false, time: 1 },
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

const notFoundErr = Object.assign(new Error("not found"), { data: { status: 404 } })

function base(opts: {
  origin?: string
  pending?: Record<string, Array<{ id: string; sessionID: string }>>
  conn?: PermissionContext["connection"]
  saveError?: unknown
  replyError?: unknown
}) {
  const messages: unknown[] = []
  const saves: unknown[] = []
  const replies: unknown[] = []
  const dirs = new Map<string, string>()
  const client = {
    permission: {
      list: async (args: { directory?: string }) => ({ data: opts.pending?.[args.directory ?? ""] ?? [], error: undefined }),
      saveAlwaysRules: async (args: unknown) => {
        saves.push(args)
        if (opts.saveError) throw opts.saveError
        return { data: true }
      },
      reply: async (args: unknown) => {
        replies.push(args)
        if (opts.replyError) throw opts.replyError
        return { data: true }
      },
    },
  } as unknown as PermissionContext["client"]
  const fake: PermissionContext = {
    client,
    currentSessionId: "ses-root",
    trackedSessionIds: new Set(["ses-root"]),
    sessionDirectories: new Map([["ses-root", DIR]]),
    connection: opts.conn,
    postMessage: (msg) => messages.push(msg),
    getWorkspaceDirectory: () => DIR,
    recordPermissionDirectory: (id, dir) => dirs.set(id, dir),
    getPermissionDirectory: (id) => dirs.get(id),
    clearPermissionDirectory: (id) => dirs.delete(id),
    prunePermissionDirectories: (active, valid) => {
      for (const [id, dir] of dirs) {
        if (active.has(id)) continue
        if (valid && !valid.has(dir)) continue
        dirs.delete(id)
      }
    },
  }
  if (opts.origin) dirs.set(PID, opts.origin)
  return { fake, messages, saves, replies, dirs }
}

describe("permission private-first", () => {
  test("identity binds permission tuple and validators accept it", () => {
    const saveIds = buildPermissionSaveIdentity(PID)
    expect(saveIds.opId).toBe(saveIds.idempotencyKey)
    expect(saveIds.opId.startsWith(`permission:${PID}:`)).toBeTrue()
    const replyIds = buildPermissionReplyIdentity(PID)
    expect(replyIds.opId.startsWith(`permission:${PID}:`)).toBeTrue()
    const token = saveIds.opId.split(":")[2]!
    expect(canonicalPermissionOpId(PID, token)).toBe(saveIds.opId)
    const saveReq = {
      v: 1,
      requestId: saveIds.requestId,
      opId: saveIds.opId,
      op: "permission/save-always-rules",
      idempotencyKey: saveIds.idempotencyKey,
      context: { directory: DIR, requestID: PID },
      payload: { approvedAlways: ["npm install lodash"] },
    }
    expect(() => validatePermissionSaveContractRequest(saveReq)).not.toThrow()
    const replyReq = {
      v: 1,
      requestId: replyIds.requestId,
      opId: replyIds.opId,
      op: "permission/reply",
      idempotencyKey: replyIds.idempotencyKey,
      context: { directory: DIR, requestID: PID },
      payload: { reply: "once" },
    }
    expect(() => validatePermissionReplyContractRequest(replyReq)).not.toThrow()
  })

  test("private success for both ordered steps uses zero SDK", async () => {
    const seen: string[] = []
    const conn = {
      isPrivateAvailable: () => true,
      privatePermissionSaveWithHandle: (req: Record<string, unknown>) => {
        seen.push("save")
        return { id: 1, promise: Promise.resolve(terminalSave(req)), cancel: () => true }
      },
      privatePermissionReplyWithHandle: (req: Record<string, unknown>) => {
        seen.push("reply")
        return { id: 2, promise: Promise.resolve(terminalReply(req, "once")), cancel: () => true }
      },
    } as unknown as PermissionContext["connection"]
    const { fake, messages, saves, replies } = base({ origin: DIR, conn })
    await handlePermissionResponse(fake, PID, "ses-root", "once", ["npm install lodash"], [])
    expect(seen).toEqual(["save", "reply"])
    expect(saves).toHaveLength(0)
    expect(replies).toHaveLength(0)
    expect(messages).not.toContainEqual({ type: "permissionError", permissionID: PID })
  })

  test("save ambiguous falls back to exactly one SDK save then private reply", async () => {
    const order: string[] = []
    const conn = {
      isPrivateAvailable: () => true,
      privatePermissionSaveWithHandle: (req: Record<string, unknown>) => {
        order.push("private-save")
        return { id: 1, promise: Promise.resolve(vague(req)), cancel: () => true }
      },
      privatePermissionReplyWithHandle: (req: Record<string, unknown>) => {
        order.push("private-reply")
        return { id: 2, promise: Promise.resolve(terminalReply(req, "once")), cancel: () => true }
      },
    } as unknown as PermissionContext["connection"]
    const { fake, saves, replies } = base({ origin: DIR, conn })
    await handlePermissionResponse(fake, PID, "ses-root", "once", ["npm install lodash"], [])
    expect(order).toEqual(["private-save", "private-reply"])
    expect(saves).toHaveLength(1)
    expect(replies).toHaveLength(0)
    expect(saves[0]).toEqual({ requestID: PID, directory: DIR, approvedAlways: ["npm install lodash"], deniedAlways: [] })
  })

  test("reply ambiguous falls back to exactly one SDK reply", async () => {
    const conn = {
      isPrivateAvailable: () => true,
      privatePermissionReplyWithHandle: (req: Record<string, unknown>) => ({
        id: 1,
        promise: Promise.resolve(vague(req)),
        cancel: () => true,
      }),
    } as unknown as PermissionContext["connection"]
    const { fake, saves, replies } = base({ origin: DIR, conn })
    await handlePermissionResponse(fake, PID, "ses-root", "once", [], [])
    expect(saves).toHaveLength(0)
    expect(replies).toHaveLength(1)
    expect(replies[0]).toEqual({ requestID: PID, reply: "once", directory: DIR })
  })

  test("save terminal not_found short-circuits reply with stale recovery and zero SDK", async () => {
    const conn = {
      isPrivateAvailable: () => true,
      privatePermissionSaveWithHandle: (req: Record<string, unknown>) => ({
        id: 1,
        promise: Promise.resolve(notFound(req)),
        cancel: () => true,
      }),
      privatePermissionReplyWithHandle: () => {
        throw new Error("reply must not execute after terminal save")
      },
    } as unknown as PermissionContext["connection"]
    const { fake, messages, saves, replies, dirs } = base({ origin: DIR, conn, pending: {} })
    await handlePermissionResponse(fake, PID, "ses-root", "once", ["npm install lodash"], [])
    expect(saves).toHaveLength(0)
    expect(replies).toHaveLength(0)
    expect(dirs.has(PID)).toBeFalse()
    expect(messages).toContainEqual({ type: "permissionError", permissionID: PID, stale: true })
  })

  test("save terminal scope_mismatch short-circuits with error and zero SDK", async () => {
    const conn = {
      isPrivateAvailable: () => true,
      privatePermissionSaveWithHandle: (req: Record<string, unknown>) => ({
        id: 1,
        promise: Promise.resolve(scopeMismatch(req)),
        cancel: () => true,
      }),
      privatePermissionReplyWithHandle: () => {
        throw new Error("reply must not execute after terminal save")
      },
    } as unknown as PermissionContext["connection"]
    const { fake, messages, saves, replies, dirs } = base({ origin: DIR, conn })
    const spy = spyOn(console, "error").mockImplementation(() => {})
    await handlePermissionResponse(fake, PID, "ses-root", "once", ["x"], [])
    spy.mockRestore()
    expect(saves).toHaveLength(0)
    expect(replies).toHaveLength(0)
    expect(dirs.get(PID)).toBe(DIR)
    expect(messages).toContainEqual({ type: "permissionError", permissionID: PID })
  })

  test("reply terminal not_found triggers stale recovery with zero SDK", async () => {
    const conn = {
      isPrivateAvailable: () => true,
      privatePermissionReplyWithHandle: (req: Record<string, unknown>) => ({
        id: 1,
        promise: Promise.resolve(notFound(req)),
        cancel: () => true,
      }),
    } as unknown as PermissionContext["connection"]
    const { fake, messages, replies, dirs } = base({ origin: DIR, conn, pending: {} })
    await handlePermissionResponse(fake, PID, "ses-root", "reject", [], [])
    expect(replies).toHaveLength(0)
    expect(dirs.has(PID)).toBeFalse()
    expect(messages).toContainEqual({ type: "permissionError", permissionID: PID, stale: true })
  })

  test("SDK save stale still recovers when private unavailable", async () => {
    const { fake, messages, saves, replies, dirs } = base({ origin: DIR, saveError: notFoundErr, pending: {} })
    await handlePermissionResponse(fake, PID, "ses-root", "once", ["npm install lodash"], [])
    expect(saves).toHaveLength(1)
    expect(replies).toHaveLength(0)
    expect(dirs.has(PID)).toBeFalse()
    expect(messages).toContainEqual({ type: "permissionError", permissionID: PID, stale: true })
  })

  test("timeout cancels the exact pending and falls back once", async () => {
    let cancelled: string[] = []
    const conn = {
      isPrivateAvailable: () => true,
      privatePermissionReplyWithHandle: (_req: Record<string, unknown>) => ({
        id: 9,
        promise: Promise.reject(new Error("private permission timeout after 3000ms")),
        cancel: (msg?: string) => {
          cancelled.push(String(msg))
          return true
        },
      }),
    } as unknown as PermissionContext["connection"]
    const { fake, replies } = base({ origin: DIR, conn })
    await handlePermissionResponse(fake, PID, "ses-root", "once", [], [])
    expect(replies).toHaveLength(1)
    expect(cancelled).toHaveLength(1)
  })

  test("toggle once path uses private-first reply with zero SDK on terminal", async () => {
    const seen: unknown[] = []
    const conn = {
      isPrivateAvailable: () => true,
      privatePermissionReplyWithHandle: (req: Record<string, unknown>) => {
        seen.push(req)
        return { id: 4, promise: Promise.resolve(terminalReply(req, "once")), cancel: () => true }
      },
    } as unknown as Parameters<typeof replyPermissionPrivateFirst>[0]["connection"]
    const out = await replyPermissionPrivateFirst({ connection: conn, directory: DIR, requestID: PID, reply: "once" })
    expect(out.outcome).toEqual({ kind: "terminal" })
    expect(seen).toHaveLength(1)
    const req = seen[0] as Record<string, unknown>
    expect(req.op).toBe("permission/reply")
    expect(req.idempotencyKey).toBe(req.opId)
    expect(String(req.opId).startsWith(`permission:${PID}:`)).toBeTrue()
    expect((req.payload as Record<string, unknown>).reply).toBe("once")
  })

  test("toggle drain preserves once semantics across mixed terminal and fallback", async () => {
    const calls: string[] = []
    let sdk = 0
    const mkConn = (mode: "terminal" | "not_found" | "ambiguous") =>
      ({
        isPrivateAvailable: () => true,
        privatePermissionReplyWithHandle: (req: Record<string, unknown>) => {
          calls.push(mode)
          if (mode === "terminal") return { id: 1, promise: Promise.resolve(terminalReply(req, "once")), cancel: () => true }
          if (mode === "not_found") return { id: 1, promise: Promise.resolve(notFound(req)), cancel: () => true }
          return { id: 1, promise: Promise.resolve(vague(req)), cancel: () => true }
        },
      }) as unknown as Parameters<typeof replyPermissionPrivateFirst>[0]["connection"]
    for (const mode of ["terminal", "not_found", "ambiguous"] as const) {
      const out = await replyPermissionPrivateFirst({ connection: mkConn(mode), directory: DIR, requestID: PID, reply: "once" })
      if (mode === "terminal") expect(out.outcome).toEqual({ kind: "terminal" })
      if (mode === "not_found") expect(out.outcome).toEqual({ kind: "terminal-failure", code: "permission.not_found" })
      if (mode === "ambiguous") {
        expect(out.outcome.kind).toBe("fallback")
        sdk += 1
      }
    }
    expect(calls).toEqual(["terminal", "not_found", "ambiguous"])
    expect(sdk).toBe(1)
  })
})
