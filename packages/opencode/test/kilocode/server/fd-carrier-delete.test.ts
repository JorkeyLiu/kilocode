import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { PassThrough } from "stream"
import { Session } from "../../../src/session/session"
import { SessionOperation } from "@opencode-ai/core/session/operation"
import { createFdCarrier } from "../../../src/kilocode/server/fd-carrier"
import { FD_PROTOCOL_NAME } from "../../../src/kilocode/server/fd-carrier-protocol"
import { JsonRpcPeer } from "../../../src/private-worker/peer"
import { tmpdir, disposeAllInstances, provideInstance } from "../../fixture/fixture"
import { resetDatabase } from "../../fixture/db"
import { AppRuntime } from "../../../src/effect/app-runtime"
import * as Log from "@opencode-ai/core/util/log"
import { BackgroundProcess } from "../../../src/kilocode/background-process"
import { SessionDeleteDispatchService } from "../../../src/kilocode/session/session-delete-dispatch"
import path from "path"

void Log.init({ print: false })

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("FD session/delete authoritative routing", () => {
  test("session/delete via carrier is authoritative and commits without prior SDK dispatch", async () => {
    const origParent = process.env.KILO_PARENT_PID
    process.env.KILO_PARENT_PID = "1"
    await using tmp = await tmpdir({ git: true })
    const dir = tmp.path
    const session = await AppRuntime.runPromise(
      provideInstance(dir)(
        Effect.gen(function* () {
          const svc = yield* Session.Service
          return yield* svc.create({ title: "carrier-delete" })
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
        capabilities: ["session/delete", "session/cancelQueued"],
      })
      const token = "carrier-del-" + crypto.randomUUID().slice(0, 6)
      const opId = SessionOperation.deleteId(session.id, token)
      const req = {
        v: 1 as const,
        requestId: "req-carrier-delete",
        opId,
        op: "session/delete" as const,
        idempotencyKey: opId,
        context: { directory: dir, sessionId: session.id, parentSessionId: null },
        payload: {},
      }
      const res = (await ext.request("session/delete", req)) as Record<string, unknown>
      expect(res.status).toBe("succeeded")
      const after = await AppRuntime.runPromise(
        provideInstance(dir)(
          Effect.gen(function* () {
            const svc = yield* Session.Service
            return yield* svc.list({})
          }),
        ),
      )
      expect((after as unknown as Session.Info[]).find((s) => s.id === session.id)).toBeUndefined()
    } finally {
      carrier.dispose()
      ext.dispose()
      if (origParent === undefined) delete process.env.KILO_PARENT_PID
      else process.env.KILO_PARENT_PID = origParent
    }
  })

  test("session/delete via carrier authoritative commit then idempotent replay", async () => {
    const origParent = process.env.KILO_PARENT_PID
    process.env.KILO_PARENT_PID = "1"
    await using tmp = await tmpdir({ git: true })
    const dir = tmp.path
    const session = await AppRuntime.runPromise(
      provideInstance(dir)(
        Effect.gen(function* () {
          const svc = yield* Session.Service
          return yield* svc.create({ title: "carrier-delete-replay" })
        }),
      ),
    )
    const token = "carrier-del-replay-" + crypto.randomUUID().slice(0, 8)
    const opId = SessionOperation.deleteId(session.id, token)
    const req = {
      v: 1 as const,
      requestId: "req-carrier-delete-replay",
      opId,
      op: "session/delete" as const,
      idempotencyKey: opId,
      context: { directory: dir, sessionId: session.id, parentSessionId: null },
      payload: {},
    } as unknown as Record<string, unknown>
    const extToCarrier = new PassThrough()
    const carrierToExt = new PassThrough()
    const carrier = createFdCarrier(extToCarrier, carrierToExt)
    const ext = new JsonRpcPeer({ reader: carrierToExt, writer: extToCarrier })
    try {
      await ext.request("initialize", {
        protocol: { name: FD_PROTOCOL_NAME, major: 1, minor: 0 },
        clientInfo: { name: "kilo-vscode", version: "7.4.11" },
        capabilities: ["session/delete", "session/cancelQueued"],
      })
      const first = (await ext.request("session/delete", req)) as Record<string, unknown>
      expect(first.status).toBe("succeeded")
      const second = (await ext.request("session/delete", req)) as Record<string, unknown>
      expect(second.status).toBe("succeeded")
      expect(second.opId).toBe(opId)
    } finally {
      carrier.dispose()
      ext.dispose()
      if (origParent === undefined) delete process.env.KILO_PARENT_PID
      else process.env.KILO_PARENT_PID = origParent
    }
  })

  test("session/delete via carrier rejects omitted parentSessionId without mutation", async () => {
    const origParent = process.env.KILO_PARENT_PID
    process.env.KILO_PARENT_PID = "1"
    await using tmp = await tmpdir({ git: true })
    const dir = tmp.path
    const session = await AppRuntime.runPromise(
      provideInstance(dir)(
        Effect.gen(function* () {
          const svc = yield* Session.Service
          return yield* svc.create({ title: "carrier-delete-strict" })
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
        capabilities: ["session/delete", "session/cancelQueued"],
      })
      const token = "carrier-delete-strict-" + crypto.randomUUID().slice(0, 8)
      const opId = SessionOperation.deleteId(session.id, token)
      const req = {
        v: 1 as const,
        requestId: "req-carrier-delete-strict",
        opId,
        op: "session/delete" as const,
        idempotencyKey: opId,
        context: { directory: dir, sessionId: session.id },
        payload: {},
      } as unknown as Record<string, unknown>
      const res = (await ext.request("session/delete", req)) as Record<string, unknown>
      expect(res.status).toBe("failed")
      expect((res as unknown as { failure: { code: string } }).failure.code).toBe("validation.failed")
      const still = await AppRuntime.runPromise(
        provideInstance(dir)(
          Effect.gen(function* () {
            const svc = yield* Session.Service
            return yield* svc.get(session.id as unknown as import("../../../src/session/schema").SessionID)
          }),
        ),
      )
      expect(still.id).toBe(session.id)
    } finally {
      carrier.dispose()
      ext.dispose()
      if (origParent === undefined) delete process.env.KILO_PARENT_PID
      else process.env.KILO_PARENT_PID = origParent
    }
  })

  test("session/delete via private dispatch cleans instance-scoped background process", async () => {
    await using tmp = await tmpdir({ git: true })
    const dir = tmp.path
    await AppRuntime.runPromise(
      provideInstance(dir)(
        Effect.gen(function* () {
          const svc = yield* Session.Service
          const session = yield* svc.create({ title: "carrier-delete-cleanup" })
          const scriptPath = path.join(dir, "bg-cleanup.mjs")
          yield* Effect.promise(() => Bun.write(scriptPath, `console.log("ready"); setInterval(()=>{}, 1000)`))
          const command = `${process.execPath} ${scriptPath}`
          const bg = yield* Effect.promise(() =>
            BackgroundProcess.start({
              sessionID: session.id as unknown as import("../../../src/session/schema").SessionID,
              command,
              cwd: dir,
              ready: { pattern: "ready", timeout: 5000 },
            }),
          )
          const before = yield* Effect.promise(() => BackgroundProcess.list({ sessionID: session.id as unknown as import("../../../src/session/schema").SessionID }))
          expect(before.map((b) => b.id)).toContain(bg.id)
          const token = "carrier-del-cleanup-" + crypto.randomUUID().slice(0, 6)
          const opId = SessionOperation.deleteId(session.id, token)
          const req = {
            v: 1 as const,
            requestId: "req-carrier-delete-cleanup",
            opId,
            op: "session/delete" as const,
            idempotencyKey: opId,
            context: { directory: dir, sessionId: session.id, parentSessionId: null },
            payload: {},
          }
          const d = yield* SessionDeleteDispatchService
          const res = yield* d.dispatch(req)
          expect(res.status).toBe("succeeded")
          const after = yield* Effect.promise(() => BackgroundProcess.list({ sessionID: session.id as unknown as import("../../../src/session/schema").SessionID }))
          expect(after.map((b) => b.id)).not.toContain(bg.id)
          const got = yield* Effect.promise(() => BackgroundProcess.get(bg.id))
          expect(got).toBeUndefined()
          const list = yield* svc.list({})
          expect((list as unknown as Session.Info[]).find((s) => s.id === session.id)).toBeUndefined()
        }) as unknown as Effect.Effect<void, never, never>,
      ),
    )
  })
})
