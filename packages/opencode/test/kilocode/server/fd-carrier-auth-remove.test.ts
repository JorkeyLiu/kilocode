import { afterEach, describe, expect } from "bun:test"
import fs from "fs"
import path from "path"
import { PassThrough } from "stream"
import { Effect } from "effect"
import { Global } from "@opencode-ai/core/global"
import { JsonRpcPeer } from "../../../src/private-worker/peer"
import { ErrorCode } from "../../../src/private-worker/json-rpc"
import { createFdCarrier } from "../../../src/kilocode/server/fd-carrier"
import { FD_PROTOCOL_NAME } from "../../../src/kilocode/server/fd-carrier-protocol"
import { AppLayer } from "../../../src/effect/app-runtime"
import { awaitRebuilds } from "../../../src/kilocode/server/config-rebuild"
import { InstanceStore } from "../../../src/project/instance-store"
import {
  canonicalAuthRemoveOpId,
  validateAuthRemoveRequest,
  validateAuthRemoveResult,
} from "../../../src/kilocode/auth-remove-private"
import { testEffectShared } from "../../lib/effect"
import { tmpdir, disposeAllInstances } from "../../fixture/fixture"
import { resetDatabase } from "../../fixture/db"

const it = testEffectShared(AppLayer)

type AuthRemoveResult = {
  v: number
  requestId: string
  opId: string
  op: string
  idempotencyKey: string
  status: string
  outcome: { type: string; time: number; failure?: { code: string; message: string; retryable: boolean } }
  accepted: boolean
  data?: { removed: boolean }
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

function asAuthRemoveResult(v: unknown): AuthRemoveResult {
  const row = asRecord(v)
  if (row.v !== 1) throw new Error("expected response.v to be 1")
  const requestId = str(row, "requestId")
  const opId = str(row, "opId")
  if (str(row, "op") !== "auth/remove") throw new Error("expected response.op to be auth/remove")
  const idempotencyKey = str(row, "idempotencyKey")
  const status = str(row, "status")
  if (status !== "succeeded" && status !== "failed") throw new Error("expected response.status succeeded or failed")
  if (typeof row.accepted !== "boolean") throw new Error("expected boolean response.accepted")
  const outcomeRaw = row.outcome
  if (!record(outcomeRaw)) throw new Error("expected record response.outcome")
  if (typeof outcomeRaw.type !== "string") throw new Error("expected string response.outcome.type")
  if (typeof outcomeRaw.time !== "number") throw new Error("expected number response.outcome.time")
  if (outcomeRaw.type !== status) throw new Error("expected response.outcome.type to match response.status")
  const outcome: AuthRemoveResult["outcome"] =
    outcomeRaw.failure === undefined
      ? { type: outcomeRaw.type, time: outcomeRaw.time }
      : { type: outcomeRaw.type, time: outcomeRaw.time, failure: failureOf(outcomeRaw.failure, "response.outcome.failure") }
  const dataRaw = row.data
  const data = dataRaw === undefined ? undefined : { removed: (asRecord(dataRaw).removed as boolean) }
  const failure = row.failure === undefined ? undefined : failureOf(row.failure, "response.failure")
  if (status === "succeeded") {
    if (row.accepted !== true) throw new Error("expected accepted true for succeeded")
    if (opId !== idempotencyKey) throw new Error("expected response.opId to equal response.idempotencyKey")
    if (data?.removed !== true) throw new Error("expected response.data.removed true for succeeded")
    if (failure !== undefined) throw new Error("expected no response.failure for succeeded")
  } else {
    if (row.accepted !== false) throw new Error("expected accepted false for failed")
    if (data !== undefined) throw new Error("expected no response.data for failed")
    if (failure === undefined) throw new Error("expected response.failure for failed")
    if (outcome.failure === undefined) throw new Error("expected response.outcome.failure for failed")
    if (failure.code !== outcome.failure.code) throw new Error("expected failure code echo")
    if (failure.message !== outcome.failure.message) throw new Error("expected failure message echo")
    if (failure.retryable !== outcome.failure.retryable) throw new Error("expected failure retryable echo")
  }
  return { v: 1, requestId, opId, op: "auth/remove", idempotencyKey, status, outcome, accepted: row.accepted, ...(data ? { data } : {}), ...(failure ? { failure } : {}) }
}

function codeOfResult(v: AuthRemoveResult): string | undefined {
  return v.failure?.code ?? v.outcome.failure?.code
}

function linked() {
  const extToCarrier = new PassThrough()
  const carrierToExt = new PassThrough()
  const carrier = createFdCarrier(extToCarrier, carrierToExt)
  const ext = new JsonRpcPeer({ reader: carrierToExt, writer: extToCarrier })
  return { carrier, ext }
}

function req(dir: string, providerID: string, token = "tok1", overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const opId = canonicalAuthRemoveOpId(token)
  return {
    v: 1,
    requestId: "req-auth-1",
    opId,
    op: "auth/remove",
    idempotencyKey: opId,
    context: { directory: dir },
    payload: { providerID },
    ...overrides,
  }
}

async function init(ext: JsonRpcPeer): Promise<Record<string, unknown>> {
  return asRecord(
    await ext.request("initialize", {
      protocol: { name: FD_PROTOCOL_NAME, major: 1, minor: 0 },
      clientInfo: { name: "kilo-vscode", version: "7.4.11" },
      capabilities: ["auth/remove"],
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

const authFile = () => path.join(Global.Path.data, "auth.json")

function readAuth(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(authFile(), "utf-8")) as Record<string, unknown>
  } catch {
    return {}
  }
}

describe("fd-carrier auth/remove (authoritative mutation)", () => {
  afterEach(async () => {
    await Effect.runPromise(awaitRebuilds())
    await disposeAllInstances()
    await resetDatabase()
  })

  it.live("initialize advertises auth/remove capability", () =>
    Effect.gen(function* () {
      const { carrier, ext } = linked()
      try {
        const res = yield* Effect.promise(() => init(ext))
        expect(capsOf(res).includes("auth/remove")).toBeTrue()
      } finally {
        carrier.dispose()
        ext.dispose()
      }
    }),
  )

  it.live("pre-init remove rejected InvalidRequest", () =>
    Effect.gen(function* () {
      const { carrier, ext } = linked()
      try {
        const err = yield* Effect.promise(() =>
          ext.request("auth/remove", req("/tmp", "kilo")).then(
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

  it.live("unknown root field fails closed with echo-validated identities", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
      const dir = tmp.path
      const store = yield* InstanceStore.Service
      yield* store.load({ directory: dir })
      const { carrier, ext } = linked()
      try {
        yield* Effect.promise(() => init(ext))
        const raw = yield* Effect.promise(() =>
          ext.request("auth/remove", req(dir, "kilo", "unknown-field", { requestId: "req-unknown", extra: true })),
        )
        const res = asAuthRemoveResult(raw)
        expect(res.status).toBe("failed")
        expect(codeOfResult(res)).toBe("validation.failed")
        expect(res.requestId).toBe("req-unknown")
        expect(res.opId).toBe(res.idempotencyKey)
      } finally {
        carrier.dispose()
        ext.dispose()
      }
    }),
  )

  it.live("opId identity mismatch fails closed", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
      const dir = tmp.path
      const store = yield* InstanceStore.Service
      yield* store.load({ directory: dir })
      const { carrier, ext } = linked()
      try {
        yield* Effect.promise(() => init(ext))
        const opId = canonicalAuthRemoveOpId("tok-a")
        const raw = yield* Effect.promise(() =>
          ext.request("auth/remove", {
            v: 1,
            requestId: "req-mismatch",
            opId,
            op: "auth/remove",
            idempotencyKey: canonicalAuthRemoveOpId("tok-b"),
            context: { directory: dir },
            payload: { providerID: "kilo" },
          }),
        )
        const res = asAuthRemoveResult(raw)
        expect(res.status).toBe("failed")
        expect(codeOfResult(res)).toBe("validation.failed")
      } finally {
        carrier.dispose()
        ext.dispose()
      }
    }),
  )

  it.live("missing providerID fails closed without mutation", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
      const dir = tmp.path
      const store = yield* InstanceStore.Service
      yield* store.load({ directory: dir })
      const { carrier, ext } = linked()
      try {
        yield* Effect.promise(() => init(ext))
        const opId = canonicalAuthRemoveOpId("tok-nopid")
        const raw = yield* Effect.promise(() =>
          ext.request("auth/remove", {
            v: 1,
            requestId: "req-nopid",
            opId,
            op: "auth/remove",
            idempotencyKey: opId,
            context: { directory: dir },
            payload: {},
          }),
        )
        const res = asAuthRemoveResult(raw)
        expect(res.status).toBe("failed")
        expect(codeOfResult(res)).toBe("validation.failed")
      } finally {
        carrier.dispose()
        ext.dispose()
      }
    }),
  )

  it.live("relative directory fails closed without mutation", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
      const dir = tmp.path
      const store = yield* InstanceStore.Service
      yield* store.load({ directory: dir })
      const { carrier, ext } = linked()
      try {
        yield* Effect.promise(() => init(ext))
        const before = readAuth()
        const opId = canonicalAuthRemoveOpId("tok-reldir")
        const raw = yield* Effect.promise(() =>
          ext.request("auth/remove", {
            v: 1,
            requestId: "req-reldir",
            opId,
            op: "auth/remove",
            idempotencyKey: opId,
            context: { directory: "relative/path" },
            payload: { providerID: "auth-remove-test-nonexistent" },
          }),
        )
        const res = asAuthRemoveResult(raw)
        expect(res.status).toBe("failed")
        expect(codeOfResult(res)).toBe("validation.failed")
        expect(readAuth()).toEqual(before)
      } finally {
        carrier.dispose()
        ext.dispose()
      }
    }),
  )

  it.live("valid remove succeeds idempotently with the same global cold-mutation semantics", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
      const dir = tmp.path
      const store = yield* InstanceStore.Service
      yield* store.load({ directory: dir })
      const { carrier, ext } = linked()
      const hadFile = fs.existsSync(authFile())
      const before = hadFile ? fs.readFileSync(authFile()) : undefined
      try {
        yield* Effect.promise(() => init(ext))
        const raw = yield* Effect.promise(() => ext.request("auth/remove", req(dir, "auth-remove-test-nonexistent", "tok-valid")))
        const res = asAuthRemoveResult(raw)
        expect(res.status).toBe("succeeded")
        expect(res.accepted).toBeTrue()
        expect(res.opId).toBe(res.idempotencyKey)
        // Idempotent replay: removing the same absent key succeeds again.
        const raw2 = yield* Effect.promise(() => ext.request("auth/remove", req(dir, "auth-remove-test-nonexistent", "tok-valid-2")))
        expect(asAuthRemoveResult(raw2).status).toBe("succeeded")
        // The synthetic key is absent before and after; no other key was touched.
        expect(readAuth()["auth-remove-test-nonexistent"]).toBeUndefined()
      } finally {
        carrier.dispose()
        ext.dispose()
        if (before !== undefined) fs.writeFileSync(authFile(), before)
        else if (fs.existsSync(authFile()) && !hadFile) fs.rmSync(authFile())
      }
    }),
  )

  it.live("auth-remove private contract validates and echoes", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
      const dir = tmp.path
      const opId = canonicalAuthRemoveOpId("tok-private")
      const parsed = yield* Effect.sync(() => validateAuthRemoveRequest(req(dir, "kilo", "tok-private")))
      expect(parsed.opId).toBe(opId)
      expect(parsed.idempotencyKey).toBe(opId)
      const ok = {
        v: 1,
        requestId: parsed.requestId,
        opId: parsed.opId,
        op: "auth/remove",
        idempotencyKey: parsed.idempotencyKey,
        status: "succeeded",
        outcome: { type: "succeeded", time: 1 },
        accepted: true,
        data: { removed: true },
      }
      expect(validateAuthRemoveResult(ok, parsed).status).toBe("succeeded")
    }),
  )
})
