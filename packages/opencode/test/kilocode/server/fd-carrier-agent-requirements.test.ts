import { afterEach, describe, expect } from "bun:test"
import { PassThrough } from "stream"
import { Context, Effect, Schema } from "effect"
import { JsonRpcPeer } from "../../../src/private-worker/peer"
import { ErrorCode } from "../../../src/private-worker/json-rpc"
import { createFdCarrier } from "../../../src/kilocode/server/fd-carrier"
import { FD_PROTOCOL_NAME } from "../../../src/kilocode/server/fd-carrier-protocol"
import { AppLayer } from "../../../src/effect/app-runtime"
import { Agent } from "../../../src/agent/agent"
import { GenerationGate } from "../../../src/kilocode/server/generation-gate"
import { InstanceStore } from "../../../src/project/instance-store"
import { InstanceRef } from "../../../src/effect/instance-ref"
import type { InstanceContext } from "../../../src/project/instance-context"
import * as AgentRequirements from "../../../src/kilocode/agent-requirements"
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

function reqFor(dir: string, agent: string, token = "tok1", overrides: Record<string, unknown> = {}) {
  const opId = `agent-requirements:${agent}:${token}`
  return {
    v: 1,
    requestId: "req-agent-1",
    opId,
    op: "agent/requirements",
    idempotencyKey: opId,
    context: { directory: dir, agent },
    payload: {},
    ...overrides,
  }
}

async function init(ext: JsonRpcPeer) {
  return asRecord(
    await ext.request("initialize", {
      protocol: { name: FD_PROTOCOL_NAME, major: 1, minor: 0 },
      clientInfo: { name: "kilo-vscode", version: "7.4.11" },
      capabilities: ["agent/requirements"],
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
      work.pipe(
        Effect.provide(captured as unknown as Context.Context<R>),
        Effect.provideService(InstanceRef, ctx),
      ),
    )
}

describe("fd-carrier agent/requirements (read-only private-first)", () => {
  afterEach(async () => {
    await disposeAllInstances()
    await resetDatabase()
  })

  it.live("initialize advertises agent/requirements capability", () =>
    Effect.gen(function* () {
      const restore = ownParentPid()
      try {
        const { carrier, ext } = linked()
        try {
          const res = yield* Effect.promise(() => init(ext))
          const caps = (res.capabilities as unknown[]) ?? []
          expect((caps as string[]).includes("agent/requirements")).toBeTrue()
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        restore()
      }
    }),
  )

  it.live("success returns exact AgentRequirementResult shape including state:error", () =>
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
            const svc = yield* Agent.Service
            return yield* svc.requirementStatus("build")
          }),
        )
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => init(ext))
          const raw = yield* Effect.promise(() => ext.request("agent/requirements", reqFor(dir, "build", "hit-tok", {
            requestId: "req-hit",
            opId: "agent-requirements:build:hit-tok",
            idempotencyKey: "agent-requirements:build:hit-tok",
          })))
          const rec = asRecord(raw)
          expect(rec.v).toBe(1)
          expect(rec.op).toBe("agent/requirements")
          expect(rec.status).toBe("succeeded")
          expect(rec.accepted).toBeTrue()
          const data = asRecord(rec.data)
          expect(Schema.is(AgentRequirements.Result)(data.requirements)).toBeTrue()
          expect(JSON.stringify(data.requirements)).toBe(JSON.stringify(expected))
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        restore()
      }
    }),
  )

  it.live("unknown agent stays a succeeded domain payload (disabled without flag)", () =>
    Effect.gen(function* () {
      const restore = ownParentPid()
      try {
        const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => init(ext))
          const raw = yield* Effect.promise(() =>
            ext.request("agent/requirements", reqFor(tmp.path, "missing-agent-xyz", "tok-unknown")),
          )
          const rec = asRecord(raw)
          expect(rec.status).toBe("succeeded")
          expect(rec.accepted).toBeTrue()
          const data = asRecord(rec.data)
          const payload = data.requirements as Record<string, unknown>
          expect(payload.agent).toBe("missing-agent-xyz")
          expect(Schema.is(AgentRequirements.Result)(data.requirements)).toBeTrue()
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
            reqFor("relative/path", "build"),
            reqFor(tmp.path, "build", "tok1", { payload: { agent: "build" } }),
            reqFor(tmp.path, "build", "tok1", { idempotencyKey: "agent-requirements:build:other" }),
            reqFor(tmp.path, "build", "tok1", { extra: 1 }),
            { ...reqFor(tmp.path, "build"), context: { directory: tmp.path, agent: "build", sessionId: "ses_x" } },
            reqFor(tmp.path, "build", "tok1", {
              opId: "agent-requirements:other:tok1",
              idempotencyKey: "agent-requirements:other:tok1",
            }),
            reqFor(tmp.path, "", "tok1"),
          ]
          for (const req of cases) {
            const raw = yield* Effect.promise(() => ext.request("agent/requirements", req))
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
              ext.request("agent/requirements", reqFor(fenceDir, "build", "fence-tok", { requestId: "req-fence" })),
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
              ext.request("agent/requirements", reqFor(fenceDir, "build", "fence-after", { requestId: "req-after" })),
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

  it.live("unknown method still MethodNotFound", () =>
    Effect.gen(function* () {
      const restore = ownParentPid()
      try {
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => init(ext))
          const err = yield* Effect.promise(() =>
            ext.request("session/unknown", {}).then(
              () => undefined,
              (e: unknown) => e,
            ),
          )
          const rec = isRecord(err) ? err : {}
          expect((rec as Record<string, unknown>).code).toBe(ErrorCode.MethodNotFound)
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
