import { afterEach, describe, expect, test } from "bun:test"
import { PassThrough } from "stream"
import { Effect } from "effect"
import { JsonRpcPeer } from "../../../src/private-worker/peer"
import { ErrorCode } from "../../../src/private-worker/json-rpc"
import { createFdCarrier } from "../../../src/kilocode/server/fd-carrier"
import { FD_PROTOCOL_NAME } from "../../../src/kilocode/server/fd-carrier-protocol"
import { AppRuntime } from "../../../src/effect/app-runtime"
import { InstanceStore } from "../../../src/project/instance-store"
import {
  canonicalBackgroundStopSessionOpId,
  validateBackgroundStopSessionRequest,
  validateBackgroundStopSessionResult,
} from "../../../src/kilocode/background-process-stop-session-private"
import { tmpdir, disposeAllInstances } from "../../fixture/fixture"
import { resetDatabase } from "../../fixture/db"

type StopResult = {
  v: number
  requestId: string
  opId: string
  op: string
  idempotencyKey: string
  status: string
  outcome: { type: string; time: number; failure?: { code: string; message: string; retryable: boolean } }
  accepted: boolean
  data?: { stopped: boolean }
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

function asStopResult(v: unknown): StopResult {
  const row = asRecord(v)
  if (row.v !== 1) throw new Error("expected response.v to be 1")
  const requestId = str(row, "requestId")
  const opId = str(row, "opId")
  if (str(row, "op") !== "background-process/stop-session")
    throw new Error("expected response.op to be background-process/stop-session")
  const idempotencyKey = str(row, "idempotencyKey")
  const status = str(row, "status")
  if (status !== "succeeded" && status !== "failed") throw new Error("expected response.status succeeded or failed")
  if (typeof row.accepted !== "boolean") throw new Error("expected boolean response.accepted")
  const outcomeRaw = row.outcome
  if (!record(outcomeRaw)) throw new Error("expected record response.outcome")
  if (typeof outcomeRaw.type !== "string") throw new Error("expected string response.outcome.type")
  if (typeof outcomeRaw.time !== "number") throw new Error("expected number response.outcome.time")
  if (outcomeRaw.type !== status) throw new Error("expected response.outcome.type to match response.status")
  const outcome: StopResult["outcome"] =
    outcomeRaw.failure === undefined
      ? { type: outcomeRaw.type, time: outcomeRaw.time }
      : {
          type: outcomeRaw.type,
          time: outcomeRaw.time,
          failure: failureOf(outcomeRaw.failure, "response.outcome.failure"),
        }
  const dataRaw = row.data
  const data = dataRaw === undefined ? undefined : { stopped: asRecord(dataRaw).stopped as boolean }
  const failure = row.failure === undefined ? undefined : failureOf(row.failure, "response.failure")
  if (status === "succeeded") {
    if (row.accepted !== true) throw new Error("expected accepted true for succeeded")
    if (opId !== idempotencyKey) throw new Error("expected response.opId to equal response.idempotencyKey")
    if (data?.stopped !== true) throw new Error("expected response.data.stopped true for succeeded")
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
  return {
    v: 1,
    requestId,
    opId,
    op: "background-process/stop-session",
    idempotencyKey,
    status,
    outcome,
    accepted: row.accepted,
    ...(data ? { data } : {}),
    ...(failure ? { failure } : {}),
  }
}

function codeOf(v: StopResult): string | undefined {
  return v.failure?.code ?? v.outcome.failure?.code
}

function linked() {
  const extToCarrier = new PassThrough()
  const carrierToExt = new PassThrough()
  const carrier = createFdCarrier(extToCarrier, carrierToExt)
  const ext = new JsonRpcPeer({ reader: carrierToExt, writer: extToCarrier })
  return { carrier, ext }
}

const SID = "ses_ffffffffffffffffffffffff"

function req(
  dir: string,
  sid: string = SID,
  token = "tok1",
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const opId = canonicalBackgroundStopSessionOpId(token)
  return {
    v: 1,
    requestId: "req-stop-1",
    opId,
    op: "background-process/stop-session",
    idempotencyKey: opId,
    context: { directory: dir, sessionId: sid },
    payload: {},
    ...overrides,
  }
}

async function init(ext: JsonRpcPeer): Promise<Record<string, unknown>> {
  return asRecord(
    await ext.request("initialize", {
      protocol: { name: FD_PROTOCOL_NAME, major: 1, minor: 0 },
      clientInfo: { name: "kilo-vscode", version: "7.4.11" },
      capabilities: ["background-process/stop-session"],
    }),
  )
}

async function loadInstance(dir: string): Promise<void> {
  await AppRuntime.runPromise(
    Effect.gen(function* () {
      const store = yield* InstanceStore.Service
      yield* store.load({ directory: dir })
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

describe("fd-carrier background-process/stop-session (session cleanup)", () => {
  afterEach(async () => {
    await disposeAllInstances()
    await resetDatabase()
  })

  test("initialize advertises background-process/stop-session capability", async () => {
    const { carrier, ext } = linked()
    try {
      const res = await init(ext)
      expect(capsOf(res).includes("background-process/stop-session")).toBeTrue()
    } finally {
      carrier.dispose()
      ext.dispose()
    }
  })

  test("pre-init stop-session rejected InvalidRequest", async () => {
    const { carrier, ext } = linked()
    try {
      const err = await ext.request("background-process/stop-session", req("/tmp")).then(
        () => undefined,
        (e: unknown) => e,
      )
      expect(asError(err).code).toBe(ErrorCode.InvalidRequest)
    } finally {
      carrier.dispose()
      ext.dispose()
    }
  })

  test("unknown root field fails closed with echo-validated identities", async () => {
    await using tmp = await tmpdir({ git: true })
    const dir = tmp.path
    await loadInstance(dir)
    const { carrier, ext } = linked()
    try {
      await init(ext)
      const raw = await ext.request(
        "background-process/stop-session",
        req(dir, SID, "unknown-field", { requestId: "req-unknown", extra: true }),
      )
      const res = asStopResult(raw)
      expect(res.status).toBe("failed")
      expect(res.outcome.type).toBe("failed")
      expect(res.accepted).toBeFalse()
      expect(codeOf(res)).toBe("validation.failed")
      expect(res.requestId).toBe("req-unknown")
      expect(res.op).toBe("background-process/stop-session")
      expect(res.opId).toBe(res.idempotencyKey)
      expect(res.data).toBeUndefined()
      expect(res.failure?.retryable).toBe(false)
    } finally {
      carrier.dispose()
      ext.dispose()
    }
  })

  test("relative directory fails closed", async () => {
    await using tmp = await tmpdir({ git: true })
    const dir = tmp.path
    await loadInstance(dir)
    const { carrier, ext } = linked()
    try {
      await init(ext)
      const raw = await ext.request(
        "background-process/stop-session",
        req("relative/path", SID, "tok-reldir", { requestId: "req-reldir" }),
      )
      const res = asStopResult(raw)
      expect(res.status).toBe("failed")
      expect(res.outcome.type).toBe("failed")
      expect(res.accepted).toBeFalse()
      expect(codeOf(res)).toBe("validation.failed")
      expect(res.requestId).toBe("req-reldir")
      expect(res.opId).toBe(res.idempotencyKey)
      expect(res.data).toBeUndefined()
      expect(res.failure?.retryable).toBe(false)
    } finally {
      carrier.dispose()
      ext.dispose()
    }
  })

  test("valid stop-session succeeds as idempotent no-op with zero processes", async () => {
    await using tmp = await tmpdir({ git: true })
    const dir = tmp.path
    await loadInstance(dir)
    const { carrier, ext } = linked()
    try {
      await init(ext)
      const raw = await ext.request("background-process/stop-session", req(dir, SID, "tok-valid"))
      const res = asStopResult(raw)
      expect(res.status).toBe("succeeded")
      expect(res.outcome.type).toBe("succeeded")
      expect(res.accepted).toBeTrue()
      expect(res.requestId).toBe("req-stop-1")
      expect(res.op).toBe("background-process/stop-session")
      expect(res.opId).toBe(res.idempotencyKey)
      expect(res.data?.stopped).toBeTrue()
      // Repeated idempotent cleanup with a new opaque identity succeeds again.
      // This operation intentionally has no journal, so the repeat re-runs cleanup
      // rather than replaying a durable result.
      const raw2 = await ext.request(
        "background-process/stop-session",
        req(dir, SID, "tok-valid-2", { requestId: "req-stop-2" }),
      )
      const res2 = asStopResult(raw2)
      expect(res2.status).toBe("succeeded")
      expect(res2.outcome.type).toBe("succeeded")
      expect(res2.accepted).toBeTrue()
      expect(res2.requestId).toBe("req-stop-2")
      expect(res2.opId).toBe(res2.idempotencyKey)
      expect(res2.data?.stopped).toBeTrue()
    } finally {
      carrier.dispose()
      ext.dispose()
    }
  })

  test("background stop-session private contract validates and echoes", () => {
    const dir = "/tmp"
    const opId = canonicalBackgroundStopSessionOpId("tok-private")
    const parsed = validateBackgroundStopSessionRequest(req(dir, SID, "tok-private"))
    expect(parsed.opId).toBe(opId)
    expect(parsed.idempotencyKey).toBe(opId)
    expect(parsed.requestId).toBe("req-stop-1")
    const ok = {
      v: 1,
      requestId: parsed.requestId,
      opId: parsed.opId,
      op: "background-process/stop-session",
      idempotencyKey: parsed.idempotencyKey,
      status: "succeeded",
      outcome: { type: "succeeded", time: 1 },
      accepted: true,
      data: { stopped: true },
    }
    const checked = validateBackgroundStopSessionResult(ok, parsed)
    expect(checked.status).toBe("succeeded")
    expect(checked.outcome.type).toBe("succeeded")
  })
})
