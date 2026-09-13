import { afterEach, describe, expect } from "bun:test"
import { PassThrough } from "stream"
import { Effect } from "effect"
import { JsonRpcPeer } from "../../../src/private-worker/peer"
import { createFdCarrier } from "../../../src/kilocode/server/fd-carrier"
import { FD_PROTOCOL_NAME } from "../../../src/kilocode/server/fd-carrier-protocol"
import { AppLayer } from "../../../src/effect/app-runtime"
import { GenerationGate } from "../../../src/kilocode/server/generation-gate"
import { testEffectShared } from "../../lib/effect"
import { tmpdir, disposeAllInstances } from "../../fixture/fixture"
import { resetDatabase } from "../../fixture/db"

const it = testEffectShared(AppLayer)

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function asRecord(v: unknown): Record<string, unknown> {
  if (!isRecord(v)) throw new Error("expected record response")
  return v
}

function linked() {
  const extToCarrier = new PassThrough()
  const carrierToExt = new PassThrough()
  const carrier = createFdCarrier(extToCarrier, carrierToExt)
  const ext = new JsonRpcPeer({ reader: carrierToExt, writer: extToCarrier })
  return { carrier, ext }
}

function localConfig(overrides: Record<string, unknown> = {}) {
  return {
    type: "local",
    command: ["true"],
    enabled: false,
    timeout: 1000,
    ...overrides,
  }
}

function addReq(dir: string, name: string, token = "tok1", overrides: Record<string, unknown> = {}) {
  const opId = `mcp-add:${token}`
  return {
    v: 1,
    requestId: "req-add-1",
    opId,
    op: "mcp/add",
    idempotencyKey: opId,
    context: { directory: dir },
    payload: { name, config: localConfig() },
    ...overrides,
  }
}

async function init(ext: JsonRpcPeer) {
  return asRecord(
    await ext.request("initialize", {
      protocol: { name: FD_PROTOCOL_NAME, major: 1, minor: 0 },
      clientInfo: { name: "kilo-vscode", version: "7.4.11" },
      capabilities: ["mcp/add"],
    }),
  )
}

function ownParentPid(): () => void {
  const prior = process.env.KILO_PARENT_PID
  process.env.KILO_PARENT_PID = "1"
  return () => {
    if (prior === undefined) delete process.env.KILO_PARENT_PID
    else process.env.KILO_PARENT_PID = prior
  }
}

function failureOf(rec: Record<string, unknown>): Record<string, unknown> {
  return asRecord(rec.failure)
}

describe("fd-carrier mcp/add (private-only, no replay)", () => {
  afterEach(async () => {
    await disposeAllInstances()
    await resetDatabase()
  })

  it.live("initialize advertises the mcp/add capability", () =>
    Effect.gen(function* () {
      const restore = ownParentPid()
      try {
        const { carrier, ext } = linked()
        try {
          const res = yield* Effect.promise(() => init(ext))
          const caps = (res.capabilities as unknown[]) ?? []
          expect((caps as string[]).includes("mcp/add")).toBeTrue()
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        restore()
      }
    }),
  )

  it.live("add registers a local server and returns the status map with no state snapshot", () =>
    Effect.gen(function* () {
      const restore = ownParentPid()
      try {
        const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
        const dir = tmp.path
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => init(ext))
          const raw = yield* Effect.promise(() =>
            ext.request("mcp/add", addReq(dir, "demo", "add-tok", { requestId: "req-add" })),
          )
          const rec = asRecord(raw)
          expect(rec.v).toBe(1)
          expect(rec.op).toBe("mcp/add")
          expect(rec.status).toBe("succeeded")
          expect(rec.accepted).toBeTrue()
          expect(rec.requestId).toBe("req-add")
          expect(rec.opId).toBe("mcp-add:add-tok")
          expect(rec.idempotencyKey).toBe("mcp-add:add-tok")
          const data = asRecord(rec.data)
          const map = asRecord(data.status)
          expect("demo" in map).toBeTrue()
          expect(rec.failure).toBeUndefined()
          expect(JSON.stringify(rec).includes(dir)).toBeFalse()
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        restore()
      }
    }),
  )

  it.live("strict validation fails closed as non-retryable terminal", () =>
    Effect.gen(function* () {
      const restore = ownParentPid()
      try {
        const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
        const dir = tmp.path
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => init(ext))
          const cases: Array<{ req: Record<string, unknown> }> = [
            { req: addReq("relative/path", "demo") },
            { req: addReq(dir, "demo", "tok1", { payload: { name: "demo", config: localConfig(), extra: 1 } }) },
            { req: addReq(dir, "demo", "tok1", { payload: { name: "demo" } }) },
            { req: addReq(dir, "", "tok1") },
            { req: addReq(dir, "demo", "tok1", { idempotencyKey: "mcp-add:other" }) },
            { req: addReq(dir, "demo", "tok1", { extra: 1 }) },
            {
              req: { ...addReq(dir, "demo", "tok1"), context: { directory: dir, workspace: "w" } },
            },
            {
              req: addReq(dir, "demo", "tok1", {
                opId: "mcp-add:a:b",
                idempotencyKey: "mcp-add:a:b",
              }),
            },
            {
              req: addReq(dir, "demo", "tok1", {
                opId: "mcp-connect:tok1",
                idempotencyKey: "mcp-connect:tok1",
              }),
            },
            { req: addReq(dir, "demo", "a/b") },
            { req: addReq(dir, "demo", "tok1", { payload: { name: "demo", config: { type: "local", command: [] } } }) },
            {
              req: addReq(dir, "demo", "tok1", {
                payload: { name: "demo", config: { ...localConfig(), extra: 1 } },
              }),
            },
            {
              req: addReq(dir, "demo", "tok1", {
                payload: { name: "demo", config: { type: "bogus", command: ["true"] } },
              }),
            },
          ]
          for (const { req } of cases) {
            const rec = asRecord(yield* Effect.promise(() => ext.request("mcp/add", req)))
            expect(rec.status).toBe("failed")
            expect(rec.accepted).toBeFalse()
            expect(failureOf(rec).code).toBe("validation.failed")
            expect(failureOf(rec).retryable).toBeFalse()
            expect(rec.data).toBeUndefined()
          }
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        restore()
      }
    }),
  )

  it.live("active fence maps to retryable InstanceUnavailableDuringConfigRebuild without leaking the directory", () =>
    Effect.gen(function* () {
      const restore = ownParentPid()
      try {
        const fenceTmp = yield* Effect.promise(() => tmpdir({ retain: true }))
        const fenceDir = fenceTmp.path
        const gate = yield* GenerationGate.Service
        const ticket = yield* gate.beginFence(fenceDir)
        try {
          const { carrier, ext } = linked()
          try {
            yield* Effect.promise(() => init(ext))
            const rec = asRecord(
              yield* Effect.promise(() => ext.request("mcp/add", addReq(fenceDir, "demo", "fence-a", { requestId: "req-fa" }))),
            )
            expect(rec.status).toBe("failed")
            expect(rec.accepted).toBeFalse()
            expect(failureOf(rec).code).toBe("InstanceUnavailableDuringConfigRebuild")
            expect(failureOf(rec).retryable).toBeTrue()
            expect(rec.data).toBeUndefined()
            expect(JSON.stringify(rec).includes(fenceDir)).toBeFalse()
          } finally {
            carrier.dispose()
            ext.dispose()
          }
        } finally {
          yield* ticket.release.pipe(Effect.ignore)
        }
      } finally {
        restore()
      }
    }),
  )
})
