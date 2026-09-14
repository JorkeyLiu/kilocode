import * as crypto from "crypto"
import {
  canonicalPtyRemoveOpId,
  canonicalPtyUpdateOpId,
  validatePtyRemoveResult,
  validatePtyUpdateResult,
} from "../services/cli-backend/serve-private-pty-contract"
import type {
  PtyRemoveContractRequest,
  PtyUpdateContractRequest,
} from "../services/cli-backend/serve-private-pty-contract"
import { isPrivatePtyValidationError } from "../services/cli-backend/serve-private-pty"

/**
 * Private-first `pty/update` (resize) + `pty/remove` (close/dispose) for the
 * active Agent Manager PTY owner (`Pty.Service` per-directory via the
 * AppLayer-owned dedicated `PtyServiceMap`, same as HTTP `PUT/DELETE /pty/:ptyID`).
 *
 * One private attempt plus at most one same `(directory,ptyID,size)` SDK
 * fallback per action, never retried. Valid private `succeeded`+`accepted`
 * returns with zero SDK; validated `pty.not_found` (`retryable === false`)
 * is success-equivalent/already gone with zero SDK; other validated terminal
 * `failed` (`retryable === false` such as `validation.failed`/
 * `scope_mismatch`/`internal`) closes with zero SDK and remains a failure
 * outcome; fence/unavailable/invalid/ambiguous/transport/closed/timeout
 * takes exactly one same-tuple SDK fallback. Update and remove are
 * idempotent, so ambiguous may safely fallback once. SDK 404
 * (`PtyNotFoundError` or status 404) is success-equivalent; no false linger
 * warning. One request-scoped token; no durable replay/journal promise.
 */

export interface PtyPrivateConnection {
  isPrivateAvailable(): boolean
  privatePtyUpdateOutcomeWithHandle(req: PtyUpdateContractRequest): {
    id: number
    promise: Promise<unknown>
    cancel?: (msg?: string) => boolean | "stale"
  }
  privatePtyRemoveOutcomeWithHandle(req: PtyRemoveContractRequest): {
    id: number
    promise: Promise<unknown>
    cancel?: (msg?: string) => boolean | "stale"
  }
}

export const PTY_PRIVATE_TIMEOUT_MS = 3000

function token(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 8)
}

export function buildPtyUpdateReq(
  directory: string,
  ptyID: string,
  rows: number,
  cols: number,
): PtyUpdateContractRequest {
  const t = token()
  const opId = canonicalPtyUpdateOpId(ptyID, t)
  return {
    v: 1 as const,
    requestId: crypto.randomUUID(),
    opId,
    op: "pty/update" as const,
    idempotencyKey: opId,
    context: { directory, ptyID },
    payload: { size: { rows, cols } },
  }
}

export function buildPtyRemoveReq(directory: string, ptyID: string): PtyRemoveContractRequest {
  const t = token()
  const opId = canonicalPtyRemoveOpId(ptyID, t)
  return {
    v: 1 as const,
    requestId: crypto.randomUUID(),
    opId,
    op: "pty/remove" as const,
    idempotencyKey: opId,
    context: { directory, ptyID },
    payload: {},
  }
}

export type PtyAttempt =
  | { kind: "ok" }
  | { kind: "gone" }
  | { kind: "terminal"; code: string }
  | { kind: "fallback"; reason: string }

function parseUpdateResult(result: unknown, req: PtyUpdateContractRequest): PtyAttempt {
  const rec = result as { status?: unknown; accepted?: unknown; transportUnknown?: unknown } | null
  if (!rec || typeof rec !== "object") return { kind: "fallback", reason: "invalid" }
  if (rec.transportUnknown === true) return { kind: "fallback", reason: "transportUnknown" }
  if (rec.status === "ambiguous") return { kind: "fallback", reason: "ambiguous" }
  if (rec.status === "succeeded") {
    try {
      const out = validatePtyUpdateResult(result, req)
      if (out.status !== "succeeded" || out.accepted !== true) return { kind: "fallback", reason: "invalid" }
      return { kind: "ok" }
    } catch {
      return { kind: "fallback", reason: "invalid" }
    }
  }
  if (rec.status === "failed") {
    try {
      const out = validatePtyUpdateResult(result, req)
      if (out.status !== "failed") return { kind: "fallback", reason: "invalid" }
      if (out.failure.code === "pty.not_found" && out.failure.retryable === false) return { kind: "gone" }
      if (out.failure.code === "transport") return { kind: "fallback", reason: "transport" }
      if (out.failure.retryable === true) return { kind: "fallback", reason: out.failure.code }
      if (out.failure.retryable === false) return { kind: "terminal", code: out.failure.code }
      return { kind: "fallback", reason: "failed without retryable" }
    } catch {
      return { kind: "fallback", reason: "invalid" }
    }
  }
  return { kind: "fallback", reason: "invalid" }
}

function parseRemoveResult(result: unknown, req: PtyRemoveContractRequest): PtyAttempt {
  const rec = result as { status?: unknown; accepted?: unknown; transportUnknown?: unknown } | null
  if (!rec || typeof rec !== "object") return { kind: "fallback", reason: "invalid" }
  if (rec.transportUnknown === true) return { kind: "fallback", reason: "transportUnknown" }
  if (rec.status === "ambiguous") return { kind: "fallback", reason: "ambiguous" }
  if (rec.status === "succeeded") {
    try {
      const out = validatePtyRemoveResult(result, req)
      if (out.status !== "succeeded" || out.accepted !== true) return { kind: "fallback", reason: "invalid" }
      return { kind: "ok" }
    } catch {
      return { kind: "fallback", reason: "invalid" }
    }
  }
  if (rec.status === "failed") {
    try {
      const out = validatePtyRemoveResult(result, req)
      if (out.status !== "failed") return { kind: "fallback", reason: "invalid" }
      if (out.failure.code === "pty.not_found" && out.failure.retryable === false) return { kind: "gone" }
      if (out.failure.code === "transport") return { kind: "fallback", reason: "transport" }
      if (out.failure.retryable === true) return { kind: "fallback", reason: out.failure.code }
      if (out.failure.retryable === false) return { kind: "terminal", code: out.failure.code }
      return { kind: "fallback", reason: "failed without retryable" }
    } catch {
      return { kind: "fallback", reason: "invalid" }
    }
  }
  return { kind: "fallback", reason: "invalid" }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms)
    ;(timer as unknown as { unref?: () => void })?.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  }) as Promise<T>
}

async function attemptPrivate(
  connection: PtyPrivateConnection | null | undefined,
  req: PtyUpdateContractRequest | PtyRemoveContractRequest,
  ms: number,
  label: string,
): Promise<{
  attempt: PtyAttempt
  handle: { id: number; cancel?: (msg?: string) => boolean | "stale" } | null
  req: typeof req
}> {
  if (!connection) return { attempt: { kind: "fallback", reason: "unavailable" }, handle: null, req }
  try {
    if (!connection.isPrivateAvailable())
      return { attempt: { kind: "fallback", reason: "unavailable" }, handle: null, req }
  } catch {
    return { attempt: { kind: "fallback", reason: "unavailable" }, handle: null, req }
  }
  let handle: { id: number; promise: Promise<unknown>; cancel?: (msg?: string) => boolean | "stale" } | null = null
  try {
    handle =
      req.op === "pty/update"
        ? connection.privatePtyUpdateOutcomeWithHandle(req as PtyUpdateContractRequest)
        : connection.privatePtyRemoveOutcomeWithHandle(req as PtyRemoveContractRequest)
    const outcome = (await withTimeout(handle.promise, ms, label)) as
      | { kind: "valid"; result: unknown }
      | { kind: "invalid"; detail: string }
    if (outcome.kind === "invalid") return { attempt: { kind: "fallback", reason: "invalid" }, handle, req }
    const parsed =
      req.op === "pty/update"
        ? parseUpdateResult(outcome.result, req as PtyUpdateContractRequest)
        : parseRemoveResult(outcome.result, req as PtyRemoveContractRequest)
    return { attempt: parsed, handle, req }
  } catch (e) {
    if (isPrivatePtyValidationError(e)) return { attempt: { kind: "fallback", reason: "invalid" }, handle, req }
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes(`${label} timeout`) && handle) {
      try {
        handle.cancel?.(`${label} timeout opId=${req.opId}`)
      } catch {}
      return { attempt: { kind: "fallback", reason: "timeout" }, handle, req }
    }
    if (/unavailable|capability|disposed|closed/i.test(msg))
      return { attempt: { kind: "fallback", reason: "transport" }, handle, req }
    return { attempt: { kind: "fallback", reason: msg.slice(0, 120) }, handle, req }
  }
}

function isSdkPtyNotFound(error: unknown): boolean {
  const rec = (v: unknown): Record<string, unknown> | undefined =>
    v && typeof v === "object" ? (v as Record<string, unknown>) : undefined
  const obj = rec(error)
  if (!obj) return false
  const cause = rec(obj.cause)
  const body = rec(cause?.body)
  const data = rec(obj.data)
  const candidates = [obj, data, cause, body, rec(body?.data)]
  for (const c of candidates) {
    if (!c) continue
    if (c._tag === "PtyNotFoundError") return true
    if (typeof c._tag === "string" && (c._tag as string).includes("PtyNotFound")) return true
    if (typeof c._tag === "string" && (c._tag as string).includes("NotFound")) return true
    if ((c as { name?: unknown }).name === "PtyNotFoundError") return true
    if ((c as { name?: unknown }).name === "NotFoundError") return true
    if ((c as { status?: unknown }).status === 404) return true
    if ((c as { code?: unknown }).code === 404) return true
  }
  const msg = error instanceof Error ? error.message : String(error)
  if (/pty.*not[ _-]?found/i.test(msg)) return true
  return false
}

export type PtySdkClient = {
  pty: {
    update: (args: {
      directory: string
      ptyID: string
      size: { rows: number; cols: number }
    }) => Promise<{ data?: unknown; error?: unknown }>
    remove: (args: { directory: string; ptyID: string }) => Promise<{ data?: unknown; error?: unknown }>
  }
}

export type PtyUpdatePrivateFirstOutcome =
  | { kind: "ok"; via: "private" | "sdk"; gone?: boolean }
  | { kind: "terminal"; code: string }
  | { kind: "sdkError"; error: unknown }

export type PtyRemovePrivateFirstOutcome =
  | { kind: "ok"; via: "private" | "sdk"; gone?: boolean }
  | { kind: "terminal"; code: string }
  | { kind: "sdkError"; error: unknown }

// Shared private-first PTY resize: one private attempt (3 s exact-cancel)
// then at most one same `(directory,ptyID,size)` SDK fallback. No private
// retry. `pty.not_found` (private or SDK 404) is success-equivalent.
export async function updatePtyPrivateFirst(opts: {
  connection?: PtyPrivateConnection | null
  getClient: () => PtySdkClient
  directory: string
  ptyID: string
  rows: number
  cols: number
  timeoutMs?: number
}): Promise<PtyUpdatePrivateFirstOutcome> {
  const req = buildPtyUpdateReq(opts.directory, opts.ptyID, opts.rows, opts.cols)
  const ms = opts.timeoutMs ?? PTY_PRIVATE_TIMEOUT_MS
  const { attempt } = await attemptPrivate(opts.connection ?? null, req, ms, "private pty-update")
  if (attempt.kind === "ok") return { kind: "ok", via: "private" }
  if (attempt.kind === "gone") return { kind: "ok", via: "private", gone: true }
  if (attempt.kind === "terminal") return { kind: "terminal", code: attempt.code }
  const client = opts.getClient()
  const res = await client.pty.update({
    directory: opts.directory,
    ptyID: opts.ptyID,
    size: { rows: opts.rows, cols: opts.cols },
  })
  if (res.error) {
    if (isSdkPtyNotFound(res.error)) return { kind: "ok", via: "sdk", gone: true }
    return { kind: "sdkError", error: res.error }
  }
  return { kind: "ok", via: "sdk" }
}

// Shared private-first PTY remove: same once-only semantics with empty
// payload and same `(directory,ptyID)` SDK fallback.
export async function removePtyPrivateFirst(opts: {
  connection?: PtyPrivateConnection | null
  getClient: () => PtySdkClient
  directory: string
  ptyID: string
  timeoutMs?: number
}): Promise<PtyRemovePrivateFirstOutcome> {
  const req = buildPtyRemoveReq(opts.directory, opts.ptyID)
  const ms = opts.timeoutMs ?? PTY_PRIVATE_TIMEOUT_MS
  const { attempt } = await attemptPrivate(opts.connection ?? null, req, ms, "private pty-remove")
  if (attempt.kind === "ok") return { kind: "ok", via: "private" }
  if (attempt.kind === "gone") return { kind: "ok", via: "private", gone: true }
  if (attempt.kind === "terminal") return { kind: "terminal", code: attempt.code }
  const client = opts.getClient()
  const res = await client.pty.remove({ directory: opts.directory, ptyID: opts.ptyID })
  if (res.error) {
    if (isSdkPtyNotFound(res.error)) return { kind: "ok", via: "sdk", gone: true }
    return { kind: "sdkError", error: res.error }
  }
  return { kind: "ok", via: "sdk" }
}
