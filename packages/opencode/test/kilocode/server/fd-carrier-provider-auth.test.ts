import { afterEach, describe, expect } from "bun:test"
import path from "path"
import { PassThrough } from "stream"
import { Effect } from "effect"
import { JsonRpcPeer } from "../../../src/private-worker/peer"
import { ErrorCode } from "../../../src/private-worker/json-rpc"
import { createFdCarrier } from "../../../src/kilocode/server/fd-carrier"
import { FD_PROTOCOL_NAME } from "../../../src/kilocode/server/fd-carrier-protocol"
import { AppLayer } from "../../../src/effect/app-runtime"
import { testEffectShared } from "../../lib/effect"
import { tmpdir, disposeAllInstances } from "../../fixture/fixture"
import { resetDatabase } from "../../fixture/db"
import { validateProviderAuthData } from "../../../src/kilocode/provider-auth"

const it = testEffectShared(AppLayer)

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}
function asRecord(v: unknown): Record<string, unknown> {
  if (!isRecord(v)) throw new Error("expected record response")
  return v
}
function str(r: Record<string, unknown>, k: string): string {
  const v = r[k]
  if (typeof v !== "string") throw new Error(`expected string response.${k}`)
  return v
}
function asResult(v: unknown) {
  const r = asRecord(v)
  if (r.v !== 1) throw new Error("expected v 1")
  const requestId = str(r, "requestId")
  const op = str(r, "op")
  if (op !== "provider/auth") throw new Error("expected op provider/auth")
  const status = str(r, "status")
  if (status !== "succeeded" && status !== "failed") throw new Error("expected succeeded/failed")
  if (r.opId !== undefined) throw new Error("requestId-only result must not carry opId")
  if (r.idempotencyKey !== undefined) throw new Error("requestId-only result must not carry idempotencyKey")
  return { r, requestId, status }
}
function failureCode(v: unknown): string | undefined {
  if (!isRecord(v)) return undefined
  const f = v.failure
  if (isRecord(f) && typeof f.code === "string") return f.code
  return undefined
}
function linked() {
  const extToCarrier = new PassThrough()
  const carrierToExt = new PassThrough()
  const carrier = createFdCarrier(extToCarrier, carrierToExt)
  const ext = new JsonRpcPeer({ reader: carrierToExt, writer: extToCarrier })
  return { carrier, ext }
}
function req(dir: string, overrides: Record<string, unknown> = {}) {
  return { v: 1, requestId: "req-auth-1", op: "provider/auth", context: { directory: dir }, payload: {}, ...overrides }
}
async function init(ext: JsonRpcPeer) {
  return asRecord(await ext.request("initialize", {
    protocol: { name: FD_PROTOCOL_NAME, major: 1, minor: 0 },
    clientInfo: { name: "kilo-vscode", version: "7.4.11" },
    capabilities: ["provider/auth"],
  }))
}
function ownParentPid(): () => void {
  const prior = process.env.KILO_PARENT_PID
  process.env.KILO_PARENT_PID = "1"
  return () => {
    if (prior === undefined) delete process.env.KILO_PARENT_PID
    else process.env.KILO_PARENT_PID = prior
  }
}
function capsOf(v: unknown): string[] {
  if (!isRecord(v)) return []
  const c = v.capabilities
  return Array.isArray(c) ? c.filter((e): e is string => typeof e === "string") : []
}

describe("fd-carrier provider/auth (private-first observation)", () => {
  afterEach(async () => {
    await disposeAllInstances()
    await resetDatabase()
  })

  it.live("initialize advertises provider/auth capability", () =>
    Effect.gen(function* () {
      const restore = ownParentPid()
      try {
        const { carrier, ext } = linked()
        try {
          const res = yield* Effect.promise(() => init(ext))
          expect(capsOf(res).includes("provider/auth")).toBeTrue()
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        restore()
      }
    }))

  it.live("pre-init rejected InvalidRequest", () =>
    Effect.gen(function* () {
      const restore = ownParentPid()
      try {
        const { carrier, ext } = linked()
        try {
          const err = yield* Effect.promise(() => ext.request("provider/auth", req("/tmp")).then(() => undefined, (e: unknown) => e))
          const rec = isRecord(err) ? err : {}
          expect((rec as Record<string, unknown>).code).toBe(ErrorCode.InvalidRequest)
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        restore()
      }
    }))

  it.live("same-directory success matches HTTP shared owner shape", () =>
    Effect.gen(function* () {
      const restore = ownParentPid()
      try {
        const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
        const dir = tmp.path
        expect(path.isAbsolute(dir)).toBeTrue()
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => init(ext))
          const raw = yield* Effect.promise(() => ext.request("provider/auth", req(dir, { requestId: "req-same" })))
          const { r, requestId, status } = asResult(raw)
          expect(status).toBe("succeeded")
          expect(requestId).toBe("req-same")
          expect(r.accepted).toBe(true)
          validateProviderAuthData(r.data)
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        restore()
      }
    }))

  it.live("strict validation fails closed with fixed redacted failures", () =>
    Effect.gen(function* () {
      const restore = ownParentPid()
      try {
        const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
        const dir = tmp.path
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => init(ext))
          const cases = [
            req("relative/path"),
            { ...req(dir), context: { directory: "/tmp\0" } },
            req(dir, { payload: { q: 1 } }),
            req(dir, { sessionRevision: 1 }),
            req(dir, { op: "provider/catalog" }),
            req(dir, { opId: "x", idempotencyKey: "x" }),
          ]
          for (const c of cases) {
            const res = asRecord(yield* Effect.promise(() => ext.request("provider/auth", c)))
            expect(res.status).toBe("failed")
            expect(failureCode(res)).toBe("validation.failed")
            expect(res.accepted).toBe(false)
            expect(res.data).toBeUndefined()
          }
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        restore()
      }
    }))
})
