// B9 cancellation-request identity envelope contract evidence only.
// Pure contract helpers with no transport, no private capability, no dispatch,
// no abort execution, no durable outcome, no timeout/late-SSE/partial handling.
// `op:"session/abort"` below is a contract-evidence label only; it is never
// registered as a private capability and never sent over any peer. Production
// abort stays SDK-only (`kilo-provider/abort.ts` + `KiloProvider.handleAbort`).
// Investigation-only: receipt is not cancellation proof; terminal convergence
// is a separate contract shape confirmed only via runtime/SSE/persistence.

import { isAbsolute, normalize, resolve } from "path"

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

function isNonEmpty(v: unknown): v is string {
  return typeof v === "string" && v.length > 0
}

function isSessionId(v: unknown): boolean {
  return typeof v === "string" && (v as string).startsWith("ses")
}

function canonicalDir(dir: string): string {
  return normalize(resolve(dir))
}

export function canonicalAbortOpId(sessionId: string, token: string): string {
  if (typeof sessionId !== "string" || sessionId.length === 0)
    throw new TypeError("sessionId must be non-empty string")
  if (sessionId.includes(":")) throw new TypeError("sessionId must not contain ':'")
  if (typeof token !== "string" || token.length === 0) throw new TypeError("token must be non-empty string")
  if (token.includes(":")) throw new TypeError("token must not contain ':'")
  return `abort:${sessionId}:${token}`
}

export function parseAbortOpId(opId: string): { sessionId: string; token: string } {
  if (typeof opId !== "string" || opId.length === 0) throw new TypeError("opId must be non-empty string")
  const segs = opId.split(":")
  if (segs.length !== 3) throw new TypeError(`abort opId must have 2 segments: ${opId}`)
  const kind = segs[0]!
  if (kind !== "abort") throw new TypeError(`opId kind must be abort: ${opId}`)
  const sid = segs[1]!
  const token = segs[2]!
  if (sid.length === 0) throw new TypeError(`opId segment must be non-empty: ${opId}`)
  if (token.length === 0) throw new TypeError(`opId segment must be non-empty: ${opId}`)
  return { sessionId: sid, token }
}

export interface AbortContractRequest {
  v: 1
  requestId: string
  opId: string
  op: "session/abort"
  idempotencyKey: string
  context: {
    directory: string
    sessionId: string
  }
  payload: Record<string, never>
}

// eslint-disable-next-line complexity
export function validateAbortContractRequest(raw: unknown): AbortContractRequest {
  if (!isRecord(raw)) throw new Error("request must be object")
  if (raw.v !== 1) throw new Error("v must be 1")
  if (!isNonEmpty(raw.requestId)) throw new Error("requestId must be non-empty string")
  if (!isNonEmpty(raw.opId)) throw new Error("opId must be non-empty string")
  if (raw.op !== "session/abort") throw new Error("op must be session/abort")
  if (!isNonEmpty(raw.idempotencyKey)) throw new Error("idempotencyKey must be non-empty string")
  if (raw.idempotencyKey !== raw.opId) throw new Error("idempotencyKey must equal opId for abort contract")
  const ctx = raw.context
  if (!isRecord(ctx)) throw new Error("context must be object")
  const allowedCtx = new Set(["directory", "sessionId"])
  for (const k of Object.keys(ctx as Record<string, unknown>))
    if (!allowedCtx.has(k)) throw new Error(`unexpected context field ${k}`)
  if (typeof ctx.directory !== "string" || !isAbsolute(ctx.directory) || ctx.directory.includes("\0"))
    throw new Error("context.directory must be absolute path")
  if (!isSessionId(ctx.sessionId)) throw new Error("context.sessionId must be SessionID")
  const payload = raw.payload
  if (!isRecord(payload)) throw new Error("payload must be object")
  if (Object.keys(payload as Record<string, unknown>).length !== 0)
    throw new Error("payload must be empty object for abort contract")
  const allowedRoot = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "context", "payload"])
  for (const k of Object.keys(raw as Record<string, unknown>))
    if (!allowedRoot.has(k)) throw new Error(`unexpected field ${k}`)
  const parsed = parseAbortOpId(raw.opId as string)
  if (parsed.sessionId !== ctx.sessionId)
    throw new Error(`opId session binding mismatch: ${raw.opId} vs ${ctx.sessionId}`)
  if (parsed.token.includes(":")) throw new Error("opId token must not contain ':'")
  const idem = parseAbortOpId(raw.idempotencyKey as string)
  if (idem.sessionId !== ctx.sessionId)
    throw new Error(`idempotencyKey session binding mismatch: ${raw.idempotencyKey} vs ${ctx.sessionId}`)
  if (idem.token !== parsed.token) throw new Error("idempotencyKey token must equal opId token")
  return raw as unknown as AbortContractRequest
}

export type AbortScopeWhich = "directory" | "session" | "request"

export type AbortScopeCheck =
  | { ok: true }
  | { ok: false; code: "scope_mismatch"; which: AbortScopeWhich }

export function checkAbortScope(
  req: AbortContractRequest,
  expected: { directory: string; sessionId: string; token: string },
): AbortScopeCheck {
  let want = expected.directory
  try {
    want = canonicalDir(expected.directory)
  } catch {
    return { ok: false, code: "scope_mismatch", which: "directory" }
  }
  let got = req.context.directory
  try {
    got = canonicalDir(req.context.directory)
  } catch {
    return { ok: false, code: "scope_mismatch", which: "directory" }
  }
  if (got !== want) return { ok: false, code: "scope_mismatch", which: "directory" }
  if (req.context.sessionId !== expected.sessionId)
    return { ok: false, code: "scope_mismatch", which: "session" }
  const parsed = parseAbortOpId(req.opId)
  if (parsed.sessionId !== expected.sessionId)
    return { ok: false, code: "scope_mismatch", which: "session" }
  if (parsed.token !== expected.token) return { ok: false, code: "scope_mismatch", which: "request" }
  const bound = canonicalAbortOpId(expected.sessionId, expected.token)
  if (req.opId !== bound || req.idempotencyKey !== bound)
    return { ok: false, code: "scope_mismatch", which: "request" }
  return { ok: true }
}

// Receipt is transport acknowledgement only (non-terminal, never cancellation
// proof). Terminal is the separate convergence shape; these fixtures prove
// shape separation only and claim no runtime convergence.
export interface AbortContractReceipt {
  kind: "receipt"
  v: 1
  requestId: string
  opId: string
  idempotencyKey: string
  accepted: true
  terminal: false
}

export interface AbortContractTerminal {
  kind: "terminal"
  v: 1
  requestId: string
  opId: string
  idempotencyKey: string
  accepted: boolean
  terminal: true
  affected: AbortAffectedGeneration[]
}

export function makeAbortReceipt(req: AbortContractRequest): AbortContractReceipt {
  return {
    kind: "receipt",
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    idempotencyKey: req.idempotencyKey,
    accepted: true,
    terminal: false,
  }
}

export function makeAbortTerminalFixture(
  req: AbortContractRequest,
  affected: AbortAffectedGeneration[],
): AbortContractTerminal {
  return {
    kind: "terminal",
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    idempotencyKey: req.idempotencyKey,
    accepted: true,
    terminal: true,
    affected: [...affected],
  }
}

export function isAbortReceipt(v: unknown): v is AbortContractReceipt {
  return isRecord(v) && v.kind === "receipt" && (v as { terminal?: unknown }).terminal === false
}

export function isAbortTerminal(v: unknown): v is AbortContractTerminal {
  return isRecord(v) && v.kind === "terminal" && (v as { terminal?: unknown }).terminal === true
}

// Generation identity is affected-set association only, never the operation
// identity. These fixture types carry existing generation references so tests
// can prove the separation without inventing production generation wire.
export interface AbortAffectedGeneration {
  kind: "generation"
  generationId: string
  sessionId: string
}

export function validateAffectedGeneration(raw: unknown): AbortAffectedGeneration {
  if (!isRecord(raw)) throw new Error("affected generation must be object")
  const allowed = new Set(["kind", "generationId", "sessionId"])
  for (const k of Object.keys(raw)) if (!allowed.has(k)) throw new Error(`unexpected affected field ${k}`)
  if (raw.kind !== "generation") throw new Error("affected kind must be generation")
  if (!isNonEmpty(raw.generationId)) throw new Error("affected generationId must be non-empty string")
  if (!isSessionId(raw.sessionId)) throw new Error("affected sessionId must be SessionID")
  return raw as unknown as AbortAffectedGeneration
}

export function assertGenerationNotRequestIdentity(
  req: AbortContractRequest,
  affected: AbortAffectedGeneration[],
): void {
  const parsed = parseAbortOpId(req.opId)
  for (const ref of affected) {
    validateAffectedGeneration(ref)
    if (parsed.token === ref.generationId)
      throw new Error("generation identity must not be the abort request identity")
  }
}
