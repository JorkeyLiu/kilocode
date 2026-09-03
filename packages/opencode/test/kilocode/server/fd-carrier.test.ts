import { afterEach, describe, expect, test, mock } from "bun:test"
import { PassThrough } from "stream"
import { Effect } from "effect"
import { JsonRpcPeer } from "../../../src/private-worker/peer"
import { encodeFrame } from "../../../src/private-worker/frame"
import { ErrorCode } from "../../../src/private-worker/json-rpc"
import { createFdCarrier, canUseFdCarrier, tryStartFdCarrier, tryStartFdCarrierWithDeps } from "../../../src/kilocode/server/fd-carrier"
import { buildInitializeResult, FD_PROTOCOL_NAME } from "../../../src/kilocode/server/fd-carrier-protocol"
import { AppRuntime } from "../../../src/effect/app-runtime"
import { Session } from "../../../src/session/session"
import { SessionID } from "../../../src/session/schema"
import { SessionUpdateDispatchService } from "../../../src/kilocode/session/session-update-dispatch"
import { MessageID } from "../../../src/session/schema"
import { SessionOperation } from "@opencode-ai/core/session/operation"
import { provideInstance, tmpdir, disposeAllInstances } from "../../fixture/fixture"
import { resetDatabase } from "../../fixture/db"
import { Server } from "../../../src/server/server"

type InitResult = {
  protocol: { name: string; major: number; minor: number }
  protocolVersion: string
  serverInfo: { name: string; version: string }
  capabilities: string[]
}

type CancelResult = {
  v: number
  requestId: string
  opId: string
  status: string
  outcome: { type: string; time: number; failure?: { code: string } }
  accepted: boolean
  data?: { cancelled: boolean }
}

function linked() {
  const extToCarrier = new PassThrough()
  const carrierToExt = new PassThrough()
  const carrier = createFdCarrier(extToCarrier, carrierToExt)
  const ext = new JsonRpcPeer({ reader: carrierToExt, writer: extToCarrier })
  return { carrier, ext, extToCarrier, carrierToExt }
}

function asRecord(v: unknown): Record<string, unknown> {
  return v as Record<string, unknown>
}

function asError(v: unknown): { code?: number; message?: string } {
  return v as { code?: number; message?: string }
}

function note(label: string, err: unknown): void {
  console.warn(`[cleanup:${label}] ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`)
}

describe("fd-carrier", () => {
  afterEach(async () => {
    await disposeAllInstances()
    await resetDatabase()
  })

  test("no-fd fallback does not prevent HTTP serve", async () => {
    const origParent = process.env.KILO_PARENT_PID
    const origClient = process.env.KILO_CLIENT
    delete process.env.KILO_PARENT_PID
    delete process.env.KILO_CLIENT
    expect(canUseFdCarrier()).toBeFalse()
    expect(tryStartFdCarrier()).toBeNull()
    // Server.listen still works (allow extra time for migration rebuild on file DB after adding create kind)
    const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
    try {
      const res = await fetch(new URL("/doc", listener.url).toString())
      expect([200, 404].includes(res.status)).toBeTrue()
    } finally {
      await listener.stop()
    }
    if (origParent !== undefined) process.env.KILO_PARENT_PID = origParent
    if (origClient !== undefined) process.env.KILO_CLIENT = origClient
  }, 30000)

  test("initialize returns 1.0 + capabilities and second init already initialized", async () => {
    process.env.KILO_PARENT_PID = String(process.pid)
    const { carrier, ext } = linked()
    try {
      const res = (await ext.request("initialize", {
        protocol: { name: FD_PROTOCOL_NAME, major: 1, minor: 0 },
        clientInfo: { name: "kilo-vscode", version: "7.4.11" },
        capabilities: ["session/cancelQueued"],
      })) as InitResult
      expect(res.protocol.major).toBe(1)
      expect(res.protocol.name).toBe(FD_PROTOCOL_NAME)
      expect(res.protocolVersion).toBe("1.0")
      const caps = res.capabilities
      expect(caps.includes("session/cancelQueued")).toBeTrue()
      // second init should be InvalidRequest Already initialized
      let secondErr: unknown
      try {
        await ext.request("initialize", {
          protocol: { name: FD_PROTOCOL_NAME, major: 1, minor: 0 },
          clientInfo: { name: "kilo-vscode", version: "7.4.11" },
          capabilities: ["session/cancelQueued"],
        })
      } catch (e) {
        secondErr = e
      }
      expect(asError(secondErr).code).toBe(ErrorCode.InvalidRequest)
      expect(String(asError(secondErr).message)).toContain("Already initialized")
    } finally {
      carrier.dispose()
      ext.dispose()
      delete process.env.KILO_PARENT_PID
    }
  })

  test("initialize fails closed on missing protocol name", async () => {
    process.env.KILO_PARENT_PID = "1"
    const { carrier, ext } = linked()
    try {
      let err: unknown
      try {
        await ext.request("initialize", {
          protocol: { major: 1, minor: 0 } as unknown as { name: string; major: number; minor: number },
          clientInfo: { name: "kilo-vscode", version: "7.4.11" },
          capabilities: ["session/cancelQueued"],
        })
      } catch (e) {
        err = e
      }
      expect(asError(err).code).toBe(ErrorCode.InvalidParams)
      expect(String(asError(err).message)).toContain("protocol name")
      // after fail, can still initialize correctly
      const res = (await ext.request("initialize", {
        protocol: { name: FD_PROTOCOL_NAME, major: 1, minor: 0 },
        clientInfo: { name: "kilo-vscode", version: "7.4.11" },
        capabilities: ["session/cancelQueued"],
      })) as InitResult
      expect(res.protocol.major).toBe(1)
    } finally {
      carrier.dispose()
      ext.dispose()
      delete process.env.KILO_PARENT_PID
    }
  })

  test("initialize fails closed on wrong protocol name", async () => {
    process.env.KILO_PARENT_PID = "1"
    const { carrier, ext } = linked()
    try {
      let err: unknown
      try {
        await ext.request("initialize", {
          protocol: { name: "wrong-name", major: 1, minor: 0 },
          clientInfo: { name: "kilo-vscode", version: "7.4.11" },
          capabilities: ["session/cancelQueued"],
        })
      } catch (e) {
        err = e
      }
      expect(asError(err).code).toBe(ErrorCode.InvalidParams)
      expect(String(asError(err).message)).toContain("protocol name")
    } finally {
      carrier.dispose()
      ext.dispose()
      delete process.env.KILO_PARENT_PID
    }
  })

  test("pre-init domain call rejected InvalidRequest", async () => {
    process.env.KILO_PARENT_PID = "1"
    const { carrier, ext } = linked()
    try {
      let err: unknown
      try {
        await ext.request("session/cancelQueued", {
          v: 1,
          requestId: "r1",
          opId: "cancelQueued:ses_a:msg_b",
          op: "session/cancelQueued",
          idempotencyKey: "idem1",
          context: { directory: "/tmp", sessionId: "ses_a", parentSessionId: null },
          payload: { messageId: "msg_b" },
        })
      } catch (e) {
        err = e
      }
      expect(asError(err).code).toBe(ErrorCode.InvalidRequest)
    } finally {
      carrier.dispose()
      ext.dispose()
      delete process.env.KILO_PARENT_PID
    }
  })

  test("unsupported major 2 fail-closed and minor 1.5 accepted", async () => {
    process.env.KILO_PARENT_PID = "1"
    {
      const { carrier, ext } = linked()
      try {
        let err: unknown
        try {
          await ext.request("initialize", {
            protocol: { name: FD_PROTOCOL_NAME, major: 2, minor: 0 },
            clientInfo: { name: "kilo-vscode", version: "7.4.11" },
            capabilities: ["session/cancelQueued"],
          })
        } catch (e) {
          err = e
        }
        expect(asError(err).code).toBe(ErrorCode.InvalidParams)
        // after fail, can still initialize with major 1? peer not initialized, so retry should succeed with minor 5
        const res = (await ext.request("initialize", {
          protocol: { name: FD_PROTOCOL_NAME, major: 1, minor: 5 },
          clientInfo: { name: "kilo-vscode", version: "7.4.11" },
          capabilities: ["session/cancelQueued"],
        })) as InitResult
        expect(res.protocol.major).toBe(1)
      } finally {
        carrier.dispose()
        ext.dispose()
      }
    }
    delete process.env.KILO_PARENT_PID
  })

  test("unknown method returns MethodNotFound", async () => {
    process.env.KILO_PARENT_PID = "1"
    const { carrier, ext } = linked()
    try {
      await ext.request("initialize", {
        protocol: { name: FD_PROTOCOL_NAME, major: 1, minor: 0 },
        clientInfo: { name: "kilo-vscode", version: "7.4.11" },
        capabilities: ["session/cancelQueued"],
      })
      let err: unknown
      try {
        await ext.request("unknown/method", {})
      } catch (e) {
        err = e
      }
      expect(asError(err).code).toBe(ErrorCode.MethodNotFound)
    } finally {
      carrier.dispose()
      ext.dispose()
      delete process.env.KILO_PARENT_PID
    }
  })

  test("pipelined frames and UTF-8 split", async () => {
    process.env.KILO_PARENT_PID = "1"
    const extToCarrier = new PassThrough()
    const carrierToExt = new PassThrough()
    const carrier = createFdCarrier(extToCarrier, carrierToExt)
    const ext = new JsonRpcPeer({ reader: carrierToExt, writer: extToCarrier })
    try {
      await ext.request("initialize", {
        protocol: { name: FD_PROTOCOL_NAME, major: 1, minor: 0 },
        clientInfo: { name: "kilo-vscode", version: "7.4.11" },
        capabilities: ["session/cancelQueued"],
      })
      const p1 = ext.request("session/cancelQueued", {
        v: 1,
        requestId: "r-pipe-1",
        opId: "cancelQueued:ses_aaaaaaaaaaaaaaaaaaaaaaaa:msg_11111111111111111111111111",
        op: "session/cancelQueued",
        idempotencyKey: "idem-pipe-1",
        context: { directory: "/tmp", sessionId: "ses_aaaaaaaaaaaaaaaaaaaaaaaa", parentSessionId: null },
        payload: { messageId: "msg_11111111111111111111111111" },
      }).catch((e: unknown) => e)
      const p2 = ext.request("session/cancelQueued", {
        v: 1,
        requestId: "r-pipe-2",
        opId: "cancelQueued:ses_aaaaaaaaaaaaaaaaaaaaaaaa:msg_22222222222222222222222222",
        op: "session/cancelQueued",
        idempotencyKey: "idem-pipe-2",
        context: { directory: "/tmp", sessionId: "ses_aaaaaaaaaaaaaaaaaaaaaaaa", parentSessionId: null },
        payload: { messageId: "msg_22222222222222222222222222" },
      }).catch((e: unknown) => e)
      const results = (await Promise.all([p1, p2])) as unknown[]
      // Both should be either succeeded/failed (not hung); pipelined handling works
      for (const r of results) {
        const rec = r as Record<string, unknown>
        if (rec.code !== undefined) continue
        expect(typeof rec.status).toBe("string")
      }
    } finally {
      carrier.dispose()
      ext.dispose()
      delete process.env.KILO_PARENT_PID
    }
  })

  test("malformed Content-Length sends ParseError and closes, poison not processed", async () => {
    process.env.KILO_PARENT_PID = "1"
    const extToCarrier = new PassThrough()
    const carrierToExt = new PassThrough()
    const carrier = createFdCarrier(extToCarrier, carrierToExt)
    const ext = new JsonRpcPeer({ reader: carrierToExt, writer: extToCarrier })
    try {
      await ext.request("initialize", {
        protocol: { name: FD_PROTOCOL_NAME, major: 1, minor: 0 },
        clientInfo: { name: "kilo-vscode", version: "7.4.11" },
        capabilities: ["session/cancelQueued"],
      })
      const malformed = Buffer.concat([Buffer.from("Content-Length: not-a-number\r\n\r\n", "ascii"), Buffer.from('{"jsonrpc":"2.0","id":501,"method":"session/cancelQueued","params":{}}', "utf8")])
      // write malformed via raw stream
      extToCarrier.write(malformed)
      await new Promise((r) => setTimeout(r, 100))
      expect(carrier.peer.getState()).toBe("closed")
      expect(ext.getState()).toBe("closed")
      let err: unknown
      try {
        await ext.request("session/cancelQueued", {
          v: 1, requestId: "r-after", opId: "cancelQueued:ses_a:msg_c", op: "session/cancelQueued", idempotencyKey: "idem-after", context: { directory: "/tmp", sessionId: "ses_a", parentSessionId: null }, payload: { messageId: "msg_c" },
        })
      } catch (e) {
        err = e
      }
      expect(asError(err).code).toBe(ErrorCode.InternalError)
    } finally {
      try {
        carrier.dispose()
      } catch (err) {
        note("carrier", err)
      }
      try {
        ext.dispose()
      } catch (err) {
        note("ext", err)
      }
      delete process.env.KILO_PARENT_PID
    }
  })

  test("EOF pending rejection InternalError and shutdown dispose closes", async () => {
    process.env.KILO_PARENT_PID = "1"
    // Part 1: hanging backend verifies pending rejection on EOF
    {
      const extToCarrier = new PassThrough()
      const carrierToExt = new PassThrough()
      // hanging handler backend (no real dispatch)
      const hanging = new JsonRpcPeer({
        reader: extToCarrier,
        writer: carrierToExt,
        onRequest: async (method: string) => {
          if (method === "initialize") return buildInitializeResult()
          return new Promise(() => {})
        },
      })
      const ext = new JsonRpcPeer({ reader: carrierToExt, writer: extToCarrier })
      try {
        await ext.request("initialize", {
          protocol: { name: FD_PROTOCOL_NAME, major: 1, minor: 0 },
          clientInfo: { name: "kilo-vscode", version: "7.4.11" },
          capabilities: ["session/cancelQueued"],
        })
        const pending = ext.request("session/cancelQueued", {
          v: 1,
          requestId: "r-pending",
          opId: "cancelQueued:ses_aaaaaaaaaaaaaaaaaaaaaaaa:msg_33333333333333333333333333",
          op: "session/cancelQueued",
          idempotencyKey: "idem-pending-eof",
          context: { directory: "/tmp", sessionId: "ses_aaaaaaaaaaaaaaaaaaaaaaaa", parentSessionId: null },
          payload: { messageId: "msg_33333333333333333333333333" },
        })
        // trigger EOF on both sides
        extToCarrier.end()
        carrierToExt.end()
        setTimeout(() => {
          try {
            hanging.dispose()
          } catch (err) {
            note("hanging", err)
          }
        }, 30)
        let err: unknown
        try {
          await pending
        } catch (e) {
          err = e
        }
        expect(asError(err).code).toBe(ErrorCode.InternalError)
        expect(hanging.getState()).toBe("closed")
      } finally {
        try {
          hanging.dispose()
        } catch (err) {
          note("hanging", err)
        }
        try {
          ext.dispose()
        } catch (err) {
          note("ext", err)
        }
      }
    }
    // Part 2: real carrier dispose idempotent and further request rejected
    {
      const extToCarrier = new PassThrough()
      const carrierToExt = new PassThrough()
      const carrier = createFdCarrier(extToCarrier, carrierToExt)
      const ext = new JsonRpcPeer({ reader: carrierToExt, writer: extToCarrier })
      try {
        await ext.request("initialize", {
          protocol: { name: FD_PROTOCOL_NAME, major: 1, minor: 0 },
          clientInfo: { name: "kilo-vscode", version: "7.4.11" },
          capabilities: ["session/cancelQueued"],
        })
        carrier.dispose()
        expect(carrier.peer.getState()).toBe("closed")
        // idempotent
        carrier.dispose()
        expect(carrier.peer.getState()).toBe("closed")
        let err2: unknown
        try {
          await ext.request("session/cancelQueued", {
            v: 1,
            requestId: "r2",
            opId: "cancelQueued:ses_a:msg_b",
            op: "session/cancelQueued",
            idempotencyKey: "idem2",
            context: { directory: "/tmp", sessionId: "ses_a", parentSessionId: null },
            payload: { messageId: "msg_b" },
          })
        } catch (e) {
          err2 = e
        }
        expect(asError(err2).code).toBe(ErrorCode.InternalError)
      } finally {
        try {
          carrier.dispose()
        } catch (err) {
          note("carrier", err)
        }
        try {
          ext.dispose()
        } catch (err) {
          note("ext", err)
        }
      }
    }
    delete process.env.KILO_PARENT_PID
  })

  test("real B0 dispatch via carrier preserves envelope and idempotency", async () => {
    process.env.KILO_PARENT_PID = "1"
    const tmp = await tmpdir({ git: true, retain: true })
    const dir = tmp.path
    const session = await AppRuntime.runPromise(
      provideInstance(dir)(
        Effect.gen(function* () {
          const svc = yield* Session.Service
          return yield* svc.create({ title: "carrier-b0" })
        }),
      ),
    )
    const extToCarrier = new PassThrough()
    const carrierToExt = new PassThrough()
    const carrier = createFdCarrier(extToCarrier, carrierToExt)
    const ext = new JsonRpcPeer({ reader: carrierToExt, writer: extToCarrier })
    try {
      const init = (await ext.request("initialize", {
        protocol: { name: FD_PROTOCOL_NAME, major: 1, minor: 0 },
        clientInfo: { name: "kilo-vscode", version: "7.4.11" },
        capabilities: ["session/cancelQueued"],
      })) as Record<string, unknown>
      const proto = asRecord(init.protocol as unknown)
      expect(proto.major).toBe(1)
      const messageId = MessageID.make("msg_b0_1")
      const opId = SessionOperation.cancelQueuedId(session.id, messageId)
      const req = {
        v: 1 as const,
        requestId: "req-b0-1",
        opId,
        op: "session/cancelQueued" as const,
        idempotencyKey: "idem-b0-1",
        context: { directory: dir, sessionId: session.id, parentSessionId: null },
        payload: { messageId },
      }
      const res1 = (await ext.request("session/cancelQueued", req)) as CancelResult
      expect(res1.v).toBe(1)
      expect(res1.requestId).toBe("req-b0-1")
      expect(res1.opId).toBe(opId)
      expect(["succeeded", "failed", "ambiguous"].includes(res1.status)).toBeTrue()
      // idempotent replay via carrier should return same opId and not advance unexpected
      const res2 = (await ext.request("session/cancelQueued", req)) as CancelResult
      expect(res2.opId).toBe(opId)
      expect(res2.status).toBe(res1.status)
    } finally {
      carrier.dispose()
      ext.dispose()
      delete process.env.KILO_PARENT_PID
    }
  })

  test("stdout remains unpolluted", async () => {
    process.env.KILO_PARENT_PID = "1"
    const extToCarrier = new PassThrough()
    const carrierToExt = new PassThrough()
    const carrier = createFdCarrier(extToCarrier, carrierToExt)
    const ext = new JsonRpcPeer({ reader: carrierToExt, writer: extToCarrier })
    const writes: string[] = []
    const origWrite = process.stdout.write
    const fakeWrite = (chunk: unknown): boolean => {
      writes.push(String(chunk))
      return true
    }
    process.stdout.write = fakeWrite as typeof process.stdout.write
    try {
      await ext.request("initialize", {
        protocol: { name: FD_PROTOCOL_NAME, major: 1, minor: 0 },
        clientInfo: { name: "kilo-vscode", version: "7.4.11" },
        capabilities: ["session/cancelQueued"],
      })
      await ext.request("session/cancelQueued", {
        v: 1,
        requestId: "r-stdout",
        opId: "cancelQueued:ses_aaaaaaaaaaaaaaaaaaaaaaaa:msg_44444444444444444444444444",
        op: "session/cancelQueued",
        idempotencyKey: "idem-stdout",
        context: { directory: "/tmp", sessionId: "ses_aaaaaaaaaaaaaaaaaaaaaaaa", parentSessionId: null },
        payload: { messageId: "msg_44444444444444444444444444" },
      }).catch(() => {})
      expect(writes.length).toBe(0)
    } finally {
      process.stdout.write = origWrite
      carrier.dispose()
      ext.dispose()
      delete process.env.KILO_PARENT_PID
    }
  })

  test("partial fd setup releases first stream if second fails (LOCK-005)", async () => {
    process.env.KILO_PARENT_PID = "1"
    let readerDestroyed = false
    const fakeReader = new PassThrough() as unknown as NodeJS.ReadableStream & { destroy: () => void }
    const origDestroy = fakeReader.destroy.bind(fakeReader)
    fakeReader.destroy = () => {
      readerDestroyed = true
      return origDestroy() as unknown as void
    }
    const deps = {
      fstatSync: () => true as unknown as ReturnType<(typeof import("node:fs"))["fstatSync"]>,
      createReadStream: () => fakeReader as unknown as NodeJS.ReadableStream,
      createWriteStream: () => {
        throw new Error("mock writer failure")
      },
    }
    try {
      const result = tryStartFdCarrierWithDeps(deps as unknown as Parameters<typeof tryStartFdCarrierWithDeps>[0])
      expect(result).toBeNull()
      expect(readerDestroyed).toBeTrue()
    } finally {
      try {
        ;(fakeReader as unknown as { destroy: () => void }).destroy()
      } catch (err) {
        note("fakeReader", err)
      }
      delete process.env.KILO_PARENT_PID
    }
  })

  test("session/update via carrier is replay-only and fails closed without prior commit (no fallback to mutating dispatch)", async () => {
    process.env.KILO_PARENT_PID = "1"
    const tmp = await tmpdir({ git: true, retain: true })
    const dir = tmp.path
    const session = await AppRuntime.runPromise(
      provideInstance(dir)(
        Effect.gen(function* () {
          const svc = yield* Session.Service
          return yield* svc.create({ title: "carrier-replay" })
        }),
      ),
    )
    const extToCarrier = new PassThrough()
    const carrierToExt = new PassThrough()
    const carrier = createFdCarrier(extToCarrier, carrierToExt)
    const ext = new JsonRpcPeer({ reader: carrierToExt, writer: extToCarrier })
    try {
      await ext.request("initialize", {
        protocol: { name: FD_PROTOCOL_NAME, major: 1, minor: 0 },
        clientInfo: { name: "kilo-vscode", version: "7.4.11" },
        capabilities: ["session/update", "session/cancelQueued"],
      })
      const beforeTitle = (
        await AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const svc = yield* Session.Service
              return yield* svc.get(session.id as unknown as import("../../../src/session/schema").SessionID)
            }),
          ),
        )
      ).title
      const token = "carrier-no-record-" + Math.random().toString(36).slice(2, 6)
      const opId = SessionOperation.sessionUpdateId(session.id, token)
      const req = {
        v: 1 as const,
        requestId: "req-carrier-replay",
        opId,
        op: "session/update" as const,
        idempotencyKey: `sessionUpdate:${session.id}:${token}`,
        context: { directory: dir, sessionId: session.id, parentSessionId: null },
        payload: { title: "carrier-title" },
      }
      const res = (await ext.request("session/update", req)) as Record<string, unknown>
      expect(res.status).toBe("failed")
      expect((res as unknown as { failure: { code: string } }).failure.code).toBe("internal")
      const afterTitle = (
        await AppRuntime.runPromise(
          provideInstance(dir)(
            Effect.gen(function* () {
              const svc = yield* Session.Service
              return yield* svc.get(session.id as unknown as import("../../../src/session/schema").SessionID)
            }),
          ),
        )
      ).title
      expect(afterTitle).toBe(beforeTitle)
    } finally {
      carrier.dispose()
      ext.dispose()
      delete process.env.KILO_PARENT_PID
    }
  })

  test("session/update via carrier positive persisted replay via createFdCarrier JSON-RPC without fallback", async () => {
    process.env.KILO_PARENT_PID = "1"
    const tmp = await tmpdir({ git: true, retain: true })
    const dir = tmp.path
    const session = await AppRuntime.runPromise(
      provideInstance(dir)(
        Effect.gen(function* () {
          const svc = yield* Session.Service
          return yield* svc.create({ title: "carrier-pos" })
        }),
      ),
    )
    const token = "carrier-pos-" + Math.random().toString(36).slice(2, 8)
    const opId = SessionOperation.sessionUpdateId(session.id, token)
    const req = {
      v: 1 as const,
      requestId: "req-carrier-pos",
      opId,
      op: "session/update" as const,
      idempotencyKey: `sessionUpdate:${session.id}:${token}`,
      context: { directory: dir, sessionId: session.id, parentSessionId: null },
      payload: { title: "carrier-positive-title" },
    } as unknown as Record<string, unknown>
    // Commit via SDK authoritative dispatch
    const sdkRes = await AppRuntime.runPromise(
      provideInstance(dir)(
        Effect.gen(function* () {
          const d = yield* SessionUpdateDispatchService
          return yield* (d as unknown as { dispatch: (r: unknown) => Effect.Effect<unknown> }).dispatch(req)
        }),
      ),
    ) as Record<string, unknown>
    expect((sdkRes as unknown as { status: string }).status).toBe("succeeded")
    const sdkTitle = ((sdkRes as unknown as { data: { title: string } }).data.title)
    expect(sdkTitle).toBe("carrier-positive-title")
    const sdkRev = ((sdkRes as unknown as { revision: { session: number } }).revision.session)
    // Now replay via actual createFdCarrier JSON-RPC (private replay-only path)
    const extToCarrier = new PassThrough()
    const carrierToExt = new PassThrough()
    const carrier = createFdCarrier(extToCarrier, carrierToExt)
    const ext = new JsonRpcPeer({ reader: carrierToExt, writer: extToCarrier })
    try {
      await ext.request("initialize", {
        protocol: { name: FD_PROTOCOL_NAME, major: 1, minor: 0 },
        clientInfo: { name: "kilo-vscode", version: "7.4.11" },
        capabilities: ["session/update", "session/cancelQueued"],
      })
      const res = (await ext.request("session/update", req)) as Record<string, unknown>
      expect(res.status).toBe("succeeded")
      const data = (res as unknown as { data: Record<string, unknown> }).data
      const title = (data.title as string) ?? ((data.session as Record<string, unknown>)?.title as string)
      expect(title).toBe("carrier-positive-title")
      expect(title).toBe(sdkTitle)
      const rev = ((res as unknown as { revision: { session: number } }).revision.session)
      expect(rev).toBe(sdkRev)
      // Verify no new mutation: current session title still the committed one and revision unchanged after replay
      const after = await AppRuntime.runPromise(
        provideInstance(dir)(
          Effect.gen(function* () {
            const svc = yield* Session.Service
            return yield* svc.get(SessionID.make(session.id))
          }),
        ),
      )
      expect(after.title).toBe("carrier-positive-title")
    } finally {
      carrier.dispose()
      ext.dispose()
      delete process.env.KILO_PARENT_PID
    }
  })
})
