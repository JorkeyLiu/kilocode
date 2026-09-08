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

// B9-P2.3 pure outcome-disposition and terminal-idempotency fixture contracts.
// Contract evidence only: stateless pure constructors/validators with no map,
// cache, store, timers, SSE hooks, persistence, replay side effects, or runtime
// dispatch. Fixtures prove shape only; they claim no runtime convergence and no
// production parity. Receipt vs terminal separation from P2.2 is unchanged.
export type AbortTargetKind =
  | "root"
  | "descendant"
  | "queued"
  | "intake"
  | "background"
  | "followup"
  | "event-publication"

export const ABORT_TARGET_KINDS: readonly AbortTargetKind[] = [
  "root",
  "descendant",
  "queued",
  "intake",
  "background",
  "followup",
  "event-publication",
]

export type AbortTargetDisposition = "cancelled" | "succeeded" | "not_affected"

export interface AbortDispositionEntry {
  kind: AbortTargetKind
  disposition: AbortTargetDisposition
  generationId: string
  sessionId: string
}

export function validateAbortDispositionEntry(raw: unknown): AbortDispositionEntry {
  if (!isRecord(raw)) throw new Error("disposition entry must be object")
  const allowed = new Set(["kind", "disposition", "generationId", "sessionId"])
  for (const k of Object.keys(raw)) if (!allowed.has(k)) throw new Error(`unexpected disposition field ${k}`)
  const kind = (raw as Record<string, unknown>).kind
  if (!ABORT_TARGET_KINDS.includes(kind as AbortTargetKind))
    throw new Error(`disposition kind must be one of ${ABORT_TARGET_KINDS.join(",")}`)
  const disposition = (raw as Record<string, unknown>).disposition
  if (disposition !== "cancelled" && disposition !== "succeeded" && disposition !== "not_affected")
    throw new Error("disposition must be cancelled, succeeded, or not_affected")
  if (!isNonEmpty((raw as Record<string, unknown>).generationId))
    throw new Error("disposition generationId must be non-empty string")
  if (!isSessionId((raw as Record<string, unknown>).sessionId))
    throw new Error("disposition sessionId must be SessionID")
  return raw as unknown as AbortDispositionEntry
}

export interface AbortDispositionTerminal {
  kind: "terminal"
  v: 1
  requestId: string
  opId: string
  idempotencyKey: string
  accepted: boolean
  terminal: true
  affected: AbortDispositionEntry[]
  diagnostic?: AbortDiagnostic
}

export function makeAbortDispositionTerminal(
  req: AbortContractRequest,
  affected: AbortDispositionEntry[],
  diagnostic?: AbortDiagnostic,
): AbortDispositionTerminal {
  for (const entry of affected) validateAbortDispositionEntry(entry)
  if (diagnostic !== undefined) validateAbortDiagnostic(diagnostic)
  if (diagnostic === undefined) {
    return {
      kind: "terminal",
      v: 1,
      requestId: req.requestId,
      opId: req.opId,
      idempotencyKey: req.idempotencyKey,
      accepted: true,
      terminal: true,
      affected: affected.map((entry) => ({ ...entry })),
    }
  }
  return {
    kind: "terminal",
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    idempotencyKey: req.idempotencyKey,
    accepted: true,
    terminal: true,
    affected: affected.map((entry) => ({ ...entry })),
    diagnostic: { ...diagnostic },
  }
}

export function validateAbortDispositionTerminal(raw: unknown): AbortDispositionTerminal {
  if (!isRecord(raw)) throw new Error("disposition terminal must be object")
  if (raw.kind !== "terminal") throw new Error("disposition terminal kind must be terminal")
  if (raw.v !== 1) throw new Error("v must be 1")
  if (!isNonEmpty(raw.requestId)) throw new Error("requestId must be non-empty string")
  if (!isNonEmpty(raw.opId)) throw new Error("opId must be non-empty string")
  if (!isNonEmpty(raw.idempotencyKey)) throw new Error("idempotencyKey must be non-empty string")
  if (typeof raw.accepted !== "boolean") throw new Error("accepted must be boolean")
  if (raw.terminal !== true) throw new Error("terminal must be true")
  if (!Array.isArray(raw.affected)) throw new Error("affected must be array")
  for (const entry of raw.affected as unknown[]) validateAbortDispositionEntry(entry)
  const allowed = new Set([
    "kind",
    "v",
    "requestId",
    "opId",
    "idempotencyKey",
    "accepted",
    "terminal",
    "affected",
    "diagnostic",
  ])
  for (const k of Object.keys(raw)) if (!allowed.has(k)) throw new Error(`unexpected terminal field ${k}`)
  if (raw.diagnostic !== undefined) validateAbortDiagnostic(raw.diagnostic)
  return raw as unknown as AbortDispositionTerminal
}

export function isAbortCancellationSuccess(entry: AbortDispositionEntry): boolean {
  return entry.disposition === "cancelled"
}

export function countAbortCancelled(affected: AbortDispositionEntry[]): number {
  let total = 0
  for (const entry of affected) {
    validateAbortDispositionEntry(entry)
    if (entry.disposition === "cancelled") total += 1
  }
  return total
}

export function assertAbortSuccessExcludesNotAffected(
  affected: AbortDispositionEntry[],
  claimed: AbortDispositionEntry[],
): void {
  for (const entry of affected) validateAbortDispositionEntry(entry)
  for (const entry of claimed) {
    validateAbortDispositionEntry(entry)
    if (entry.disposition === "not_affected")
      throw new Error("not_affected must not be counted as cancellation success")
    if (entry.disposition === "succeeded")
      throw new Error("succeeded must not be counted as cancellation success")
  }
  const owned = new Set(affected.map((entry) => `${entry.kind}:${entry.generationId}:${entry.disposition}`))
  for (const entry of claimed) {
    const key = `${entry.kind}:${entry.generationId}:${entry.disposition}`
    if (!owned.has(key)) throw new Error("claimed success entry must come from the terminal affected set")
    if (!isAbortCancellationSuccess(entry)) throw new Error("only cancelled entries count as cancellation success")
  }
}

// Redacted diagnostic shape following B5-B8 failure fixture conventions
// ({code,message,retryable} + occurrence time). Only code/retryable/time (plus
// an optional short redacted message) are allowed; raw session/prompt/tool/
// error echo keys are rejected so fixtures cannot carry secret material.
export interface AbortDiagnostic {
  code: string
  retryable: boolean
  time: number
  message?: string
}

const ABORT_DIAGNOSTIC_FORBIDDEN = new Set([
  "session",
  "sessionId",
  "prompt",
  "tool",
  "error",
  "raw",
  "output",
  "detail",
])

export function validateAbortDiagnostic(raw: unknown): AbortDiagnostic {
  if (!isRecord(raw)) throw new Error("diagnostic must be object")
  for (const k of Object.keys(raw)) {
    if (ABORT_DIAGNOSTIC_FORBIDDEN.has(k)) throw new Error(`diagnostic must not carry ${k}`)
  }
  const allowed = new Set(["code", "retryable", "time", "message"])
  for (const k of Object.keys(raw)) if (!allowed.has(k)) throw new Error(`unexpected diagnostic field ${k}`)
  if (!isNonEmpty(raw.code)) throw new Error("diagnostic code must be non-empty string")
  if (typeof raw.retryable !== "boolean") throw new Error("diagnostic retryable must be boolean")
  if (typeof raw.time !== "number" || !Number.isFinite(raw.time))
    throw new Error("diagnostic time must be finite number")
  if (raw.message !== undefined && !isNonEmpty(raw.message))
    throw new Error("diagnostic message must be non-empty string when present")
  return raw as unknown as AbortDiagnostic
}

// Typed `session.not_found` terminal failure fixture. Shape-only contract
// vocabulary with explicit sideEffect:false; it proves no runtime behavior and
// performs no state change.
export interface AbortNotFoundTerminal {
  kind: "terminal-failure"
  v: 1
  requestId: string
  opId: string
  idempotencyKey: string
  accepted: false
  terminal: true
  failure: AbortDiagnostic
  sideEffect: false
}

export function makeAbortNotFoundFixture(
  req: AbortContractRequest,
  diagnostic: AbortDiagnostic,
): AbortNotFoundTerminal {
  validateAbortDiagnostic(diagnostic)
  if (diagnostic.code !== "session.not_found") throw new Error("not_found fixture code must be session.not_found")
  return {
    kind: "terminal-failure",
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    idempotencyKey: req.idempotencyKey,
    accepted: false,
    terminal: true,
    failure: { ...diagnostic },
    sideEffect: false,
  }
}

export function validateAbortNotFoundTerminal(raw: unknown): AbortNotFoundTerminal {
  if (!isRecord(raw)) throw new Error("not_found terminal must be object")
  if (raw.kind !== "terminal-failure") throw new Error("not_found terminal kind must be terminal-failure")
  if (raw.v !== 1) throw new Error("v must be 1")
  if (!isNonEmpty(raw.requestId)) throw new Error("requestId must be non-empty string")
  if (!isNonEmpty(raw.opId)) throw new Error("opId must be non-empty string")
  if (!isNonEmpty(raw.idempotencyKey)) throw new Error("idempotencyKey must be non-empty string")
  if (raw.accepted !== false) throw new Error("not_found terminal accepted must be false")
  if (raw.terminal !== true) throw new Error("terminal must be true")
  if (raw.sideEffect !== false) throw new Error("not_found terminal sideEffect must be false")
  const allowed = new Set([
    "kind",
    "v",
    "requestId",
    "opId",
    "idempotencyKey",
    "accepted",
    "terminal",
    "failure",
    "sideEffect",
  ])
  for (const k of Object.keys(raw)) if (!allowed.has(k)) throw new Error(`unexpected not_found field ${k}`)
  const failure = validateAbortDiagnostic(raw.failure)
  if (failure.code !== "session.not_found") throw new Error("not_found failure code must be session.not_found")
  return raw as unknown as AbortNotFoundTerminal
}

export function isAbortNotFoundTerminal(v: unknown): v is AbortNotFoundTerminal {
  return isRecord(v) && v.kind === "terminal-failure" && (v as { terminal?: unknown }).terminal === true
}

// Stateless terminal re-observation: matches the same opId + idempotencyKey
// and returns the exact original terminal facts as a deep-equal copy. No map,
// cache, store, or mutation; mismatched identity is rejected.
export function reobserveAbortTerminal<T extends { opId: string; idempotencyKey: string; terminal: true }>(
  stored: T,
  probe: { opId: string; idempotencyKey: string },
): T {
  if (!isRecord(stored)) throw new Error("stored terminal must be object")
  if ((stored as { terminal?: unknown }).terminal !== true) throw new Error("stored terminal must be terminal")
  if (!isNonEmpty((stored as { opId?: unknown }).opId)) throw new Error("stored opId must be non-empty string")
  if (!isNonEmpty((stored as { idempotencyKey?: unknown }).idempotencyKey))
    throw new Error("stored idempotencyKey must be non-empty string")
  if (!isRecord(probe)) throw new Error("probe must be object")
  if (!isNonEmpty((probe as Record<string, unknown>).opId)) throw new Error("probe opId must be non-empty string")
  if (!isNonEmpty((probe as Record<string, unknown>).idempotencyKey))
    throw new Error("probe idempotencyKey must be non-empty string")
  if (probe.opId !== stored.opId) throw new Error("re-observation opId mismatch")
  if (probe.idempotencyKey !== stored.idempotencyKey) throw new Error("re-observation idempotencyKey mismatch")
  return JSON.parse(JSON.stringify(stored)) as T
}
