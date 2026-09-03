import { describe, expect, test } from "bun:test"
import { createHash } from "crypto"
import { PassThrough } from "stream"
import { JsonRpcPeer } from "../../private-worker/peer"
import {
  ServePrivatePeer,
  canonicalMessagesOpId,
  validateMessagesRequest,
  validateMessagesResult,
  normalizePrivateMessagesWire,
  compareMessagesParity,
  isPrivateMessagesValidationError,
} from "./serve-private-peer"
import {
  buildSessionMessagesIdentity,
  observeSessionMessagesParityDetached,
  sdkMessagesHasTerminal,
  type MessagesParityConnection,
} from "../../kilo-provider/session-messages-parity"

function createLinkedChannel(handler: (method: string, params: unknown) => unknown | Promise<unknown>) {
  const toClient = new PassThrough()
  const toBackend = new PassThrough()
  const backendPeer = new JsonRpcPeer({
    reader: toBackend,
    writer: toClient,
    onRequest: handler as unknown as (m: string, p: unknown) => unknown,
  })
  return { clientReader: toClient, clientWriter: toBackend, backendPeer }
}

function makeReq(over: Record<string, unknown> = {}) {
  const sessionId = "ses_abc"
  const opId = canonicalMessagesOpId(sessionId, "tok1")
  return {
    v: 1 as const,
    requestId: "r1",
    opId,
    op: "session/messages" as const,
    idempotencyKey: opId,
    context: { directory: "/tmp", sessionId },
    payload: {},
    ...over,
  }
}

function msgItem(id: string, created: number) {
  return { info: { id, sessionID: "ses_abc", role: "user", time: { created } }, parts: [] }
}

function makeSuccess(req: ReturnType<typeof makeReq>, messages: unknown[] = [], nextCursor?: string) {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "session/messages",
    idempotencyKey: req.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: 1 },
    accepted: true,
    data: nextCursor !== undefined ? { messages, nextCursor } : { messages },
  }
}

function makeFailed(req: ReturnType<typeof makeReq>, code: string) {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "session/messages",
    idempotencyKey: req.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time: 1, failure: { code, message: "x", retryable: false } },
    accepted: false,
    failure: { code, message: "x", retryable: false },
  }
}

function sdkSuccess(items: unknown[], cursor: string | null) {
  return {
    data: items,
    error: undefined,
    response: { status: 200, headers: { get: (k: string) => (k === "X-Next-Cursor" ? cursor : null) } },
  }
}

describe("B7 session/messages private peer", () => {
  test("canonicalMessagesOpId binds session and token strictly", () => {
    expect(canonicalMessagesOpId("ses_a", "t1")).toBe("messages:ses_a:t1")
    expect(() => canonicalMessagesOpId("ses_a", "")).toThrow()
    expect(() => canonicalMessagesOpId("ses_a", "a:b")).toThrow()
    expect(() => canonicalMessagesOpId("", "t1")).toThrow()
    expect(() => canonicalMessagesOpId("ses:a", "t1")).toThrow()
    expect(buildSessionMessagesIdentity("ses_a").opId.startsWith("messages:ses_a:")).toBeTrue()
    const ident = buildSessionMessagesIdentity("ses_a")
    expect(ident.idempotencyKey).toBe(ident.opId)
  })

  test("validateMessagesRequest accepts strict shape and rejects violations", () => {
    const req = makeReq()
    expect(() => validateMessagesRequest(req)).not.toThrow()
    expect(() => validateMessagesRequest(makeReq({ payload: { limit: 0 } }))).not.toThrow()
    expect(() => validateMessagesRequest(makeReq({ payload: { limit: 2 } }))).not.toThrow()
    expect(() => validateMessagesRequest(makeReq({ payload: { limit: 2, before: "cur" } }))).not.toThrow()
    expect(() => validateMessagesRequest({ ...req, opId: "messages:ses_other:tok1" })).toThrow()
    expect(() => validateMessagesRequest({ ...req, idempotencyKey: "messages:ses_abc:other" })).toThrow()
    expect(() => validateMessagesRequest({ ...req, context: { directory: "relative", sessionId: "ses_abc" } })).toThrow()
    expect(() => validateMessagesRequest({ ...req, context: { directory: "/tmp", sessionId: "bad" } })).toThrow()
    expect(() => validateMessagesRequest(makeReq({ payload: { before: "cur" } }))).toThrow()
    expect(() => validateMessagesRequest(makeReq({ payload: { limit: 0, before: "cur" } }))).not.toThrow()
    expect(() => validateMessagesRequest(makeReq({ payload: { limit: -1 } }))).toThrow()
    expect(() => validateMessagesRequest(makeReq({ payload: { limit: 1.5 } }))).toThrow()
    expect(() => validateMessagesRequest(makeReq({ payload: { limit: "2" } }))).toThrow()
    expect(() => validateMessagesRequest(makeReq({ payload: { limit: 2, before: "" } }))).toThrow()
    expect(() => validateMessagesRequest(makeReq({ payload: { limit: 2, revision: 1 } }))).toThrow()
    expect(() => validateMessagesRequest({ ...req, context: { directory: "/tmp", sessionId: "ses_abc", extra: 1 } })).toThrow()
    expect(() => validateMessagesRequest({ ...req, extra: 1 })).toThrow()
  })

  test("validateMessagesResult enforces per-status shape", () => {
    const req = makeReq()
    expect(() => validateMessagesResult(makeSuccess(req, [msgItem("msg_1", 1)]), req)).not.toThrow()
    expect(() => validateMessagesResult(makeSuccess(req, [], "cur1"), req)).not.toThrow()
    expect(() => validateMessagesResult({ ...makeSuccess(req, []), requestId: "r2" }, req)).toThrow()
    expect(() => validateMessagesResult({ ...makeSuccess(req, []), data: { messages: {}, } }, req)).toThrow()
    expect(() => validateMessagesResult({ ...makeSuccess(req, []), data: { messages: [], nextCursor: 1 } }, req)).toThrow()
    expect(() => validateMessagesResult({ ...makeSuccess(req, []), data: { messages: [], extra: 1 } }, req)).toThrow()
    expect(() => validateMessagesResult({ ...makeSuccess(req, []), data: { messages: ["x"] } }, req)).toThrow()
    const failed = makeFailed(req, "session.not_found")
    expect(() => validateMessagesResult(failed, req)).not.toThrow()
    const ambiguous = {
      v: 1,
      requestId: req.requestId,
      opId: req.opId,
      op: "session/messages",
      idempotencyKey: req.idempotencyKey,
      status: "ambiguous",
      outcome: { type: "ambiguous", time: 1 },
      accepted: false,
      transportUnknown: true,
    }
    expect(() => validateMessagesResult(ambiguous, req)).not.toThrow()
    // Revision fields are never accepted.
    expect(() => validateMessagesResult({ ...makeSuccess(req, []), revision: { session: 1, config: 1 } }, req)).toThrow()
  })

  test("compareMessagesParity matches exact page and reports warn-only observation divergence without sensitive values", () => {
    const req = makeReq()
    const items = [msgItem("msg_1", 1), msgItem("msg_2", 2)]
    const priv = makeSuccess(req, items) as unknown as Parameters<typeof compareMessagesParity>[0]
    const sdk = sdkSuccess(items, null) as unknown as Parameters<typeof compareMessagesParity>[1]
    expect(compareMessagesParity(priv, sdk).divergence).toBeNull()
    // Count mismatch is observation divergence with counts only.
    const fewer = makeSuccess(req, [msgItem("msg_1", 1)]) as unknown as Parameters<typeof compareMessagesParity>[0]
    const countRes = compareMessagesParity(fewer, sdk)
    expect(countRes.divergence).toBe("observation-divergence:count-mismatch")
    expect(JSON.stringify(countRes.details).includes("msg_1")).toBeFalse()
    // Order mismatch is observation divergence, never content.
    const reordered = makeSuccess(req, [msgItem("msg_2", 2), msgItem("msg_1", 1)]) as unknown as Parameters<typeof compareMessagesParity>[0]
    const orderRes = compareMessagesParity(reordered, sdk)
    expect(orderRes.divergence).toBe("observation-divergence:order-mismatch")
    expect(JSON.stringify(orderRes.details).includes("msg_")).toBeFalse()
    // Cursor presence mismatch is observation divergence without cursor values.
    const cursorPriv = makeSuccess(req, items, "secret-cursor-1") as unknown as Parameters<typeof compareMessagesParity>[0]
    const cursorRes = compareMessagesParity(cursorPriv, sdk)
    expect(cursorRes.divergence).toBe("observation-divergence:cursor-mismatch")
    expect(JSON.stringify(cursorRes.details).includes("secret-cursor-1")).toBeFalse()
    // Failure classes map like B6.
    const sdk404 = { error: { status: 404 }, response: { status: 404 } } as unknown as Parameters<typeof compareMessagesParity>[1]
    const priv404 = makeFailed(req, "session.not_found") as unknown as Parameters<typeof compareMessagesParity>[0]
    expect(compareMessagesParity(priv404, sdk404).divergence).toBeNull()
    const privWrong = makeFailed(req, "internal") as unknown as Parameters<typeof compareMessagesParity>[0]
    const wrong = compareMessagesParity(privWrong, sdk404)
    expect(wrong.divergence).toContain("failure-class-mismatch")
    expect(JSON.stringify(wrong.details).includes("msg_")).toBeFalse()
  })

  test("peer capability gating requires session/messages", async () => {
    const { clientReader, clientWriter, backendPeer } = createLinkedChannel(() => ({ v: 1 }))
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, epoch: 1 })
    // Force available without initialize: inject a peer with get-capability only.
    ;(peer as unknown as Record<string, unknown>).available = true
    ;(peer as unknown as Record<string, unknown>).peer = new JsonRpcPeer({ reader: clientReader, writer: clientWriter })
    ;(peer as unknown as Record<string, unknown>).capabilities = ["session/get"]
    const req = makeReq()
    expect(() => (peer as unknown as { privateMessagesWithHandle: (r: unknown) => unknown }).privateMessagesWithHandle(req)).toThrow(
      "Private peer missing session/messages capability",
    )
    expect(() => (peer as unknown as { privateMessagesOutcomeWithHandle: (r: unknown) => unknown }).privateMessagesOutcomeWithHandle(req)).toThrow(
      "Private peer missing session/messages capability",
    )
    peer.dispose()
    backendPeer.dispose()
    clientReader.destroy()
    clientWriter.destroy()
  })

  test("peer outcome handle resolves normalized wire and rejects invalid wire", async () => {
    const req = makeReq({ payload: { limit: 2 } })
    const success = makeSuccess(req, [msgItem("msg_1", 1)])
    const { clientReader, clientWriter, backendPeer } = createLinkedChannel((method) => {
      expect(method).toBe("session/messages")
      return success
    })
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, epoch: 5 })
    ;(peer as unknown as Record<string, unknown>).available = true
    ;(peer as unknown as Record<string, unknown>).peer = new JsonRpcPeer({ reader: clientReader, writer: clientWriter })
    ;(peer as unknown as Record<string, unknown>).capabilities = ["session/messages"]
    const outcome = await peer.privateMessagesOutcomeWithHandle(req as never).promise
    expect(outcome.kind).toBe("valid")
    if (outcome.kind === "valid") expect(outcome.result.status).toBe("succeeded")
    peer.dispose()
    backendPeer.dispose()
    clientReader.destroy()
    clientWriter.destroy()

    const bad = { ...success, data: { messages: ["not-object"] } }
    const wire = normalizePrivateMessagesWire(bad, req as never)
    expect(wire.kind).toBe("invalid")
  })

  test("sdkMessagesHasTerminal gates non-terminal errors", () => {
    expect(sdkMessagesHasTerminal({ data: [] } as never)).toBeTrue()
    expect(sdkMessagesHasTerminal({ error: { status: 404 }, response: { status: 404 } } as never)).toBeTrue()
    expect(sdkMessagesHasTerminal({ error: { message: "boom" } } as never)).toBeFalse()
    expect(sdkMessagesHasTerminal({ error: { code: "ECONNRESET" } } as never)).toBeFalse()
  })

  test("sdkMessagesHasTerminal terminal-only gating for real thrown Errors", () => {
    expect(sdkMessagesHasTerminal(new Error("boom") as never)).toBeFalse()
    expect(sdkMessagesHasTerminal(Object.assign(new Error("fetch failed"), { cause: { body: "x" } }) as never)).toBeFalse()
    const abort = new Error("aborted")
    abort.name = "AbortError"
    expect(sdkMessagesHasTerminal(abort as never)).toBeFalse()
    expect(sdkMessagesHasTerminal(Object.assign(new Error("net"), { cause: { body: "x", status: 503 } }) as never)).toBeFalse()
    expect(sdkMessagesHasTerminal(new Error("got 404 inline") as never)).toBeFalse()
    for (const status of [400, 404, 409, 500]) {
      expect(sdkMessagesHasTerminal({ error: { status }, response: { status } } as never)).toBeTrue()
      expect(sdkMessagesHasTerminal(Object.assign(new Error("terminal"), { cause: { body: { name: "x" }, status } }) as never)).toBeTrue()
    }
    expect(sdkMessagesHasTerminal({ data: undefined } as never)).toBeFalse()
    expect(sdkMessagesHasTerminal({} as never)).toBeFalse()
  })

  test("observer never launches private work for real thrown non-terminal Error", async () => {
    const warns: unknown[][] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warns.push(args)
    }
    try {
      const calls: string[] = []
      const invalidated: string[] = []
      const conn: MessagesParityConnection = {
        isPrivateAvailable: () => true,
        privateMessages: async () => {
          throw new Error("unused")
        },
        privateMessagesWithHandle: () => {
          throw new Error("unused")
        },
        privateMessagesOutcomeWithHandle: (req) => {
          calls.push(req.opId)
          return { id: 1, promise: Promise.resolve({ kind: "valid", result: {} }) }
        },
        invalidatePrivatePeerOnObserverTimeout: (r) => {
          invalidated.push(r)
        },
        getPrivateEpoch: () => 1,
      }
      observeSessionMessagesParityDetached(conn, new Error("boom") as never, "ses_abc", "/tmp", { limit: 2 }, 20)
      await new Promise((r) => setTimeout(r, 30))
      expect(calls).toHaveLength(0)
      expect(invalidated).toHaveLength(0)
      expect(warns).toHaveLength(0)
    } finally {
      console.warn = origWarn
    }
  })

  test("observer still runs detached for terminal thrown Error with cause status", async () => {
    const warns: unknown[][] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warns.push(args)
    }
    try {
      const calls: string[] = []
      const conn: MessagesParityConnection = {
        isPrivateAvailable: () => true,
        privateMessages: async () => {
          throw new Error("unused")
        },
        privateMessagesWithHandle: () => {
          throw new Error("unused")
        },
        privateMessagesOutcomeWithHandle: (req) => {
          calls.push(req.opId)
          return {
            id: 1,
            promise: Promise.resolve({
              kind: "valid",
              result: {
                v: 1,
                requestId: req.requestId,
                opId: req.opId,
                op: "session/messages",
                idempotencyKey: req.idempotencyKey,
                status: "ambiguous",
                outcome: { type: "ambiguous", time: 1 },
                accepted: false,
                transportUnknown: true,
              },
            }),
          }
        },
      }
      const terminal = Object.assign(new Error("Session not found"), { cause: { body: { name: "NotFoundError" }, status: 404 } })
      observeSessionMessagesParityDetached(conn, terminal as never, "ses_abc", "/tmp", { limit: 2 }, 200)
      await new Promise((r) => setTimeout(r, 50))
      expect(calls).toHaveLength(1)
    } finally {
      console.warn = origWarn
    }
  })

  test("observer is SDK-first detached exact-once with safe diagnostics", async () => {
    const warns: unknown[][] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warns.push(args)
    }
    try {
      const calls: string[] = []
      const items = [msgItem("msg_9", 9)]
      const conn: MessagesParityConnection = {
        isPrivateAvailable: () => true,
        privateMessages: async () => {
          throw new Error("unused")
        },
        privateMessagesWithHandle: () => {
          throw new Error("unused")
        },
        privateMessagesOutcomeWithHandle: (req) => {
          calls.push(`outcome:${req.opId}:${JSON.stringify(req.payload)}`)
          return {
            id: 1,
            promise: Promise.resolve({
              kind: "valid",
              result: {
                v: 1,
                requestId: req.requestId,
                opId: req.opId,
                op: "session/messages",
                idempotencyKey: req.idempotencyKey,
                status: "succeeded",
                outcome: { type: "succeeded", time: 1 },
                accepted: true,
                data: { messages: items },
              },
            }),
          }
        },
      }
      const sdk = sdkSuccess(items, null)
      const before = JSON.stringify(sdk.data)
      const ret = observeSessionMessagesParityDetached(conn, sdk as unknown as never, "ses_abc", "/tmp", { limit: 2 }, 200)
      expect(ret).toBeUndefined()
      expect(JSON.stringify(sdk.data)).toBe(before)
      await new Promise((r) => setTimeout(r, 50))
      expect(calls.length).toBe(1)
      expect(calls[0]!.includes("messages:ses_abc:")).toBeTrue()
      expect(calls[0]!.includes('"limit":2')).toBeTrue()
      expect(warns.length).toBe(0)
    } finally {
      console.warn = origWarn
    }
  })

  test("observer divergence is warn-only and invalid wire never reaches comparator, with no sensitive output", async () => {
    const warns: unknown[][] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warns.push(args)
    }
    try {
      const sdk = sdkSuccess([msgItem("msg_1", 1)], null)
      const divergent: MessagesParityConnection = {
        isPrivateAvailable: () => true,
        privateMessages: async () => {
          throw new Error("unused")
        },
        privateMessagesWithHandle: () => {
          throw new Error("unused")
        },
        privateMessagesOutcomeWithHandle: (req) => ({
          id: 1,
          promise: Promise.resolve({
            kind: "valid",
            result: {
              v: 1,
              requestId: req.requestId,
              opId: req.opId,
              op: "session/messages",
              idempotencyKey: req.idempotencyKey,
              status: "succeeded",
              outcome: { type: "succeeded", time: 1 },
              accepted: true,
              data: { messages: [msgItem("msg_2", 2)] },
            },
          }),
        }),
      }
      observeSessionMessagesParityDetached(divergent, sdk as unknown as never, "ses_abc", "/tmp", { limit: 2 }, 200)
      await new Promise((r) => setTimeout(r, 50))
      expect(warns.some((w) => String(w[0]).includes("parity divergence") && String(w[1]).includes("observation-divergence"))).toBeTrue()
      const logged = warns.map((w) => w.map(String).join(" ")).join(" ")
      expect(logged.includes("msg_1")).toBeFalse()
      expect(logged.includes("msg_2")).toBeFalse()

      warns.length = 0
      const invalid: MessagesParityConnection = {
        isPrivateAvailable: () => true,
        privateMessages: async () => {
          throw new Error("unused")
        },
        privateMessagesWithHandle: () => {
          throw new Error("unused")
        },
        privateMessagesOutcomeWithHandle: () => ({
          id: 2,
          promise: Promise.resolve({ kind: "invalid", detail: "succeeded data.messages must be array" }),
        }),
      }
      observeSessionMessagesParityDetached(invalid, sdk as unknown as never, "ses_abc", "/tmp", { limit: 2 }, 200)
      await new Promise((r) => setTimeout(r, 50))
      expect(warns.some((w) => String(w[0]).includes("validation divergence"))).toBeTrue()
      expect(warns.some((w) => String(w[1] ?? "").includes("observation-divergence"))).toBeFalse()
    } finally {
      console.warn = origWarn
    }
  })

  test("observer binds exact query: before requires limit and limit:0 is full-read", async () => {
    const calls: unknown[] = []
    const conn: MessagesParityConnection = {
      isPrivateAvailable: () => true,
      privateMessages: async () => {
        throw new Error("unused")
      },
      privateMessagesWithHandle: () => {
        throw new Error("unused")
      },
      privateMessagesOutcomeWithHandle: (req) => {
        calls.push(req.payload)
        return { id: 1, promise: new Promise(() => {}) }
      },
    }
    const sdk = sdkSuccess([], null)
    // before without limit never observes.
    observeSessionMessagesParityDetached(conn, sdk as unknown as never, "ses_abc", "/tmp", { before: "cur" } as never, 20)
    await new Promise((r) => setTimeout(r, 30))
    expect(calls.length).toBe(0)
    // before with limit:0 observes with exact query identity (full-read).
    observeSessionMessagesParityDetached(conn, sdk as unknown as never, "ses_abc", "/tmp", { limit: 0, before: "cur" }, 20)
    await new Promise((r) => setTimeout(r, 30))
    expect(calls.length).toBe(1)
    expect(calls[0]).toEqual({ limit: 0, before: "cur" })
    // limit:0 observes as full-read payload.
    observeSessionMessagesParityDetached(conn, sdk as unknown as never, "ses_abc", "/tmp", { limit: 0 }, 20)
    await new Promise((r) => setTimeout(r, 30))
    expect(calls.length).toBe(2)
    expect(calls[1]).toEqual({ limit: 0 })
  })

  test("observer timeout uses exact cancel; miss fail-closed invalidates without SDK impact", async () => {
    const cancelled: number[] = []
    const invalidated: string[] = []
    const sdk = sdkSuccess([], null)
    const conn: MessagesParityConnection = {
      isPrivateAvailable: () => true,
      privateMessages: async () => {
        throw new Error("unused")
      },
      privateMessagesWithHandle: () => {
        throw new Error("unused")
      },
      privateMessagesOutcomeWithHandle: () => ({
        id: 42,
        promise: new Promise(() => {}),
        cancel: () => {
          cancelled.push(42)
          return true
        },
      }),
      tryCancelPrivatePending: () => false,
      invalidatePrivatePeerOnObserverTimeout: (r) => {
        invalidated.push(r)
      },
      getPrivateEpoch: () => 9,
    }
    observeSessionMessagesParityDetached(conn, sdk as unknown as never, "ses_abc", "/tmp", { limit: 2 }, 20)
    await new Promise((r) => setTimeout(r, 80))
    expect(cancelled).toEqual([42])
    expect(invalidated).toEqual([])
    expect(JSON.stringify(sdk.data)).toBe(JSON.stringify([]))
  })

  test("observer defers while negotiating with exact-query keys and skips stale epochs", async () => {
    const sdk = sdkSuccess([], null)
    let listener: (() => void) | null = null
    const conn: MessagesParityConnection = {
      isPrivateAvailable: () => false,
      privateMessages: async () => {
        throw new Error("unused")
      },
      privateMessagesWithHandle: () => {
        throw new Error("unused")
      },
      getPrivateEpoch: () => 3,
      onPrivateAvailable: (fn) => {
        listener = fn
        return () => {
          listener = null
        }
      },
    }
    observeSessionMessagesParityDetached(conn, sdk as unknown as never, "ses_abc", "/tmp", { limit: 2 }, 50)
    expect(listener).not.toBeNull()
    ;(conn as { getPrivateEpoch: () => number }).getPrivateEpoch = () => 4
    listener!()
    await new Promise((r) => setTimeout(r, 30))
  })

  test("owner-managed deferred messages keys dedupe per exact query", async () => {
    const sdk = sdkSuccess([], null)
    const listeners = new Map<string, () => void>()
    const conn: MessagesParityConnection = {
      isPrivateAvailable: () => false,
      privateMessages: async () => {
        throw new Error("unused")
      },
      privateMessagesWithHandle: () => {
        throw new Error("unused")
      },
      getPrivateEpoch: () => 11,
      addDeferredMessagesObserver: (dir: string, sessionId: string, limit: number | undefined, before: string | undefined, fn: () => void) => {
        const beforePart = before === undefined ? "none" : `h-${createHash("sha256").update(before, "utf8").digest("hex")}`
        const key = `messages:11:${dir}:${sessionId}:${limit ?? "none"}:${beforePart}`
        if (listeners.has(key)) return () => {}
        listeners.set(key, () => {
          listeners.delete(key)
          fn()
        })
        return () => {
          listeners.delete(key)
        }
      },
      onPrivateAvailable: () => () => {},
    }
    observeSessionMessagesParityDetached(conn, sdk as unknown as never, "ses_abc", "/tmp", { limit: 2 }, 50)
    observeSessionMessagesParityDetached(conn, sdk as unknown as never, "ses_abc", "/tmp", { limit: 2 }, 50)
    expect(listeners.size).toBe(1)
    // Different query is a different observation.
    observeSessionMessagesParityDetached(conn, sdk as unknown as never, "ses_abc", "/tmp", { limit: 2, before: "cur" }, 50)
    expect(listeners.size).toBe(2)
    // Distinct before cursor values are distinct observations (LOCK-B7-002).
    observeSessionMessagesParityDetached(conn, sdk as unknown as never, "ses_abc", "/tmp", { limit: 2, before: "cur-other" }, 50)
    expect(listeners.size).toBe(3)
    // Same exact before value dedupes.
    observeSessionMessagesParityDetached(conn, sdk as unknown as never, "ses_abc", "/tmp", { limit: 2, before: "cur" }, 50)
    expect(listeners.size).toBe(3)
    observeSessionMessagesParityDetached(conn, sdk as unknown as never, "ses_other", "/tmp", { limit: 2 }, 50)
    expect(listeners.size).toBe(4)
  })

  test("production deferred messages keys distinguish exact before values without exposing cursors", async () => {
    const { KiloConnectionService } = await import("./connection-service")
    const svc = new KiloConnectionService({} as never)
    try {
      const anySvc = svc as unknown as {
        privateEpoch: number | null
        deferredMessagesObservers: Map<string, () => void>
        setPrivateEpoch: (server: unknown) => void
      }
      anySvc.setPrivateEpoch({ epoch: 71, pid: 711 })
      const plain = svc.deferredMessagesObserverKey("/tmp", "ses_abc", 2, undefined)
      const first = svc.deferredMessagesObserverKey("/tmp", "ses_abc", 2, "cur-a")
      const second = svc.deferredMessagesObserverKey("/tmp", "ses_abc", 2, "cur-b")
      const repeat = svc.deferredMessagesObserverKey("/tmp", "ses_abc", 2, "cur-a")
      expect(first).not.toBe(second)
      expect(first).toBe(repeat)
      expect(first).not.toBe(plain)
      expect(first.includes("cur-a")).toBeFalse()
      expect(second.includes("cur-b")).toBeFalse()
      svc.addDeferredMessagesObserver("/tmp", "ses_abc", 2, "cur-a", () => {})
      expect(anySvc.deferredMessagesObservers.size).toBe(1)
      svc.addDeferredMessagesObserver("/tmp", "ses_abc", 2, "cur-a", () => {})
      expect(anySvc.deferredMessagesObservers.size).toBe(1)
      svc.addDeferredMessagesObserver("/tmp", "ses_abc", 2, "cur-b", () => {})
      expect(anySvc.deferredMessagesObservers.size).toBe(2)
      svc.addDeferredMessagesObserver("/tmp", "ses_abc", 2, undefined, () => {})
      expect(anySvc.deferredMessagesObservers.size).toBe(3)
    } finally {
      try {
        svc.dispose()
      } catch (err) {
        console.warn("[Kilo Messages] test dispose failed (fail-closed):", String(err).slice(0, 200))
      }
    }
  })

  test("fallback deferred messages keys distinguish exact before values", async () => {
    const sdk = sdkSuccess([], null)
    let subs = 0
    const conn: MessagesParityConnection = {
      isPrivateAvailable: () => false,
      privateMessages: async () => {
        throw new Error("unused")
      },
      privateMessagesWithHandle: () => {
        throw new Error("unused")
      },
      getPrivateEpoch: () => 81,
      onPrivateAvailable: () => {
        subs += 1
        return () => {}
      },
    }
    observeSessionMessagesParityDetached(conn, sdk as unknown as never, "ses_abc", "/tmp", { limit: 2, before: "cur-a" }, 50)
    observeSessionMessagesParityDetached(conn, sdk as unknown as never, "ses_abc", "/tmp", { limit: 2, before: "cur-a" }, 50)
    expect(subs).toBe(1)
    observeSessionMessagesParityDetached(conn, sdk as unknown as never, "ses_abc", "/tmp", { limit: 2, before: "cur-b" }, 50)
    expect(subs).toBe(2)
  })

  test("observer timeout cancel miss fail-closed invalidates with sanitized diagnostics", async () => {
    const warns: unknown[][] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warns.push(args)
    }
    try {
      const sdk = sdkSuccess([], null)
      const before = JSON.stringify(sdk.data)
      const invalidated: string[] = []
      const conn: MessagesParityConnection = {
        isPrivateAvailable: () => true,
        privateMessages: async () => {
          throw new Error("unused")
        },
        privateMessagesWithHandle: () => {
          throw new Error("unused")
        },
        privateMessagesOutcomeWithHandle: () => ({
          id: 43,
          promise: new Promise(() => {}),
          cancel: () => false,
        }),
        invalidatePrivatePeerOnObserverTimeout: (r) => {
          invalidated.push(r)
        },
        getPrivateEpoch: () => 9,
      }
      observeSessionMessagesParityDetached(conn, sdk as unknown as never, "ses_abc", "/tmp", { limit: 2 }, 20)
      await new Promise((r) => setTimeout(r, 80))
      expect(invalidated).toHaveLength(1)
      expect(JSON.stringify(sdk.data)).toBe(before)
      const logged = warns.map((w) => w.map(String).join(" ")).join(" ")
      expect(logged.includes("messages:ses_abc:")).toBeFalse()
      expect(logged.includes("ses_abc")).toBeFalse()
      expect(warns.some((w) => String(w[0]).includes("private parity timeout"))).toBeTrue()
    } finally {
      console.warn = origWarn
    }
  })

  test("observer timeout cancel throw fail-closed invalidates with sanitized diagnostics", async () => {
    const warns: unknown[][] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warns.push(args)
    }
    try {
      const sdk = sdkSuccess([], null)
      const before = JSON.stringify(sdk.data)
      const invalidated: string[] = []
      const conn: MessagesParityConnection = {
        isPrivateAvailable: () => true,
        privateMessages: async () => {
          throw new Error("unused")
        },
        privateMessagesWithHandle: () => {
          throw new Error("unused")
        },
        privateMessagesOutcomeWithHandle: () => ({
          id: 44,
          promise: new Promise(() => {}),
          cancel: () => {
            throw new Error("cancel boom")
          },
        }),
        invalidatePrivatePeerOnObserverTimeout: (r) => {
          invalidated.push(r)
        },
        getPrivateEpoch: () => 9,
      }
      observeSessionMessagesParityDetached(conn, sdk as unknown as never, "ses_abc", "/tmp", { limit: 2 }, 20)
      await new Promise((r) => setTimeout(r, 80))
      expect(invalidated).toHaveLength(1)
      expect(JSON.stringify(sdk.data)).toBe(before)
      const logged = warns.map((w) => w.map(String).join(" ")).join(" ")
      expect(logged.includes("messages:ses_abc:")).toBeFalse()
      expect(logged.includes("cancel boom")).toBeFalse()
      expect(logged.includes("ses_abc")).toBeFalse()
      expect(warns.some((w) => String(w[0]).includes("handle.cancel failed") || String(w[0]).includes("observer timeout"))).toBeTrue()
    } finally {
      console.warn = origWarn
    }
  })

  test("complete-payload content mismatch with same ids/times diverges with safe summary only", async () => {
    const req = makeReq()
    const sdkItem = msgItem("msg_1", 1)
    const privSameKeys = {
      info: { id: "msg_1", sessionID: "ses_abc", role: "user", time: { created: 1 } },
      parts: [{ type: "text", text: "different-content" }],
    }
    const sdkItemWithParts = {
      info: { id: "msg_1", sessionID: "ses_abc", role: "user", time: { created: 1 } },
      parts: [{ type: "text", text: "original-content" }],
    }
    const priv = makeSuccess(req, [privSameKeys]) as unknown as Parameters<typeof compareMessagesParity>[0]
    const sdk = sdkSuccess([sdkItemWithParts], null) as unknown as Parameters<typeof compareMessagesParity>[1]
    const res = compareMessagesParity(priv, sdk)
    expect(res.divergence).toBe("observation-divergence:content-mismatch")
    const serialized = JSON.stringify(res)
    expect(serialized.includes("different-content")).toBeFalse()
    expect(serialized.includes("original-content")).toBeFalse()
    expect(serialized.includes("msg_1")).toBeFalse()
    expect(res.details).toEqual({ sdkCount: 1, privCount: 1, sdkCursor: false, privCursor: false })
    // Identical full payload still matches.
    const samePriv = makeSuccess(req, [sdkItem]) as unknown as Parameters<typeof compareMessagesParity>[0]
    const sameSdk = sdkSuccess([sdkItem], null) as unknown as Parameters<typeof compareMessagesParity>[1]
    expect(compareMessagesParity(samePriv, sameSdk).divergence).toBeNull()
  })

  test("availability race between check and deferred registration cannot drop observer", async () => {
    const warns: unknown[][] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warns.push(args)
    }
    try {
      const sdk = sdkSuccess([], null)
      let available = false
      let observed = 0
      const listeners = new Map<string, () => void>()
      const conn: MessagesParityConnection = {
        isPrivateAvailable: () => available,
        privateMessages: async () => {
          throw new Error("unused")
        },
        privateMessagesWithHandle: () => {
          throw new Error("unused")
        },
        privateMessagesOutcomeWithHandle: () => {
          observed += 1
          return {
            id: 1,
            promise: Promise.resolve({
              kind: "valid",
              result: {
                v: 1,
                requestId: "r",
                opId: "messages:ses_abc:tok",
                op: "session/messages",
                idempotencyKey: "messages:ses_abc:tok",
                status: "ambiguous",
                outcome: { type: "ambiguous", time: 1 },
                accepted: false,
                transportUnknown: true,
              },
            }),
          }
        },
        getPrivateEpoch: () => 5,
        addDeferredMessagesObserver: (_dir: string, _sid: string, _limit: number | undefined, _before: string | undefined, fn: () => void) => {
          // Simulate negotiation completing synchronously during registration.
          available = true
          listeners.set("k", fn)
          return () => {
            listeners.delete("k")
          }
        },
      }
      observeSessionMessagesParityDetached(conn, sdk as unknown as never, "ses_abc", "/tmp", { limit: 2 }, 50)
      await new Promise((r) => setTimeout(r, 30))
      expect(observed).toBe(1)
      const logged = warns.map((w) => w.map(String).join(" ")).join(" ")
      expect(logged.includes("ses_abc")).toBeFalse()
    } finally {
      console.warn = origWarn
    }
  })

  test("error-derived cleanup diagnostics never include identity-like text", async () => {
    const warns: unknown[][] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warns.push(args)
    }
    try {
      const sdk = sdkSuccess([], null)
      const secret = "ses_secret-identity-xyz"
      const conn: MessagesParityConnection = {
        isPrivateAvailable: () => true,
        privateMessages: async () => {
          throw new Error("unused")
        },
        privateMessagesWithHandle: () => {
          throw new Error("unused")
        },
        privateMessagesOutcomeWithHandle: () => ({
          id: 45,
          promise: new Promise(() => {}),
          cancel: () => {
            throw new Error(`boom ${secret} opId=messages:${secret}:tok requestId=req-${secret}`)
          },
        }),
        invalidatePrivatePeerOnObserverTimeout: () => {},
        getPrivateEpoch: () => 9,
      }
      observeSessionMessagesParityDetached(conn, sdk as unknown as never, "ses_abc", "/tmp", { limit: 2 }, 20)
      await new Promise((r) => setTimeout(r, 80))
      const logged = warns.map((w) => w.map(String).join(" ")).join(" ")
      expect(logged.includes(secret)).toBeFalse()
      expect(logged.includes("messages:ses_")).toBeFalse()
    } finally {
      console.warn = origWarn
    }
  })

  test("stale observer timeout skips invalidation and never harms replacement peer", async () => {
    const warns: unknown[][] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warns.push(args)
    }
    try {
      const sdk = sdkSuccess([], null)
      // Explicit "stale" from the captured handle: replacement peer untouched.
      const replacementInvalidated: string[] = []
      const staleConn: MessagesParityConnection = {
        isPrivateAvailable: () => true,
        privateMessages: async () => {
          throw new Error("unused")
        },
        privateMessagesWithHandle: () => {
          throw new Error("unused")
        },
        privateMessagesOutcomeWithHandle: () => ({
          id: 45,
          promise: new Promise(() => {}),
          cancel: () => "stale",
        }),
        invalidatePrivatePeerOnObserverTimeout: (r) => {
          replacementInvalidated.push(r)
        },
        getPrivateEpoch: () => 10,
      }
      observeSessionMessagesParityDetached(staleConn, sdk as unknown as never, "ses_abc", "/tmp", { limit: 2 }, 20)
      await new Promise((r) => setTimeout(r, 80))
      expect(replacementInvalidated).toEqual([])
      expect(warns.some((w) => String(w[0]).includes("stale observer timeout"))).toBeTrue()
      const loggedStale = warns.map((w) => w.map(String).join(" ")).join(" ")
      expect(loggedStale.includes("messages:ses_abc:")).toBeFalse()

      // Epoch drift between call and timeout: cancel miss must not invalidate.
      warns.length = 0
      let epoch = 9
      const driftInvalidated: string[] = []
      const driftConn: MessagesParityConnection = {
        isPrivateAvailable: () => true,
        privateMessages: async () => {
          throw new Error("unused")
        },
        privateMessagesWithHandle: () => {
          throw new Error("unused")
        },
        privateMessagesOutcomeWithHandle: () => ({
          id: 46,
          promise: new Promise(() => {}),
          cancel: () => false,
        }),
        invalidatePrivatePeerOnObserverTimeout: (r) => {
          driftInvalidated.push(r)
        },
        getPrivateEpoch: () => epoch,
      }
      observeSessionMessagesParityDetached(driftConn, sdk as unknown as never, "ses_abc", "/tmp", { limit: 2 }, 20)
      epoch = 10
      await new Promise((r) => setTimeout(r, 80))
      expect(driftInvalidated).toEqual([])
      expect(warns.some((w) => String(w[0]).includes("stale observer timeout"))).toBeTrue()
    } finally {
      console.warn = origWarn
    }
  })

  test("deferred stale epoch skips observe and releases fallback key for replacement epoch", async () => {
    const sdk = sdkSuccess([], null)
    let epoch = 3
    let privCalls = 0
    let subs = 0
    let listener: (() => void) | null = null
    const conn: MessagesParityConnection = {
      isPrivateAvailable: () => false,
      privateMessages: async () => {
        throw new Error("unused")
      },
      privateMessagesWithHandle: () => {
        throw new Error("unused")
      },
      privateMessagesOutcomeWithHandle: () => {
        privCalls += 1
        return { id: 1, promise: new Promise(() => {}) }
      },
      getPrivateEpoch: () => epoch,
      onPrivateAvailable: (fn) => {
        subs += 1
        listener = fn
        return () => {
          listener = null
        }
      },
    }
    observeSessionMessagesParityDetached(conn, sdk as unknown as never, "ses_abc", "/tmp", { limit: 2 }, 50)
    expect(subs).toBe(1)
    expect(listener).not.toBeNull()
    epoch = 4
    listener!()
    await new Promise((r) => setTimeout(r, 30))
    expect(privCalls).toBe(0)
    // Fallback key was released on fire, so the replacement epoch can defer again.
    epoch = 4
    ;(conn as { isPrivateAvailable: () => boolean }).isPrivateAvailable = () => false
    observeSessionMessagesParityDetached(conn, sdk as unknown as never, "ses_abc", "/tmp", { limit: 2 }, 50)
    expect(subs).toBe(2)
  })

  test("peer messages stale cancel never logs raw opId and never harms replacement epoch", async () => {
    const warns: unknown[][] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warns.push(args)
    }
    const { clientReader, clientWriter, backendPeer } = createLinkedChannel(() => new Promise(() => {}))
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, epoch: 5 })
    try {
      ;(peer as unknown as Record<string, unknown>).available = true
      ;(peer as unknown as Record<string, unknown>).peer = new JsonRpcPeer({ reader: clientReader, writer: clientWriter })
      ;(peer as unknown as Record<string, unknown>).capabilities = ["session/messages"]
      const req = makeReq({ payload: { limit: 2 } })
      const handle = peer.privateMessagesOutcomeWithHandle(req as never)
      // Simulate replacement epoch: captured handle is now stale.
      ;(peer as unknown as { opts: { epoch: number } }).opts.epoch = 6
      const ok = handle.cancel("private parity timeout")
      expect(ok).toBeFalse()
      const logged = warns.map((w) => w.map(String).join(" ")).join(" ")
      expect(logged.includes(req.opId as string)).toBeFalse()
      expect(logged.includes(req.requestId as string)).toBeFalse()
      expect(logged.includes("tok1")).toBeFalse()
    } finally {
      console.warn = origWarn
      peer.dispose()
      backendPeer.dispose()
      clientReader.destroy()
      clientWriter.destroy()
    }
  })

  test("isPrivateMessagesValidationError identifies invalid wire", () => {
    expect(isPrivateMessagesValidationError({ kind: "private-messages-validation", detail: "x", message: "y", name: "z" })).toBeTrue()
    expect(isPrivateMessagesValidationError({ kind: "other" })).toBeFalse()
  })
})
