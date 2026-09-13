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

function authReq(dir: string, name: string, token = "tok1", overrides: Record<string, unknown> = {}) {
  const opId = `mcp-authenticate:${token}`
  return {
    v: 1,
    requestId: "req-auth-1",
    opId,
    op: "mcp/authenticate",
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
      capabilities: ["mcp/authenticate"],
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

describe("fd-carrier mcp/authenticate (private-only, no replay)", () => {
  afterEach(async () => {
    await disposeAllInstances()
    await resetDatabase()
  })

  it.live("initialize advertises mcp/authenticate capability", () =>
    Effect.gen(function* () {
      const restore = ownParentPid()
      try {
        const { carrier, ext } = linked()
        try {
          const res = yield* Effect.promise(() => init(ext))
          const caps = (res.capabilities as unknown[]) ?? []
          expect((caps as string[]).includes("mcp/authenticate")).toBeTrue()
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
          const rec = asRecord(yield* Effect.promise(() => ext.request("mcp/authenticate", authReq(dir, "nope", "nf-a"))))
          expect(rec.v).toBe(1)
          expect(rec.op).toBe("mcp/authenticate")
          expect(rec.status).toBe("failed")
          expect(rec.accepted).toBeFalse()
          expect(failureOf(rec).code).toBe("mcp.not_found")
          expect(failureOf(rec).retryable).toBeFalse()
          expect(rec.data).toBeUndefined()
          expect(JSON.stringify(rec).includes("nope")).toBeFalse()
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
          const cases: Array<Record<string, unknown>> = [
            authReq("relative/path", "demo"),
            authReq(dir, "demo", "tok1", { payload: { name: "demo", extra: 1 } }),
            authReq(dir, "", "tok1"),
            authReq(dir, "demo", "tok1", { idempotencyKey: "mcp-authenticate:other" }),
            authReq(dir, "demo", "tok1", { extra: 1 }),
            { ...authReq(dir, "demo", "tok1"), context: { directory: dir, workspace: "w" } },
            authReq(dir, "demo", "tok1", { opId: "mcp-connect:tok1", idempotencyKey: "mcp-connect:tok1" }),
            authReq(dir, "demo", "a/b"),
          ]
          for (const req of cases) {
            const rec = asRecord(yield* Effect.promise(() => ext.request("mcp/authenticate", req)))
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
            const rec = asRecord(
              yield* Effect.promise(() =>
                ext.request("mcp/authenticate", authReq(fenceDir, "demo", "fence-a", { requestId: "req-fa" })),
              ),
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
