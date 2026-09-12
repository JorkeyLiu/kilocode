import { afterEach, describe, expect } from "bun:test"
import { PassThrough } from "stream"
import { Context, Effect } from "effect"
import { JsonRpcPeer } from "../../../src/private-worker/peer"
import { createFdCarrier } from "../../../src/kilocode/server/fd-carrier"
import { FD_PROTOCOL_NAME } from "../../../src/kilocode/server/fd-carrier-protocol"
import { AppLayer } from "../../../src/effect/app-runtime"
import { MCP } from "../../../src/mcp"
import { GenerationGate } from "../../../src/kilocode/server/generation-gate"
import { InstanceStore } from "../../../src/project/instance-store"
import { InstanceRef } from "../../../src/effect/instance-ref"
import type { InstanceContext } from "../../../src/project/instance-context"
import { runInInstance } from "../../../src/kilocode/effect/als-bridge"
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

function reqFor(dir: string, token = "tok1", overrides: Record<string, unknown> = {}) {
  const opId = `mcp-status:${token}`
  return {
    v: 1,
    requestId: "req-mcp-1",
    opId,
    op: "mcp/status",
    idempotencyKey: opId,
    context: { directory: dir },
    payload: {},
    ...overrides,
  }
}

async function init(ext: JsonRpcPeer) {
  return asRecord(
    await ext.request("initialize", {
      protocol: { name: FD_PROTOCOL_NAME, major: 1, minor: 0 },
      clientInfo: { name: "kilo-vscode", version: "7.4.11" },
      capabilities: ["mcp/status"],
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

function scoped(ctx: InstanceContext, captured: Context.Context<never>) {
  return <A, E, R>(work: Effect.Effect<A, E, R>): Effect.Effect<A, E, never> =>
    runInInstance(
      ctx,
      work.pipe(Effect.provide(captured as unknown as Context.Context<R>), Effect.provideService(InstanceRef, ctx)),
    )
}

describe("fd-carrier mcp/status (read-only private-first)", () => {
  afterEach(async () => {
    await disposeAllInstances()
    await resetDatabase()
  })

  it.live("initialize advertises mcp/status capability", () =>
    Effect.gen(function* () {
      const restore = ownParentPid()
      try {
        const { carrier, ext } = linked()
        try {
          const res = yield* Effect.promise(() => init(ext))
          const caps = (res.capabilities as unknown[]) ?? []
          expect((caps as string[]).includes("mcp/status")).toBeTrue()
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        restore()
      }
    }),
  )

  it.live("success returns the exact MCP.Service.status() shape with no mutation", () =>
    Effect.gen(function* () {
      const restore = ownParentPid()
      try {
        const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
        const dir = tmp.path
        const store = yield* InstanceStore.Service
        const ctx = yield* store.load({ directory: dir })
        const captured = yield* Effect.context()
        const run = scoped(ctx, captured)
        const expected = yield* run(
          Effect.gen(function* () {
            const svc = yield* MCP.Service
            return yield* svc.status()
          }),
        )
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => init(ext))
          const raw = yield* Effect.promise(() =>
            ext.request("mcp/status", reqFor(dir, "hit-tok", { requestId: "req-hit" })),
          )
          const rec = asRecord(raw)
          expect(rec.v).toBe(1)
          expect(rec.op).toBe("mcp/status")
          expect(rec.status).toBe("succeeded")
          expect(rec.accepted).toBeTrue()
          expect(rec.requestId).toBe("req-hit")
          expect(rec.opId).toBe("mcp-status:hit-tok")
          const data = asRecord(rec.data)
          expect(JSON.stringify(data.status)).toBe(JSON.stringify(expected))
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
          const first = asRecord(yield* Effect.promise(() => ext.request("mcp/status", reqFor(tmpA.path, "iso-a"))))
          expect(first.status).toBe("succeeded")
          expect(first.accepted).toBeTrue()
          const second = asRecord(yield* Effect.promise(() => ext.request("mcp/status", reqFor(tmpB.path, "iso-a"))))
          expect(second.status).toBe("succeeded")
          expect(second.accepted).toBeTrue()
          expect(JSON.stringify(asRecord(second.data).status)).toBe(JSON.stringify(asRecord(first.data).status))
          const slashed = asRecord(
            yield* Effect.promise(() => ext.request("mcp/status", reqFor(`${tmpA.path}/`, "iso-b"))),
          )
          expect(slashed.status).toBe("succeeded")
          expect(slashed.accepted).toBeTrue()
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
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => init(ext))
          const cases = [
            reqFor("relative/path", "tok1"),
            reqFor(tmp.path, "tok1", { payload: { directory: tmp.path } }),
            reqFor(tmp.path, "tok1", { idempotencyKey: "mcp-status:other" }),
            reqFor(tmp.path, "tok1", { extra: 1 }),
            { ...reqFor(tmp.path, "tok1"), context: { directory: tmp.path, workspace: "w" } },
            reqFor(tmp.path, "tok1", { opId: "mcp-status:a:b", idempotencyKey: "mcp-status:a:b" }),
            reqFor(tmp.path, "tok1", { opId: "permission-list:tok1", idempotencyKey: "permission-list:tok1" }),
            reqFor(tmp.path, "a/b"),
          ]
          for (const req of cases) {
            const raw = yield* Effect.promise(() => ext.request("mcp/status", req))
            const rec = asRecord(raw)
            expect(rec.status).toBe("failed")
            expect(asRecord(rec.failure).code).toBe("validation.failed")
            expect(asRecord(rec.failure).retryable).toBeFalse()
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

  it.live("active fence maps to retryable InstanceUnavailableDuringConfigRebuild then recovers", () =>
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
            const raw = yield* Effect.promise(() =>
              ext.request("mcp/status", reqFor(fenceDir, "fence-tok", { requestId: "req-fence" })),
            )
            const rec = asRecord(raw)
            expect(rec.status).toBe("failed")
            expect(rec.accepted).toBeFalse()
            expect(asRecord(rec.failure).code).toBe("InstanceUnavailableDuringConfigRebuild")
            expect(asRecord(rec.failure).retryable).toBeTrue()
            expect(rec.data).toBeUndefined()
            const wire = JSON.stringify(rec)
            expect(wire.includes(fenceDir)).toBeFalse()
          } finally {
            carrier.dispose()
            ext.dispose()
          }
        } finally {
          yield* ticket.release.pipe(Effect.ignore)
        }
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => init(ext))
          const second = asRecord(
            yield* Effect.promise(() =>
              ext.request("mcp/status", reqFor(fenceDir, "fence-after", { requestId: "req-after" })),
            ),
          )
          expect(second.status).toBe("succeeded")
          expect(second.accepted).toBeTrue()
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        restore()
      }
    }),
  )
})
