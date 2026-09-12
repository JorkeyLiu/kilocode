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

function connectReq(dir: string, name: string, token = "tok1", overrides: Record<string, unknown> = {}) {
  const opId = `mcp-connect:${token}`
  return {
    v: 1,
    requestId: "req-connect-1",
    opId,
    op: "mcp/connect",
    idempotencyKey: opId,
    context: { directory: dir },
    payload: { name },
    ...overrides,
  }
}

function disconnectReq(dir: string, name: string, token = "tok1", overrides: Record<string, unknown> = {}) {
  const opId = `mcp-disconnect:${token}`
  return {
    v: 1,
    requestId: "req-disconnect-1",
    opId,
    op: "mcp/disconnect",
    idempotencyKey: opId,
    context: { directory: dir },
    payload: { name },
    ...overrides,
  }
}

async function init(ext: JsonRpcPeer) {
  return asRecord(
    await ext.request("initialize", {
      protocol: { name: FD_PROTOCOL_NAME, major: 1, minor: 0 },
      clientInfo: { name: "kilo-vscode", version: "7.4.11" },
      capabilities: ["mcp/connect", "mcp/disconnect"],
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

describe("fd-carrier mcp/connect + mcp/disconnect (private-only, no replay)", () => {
  afterEach(async () => {
    await disposeAllInstances()
    await resetDatabase()
  })

  it.live("initialize advertises mcp/connect and mcp/disconnect capabilities", () =>
    Effect.gen(function* () {
      const restore = ownParentPid()
      try {
        const { carrier, ext } = linked()
        try {
          const res = yield* Effect.promise(() => init(ext))
          const caps = (res.capabilities as unknown[]) ?? []
          expect((caps as string[]).includes("mcp/connect")).toBeTrue()
          expect((caps as string[]).includes("mcp/disconnect")).toBeTrue()
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        restore()
      }
    }),
  )

  it.live("connect succeeds against the real directory-keyed MCP.Service with no state snapshot", () =>
    Effect.gen(function* () {
      const restore = ownParentPid()
      try {
        const tmp = yield* Effect.promise(() =>
          tmpdir({
            git: true,
            retain: true,
            config: {
              mcp: { demo: { type: "local", command: ["true"], enabled: false, timeout: 1000 } },
            } as never,
          }),
        )
        const dir = tmp.path
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => init(ext))
          const raw = yield* Effect.promise(() =>
            ext.request("mcp/connect", connectReq(dir, "demo", "conn-tok", { requestId: "req-conn" })),
          )
          const rec = asRecord(raw)
          expect(rec.v).toBe(1)
          expect(rec.op).toBe("mcp/connect")
          expect(rec.status).toBe("succeeded")
          expect(rec.accepted).toBeTrue()
          expect(rec.requestId).toBe("req-conn")
          expect(rec.opId).toBe("mcp-connect:conn-tok")
          expect(rec.idempotencyKey).toBe("mcp-connect:conn-tok")
          expect(asRecord(rec.data)).toEqual({ connected: true })
          expect(rec.failure).toBeUndefined()
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        restore()
      }
    }),
  )

  it.live("disconnect succeeds after connect through the same lane", () =>
    Effect.gen(function* () {
      const restore = ownParentPid()
      try {
        const tmp = yield* Effect.promise(() =>
          tmpdir({
            git: true,
            retain: true,
            config: {
              mcp: { demo: { type: "local", command: ["true"], enabled: false, timeout: 1000 } },
            } as never,
          }),
        )
        const dir = tmp.path
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => init(ext))
          const connected = asRecord(
            yield* Effect.promise(() => ext.request("mcp/connect", connectReq(dir, "demo", "c1"))),
          )
          expect(connected.status).toBe("succeeded")
          const raw = yield* Effect.promise(() =>
            ext.request("mcp/disconnect", disconnectReq(dir, "demo", "d1", { requestId: "req-disc" })),
          )
          const rec = asRecord(raw)
          expect(rec.v).toBe(1)
          expect(rec.op).toBe("mcp/disconnect")
          expect(rec.status).toBe("succeeded")
          expect(rec.accepted).toBeTrue()
          expect(rec.requestId).toBe("req-disc")
          expect(asRecord(rec.data)).toEqual({ disconnected: true })
          expect(rec.failure).toBeUndefined()
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        restore()
      }
    }),
  )

  it.live("unknown server is a typed terminal mcp.not_found with no retry", () =>
    Effect.gen(function* () {
      const restore = ownParentPid()
      try {
        const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
        const dir = tmp.path
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => init(ext))
          for (const [method, req] of [
            ["mcp/connect", connectReq(dir, "nope", "nf-c")],
            ["mcp/disconnect", disconnectReq(dir, "nope", "nf-d")],
          ] as const) {
            const rec = asRecord(yield* Effect.promise(() => ext.request(method, req)))
            expect(rec.status).toBe("failed")
            expect(rec.accepted).toBeFalse()
            const failure = failureOf(rec)
            expect(failure.code).toBe("mcp.not_found")
            expect(failure.retryable).toBeFalse()
            expect(rec.data).toBeUndefined()
            expect(JSON.stringify(rec).includes("nope")).toBeFalse()
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

  it.live("directory routing isolates instances and canonicalizes paths", () =>
    Effect.gen(function* () {
      const restore = ownParentPid()
      try {
        const tmpA = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
        const tmpB = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => init(ext))
          const first = asRecord(
            yield* Effect.promise(() => ext.request("mcp/connect", connectReq(tmpA.path, "ghost", "iso-a"))),
          )
          expect(failureOf(first).code).toBe("mcp.not_found")
          const second = asRecord(
            yield* Effect.promise(() => ext.request("mcp/connect", connectReq(tmpB.path, "ghost", "iso-a"))),
          )
          expect(failureOf(second).code).toBe("mcp.not_found")
          const slashed = asRecord(
            yield* Effect.promise(() => ext.request("mcp/disconnect", disconnectReq(`${tmpA.path}/`, "ghost", "iso-b"))),
          )
          expect(failureOf(slashed).code).toBe("mcp.not_found")
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        restore()
      }
    }),
  )

  it.live("strict validation fails closed as non-retryable terminal on both ops", () =>
    Effect.gen(function* () {
      const restore = ownParentPid()
      try {
        const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
        const dir = tmp.path
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => init(ext))
          const cases: Array<{ method: string; req: Record<string, unknown> }> = [
            { method: "mcp/connect", req: connectReq("relative/path", "demo") },
            { method: "mcp/connect", req: connectReq(dir, "demo", "tok1", { payload: { name: "demo", extra: 1 } }) },
            { method: "mcp/connect", req: connectReq(dir, "demo", "tok1", { payload: {} }) },
            { method: "mcp/connect", req: connectReq(dir, "", "tok1") },
            { method: "mcp/connect", req: connectReq(dir, "demo", "tok1", { idempotencyKey: "mcp-connect:other" }) },
            { method: "mcp/connect", req: connectReq(dir, "demo", "tok1", { extra: 1 }) },
            {
              method: "mcp/connect",
              req: { ...connectReq(dir, "demo", "tok1"), context: { directory: dir, workspace: "w" } },
            },
            {
              method: "mcp/connect",
              req: connectReq(dir, "demo", "tok1", {
                opId: "mcp-connect:a:b",
                idempotencyKey: "mcp-connect:a:b",
              }),
            },
            {
              method: "mcp/connect",
              req: connectReq(dir, "demo", "tok1", {
                opId: "mcp-disconnect:tok1",
                idempotencyKey: "mcp-disconnect:tok1",
              }),
            },
            { method: "mcp/connect", req: connectReq(dir, "demo", "a/b") },
            { method: "mcp/disconnect", req: disconnectReq("relative/path", "demo") },
            { method: "mcp/disconnect", req: disconnectReq(dir, "demo", "tok1", { payload: { name: "demo", extra: 1 } }) },
            { method: "mcp/disconnect", req: disconnectReq(dir, "", "tok1") },
            { method: "mcp/disconnect", req: disconnectReq(dir, "demo", "tok1", { idempotencyKey: "mcp-disconnect:other" }) },
            { method: "mcp/disconnect", req: disconnectReq(dir, "demo", "tok1", { extra: 1 }) },
            {
              method: "mcp/disconnect",
              req: disconnectReq(dir, "demo", "tok1", {
                opId: "mcp-connect:tok1",
                idempotencyKey: "mcp-connect:tok1",
              }),
            },
          ]
          for (const { method, req } of cases) {
            const rec = asRecord(yield* Effect.promise(() => ext.request(method, req)))
            expect(rec.status).toBe("failed")
            expect(failureOf(rec).code).toBe("validation.failed")
            expect(failureOf(rec).retryable).toBeFalse()
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
            for (const [method, req] of [
              ["mcp/connect", connectReq(fenceDir, "demo", "fence-c", { requestId: "req-fc" })],
              ["mcp/disconnect", disconnectReq(fenceDir, "demo", "fence-d", { requestId: "req-fd" })],
            ] as const) {
              const rec = asRecord(yield* Effect.promise(() => ext.request(method, req)))
              expect(rec.status).toBe("failed")
              expect(rec.accepted).toBeFalse()
              expect(failureOf(rec).code).toBe("InstanceUnavailableDuringConfigRebuild")
              expect(failureOf(rec).retryable).toBeTrue()
              expect(rec.data).toBeUndefined()
              expect(JSON.stringify(rec).includes(fenceDir)).toBeFalse()
            }
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
