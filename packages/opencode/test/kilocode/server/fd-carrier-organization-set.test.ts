import { afterEach, describe, expect } from "bun:test"
import fs from "fs"
import path from "path"
import { readFile } from "fs/promises"
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
import { Auth } from "../../../src/auth"
import {
  canonicalOrganizationSetOpId,
  validateOrganizationSetRequest,
  validateOrganizationSetResult,
} from "../../../src/kilocode/organization-set-private"
import { testEffectShared } from "../../lib/effect"
import { tmpdir, disposeAllInstances } from "../../fixture/fixture"
import { resetDatabase } from "../../fixture/db"

const it = testEffectShared(AppLayer)

type OrganizationSetResult = {
  v: number
  requestId: string
  opId: string
  op: string
  idempotencyKey: string
  status: string
  outcome: { type: string; time: number; failure?: { code: string; message: string; retryable: boolean } }
  accepted: boolean
  data?: { updated: boolean }
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

function asOrganizationSetResult(v: unknown): OrganizationSetResult {
  const row = asRecord(v)
  if (row.v !== 1) throw new Error("expected response.v to be 1")
  const requestId = str(row, "requestId")
  const opId = str(row, "opId")
  if (str(row, "op") !== "kilo/organization/set") throw new Error("expected response.op to be kilo/organization/set")
  const idempotencyKey = str(row, "idempotencyKey")
  const status = str(row, "status")
  if (status !== "succeeded" && status !== "failed") throw new Error("expected response.status succeeded or failed")
  if (typeof row.accepted !== "boolean") throw new Error("expected boolean response.accepted")
  const outcomeRaw = row.outcome
  if (!record(outcomeRaw)) throw new Error("expected record response.outcome")
  if (typeof outcomeRaw.type !== "string") throw new Error("expected string response.outcome.type")
  if (typeof outcomeRaw.time !== "number") throw new Error("expected number response.outcome.time")
  if (outcomeRaw.type !== status) throw new Error("expected response.outcome.type to match response.status")
  const outcome: OrganizationSetResult["outcome"] =
    outcomeRaw.failure === undefined
      ? { type: outcomeRaw.type, time: outcomeRaw.time }
      : { type: outcomeRaw.type, time: outcomeRaw.time, failure: failureOf(outcomeRaw.failure, "response.outcome.failure") }
  const dataRaw = row.data
  const data = dataRaw === undefined ? undefined : { updated: (asRecord(dataRaw).updated as boolean) }
  const failure = row.failure === undefined ? undefined : failureOf(row.failure, "response.failure")
  if (status === "succeeded") {
    if (row.accepted !== true) throw new Error("expected accepted true for succeeded")
    if (opId !== idempotencyKey) throw new Error("expected response.opId to equal response.idempotencyKey")
    if (data?.updated !== true) throw new Error("expected response.data.updated true for succeeded")
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
  return { v: 1, requestId, opId, op: "kilo/organization/set", idempotencyKey, status, outcome, accepted: row.accepted, ...(data ? { data } : {}), ...(failure ? { failure } : {}) }
}

function codeOfResult(v: OrganizationSetResult): string | undefined {
  return v.failure?.code ?? v.outcome.failure?.code
}

function linked() {
  const extToCarrier = new PassThrough()
  const carrierToExt = new PassThrough()
  const carrier = createFdCarrier(extToCarrier, carrierToExt)
  const ext = new JsonRpcPeer({ reader: carrierToExt, writer: extToCarrier })
  return { carrier, ext }
}

function req(dir: string, organizationId: string | null, token = "tok1", overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const opId = canonicalOrganizationSetOpId(token)
  return {
    v: 1,
    requestId: "req-org-1",
    opId,
    op: "kilo/organization/set",
    idempotencyKey: opId,
    context: { directory: dir },
    payload: { organizationId },
    ...overrides,
  }
}

async function init(ext: JsonRpcPeer): Promise<Record<string, unknown>> {
  return asRecord(
    await ext.request("initialize", {
      protocol: { name: FD_PROTOCOL_NAME, major: 1, minor: 0 },
      clientInfo: { name: "kilo-vscode", version: "7.4.11" },
      capabilities: ["kilo/organization/set"],
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

describe("fd-carrier kilo/organization/set (authoritative mutation)", () => {
  afterEach(async () => {
    await Effect.runPromise(awaitRebuilds())
    await disposeAllInstances()
    await resetDatabase()
  })

  it.live("initialize advertises kilo/organization/set capability", () =>
    Effect.gen(function* () {
      const { carrier, ext } = linked()
      try {
        const res = yield* Effect.promise(() => init(ext))
        expect(capsOf(res).includes("kilo/organization/set")).toBeTrue()
      } finally {
        carrier.dispose()
        ext.dispose()
      }
    }),
  )

  it.live("pre-init set rejected InvalidRequest", () =>
    Effect.gen(function* () {
      const { carrier, ext } = linked()
      try {
        const err = yield* Effect.promise(() =>
          ext.request("kilo/organization/set", req("/tmp", "org-1")).then(
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
          ext.request("kilo/organization/set", req(dir, "org-1", "unknown-field", { requestId: "req-unknown", extra: true })),
        )
        const res = asOrganizationSetResult(raw)
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

  it.live("organizationId type violation fails closed without mutation", () =>
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
        const opId = canonicalOrganizationSetOpId("tok-badtype")
        const raw = yield* Effect.promise(() =>
          ext.request("kilo/organization/set", {
            v: 1,
            requestId: "req-badtype",
            opId,
            op: "kilo/organization/set",
            idempotencyKey: opId,
            context: { directory: dir },
            payload: { organizationId: 42 },
          }),
        )
        const res = asOrganizationSetResult(raw)
        expect(res.status).toBe("failed")
        expect(codeOfResult(res)).toBe("validation.failed")
        if (before !== undefined) expect(fs.readFileSync(authFile()).equals(before)).toBeTrue()
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
        const opId = canonicalOrganizationSetOpId("tok-reldir")
        const raw = yield* Effect.promise(() =>
          ext.request("kilo/organization/set", {
            v: 1,
            requestId: "req-reldir",
            opId,
            op: "kilo/organization/set",
            idempotencyKey: opId,
            context: { directory: "relative/path" },
            payload: { organizationId: "org-1" },
          }),
        )
        const res = asOrganizationSetResult(raw)
        expect(res.status).toBe("failed")
        expect(codeOfResult(res)).toBe("validation.failed")
        expect(readAuth()).toEqual(before)
      } finally {
        carrier.dispose()
        ext.dispose()
      }
    }),
  )

  it.live("auth missing is terminal unauthorized with zero side effects", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
      const dir = tmp.path
      const store = yield* InstanceStore.Service
      yield* store.load({ directory: dir })
      const auth = yield* Auth.Service
      yield* auth.remove("kilo").pipe(Effect.orElseSucceed(() => undefined))
      const before = readAuth()
      expect(before["kilo"]).toBeUndefined()
      const { carrier, ext } = linked()
      try {
        yield* Effect.promise(() => init(ext))
        const raw = yield* Effect.promise(() => ext.request("kilo/organization/set", req(dir, "org-1", "tok-noauth")))
        const res = asOrganizationSetResult(raw)
        expect(res.status).toBe("failed")
        expect(codeOfResult(res)).toBe("unauthorized")
        expect(res.failure?.retryable).toBe(false)
        expect(readAuth()).toEqual(before)
      } finally {
        carrier.dispose()
        ext.dispose()
      }
    }),
  )

  it.live("fd success truly updates the auth record and preserves credentials", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
      const dir = tmp.path
      const store = yield* InstanceStore.Service
      yield* store.load({ directory: dir })
      const auth = yield* Auth.Service
      const hadFile = fs.existsSync(authFile())
      const before = hadFile ? fs.readFileSync(authFile()) : undefined
      try {
        yield* auth.set("kilo", {
          type: "oauth",
          refresh: "refresh-keep",
          access: "access-keep",
          expires: 424242,
          accountId: "org-old",
        })
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => init(ext))
          const raw = yield* Effect.promise(() => ext.request("kilo/organization/set", req(dir, "org-new", "tok-valid")))
          const res = asOrganizationSetResult(raw)
          expect(res.status).toBe("succeeded")
          expect(res.accepted).toBeTrue()
          expect(res.opId).toBe(res.idempotencyKey)
          const after = (yield* auth.get("kilo")) as unknown as Record<string, unknown>
          expect(after["type"]).toBe("oauth")
          expect(after["refresh"]).toBe("refresh-keep")
          expect(after["access"]).toBe("access-keep")
          expect(after["expires"]).toBe(424242)
          expect(after["accountId"]).toBe("org-new")
          // Safe overwrite: repeating the same organizationId succeeds again.
          const raw2 = yield* Effect.promise(() => ext.request("kilo/organization/set", req(dir, "org-new", "tok-valid-2")))
          expect(asOrganizationSetResult(raw2).status).toBe("succeeded")
          // Null clears back to the personal account while preserving credentials.
          const raw3 = yield* Effect.promise(() => ext.request("kilo/organization/set", req(dir, null, "tok-null")))
          expect(asOrganizationSetResult(raw3).status).toBe("succeeded")
          const cleared = (yield* auth.get("kilo")) as unknown as Record<string, unknown>
          expect(cleared["refresh"]).toBe("refresh-keep")
          expect(cleared["access"]).toBe("access-keep")
          expect(cleared["expires"]).toBe(424242)
          expect(cleared["accountId"]).toBeUndefined()
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        if (before !== undefined) fs.writeFileSync(authFile(), before)
        else if (fs.existsSync(authFile()) && !hadFile) fs.rmSync(authFile())
      }
    }),
  )

  it.live("shared mutate keeps the fence-internal read and modes-cache clear (no drift)", () =>
    Effect.gen(function* () {
      const shared = yield* Effect.promise(() =>
        readFile(new URL("../../../src/kilocode/organization-set-private.ts", import.meta.url), "utf8"),
      )
      const fenceIdx = shared.indexOf("invalidateAfterProviderAuthChange")
      const readIdx = shared.indexOf('auth.get("kilo")')
      const setIdx = shared.indexOf('.set("kilo"')
      const cacheIdx = shared.lastIndexOf("clearModesCache()")
      expect(fenceIdx).toBeGreaterThan(-1)
      expect(readIdx).toBeGreaterThan(fenceIdx)
      expect(setIdx).toBeGreaterThan(readIdx)
      expect(cacheIdx).toBeGreaterThan(setIdx)
      expect(shared).not.toContain("cleanupDisabled:")
      expect(shared).not.toContain("instance-ref")
      expect(shared).not.toContain("InstanceRef.")
      expect(shared).not.toContain("acquireDrainControl(")
      const handler = yield* Effect.promise(() =>
        readFile(
          new URL("../../../src/kilocode/server/httpapi/handlers/kilo-gateway.ts", import.meta.url),
          "utf8",
        ),
      )
      expect(handler).toContain("organizationSetMutate")
      // The HTTP route owns no second copy of the mutation body.
      expect(handler.match(/auth\.set\("kilo"/g)?.length ?? 0).toBe(0)
      expect(handler.match(/clearModesCache\(\)/g)?.length ?? 0).toBe(0)
      const parsed = yield* Effect.sync(() => validateOrganizationSetRequest(req("/tmp", "org-1", "tok-private")))
      expect(parsed.opId).toBe(canonicalOrganizationSetOpId("tok-private"))
      expect(parsed.idempotencyKey).toBe(parsed.opId)
      const ok = {
        v: 1,
        requestId: parsed.requestId,
        opId: parsed.opId,
        op: "kilo/organization/set",
        idempotencyKey: parsed.idempotencyKey,
        status: "succeeded",
        outcome: { type: "succeeded", time: 1 },
        accepted: true,
        data: { updated: true },
      }
      expect(validateOrganizationSetResult(ok, parsed).status).toBe("succeeded")
    }),
  )
})
