import { isE2EFixtureEnabled } from "../../util/e2e-fixture"

export interface E2ESandboxTokenIssueRequest {
  v: 1
  requestId: string
  opId: string
  op: "session/e2eSandboxTokenIssue"
  idempotencyKey: string
  context: { directory: string }
  payload: { sourceSessionId: string; sourceDirectory: string; count?: number }
}

export type E2ESandboxTokenIssueResult =
  | {
      v: 1
      requestId: string
      opId: string
      op: "session/e2eSandboxTokenIssue"
      idempotencyKey: string
      status: "succeeded"
      outcome: { type: "succeeded"; time: number }
      accepted: true
      data: { token: string; hash: string; sourceSessionId: string; sourceDirectory: string; count: number; directory: string }
    }
  | {
      v: 1
      requestId: string
      opId: string
      op: "session/e2eSandboxTokenIssue"
      idempotencyKey: string
      status: "failed"
      outcome: { type: "failed"; time: number; failure: { code: string; message: string; retryable: boolean } }
      accepted: boolean
      failure: { code: string; message: string; retryable: boolean }
    }

export interface E2ESandboxPolicyReadRequest {
  v: 1
  requestId: string
  opId: string
  op: "session/e2eSandboxPolicyRead"
  idempotencyKey: string
  context: { directory: string }
  payload: { sessionId: string }
}

export type E2ESandboxPolicyReadResult =
  | {
      v: 1
      requestId: string
      opId: string
      op: "session/e2eSandboxPolicyRead"
      idempotencyKey: string
      status: "succeeded"
      outcome: { type: "succeeded"; time: number }
      accepted: true
      data: { sessionId: string; directory: string; found: boolean; snapshot: unknown | null }
    }
  | {
      v: 1
      requestId: string
      opId: string
      op: "session/e2eSandboxPolicyRead"
      idempotencyKey: string
      status: "failed"
      outcome: { type: "failed"; time: number; failure: { code: string; message: string; retryable: boolean } }
      accepted: boolean
      failure: { code: string; message: string; retryable: boolean }
    }

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

// eslint-disable-next-line complexity -- strict fixture request validation aggregates many field checks
export function validateE2ESandboxTokenIssueRequest(raw: unknown): E2ESandboxTokenIssueRequest {
  if (!isE2EFixtureEnabled()) throw new Error("e2eSandboxTokenIssue requires KILO_E2E_FIXTURE")
  if (!isRecord(raw)) throw new Error("request must be object")
  if (raw.v !== 1) throw new Error("v must be 1")
  if (typeof raw.requestId !== "string" || !raw.requestId) throw new Error("requestId must be non-empty string")
  if (typeof raw.opId !== "string" || !raw.opId) throw new Error("opId must be non-empty string")
  if (raw.op !== "session/e2eSandboxTokenIssue") throw new Error("op must be session/e2eSandboxTokenIssue")
  if (typeof raw.idempotencyKey !== "string" || !raw.idempotencyKey) throw new Error("idempotencyKey must be non-empty string")
  const ctx = raw.context as unknown
  if (!isRecord(ctx) || typeof ctx.directory !== "string" || !ctx.directory) throw new Error("context.directory must be non-empty string")
  const p = raw.payload as unknown
  if (!isRecord(p) || typeof p.sourceSessionId !== "string" || !p.sourceSessionId.startsWith("ses")) throw new Error("payload.sourceSessionId must be ses*")
  if (typeof p.sourceDirectory !== "string" || !p.sourceDirectory) throw new Error("payload.sourceDirectory must be non-empty string")
  if (p.count !== undefined && (typeof p.count !== "number" || !Number.isInteger(p.count) || p.count < 2)) throw new Error("payload.count must be integer >=2")
  return raw as unknown as E2ESandboxTokenIssueRequest
}

export function validateE2ESandboxTokenIssueResult(raw: unknown, req: E2ESandboxTokenIssueRequest): E2ESandboxTokenIssueResult {
  if (!isRecord(raw)) throw new Error("result must be object")
  if (raw.v !== 1) throw new Error("result v must be 1")
  if (raw.requestId !== req.requestId) throw new Error("requestId mismatch")
  if (raw.opId !== req.opId) throw new Error("opId mismatch")
  if (raw.op !== "session/e2eSandboxTokenIssue") throw new Error("op mismatch")
  if (raw.idempotencyKey !== req.idempotencyKey) throw new Error("idempotencyKey mismatch")
  const status = raw.status as string
  if (status !== "succeeded" && status !== "failed") throw new Error("status must be succeeded/failed")
  if (typeof raw.accepted !== "boolean") throw new Error("accepted must be boolean")
  const out = raw.outcome as unknown
  if (!isRecord(out) || typeof out.type !== "string" || typeof out.time !== "number") throw new Error("outcome invalid")
  if (out.type !== status) throw new Error("outcome.type must match status")
  if (status === "succeeded") {
    if (raw.accepted !== true) throw new Error("succeeded accepted must be true")
    const data = (raw as Record<string, unknown>).data as unknown
    if (!isRecord(data) || typeof data.token !== "string" || !/^si-/.test(data.token as string)) throw new Error("succeeded data.token invalid")
  }
  return raw as unknown as E2ESandboxTokenIssueResult
}

export function validateE2ESandboxPolicyReadRequest(raw: unknown): E2ESandboxPolicyReadRequest {
  if (!isE2EFixtureEnabled()) throw new Error("e2eSandboxPolicyRead requires KILO_E2E_FIXTURE")
  if (!isRecord(raw)) throw new Error("request must be object")
  if (raw.v !== 1) throw new Error("v must be 1")
  if (typeof raw.requestId !== "string" || !raw.requestId) throw new Error("requestId must be non-empty string")
  if (typeof raw.opId !== "string" || !raw.opId) throw new Error("opId must be non-empty string")
  if (raw.op !== "session/e2eSandboxPolicyRead") throw new Error("op must be session/e2eSandboxPolicyRead")
  if (typeof raw.idempotencyKey !== "string" || !raw.idempotencyKey) throw new Error("idempotencyKey must be non-empty string")
  const ctx = raw.context as unknown
  if (!isRecord(ctx) || typeof ctx.directory !== "string" || !ctx.directory) throw new Error("context.directory must be non-empty string")
  const p = raw.payload as unknown
  if (!isRecord(p) || typeof p.sessionId !== "string" || !p.sessionId.startsWith("ses")) throw new Error("payload.sessionId must be ses*")
  return raw as unknown as E2ESandboxPolicyReadRequest
}

export function validateE2ESandboxPolicyReadResult(raw: unknown, req: E2ESandboxPolicyReadRequest): E2ESandboxPolicyReadResult {
  if (!isRecord(raw)) throw new Error("result must be object")
  if (raw.v !== 1) throw new Error("result v must be 1")
  if (raw.requestId !== req.requestId) throw new Error("requestId mismatch")
  if (raw.opId !== req.opId) throw new Error("opId mismatch")
  if (raw.op !== "session/e2eSandboxPolicyRead") throw new Error("op mismatch")
  if (raw.idempotencyKey !== req.idempotencyKey) throw new Error("idempotencyKey mismatch")
  const status = raw.status as string
  if (status !== "succeeded" && status !== "failed") throw new Error("status must be succeeded/failed")
  if (typeof raw.accepted !== "boolean") throw new Error("accepted must be boolean")
  const out = raw.outcome as unknown
  if (!isRecord(out) || typeof out.type !== "string" || typeof out.time !== "number") throw new Error("outcome invalid")
  if (out.type !== status) throw new Error("outcome.type must match status")
  return raw as unknown as E2ESandboxPolicyReadResult
}

export interface E2ESandboxSetRequest {
  v: 1
  requestId: string
  opId: string
  op: "session/e2eSandboxSet"
  idempotencyKey: string
  context: { directory: string }
  payload: { sessionId: string }
}

export type E2ESandboxSetResult =
  | {
      v: 1
      requestId: string
      opId: string
      op: "session/e2eSandboxSet"
      idempotencyKey: string
      status: "succeeded"
      outcome: { type: "succeeded"; time: number }
      accepted: true
      data: { sessionId: string; directory: string; snapshot: unknown }
    }
  | {
      v: 1
      requestId: string
      opId: string
      op: "session/e2eSandboxSet"
      idempotencyKey: string
      status: "failed"
      outcome: { type: "failed"; time: number; failure: { code: string; message: string; retryable: boolean } }
      accepted: boolean
      failure: { code: string; message: string; retryable: boolean }
    }

export function validateE2ESandboxSetRequest(raw: unknown): E2ESandboxSetRequest {
  if (!isE2EFixtureEnabled()) throw new Error("e2eSandboxSet requires KILO_E2E_FIXTURE")
  if (!isRecord(raw)) throw new Error("request must be object")
  if (raw.v !== 1) throw new Error("v must be 1")
  if (typeof raw.requestId !== "string" || !raw.requestId) throw new Error("requestId must be non-empty string")
  if (typeof raw.opId !== "string" || !raw.opId) throw new Error("opId must be non-empty string")
  if (raw.op !== "session/e2eSandboxSet") throw new Error("op must be session/e2eSandboxSet")
  if (typeof raw.idempotencyKey !== "string" || !raw.idempotencyKey) throw new Error("idempotencyKey must be non-empty string")
  const ctx = raw.context as unknown
  if (!isRecord(ctx) || typeof ctx.directory !== "string" || !ctx.directory) throw new Error("context.directory must be non-empty string")
  const p = raw.payload as unknown
  if (!isRecord(p) || typeof p.sessionId !== "string" || !p.sessionId.startsWith("ses")) throw new Error("payload.sessionId must be ses*")
  return raw as unknown as E2ESandboxSetRequest
}

export function validateE2ESandboxSetResult(raw: unknown, req: E2ESandboxSetRequest): E2ESandboxSetResult {
  if (!isRecord(raw)) throw new Error("result must be object")
  if (raw.v !== 1) throw new Error("result v must be 1")
  if (raw.requestId !== req.requestId) throw new Error("requestId mismatch")
  if (raw.opId !== req.opId) throw new Error("opId mismatch")
  if (raw.op !== "session/e2eSandboxSet") throw new Error("op mismatch")
  if (raw.idempotencyKey !== req.idempotencyKey) throw new Error("idempotencyKey mismatch")
  const status = raw.status as string
  if (status !== "succeeded" && status !== "failed") throw new Error("status must be succeeded/failed")
  if (typeof raw.accepted !== "boolean") throw new Error("accepted must be boolean")
  const out = raw.outcome as unknown
  if (!isRecord(out) || typeof out.type !== "string" || typeof out.time !== "number") throw new Error("outcome invalid")
  if (out.type !== status) throw new Error("outcome.type must match status")
  return raw as unknown as E2ESandboxSetResult
}

export interface E2ESandboxGrantReadRequest {
  v: 1
  requestId: string
  opId: string
  op: "session/e2eSandboxGrantRead"
  idempotencyKey: string
  context: { directory: string }
  payload: { hash: string }
}

export type E2ESandboxGrantReadResult =
  | {
      v: 1
      requestId: string
      opId: string
      op: "session/e2eSandboxGrantRead"
      idempotencyKey: string
      status: "succeeded"
      outcome: { type: "succeeded"; time: number }
      accepted: true
      data: { hash: string; found: boolean; remaining?: number; directory?: string; sourceSessionId?: string }
    }
  | {
      v: 1
      requestId: string
      opId: string
      op: "session/e2eSandboxGrantRead"
      idempotencyKey: string
      status: "failed"
      outcome: { type: "failed"; time: number; failure: { code: string; message: string; retryable: boolean } }
      accepted: boolean
      failure: { code: string; message: string; retryable: boolean }
    }

export function validateE2ESandboxGrantReadRequest(raw: unknown): E2ESandboxGrantReadRequest {
  if (!isE2EFixtureEnabled()) throw new Error("e2eSandboxGrantRead requires KILO_E2E_FIXTURE")
  if (!isRecord(raw)) throw new Error("request must be object")
  if (raw.v !== 1) throw new Error("v must be 1")
  if (typeof raw.requestId !== "string" || !raw.requestId) throw new Error("requestId must be non-empty string")
  if (typeof raw.opId !== "string" || !raw.opId) throw new Error("opId must be non-empty string")
  if (raw.op !== "session/e2eSandboxGrantRead") throw new Error("op must be session/e2eSandboxGrantRead")
  if (typeof raw.idempotencyKey !== "string" || !raw.idempotencyKey) throw new Error("idempotencyKey must be non-empty string")
  const ctx = raw.context as unknown
  if (!isRecord(ctx) || typeof ctx.directory !== "string" || !ctx.directory) throw new Error("context.directory must be non-empty string")
  const p = raw.payload as unknown
  if (!isRecord(p) || typeof p.hash !== "string" || !/^[0-9a-f]{64}$/i.test(p.hash as string)) throw new Error("payload.hash must be 64 hex")
  return raw as unknown as E2ESandboxGrantReadRequest
}

export function validateE2ESandboxGrantReadResult(raw: unknown, req: E2ESandboxGrantReadRequest): E2ESandboxGrantReadResult {
  if (!isRecord(raw)) throw new Error("result must be object")
  if (raw.v !== 1) throw new Error("result v must be 1")
  if (raw.requestId !== req.requestId) throw new Error("requestId mismatch")
  if (raw.opId !== req.opId) throw new Error("opId mismatch")
  if (raw.op !== "session/e2eSandboxGrantRead") throw new Error("op mismatch")
  if (raw.idempotencyKey !== req.idempotencyKey) throw new Error("idempotencyKey mismatch")
  const status = raw.status as string
  if (status !== "succeeded" && status !== "failed") throw new Error("status must be succeeded/failed")
  if (typeof raw.accepted !== "boolean") throw new Error("accepted must be boolean")
  const out = raw.outcome as unknown
  if (!isRecord(out) || typeof out.type !== "string" || typeof out.time !== "number") throw new Error("outcome invalid")
  if (out.type !== status) throw new Error("outcome.type must match status")
  if (status === "succeeded") {
    if (raw.accepted !== true) throw new Error("succeeded accepted must be true")
    const data = (raw as Record<string, unknown>).data as unknown
    if (!isRecord(data) || typeof data.hash !== "string") throw new Error("succeeded data.hash invalid")
    if (typeof data.found !== "boolean") throw new Error("succeeded data.found invalid")
  }
  return raw as unknown as E2ESandboxGrantReadResult
}
