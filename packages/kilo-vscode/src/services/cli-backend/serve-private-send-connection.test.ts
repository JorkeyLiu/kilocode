import { describe, expect, test } from "bun:test"
import { commandSendHandle, promptSendHandle } from "./serve-private-send-connection"
import { canonicalPromptOpId } from "./serve-private-prompt-contract"
import { canonicalCommandOpId } from "./serve-private-command-contract"

const SID = "ses_send00000000000001"
const DIR = "/tmp/ws"
const MID = "msg_send00000000000001"

function promptReq() {
  const opId = canonicalPromptOpId(MID)
  return {
    v: 1 as const,
    requestId: "req-prompt",
    opId,
    op: "session/prompt" as const,
    idempotencyKey: opId,
    context: { directory: DIR, sessionId: SID, parentSessionId: null as string | null },
    payload: { messageId: MID, parts: [{ type: "text", text: "hi" }] },
  }
}

function commandReq() {
  const opId = canonicalCommandOpId(MID)
  return {
    v: 1 as const,
    requestId: "req-command",
    opId,
    op: "session/command" as const,
    idempotencyKey: opId,
    context: { directory: DIR, sessionId: SID, parentSessionId: null as string | null },
    payload: { messageId: MID, command: "probe", arguments: "hi" },
  }
}

function succeededPrompt(req: ReturnType<typeof promptReq>) {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "session/prompt",
    idempotencyKey: req.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: 1 },
    accepted: true,
    data: { accepted: true, messageId: MID, sessionId: SID },
  }
}

function succeededCommand(req: ReturnType<typeof commandReq>) {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "session/command",
    idempotencyKey: req.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: 1 },
    accepted: true,
    data: { accepted: true, messageId: MID, sessionId: SID },
  }
}

function peerFor(handle: { id: number; promise: Promise<never> }) {
  const peer = {
    invalidated: [] as string[],
    cancelled: [] as number[],
    cancelResult: true as boolean,
    cancelThrows: false as boolean,
    isAvailable: () => true,
    hasCapability: () => true,
    privatePromptWithHandle: (_r: unknown) => handle as never,
    privateCommandWithHandle: (_r: unknown) => handle as never,
    tryCancelPending: (id: number) => {
      peer.cancelled.push(id)
      if (peer.cancelThrows) throw new Error("cancel throw")
      return peer.cancelResult
    },
    invalidateOnObserverTimeout: (reason: string) => {
      peer.invalidated.push(reason)
    },
  }
  return peer
}

describe("send-connection prompt/command epoch helpers", () => {
  test("prompt preserves authoritative success without drift", async () => {
    const req = promptReq()
    const peer = peerFor({ id: 1, promise: Promise.resolve(succeededPrompt(req) as never) })
    const conn = { peer: peer as never, live: true, epoch: 7, invalidate: () => {} }
    const out = await promptSendHandle(conn, req).promise
    expect((out as { status?: string }).status).toBe("succeeded")
  })

  test("command preserves authoritative success without drift", async () => {
    const req = commandReq()
    const peer = peerFor({ id: 2, promise: Promise.resolve(succeededCommand(req) as never) })
    const conn = { peer: peer as never, live: true, epoch: 7, invalidate: () => {} }
    const out = await commandSendHandle(conn, req).promise
    expect((out as { status?: string }).status).toBe("succeeded")
  })

  test("prompt epoch drift maps to ambiguous transportUnknown", async () => {
    const req = promptReq()
    const peer = peerFor({ id: 3, promise: Promise.resolve(succeededPrompt(req) as never) })
    const conn = { peer: peer as never, live: true, epoch: 7, invalidate: () => {} }
    const handle = promptSendHandle(conn, req)
    conn.epoch = 8
    const out = (await handle.promise) as { status?: string; transportUnknown?: boolean }
    expect(out.status).toBe("ambiguous")
    expect(out.transportUnknown).toBeTrue()
  })

  test("command peer replacement maps to ambiguous transportUnknown", async () => {
    const req = commandReq()
    const peer = peerFor({ id: 4, promise: Promise.resolve(succeededCommand(req) as never) })
    const conn = { peer: peer as never, live: true, epoch: 7, invalidate: () => {} }
    const handle = commandSendHandle(conn, req)
    conn.peer = null as never
    const out = (await handle.promise) as { status?: string; transportUnknown?: boolean }
    expect(out.status).toBe("ambiguous")
    expect(out.transportUnknown).toBeTrue()
  })

  test("exact cancel success preserves owner, miss invalidates owner, stale cleans captured only", () => {
    const preq = promptReq()
    const peer = peerFor({ id: 11, promise: new Promise<never>(() => {}) })
    let ownerInvalidated = 0
    const conn = { peer: peer as never, live: true, epoch: 7, invalidate: () => { ownerInvalidated += 1 } }
    const handle = promptSendHandle(conn, preq)
    expect(handle.cancel("t")).toBeTrue()
    expect(ownerInvalidated).toBe(0)
    expect(peer.cancelled).toEqual([11])

    peer.cancelResult = false
    expect(handle.cancel("t")).toBeFalse()
    expect(ownerInvalidated).toBe(1)

    peer.cancelResult = true
    peer.cancelThrows = true
    expect(handle.cancel("t")).toBeFalse()
    expect(ownerInvalidated).toBe(2)

    const stalePeer = peerFor({ id: 12, promise: new Promise<never>(() => {}) })
    const staleConn = { peer: stalePeer as never, live: true, epoch: 7, invalidate: () => { ownerInvalidated += 1 } }
    const staleHandle = commandSendHandle(staleConn, commandReq())
    staleConn.epoch = 8
    const before = ownerInvalidated
    expect(staleHandle.cancel("t")).toBeFalse()
    expect(ownerInvalidated).toBe(before)
    expect(stalePeer.invalidated.length).toBe(1)
  })

  test("unavailable peer and missing capability throw before allocation", () => {
    const preq = promptReq()
    expect(() => promptSendHandle({ peer: null, live: true, epoch: 7, invalidate: () => {} }, preq)).toThrow("Private peer unavailable")
    const dead = { ...peerFor({ id: 1, promise: Promise.resolve({} as never) }), isAvailable: () => false }
    expect(() => commandSendHandle({ peer: dead as never, live: true, epoch: 7, invalidate: () => {} }, commandReq())).toThrow("Private peer unavailable")
    const nocap = { ...peerFor({ id: 1, promise: Promise.resolve({} as never) }), hasCapability: () => false }
    expect(() => promptSendHandle({ peer: nocap as never, live: true, epoch: 7, invalidate: () => {} }, preq)).toThrow("capability")
  })
})
