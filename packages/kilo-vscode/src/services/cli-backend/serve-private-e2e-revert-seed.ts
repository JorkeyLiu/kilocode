import { isE2EFixtureEnabled } from "../../util/e2e-fixture"

export interface E2ERevertSeedRequest {
  v: 1
  requestId: string
  opId: string
  op: "session/e2eRevertSeed"
  idempotencyKey: string
  context: { directory: string }
  payload: { title?: string }
}

export type E2ERevertSeedResult =
  | {
      v: 1
      requestId: string
      opId: string
      op: "session/e2eRevertSeed"
      idempotencyKey: string
      status: "succeeded"
      outcome: { type: "succeeded"; time: number }
      accepted: true
      data: { sessionId: string; messageId: string; partId: string; session: Record<string, unknown>; revision: number }
    }
  | {
      v: 1
      requestId: string
      opId: string
      op: "session/e2eRevertSeed"
      idempotencyKey: string
      status: "failed"
      outcome: { type: "failed"; time: number; failure: { code: string; message: string; retryable: boolean } }
      accepted: boolean
      failure: { code: string; message: string; retryable: boolean }
    }

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

export function validateE2ERevertSeedRequest(raw: unknown): E2ERevertSeedRequest {
  if (!isE2EFixtureEnabled()) throw new Error("e2eRevertSeed requires KILO_E2E_FIXTURE")
  if (!isRecord(raw)) throw new Error("request must be object")
  if (raw.v !== 1) throw new Error("v must be 1")
  if (typeof raw.requestId !== "string" || !raw.requestId) throw new Error("requestId must be non-empty string")
  if (typeof raw.opId !== "string" || !raw.opId) throw new Error("opId must be non-empty string")
  if (raw.op !== "session/e2eRevertSeed") throw new Error("op must be session/e2eRevertSeed")
  if (typeof raw.idempotencyKey !== "string" || !raw.idempotencyKey) throw new Error("idempotencyKey must be non-empty string")
  const ctx = raw.context as unknown
  if (!isRecord(ctx) || typeof ctx.directory !== "string" || !ctx.directory) throw new Error("context.directory must be non-empty string")
  const payload = raw.payload as unknown
  if (payload !== undefined && !isRecord(payload)) throw new Error("payload must be object")
  if (payload && typeof (payload as Record<string, unknown>).title !== "undefined" && typeof (payload as Record<string, unknown>).title !== "string") throw new Error("payload.title must be string")
  return raw as unknown as E2ERevertSeedRequest
}

export function validateE2ERevertSeedResult(raw: unknown, req: E2ERevertSeedRequest): E2ERevertSeedResult {
  if (!isRecord(raw)) throw new Error("result must be object")
  if (raw.v !== 1) throw new Error("result v must be 1")
  if (raw.requestId !== req.requestId) throw new Error("requestId mismatch")
  if (raw.opId !== req.opId) throw new Error("opId mismatch")
  if (raw.op !== "session/e2eRevertSeed") throw new Error("op mismatch")
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
    if (!isRecord(data) || typeof data.sessionId !== "string" || typeof data.messageId !== "string") throw new Error("succeeded data invalid")
  }
  return raw as unknown as E2ERevertSeedResult
}
