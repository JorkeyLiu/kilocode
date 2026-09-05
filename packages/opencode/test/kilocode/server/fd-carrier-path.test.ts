import { afterEach, describe, expect } from "bun:test"
import { PassThrough } from "stream"
import { Effect } from "effect"
import { JsonRpcPeer } from "../../../src/private-worker/peer"
import { ErrorCode } from "../../../src/private-worker/json-rpc"
import { createFdCarrier } from "../../../src/kilocode/server/fd-carrier"
import { FD_PROTOCOL_NAME } from "../../../src/kilocode/server/fd-carrier-protocol"
import { Global } from "@opencode-ai/core/global"
import { canonicalDirectory } from "../../../src/kilocode/session/canonical-directory"
import { testEffectShared } from "../../lib/effect"
import { tmpdir, disposeAllInstances } from "../../fixture/fixture"
import { resetDatabase } from "../../fixture/db"
import { AppLayer } from "../../../src/effect/app-runtime"

const it = testEffectShared(AppLayer)

type PathResult = {
  v: number
  requestId: string
  opId: string
  op: string
  idempotencyKey: string
  status: string
  outcome: { type: string; time: number; failure?: { code: string; message?: string; retryable?: boolean } }
  accepted: boolean
  data?: { path: Record<string, unknown> }
  failure?: { code: string; message?: string; retryable?: boolean }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function asRecord(v: unknown): Record<string, unknown> {
  if (!isRecord(v)) throw new Error("expected record response")
  return v
}

function str(record: Record<string, unknown>, key: string): string {
  const v = record[key]
  if (typeof v !== "string") throw new Error(`expected string response.${key}`)
  return v
}

function failureOf(v: unknown, p: string): { code: string; message?: string; retryable?: boolean } {
  if (!isRecord(v)) throw new Error(`expected record ${p}`)
  const code = v.code
  if (typeof code !== "string") throw new Error(`expected string ${p}.code`)
  const out: { code: string; message?: string; retryable?: boolean } = { code }
  if (v.message !== undefined) {
    if (typeof v.message !== "string") throw new Error(`expected string ${p}.message`)
    out.message = v.message
  }
  if (typeof v.retryable === "boolean") out.retryable = v.retryable
  return out
}

function asPathResult(v: unknown): PathResult {
  const record = asRecord(v)
  if (record.v !== 1) throw new Error("expected response.v to be 1")
  const requestId = str(record, "requestId")
  const opId = str(record, "opId")
  const op = str(record, "op")
  if (op !== "path/get") throw new Error("expected response.op to be path/get")
  const idempotencyKey = str(record, "idempotencyKey")
  const status = str(record, "status")
  if (status !== "succeeded" && status !== "failed") throw new Error("expected response.status succeeded or failed")
  const accepted = record.accepted
  if (typeof accepted !== "boolean") throw new Error("expected boolean response.accepted")
  if (status === "succeeded" && accepted !== true) throw new Error("expected accepted true for succeeded")
  if (status === "failed" && accepted !== false) throw new Error("expected accepted false for failed")
  const outcomeRaw = record.outcome
  if (!isRecord(outcomeRaw)) throw new Error("expected record response.outcome")
  const outcomeType = outcomeRaw.type
  if (typeof outcomeType !== "string") throw new Error("expected string response.outcome.type")
  const outcomeTime = outcomeRaw.time
  if (typeof outcomeTime !== "number") throw new Error("expected number response.outcome.time")
  if (outcomeType !== status) throw new Error("expected response.outcome.type to match response.status")
  const outcome: PathResult["outcome"] =
    outcomeRaw.failure === undefined
      ? { type: outcomeType, time: outcomeTime }
      : { type: outcomeType, time: outcomeTime, failure: failureOf(outcomeRaw.failure, "response.outcome.failure") }
  let data: PathResult["data"]
  if (record.data !== undefined) {
    if (!isRecord(record.data)) throw new Error("expected record response.data")
    const keys = Object.keys(record.data)
    for (const k of keys) if (k !== "path") throw new Error(`unexpected response.data field ${k}`)
    const path = (record.data as Record<string, unknown>).path
    if (!isRecord(path)) throw new Error("expected record response.data.path")
    data = { path: path as Record<string, unknown> }
  }
  let failure: PathResult["failure"]
  if (record.failure !== undefined) failure = failureOf(record.failure, "response.failure")
  if (status === "succeeded") {
    if (opId !== idempotencyKey) throw new Error("expected response.opId to equal response.idempotencyKey for succeeded")
    if (data === undefined) throw new Error("expected response.data for succeeded")
    if (failure !== undefined) throw new Error("expected no response.failure for succeeded")
    if (outcome.failure !== undefined) throw new Error("expected no response.outcome.failure for succeeded")
  } else {
    if (data !== undefined) throw new Error("expected no response.data for failed")
    if (failure === undefined) throw new Error("expected response.failure for failed")
    if (outcome.failure === undefined) throw new Error("expected response.outcome.failure for failed")
    if (failure.code !== outcome.failure.code) throw new Error("expected response.failure.code to equal response.outcome.failure.code")
    if (typeof failure.message === "string" && failure.message.length > 200) throw new Error("expected bounded response.failure.message")
  }
  return { v: 1, requestId, opId, op, idempotencyKey, status, outcome, accepted, ...(data !== undefined ? { data } : {}), ...(failure !== undefined ? { failure } : {}) }
}

function asError(v: unknown): { code?: number; message?: string } {
  if (!isRecord(v)) return {}
  const out: { code?: number; message?: string } = {}
  if (typeof v.code === "number") out.code = v.code
  if (typeof v.message === "string") out.message = v.message
  return out
}

function capabilitiesOf(v: unknown): string[] {
  if (!isRecord(v)) return []
  const caps = v.capabilities
  if (!Array.isArray(caps)) return []
  return caps.filter((entry): entry is string => typeof entry === "string")
}

function pathReq(dir: string, token = "tok1", overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const opId = `path:${token}`
  return {
    v: 1,
    requestId: "req-path-1",
    opId,
    op: "path/get",
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
      capabilities: ["path/get"],
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

function linked() {
  const extToCarrier = new PassThrough()
  const carrierToExt = new PassThrough()
  const carrier = createFdCarrier(extToCarrier, carrierToExt)
  const ext = new JsonRpcPeer({ reader: carrierToExt, writer: extToCarrier })
  return { carrier, ext }
}

function pathOf(res: PathResult): Record<string, string> {
  const p = res.data?.path ?? {}
  for (const f of ["home", "state", "config", "worktree", "directory"]) {
    const v = (p as Record<string, unknown>)[f]
    if (typeof v !== "string" || v.length === 0 || v.includes("\0")) throw new Error(`expected non-empty string path.${f}`)
  }
  const keys = Object.keys(p)
  if (keys.length !== 5) throw new Error("expected exactly five path fields")
  return p as Record<string, string>
}

function assertNoPathLeak(res: PathResult, dir: string): void {
  const msg = res.failure?.message ?? res.outcome.failure?.message ?? ""
  expect(msg).not.toContain(dir)
  expect(msg).not.toContain("\0")
  const rec = res as unknown as Record<string, unknown>
  for (const k of ["home", "state", "config", "worktree", "directory", "path", "workspace"]) {
    expect(rec[k]).toBeUndefined()
  }
}

describe("fd-carrier path/get (parity-only read)", () => {
  afterEach(async () => {
    await disposeAllInstances()
    await resetDatabase()
  })

  it.live("initialize advertises path/get capability", () =>
    Effect.gen(function* () {
      const restoreParentPid = ownParentPid()
      try {
        const { carrier, ext } = linked()
        try {
          const res = yield* Effect.promise(() => init(ext))
          expect(capabilitiesOf(res).includes("path/get")).toBeTrue()
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        restoreParentPid()
      }
    }),
  )

  it.live("pre-init path rejected InvalidRequest", () =>
    Effect.gen(function* () {
      const restoreParentPid = ownParentPid()
      try {
        const { carrier, ext } = linked()
        try {
          const err = yield* Effect.promise(() =>
            ext.request("path/get", pathReq("/tmp")).then(
              () => undefined,
              (e: unknown) => e,
            ),
          )
          expect(asError(err).code).toBe(ErrorCode.InvalidRequest)
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        restoreParentPid()
      }
    }),
  )

  it.live("same-directory success returns five safe fields matching production source", () =>
    Effect.gen(function* () {
      const restoreParentPid = ownParentPid()
      try {
        const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
        const dir = tmp.path
        const canon = canonicalDirectory(dir)
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => init(ext))
          const raw = yield* Effect.promise(() => ext.request("path/get", pathReq(dir, "same-tok", { requestId: "req-same" })))
          const res = asPathResult(raw)
          expect(res.status).toBe("succeeded")
          expect(res.accepted).toBeTrue()
          expect(res.opId).toBe("path:same-tok")
          expect(res.idempotencyKey).toBe("path:same-tok")
          const p = pathOf(res)
          // Five-field production projection matches SDK shape; globals are
          // process-global (never bound to the request directory).
          expect(p.home).toBe(Global.Path.home)
          expect(p.state).toBe(Global.Path.state)
          expect(p.config).toBe(Global.Path.config)
          expect(p.directory).toBe(canon)
          expect(typeof p.worktree).toBe("string")
          // No worktree===directory guarantee asserted (derivation unknown).
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        restoreParentPid()
      }
    }),
  )

  it.live("workspace routing label accepted without changing safe projection", () =>
    Effect.gen(function* () {
      const restoreParentPid = ownParentPid()
      try {
        const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
        const dir = tmp.path
        const canon = canonicalDirectory(dir)
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => init(ext))
          const opId = "path:ws-tok"
          const raw = yield* Effect.promise(() =>
            ext.request("path/get", {
              v: 1,
              requestId: "req-ws",
              opId,
              op: "path/get",
              idempotencyKey: opId,
              context: { directory: dir, workspace: "ws1" },
              payload: {},
            }),
          )
          const res = asPathResult(raw)
          expect(res.status).toBe("succeeded")
          const p = pathOf(res)
          expect(p.directory).toBe(canon)
          expect(p.home).toBe(Global.Path.home)
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        restoreParentPid()
      }
    }),
  )

  it.live("malformed requests fail closed with redacted bounded failures", () =>
    Effect.gen(function* () {
      const restoreParentPid = ownParentPid()
      try {
        const tmp = yield* Effect.promise(() => tmpdir({ retain: true }))
        const dir = tmp.path
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => init(ext))
          const bad: Record<string, unknown>[] = [
            pathReq(dir, "bad-v", { v: 2 }),
            pathReq(dir, "bad-op", { op: "remote/status" }),
            pathReq(dir, "bad-idem", { idempotencyKey: "path:other" }),
            pathReq(dir, "bad-opid", { opId: "remote-status:tok1", idempotencyKey: "remote-status:tok1" }),
            { ...pathReq(dir, "bad-rel"), context: { directory: "relative" } },
            { ...pathReq(dir, "bad-nul"), context: { directory: "/tmp\0" } },
            { ...pathReq(dir, "bad-payload"), payload: { reason: "x" } },
            { ...pathReq(dir, "bad-extra"), extra: 1 },
            { ...pathReq(dir, "bad-ws"), context: { directory: dir, workspace: "" } },
          ]
          for (const params of bad) {
            const raw = yield* Effect.promise(() => ext.request("path/get", params))
            const res = asPathResult(raw)
            expect(res.status).toBe("failed")
            expect(res.accepted).toBeFalse()
            expect(res.failure?.code).toBe("validation.failed")
            assertNoPathLeak(res, dir)
          }
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        restoreParentPid()
      }
    }),
  )

  it.live("path-bearing unknown keys fail closed without leaking key material", () =>
    Effect.gen(function* () {
      const restoreParentPid = ownParentPid()
      try {
        const tmp = yield* Effect.promise(() => tmpdir({ retain: true }))
        const dir = tmp.path
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => init(ext))
          // Unknown keys carry raw path material; sanitized validation must
          // return fixed messages that never echo the key or the directory.
          const evilCtxKey = `${dir}/secret-evil`
          const evilRootKey = "/home/u/.config/kilo-evil"
          const bad: Record<string, unknown>[] = [
            { ...pathReq(dir, "evil-ctx"), context: { directory: dir, [evilCtxKey]: "x" } },
            { ...pathReq(dir, "evil-root"), [evilRootKey]: 1 },
            { ...pathReq(dir, "evil-ws-key"), context: { directory: dir, workspace: "ws1", [evilCtxKey]: 1 } },
          ]
          for (const [idx, params] of bad.entries()) {
            const raw = yield* Effect.promise(() => ext.request("path/get", params))
            const res = asPathResult(raw)
            expect(res.status).toBe("failed")
            expect(res.accepted).toBeFalse()
            expect(res.failure?.code).toBe("validation.failed")
            const msg = res.failure?.message ?? ""
            expect(msg).toBe(idx === 1 ? "unexpected field" : "unexpected context field")
            expect(msg).not.toContain(dir)
            expect(msg).not.toContain("secret-evil")
            expect(msg).not.toContain("kilo-evil")
            expect(msg).not.toContain("\0")
            assertNoPathLeak(res, dir)
            assertNoPathLeak(res, evilCtxKey)
          }
          const rootRaw = yield* Effect.promise(() => ext.request("path/get", bad[1]!))
          const rootRes = asPathResult(rootRaw)
          expect(rootRes.failure?.message).toBe("unexpected field")
          expect(rootRes.failure?.message).not.toContain("kilo-evil")
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        restoreParentPid()
      }
    }),
  )

  it.live("unknown method stays MethodNotFound and path failures never echo raw material", () =>
    Effect.gen(function* () {
      const restoreParentPid = ownParentPid()
      try {
        const tmp = yield* Effect.promise(() => tmpdir({ retain: true }))
        const dir = tmp.path
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => init(ext))
          const err = yield* Effect.promise(() =>
            ext.request("command/list", pathReq(dir)).then(
              () => undefined,
              (e: unknown) => e,
            ),
          )
          expect(asError(err).code).toBe(ErrorCode.MethodNotFound)
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        restoreParentPid()
      }
    }),
  )

  it.live("path-bearing requestId/opId/idempotencyKey are sanitized without path leak", () =>
    Effect.gen(function* () {
      const restoreParentPid = ownParentPid()
      try {
        const tmp = yield* Effect.promise(() => tmpdir({ retain: true }))
        const dir = tmp.path
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => init(ext))
          const evil = `${dir}/secret-evil`
          // Each case carries path material in exactly one correlation
          // identity; all three must fail closed with sanitized envelopes.
          const cases: Record<string, unknown>[] = [
            { ...pathReq(dir, "tok-evil-req"), requestId: evil },
            {
              ...pathReq(dir, "tok-evil-op"),
              opId: `path:${evil}`,
              idempotencyKey: `path:${evil}`,
            },
            { ...pathReq(dir, "tok-evil-idem"), opId: "path:tok-evil-idem", idempotencyKey: evil },
          ]
          for (const params of cases) {
            const raw = yield* Effect.promise(() => ext.request("path/get", params))
            const res = asPathResult(raw)
            expect(res.status).toBe("failed")
            expect(res.accepted).toBeFalse()
            expect(res.failure?.code).toBe("validation.failed")
            const rec = res as unknown as Record<string, unknown>
            for (const field of ["requestId", "opId", "idempotencyKey"] as const) {
              const v = rec[field]
              expect(typeof v).toBe("string")
              expect(v as string).not.toContain(dir)
              expect(v as string).not.toContain("secret-evil")
              expect(v as string).not.toContain("/")
            }
            const msg = res.failure?.message ?? ""
            expect(msg).not.toContain(dir)
            expect(msg).not.toContain("secret-evil")
            expect(msg).not.toContain("\0")
            assertNoPathLeak(res, dir)
            assertNoPathLeak(res, evil)
          }
          // Valid locally generated path:<hex> identities preserve protocol
          // correlation on validation failure (relative directory).
          const goodOp = "path:abc123ef"
          const goodRaw = yield* Effect.promise(() =>
            ext.request("path/get", {
              v: 1,
              requestId: "req-good-1",
              opId: goodOp,
              op: "path/get",
              idempotencyKey: goodOp,
              context: { directory: "relative" },
              payload: {},
            }),
          )
          const good = asPathResult(goodRaw)
          expect(good.status).toBe("failed")
          expect(good.requestId).toBe("req-good-1")
          expect(good.opId).toBe(goodOp)
          expect(good.idempotencyKey).toBe(goodOp)
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        restoreParentPid()
      }
    }),
  )

  it.live("slash-bearing path token and post-validation failure never echo path material", () =>
    Effect.gen(function* () {
      const restoreParentPid = ownParentPid()
      try {
        const tmp = yield* Effect.promise(() => tmpdir({ retain: true }))
        const dir = tmp.path
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => init(ext))
          // `path:/tmp/private` must be rejected before it can be echoed in
          // any returned correlation identity.
          const slashOp = `path:${dir}/private`
          const slashRaw = yield* Effect.promise(() =>
            ext.request("path/get", {
              v: 1,
              requestId: "req-slash-1",
              opId: slashOp,
              op: "path/get",
              idempotencyKey: slashOp,
              context: { directory: dir },
              payload: {},
            }),
          )
          const slash = asPathResult(slashRaw)
          expect(slash.status).toBe("failed")
          expect(slash.failure?.code).toBe("validation.failed")
          expect(slash.opId).toBe("unknown")
          expect(slash.idempotencyKey).toBe("unknown")
          expect(slash.requestId).toBe("req-slash-1")
          expect(JSON.stringify(slash)).not.toContain("/private")
          expect(JSON.stringify(slash)).not.toContain(dir)
          // Post-validation shape: valid identities with an invalid routing
          // label fail closed with fixed messages and safe correlation.
          const wsRaw = yield* Effect.promise(() =>
            ext.request("path/get", {
              v: 1,
              requestId: "req-post-1",
              opId: "path:postok12",
              op: "path/get",
              idempotencyKey: "path:postok12",
              context: { directory: dir, workspace: "" },
              payload: {},
            }),
          )
          const ws = asPathResult(wsRaw)
          expect(ws.status).toBe("failed")
          expect(ws.requestId).toBe("req-post-1")
          expect(ws.opId).toBe("path:postok12")
          expect(ws.idempotencyKey).toBe("path:postok12")
          expect(ws.failure?.message).not.toContain(dir)
          expect((ws.failure?.message ?? "").length).toBeLessThanOrEqual(200)
          assertNoPathLeak(ws, dir)
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        restoreParentPid()
      }
    }),
  )
})
