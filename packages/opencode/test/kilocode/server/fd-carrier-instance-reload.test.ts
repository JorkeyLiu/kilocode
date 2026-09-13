import { afterEach, describe, expect } from "bun:test"
import { PassThrough } from "stream"
import { Context, Effect } from "effect"
import { JsonRpcPeer } from "../../../src/private-worker/peer"
import { ErrorCode } from "../../../src/private-worker/json-rpc"
import { createFdCarrier } from "../../../src/kilocode/server/fd-carrier"
import { FD_PROTOCOL_NAME } from "../../../src/kilocode/server/fd-carrier-protocol"
import { AppLayer } from "../../../src/effect/app-runtime"
import { InstanceStore } from "../../../src/project/instance-store"
import { Session } from "../../../src/session/session"
import { SessionStatus } from "../../../src/session/status"
import { InstanceRef } from "../../../src/effect/instance-ref"
import type { InstanceContext } from "../../../src/project/instance-context"
import { runInInstance } from "../../../src/kilocode/effect/als-bridge"
import {
  canonicalInstanceReloadOpId,
  validateInstanceReloadRequest,
} from "../../../src/kilocode/instance-reload-private"
import { testEffectShared } from "../../lib/effect"
import { tmpdir, disposeAllInstances } from "../../fixture/fixture"
import { resetDatabase } from "../../fixture/db"
import { readFile } from "fs/promises"

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

const it = testEffectShared(AppLayer)

type ReloadResult = {
  v: number
  requestId: string
  opId: string
  op: string
  idempotencyKey: string
  status: string
  outcome: { type: string; time: number; failure?: { code: string; message: string; retryable: boolean } }
  accepted: boolean
  data?: { reloaded: boolean }
  failure?: { code: string; message: string; retryable: boolean }
}

function record(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function asRecord(v: unknown): Record<string, unknown> {
  if (!record(v)) throw new Error("expected record response")
  return v
}

function str(row: Record<string, unknown>, key: string): string {
  const v = row[key]
  if (typeof v !== "string") throw new Error(`expected string response.${key}`)
  return v
}

function failureOf(v: unknown, p: string): { code: string; message: string; retryable: boolean } {
  if (!record(v)) throw new Error(`expected record ${p}`)
  if (typeof v.code !== "string") throw new Error(`expected string ${p}.code`)
  if (typeof v.message !== "string") throw new Error(`expected string ${p}.message`)
  if (typeof v.retryable !== "boolean") throw new Error(`expected boolean ${p}.retryable`)
  return { code: v.code, message: v.message, retryable: v.retryable }
}

function asReloadResult(v: unknown): ReloadResult {
  const row = asRecord(v)
  if (row.v !== 1) throw new Error("expected response.v to be 1")
  const requestId = str(row, "requestId")
  const opId = str(row, "opId")
  if (str(row, "op") !== "instance/reload") throw new Error("expected response.op to be instance/reload")
  const idempotencyKey = str(row, "idempotencyKey")
  const status = str(row, "status")
  if (status !== "succeeded" && status !== "failed") throw new Error("expected response.status succeeded or failed")
  if (typeof row.accepted !== "boolean") throw new Error("expected boolean response.accepted")
  const outcomeRaw = row.outcome
  if (!record(outcomeRaw)) throw new Error("expected record response.outcome")
  if (typeof outcomeRaw.type !== "string") throw new Error("expected string response.outcome.type")
  if (typeof outcomeRaw.time !== "number") throw new Error("expected number response.outcome.time")
  if (outcomeRaw.type !== status) throw new Error("expected response.outcome.type to match response.status")
  const outcome: ReloadResult["outcome"] =
    outcomeRaw.failure === undefined
      ? { type: outcomeRaw.type, time: outcomeRaw.time }
      : { type: outcomeRaw.type, time: outcomeRaw.time, failure: failureOf(outcomeRaw.failure, "response.outcome.failure") }
  const dataRaw = row.data
  const data = dataRaw === undefined ? undefined : { reloaded: (asRecord(dataRaw).reloaded as boolean) }
  const failure = row.failure === undefined ? undefined : failureOf(row.failure, "response.failure")
  if (status === "succeeded") {
    if (row.accepted !== true) throw new Error("expected accepted true for succeeded")
    if (opId !== idempotencyKey) throw new Error("expected response.opId to equal response.idempotencyKey")
    if (data?.reloaded !== true) throw new Error("expected response.data.reloaded true for succeeded")
    if (failure !== undefined) throw new Error("expected no response.failure for succeeded")
  } else {
    if (row.accepted !== false) throw new Error("expected accepted false for failed")
    if (data !== undefined) throw new Error("expected no response.data for failed")
    if (failure === undefined) throw new Error("expected response.failure for failed")
    if (outcome.failure === undefined) throw new Error("expected response.outcome.failure for failed")
    if (failure.code !== outcome.failure.code) throw new Error("expected failure code echo")
  }
  return { v: 1, requestId, opId, op: "instance/reload", idempotencyKey, status, outcome, accepted: row.accepted, ...(data ? { data } : {}), ...(failure ? { failure } : {}) }
}

function codeOf(v: ReloadResult): string | undefined {
  return v.failure?.code ?? v.outcome.failure?.code
}

function linked() {
  const extToCarrier = new PassThrough()
  const carrierToExt = new PassThrough()
  const carrier = createFdCarrier(extToCarrier, carrierToExt)
  const ext = new JsonRpcPeer({ reader: carrierToExt, writer: extToCarrier })
  return { carrier, ext }
}

function req(dir: string, token = "tok1", overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const opId = canonicalInstanceReloadOpId(token)
  return {
    v: 1,
    requestId: "req-reload-1",
    opId,
    op: "instance/reload",
    idempotencyKey: opId,
    context: { directory: dir },
    payload: {},
    ...overrides,
  }
}

async function init(ext: JsonRpcPeer): Promise<Record<string, unknown>> {
  return asRecord(
    await ext.request("initialize", {
      protocol: { name: FD_PROTOCOL_NAME, major: 1, minor: 0 },
      clientInfo: { name: "kilo-vscode", version: "7.4.11" },
      capabilities: ["instance/reload"],
    }),
  )
}

function capsOf(v: unknown): string[] {
  if (!record(v)) return []
  const caps = v.capabilities
  if (!Array.isArray(caps)) return []
  return caps.filter((entry): entry is string => typeof entry === "string")
}

function asError(v: unknown): { code?: number; message?: string } {
  if (!record(v)) return {}
  const out: { code?: number; message?: string } = {}
  if (typeof v.code === "number") out.code = v.code
  if (typeof v.message === "string") out.message = v.message
  return out
}

describe("fd-carrier instance/reload (authoritative reboot)", () => {
  afterEach(async () => {
    await disposeAllInstances()
    await resetDatabase()
  })

  it.live("initialize advertises instance/reload capability", () =>
    Effect.gen(function* () {
      const { carrier, ext } = linked()
      try {
        const res = yield* Effect.promise(() => init(ext))
        expect(capsOf(res).includes("instance/reload")).toBeTrue()
      } finally {
        carrier.dispose()
        ext.dispose()
      }
    }),
  )

  it.live("pre-init reload rejected InvalidRequest", () =>
    Effect.gen(function* () {
      const { carrier, ext } = linked()
      try {
        const err = yield* Effect.promise(() =>
          ext.request("instance/reload", req("/tmp")).then(
            () => undefined,
            (e: unknown) => e,
          ),
        )
        expect(asError(err).code).toBe(ErrorCode.InvalidRequest)
      } finally {
        carrier.dispose()
        ext.dispose()
      }
    }),
  )

  it.live("unknown root field fails closed validation.failed", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
      const dir = tmp.path
      const store = yield* InstanceStore.Service
      yield* store.load({ directory: dir })
      const { carrier, ext } = linked()
      try {
        yield* Effect.promise(() => init(ext))
        const raw = yield* Effect.promise(() =>
          ext.request("instance/reload", req(dir, "unknown-field", { requestId: "req-unknown", extra: true })),
        )
        const res = asReloadResult(raw)
        expect(res.status).toBe("failed")
        expect(codeOf(res)).toBe("validation.failed")
        expect(res.requestId).toBe("req-unknown")
        expect(res.opId).toBe(res.idempotencyKey)
      } finally {
        carrier.dispose()
        ext.dispose()
      }
    }),
  )

  it.live("relative directory fails closed without reload", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
      const dir = tmp.path
      const store = yield* InstanceStore.Service
      yield* store.load({ directory: dir })
      const { carrier, ext } = linked()
      try {
        yield* Effect.promise(() => init(ext))
        const opId = canonicalInstanceReloadOpId("tok-reldir")
        const raw = yield* Effect.promise(() =>
          ext.request("instance/reload", {
            v: 1,
            requestId: "req-reldir",
            opId,
            op: "instance/reload",
            idempotencyKey: opId,
            context: { directory: "relative/path" },
            payload: {},
          }),
        )
        const res = asReloadResult(raw)
        expect(res.status).toBe("failed")
        expect(codeOf(res)).toBe("validation.failed")
      } finally {
        carrier.dispose()
        ext.dispose()
      }
    }),
  )

  it.live("non-empty payload fails closed validation.failed", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
      const dir = tmp.path
      const store = yield* InstanceStore.Service
      yield* store.load({ directory: dir })
      const { carrier, ext } = linked()
      try {
        yield* Effect.promise(() => init(ext))
        const opId = canonicalInstanceReloadOpId("tok-payload")
        const raw = yield* Effect.promise(() =>
          ext.request("instance/reload", {
            v: 1,
            requestId: "req-payload",
            opId,
            op: "instance/reload",
            idempotencyKey: opId,
            context: { directory: dir },
            payload: { extra: 1 },
          }),
        )
        const res = asReloadResult(raw)
        expect(res.status).toBe("failed")
        expect(codeOf(res)).toBe("validation.failed")
      } finally {
        carrier.dispose()
        ext.dispose()
      }
    }),
  )

  it.live("idle success reloads with reloaded:true and stays usable", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
      const dir = tmp.path
      const store = yield* InstanceStore.Service
      yield* store.load({ directory: dir })
      const { carrier, ext } = linked()
      try {
        yield* Effect.promise(() => init(ext))
        const raw = yield* Effect.promise(() => ext.request("instance/reload", req(dir, "tok-ok")))
        const res = asReloadResult(raw)
        expect(res.status).toBe("succeeded")
        expect(res.accepted).toBeTrue()
        expect(res.data?.reloaded).toBeTrue()
        expect(res.opId).toBe(res.idempotencyKey)
        // Still usable after reload: snapshot exists.
        const snap = yield* store.snapshot(dir)
        expect(snap._tag).toBe("Some")
      } finally {
        carrier.dispose()
        ext.dispose()
      }
    }),
  )

  it.live("active session conflict closes terminally with zero reload", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
      const dir = tmp.path
      const store = yield* InstanceStore.Service
      const ctx = yield* store.load({ directory: dir })
      const captured = yield* Effect.context()
      const run = scoped(ctx, captured)
      const sess = yield* run(
        Effect.gen(function* () {
          const svc = yield* Session.Service
          return yield* svc.create({ title: "reload-conflict" })
        }),
      )
      yield* run(
        Effect.gen(function* () {
          const svc = yield* SessionStatus.Service
          yield* svc.set(sess.id, { type: "busy" })
        }),
      )
      const { carrier, ext } = linked()
      try {
        yield* Effect.promise(() => init(ext))
        const raw = yield* Effect.promise(() => ext.request("instance/reload", req(dir, "tok-conflict")))
        const res = asReloadResult(raw)
        expect(res.status).toBe("failed")
        expect(codeOf(res)).toBe("conflict")
        expect(res.failure?.retryable).toBe(false)
        // Zero reload: the busy status survives (a reload would have rebooted to idle).
        // Note: the private path reads via snapshot+lease, not the stale ctx;
        // if it had reloaded, the snapshot would be a new identity with empty statuses.
        // Re-read via fresh snapshot to prove no reboot.
        const fresh = yield* store.snapshot(dir)
        expect(fresh._tag).toBe("Some")
        if (fresh._tag === "Some") {
          const st = yield* run(
            Effect.gen(function* () {
              const svc = yield* SessionStatus.Service
              return yield* svc.get(sess.id)
            }),
          )
          expect(st.type).toBe("busy")
        }
      } finally {
        carrier.dispose()
        ext.dispose()
      }
    }),
  )

  it.live("private reuses hasActiveSession and the unique InstanceStore.reload path (no drift)", () =>
    Effect.gen(function* () {
      const shared = yield* Effect.promise(() =>
        readFile(new URL("../../../src/kilocode/instance-reload-private.ts", import.meta.url), "utf8"),
      )
      expect(shared).toContain("hasActiveSession")
      expect(shared).toContain(".reload({ directory: dir })")
      expect(shared).toContain("instance-reload:")
      expect(shared).not.toContain("session_operation")
      expect(shared).not.toContain("SessionTable")
      const handler = yield* Effect.promise(() =>
        readFile(
          new URL("../../../src/kilocode/server/httpapi/handlers/instance-reload.ts", import.meta.url),
          "utf8",
        ),
      )
      expect(handler).toContain("hasActiveSession")
      expect(handler).toContain("store.reload")
      const carrier = yield* Effect.promise(() =>
        readFile(new URL("../../../src/kilocode/server/fd-carrier.ts", import.meta.url), "utf8"),
      )
      expect(carrier).toContain("reloadInstancePrivate")
      expect(carrier).toContain("instance/reload")
      const protocol = yield* Effect.promise(() =>
        readFile(new URL("../../../src/kilocode/server/fd-carrier-protocol.ts", import.meta.url), "utf8"),
      )
      expect(protocol).toContain('"instance/reload"')
      const parsed = yield* Effect.sync(() => validateInstanceReloadRequest(req("/tmp", "tok-private")))
      expect(parsed.opId).toBe(canonicalInstanceReloadOpId("tok-private"))
    }),
  )
})
