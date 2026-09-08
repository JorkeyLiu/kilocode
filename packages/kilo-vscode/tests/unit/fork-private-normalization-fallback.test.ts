import { describe, expect, it, mock } from "bun:test"
import { PassThrough } from "stream"
import type { Session } from "@kilocode/sdk/v2/client"
import type { KiloClient } from "@kilocode/sdk/v2/client"
import { JsonRpcPeer } from "../../src/private-worker/peer"
import { ServePrivatePeer, type ServePrivateForkRequest } from "../../src/services/cli-backend/serve-private-peer"
import { forkSessionPrivateFirst } from "../../src/kilo-provider/fork-session"

function createLinkedChannel(handler: (method: string, params: unknown) => unknown | Promise<unknown>): {
  clientReader: PassThrough
  clientWriter: PassThrough
  backendPeer: JsonRpcPeer
} {
  const toClient = new PassThrough()
  const toBackend = new PassThrough()
  const backendPeer = new JsonRpcPeer({
    reader: toBackend,
    writer: toClient,
    onRequest: handler as unknown as (m: string, p: unknown) => unknown,
  })
  return { clientReader: toClient, clientWriter: toBackend, backendPeer }
}

function makeReq(): ServePrivateForkRequest {
  return {
    v: 1,
    requestId: "req1",
    opId: "fork:ses_src:tok",
    op: "session/fork",
    idempotencyKey: "fork:ses_src:tok",
    context: { directory: "/tmp", sessionId: "ses_src", parentSessionId: null },
    payload: {},
  }
}

function validFailed(retryable: boolean, code = "session.not_found") {
  return {
    v: 1,
    requestId: "req1",
    opId: "fork:ses_src:tok",
    op: "session/fork",
    idempotencyKey: "fork:ses_src:tok",
    status: "failed",
    outcome: { type: "failed", time: Date.now(), failure: { code, message: code, retryable } },
    accepted: false,
    failure: { code, message: code, retryable },
  }
}

async function makePeer(handler: (method: string, params: unknown) => unknown | Promise<unknown>): Promise<ServePrivatePeer> {
  const { clientReader, clientWriter } = createLinkedChannel(handler)
  const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, pid: 1, epoch: 1, initializeTimeoutMs: 500 })
  const ok = await peer.initialize(1000)
  expect(ok).toBeTrue()
  return peer
}

function makeSdkSession() {
  return { id: "ses_sdk_fork", parentID: "ses_src", directory: "/repo", title: "forked" } as unknown as Session
}

describe("fork private normalization closes failure classification", () => {
  it("invalid wire normalizes to ambiguous, never terminal failed", async () => {
    const peer = await makePeer(async (method) => {
      if (method === "initialize") {
        return { protocol: { name: "kilo-private", major: 1, minor: 0 }, serverInfo: { name: "kilo", version: "1" }, capabilities: ["session/fork"] }
      }
      return {
        v: 1,
        requestId: "req1",
        opId: "fork:ses_src:tok",
        op: "session/fork",
        idempotencyKey: "fork:ses_src:tok",
        status: "succeeded",
        outcome: { type: "succeeded", time: Date.now() },
        accepted: true,
        data: { session: null },
      }
    })
    try {
      const out = await peer.privateFork(makeReq())
      expect(out.status).toBe("ambiguous")
      expect(out.accepted).toBeFalse()
    } finally {
      peer.dispose()
    }
  })

  it("transport error normalizes to ambiguous, never terminal failed", async () => {
    const peer = await makePeer(async (method) => {
      if (method === "initialize") {
        return { protocol: { name: "kilo-private", major: 1, minor: 0 }, serverInfo: { name: "kilo", version: "1" }, capabilities: ["session/fork"] }
      }
      throw new Error("boom-transport")
    })
    try {
      const out = await peer.privateFork(makeReq())
      expect(out.status).toBe("ambiguous")
      expect(out.accepted).toBeFalse()
    } finally {
      peer.dispose()
    }
  })

  it("validated failed retryable false stays terminal, retryable true stays fallback-class", async () => {
    const terminal = await (async () => {
      const peer = await makePeer(async (method) => {
        if (method === "initialize") {
          return { protocol: { name: "kilo-private", major: 1, minor: 0 }, serverInfo: { name: "kilo", version: "1" }, capabilities: ["session/fork"] }
        }
        return validFailed(false)
      })
      try {
        return await peer.privateFork(makeReq())
      } finally {
        peer.dispose()
      }
    })()
    expect(terminal.status).toBe("failed")
    if (terminal.status === "failed") expect(terminal.failure.retryable).toBeFalse()

    const retryable = await (async () => {
      const peer = await makePeer(async (method) => {
        if (method === "initialize") {
          return { protocol: { name: "kilo-private", major: 1, minor: 0 }, serverInfo: { name: "kilo", version: "1" }, capabilities: ["session/fork"] }
        }
        return validFailed(true, "internal")
      })
      try {
        return await peer.privateFork(makeReq())
      } finally {
        peer.dispose()
      }
    })()
    expect(retryable.status).toBe("failed")
    if (retryable.status === "failed") expect(retryable.failure.retryable).toBeTrue()
  })

  it("real normalized ambiguous falls back to exactly one SDK with same tuple", async () => {
    const peer = await makePeer(async (method) => {
      if (method === "initialize") {
        return { protocol: { name: "kilo-private", major: 1, minor: 0 }, serverInfo: { name: "kilo", version: "1" }, capabilities: ["session/fork"] }
      }
      throw new Error("boom-transport")
    })
    let normalized: unknown
    try {
      normalized = await peer.privateFork(makeReq())
    } finally {
      peer.dispose()
    }
    expect((normalized as { status: string }).status).toBe("ambiguous")

    const sdk = mock(async () => ({ data: makeSdkSession(), error: undefined }))
    const client = { session: { fork: sdk } } as unknown as KiloClient
    let req: Record<string, unknown> | null = null
    const conn = {
      isPrivateAvailable: () => true,
      privateForkWithHandle: (r: unknown) => {
        req = r as Record<string, unknown>
        return { id: 1, promise: Promise.resolve(normalized), cancel: () => true }
      },
      peekPrivatePeerNextId: () => 1,
      tryCancelPrivatePending: () => true,
      invalidatePrivatePeerOnObserverTimeout: () => {},
    } as unknown as never
    const sess = await forkSessionPrivateFirst({ client, connection: conn as never, sessionId: "ses_src", directory: "/repo" })
    expect((sess as unknown as { id: string }).id).toBe("ses_sdk_fork")
    expect(sdk).toHaveBeenCalledTimes(1)
    const input = sdk.mock.calls[0]![0] as Record<string, unknown>
    expect(input.opId).toBe(req?.opId)
    expect(input.idempotencyKey).toBe(req?.idempotencyKey)
    expect(input.requestId).toBe(req?.requestId)
  })

  it("real normalized terminal failed closes with zero SDK", async () => {
    const peer = await makePeer(async (method) => {
      if (method === "initialize") {
        return { protocol: { name: "kilo-private", major: 1, minor: 0 }, serverInfo: { name: "kilo", version: "1" }, capabilities: ["session/fork"] }
      }
      return validFailed(false, "session.not_found")
    })
    let normalized: unknown
    try {
      normalized = await peer.privateFork(makeReq())
    } finally {
      peer.dispose()
    }
    expect((normalized as { status: string }).status).toBe("failed")

    const sdk = mock(async () => ({ data: makeSdkSession(), error: undefined }))
    const client = { session: { fork: sdk } } as unknown as KiloClient
    const conn = {
      isPrivateAvailable: () => true,
      privateForkWithHandle: (r: unknown) => {
        const req = r as Record<string, unknown>
        const terminal = {
          ...(normalized as Record<string, unknown>),
          requestId: req.requestId,
          opId: req.opId,
          idempotencyKey: req.idempotencyKey,
          outcome: {
            ...((normalized as Record<string, unknown>).outcome as Record<string, unknown>),
          },
        }
        const failure = { code: "session.not_found", message: "session.not_found", retryable: false }
        ;(terminal.outcome as Record<string, unknown>).failure = failure
        ;(terminal as Record<string, unknown>).failure = failure
        return { id: 1, promise: Promise.resolve(terminal), cancel: () => true }
      },
      peekPrivatePeerNextId: () => 1,
      tryCancelPrivatePending: () => true,
      invalidatePrivatePeerOnObserverTimeout: () => {},
    } as unknown as never
    await expect(forkSessionPrivateFirst({ client, connection: conn as never, sessionId: "ses_src", directory: "/repo" })).rejects.toThrow("session.not_found")
    expect(sdk).toHaveBeenCalledTimes(0)
  })
})
