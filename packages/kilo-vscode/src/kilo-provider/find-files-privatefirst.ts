import * as crypto from "crypto"
import { isAbsolute } from "path"
import {
  canonicalFindFilesOpId,
  isFindFilesValidationError,
  validateFindFilesResult,
  type FindFilesContractRequest,
  type FindFilesEntry,
} from "../services/cli-backend/serve-private-find-files-contract"

/**
 * Private-first `find/files` read for the `handleFileSearch` production
 * consumer.
 *
 * The private fd carrier reads the same `FileSystem.Service.find` source as
 * `GET /find/file` through the existing drain-control + `InstanceRef` lane
 * for the target directory. Success data is the locked safe projection
 * `{path,type}` only (relative POSIX, explicit `file|directory`); absolute
 * paths, URIs, sensitive names, contents, and raw filesystem metadata never
 * cross the private boundary. `directory`/`workspace` are routing identity
 * only; no new owner, no cache, no lifecycle change.
 *
 * Each logical query (`type:file` and `type:directory`, limit 50) runs one
 * private attempt first. Valid private `succeeded`+`accepted` (including
 * empty) is authoritative with zero SDK; validated terminal `failed`
 * (`retryable === false` except `transport`, such as
 * `validation.failed`/`scope_mismatch`/`internal`) closes fail-soft with zero
 * SDK; retryable fence plus unavailable/invalid/ambiguous/transport/closed/
 * timeout takes exactly one same-tuple SDK `client.find.files` fallback with
 * no retry. SDK failure or malformed SDK data returns `unavailable` for the
 * caller to fail soft (`[]` for that type).
 *
 * `compareFindFilesTypeParity`/`digestFindFilesSet` are intentionally not
 * wired here: with private-first there is at most one private result plus at
 * most one SDK result per type per search, so a comparator would need a third
 * request to add signal. They stay as pure diagnostic/test evidence only.
 */
export interface FindFilesPrivateConnection {
  isPrivateAvailable(): boolean
  privateFindFilesOutcomeWithHandle(req: FindFilesContractRequest): {
    id: number
    promise: Promise<unknown>
    cancel?: (msg?: string) => boolean | "stale"
  }
}

export const FIND_FILES_PRIVATE_TIMEOUT_MS = 3000
export const FIND_FILES_PRIVATE_LIMIT = 50

export function buildFindFilesIdentity(): { opId: string; idempotencyKey: string; requestId: string } {
  const token = crypto.randomUUID().replace(/-/g, "").slice(0, 8)
  const opId = canonicalFindFilesOpId(token)
  return { opId, idempotencyKey: opId, requestId: crypto.randomUUID() }
}

export function buildFindFilesReq(
  dir: string,
  query: string,
  type: "file" | "directory",
  limit = FIND_FILES_PRIVATE_LIMIT,
  workspace?: string,
): FindFilesContractRequest {
  const ids = buildFindFilesIdentity()
  return {
    v: 1 as const,
    requestId: ids.requestId,
    opId: ids.opId,
    op: "find/files" as const,
    idempotencyKey: ids.idempotencyKey,
    context: workspace === undefined ? { directory: dir } : { directory: dir, workspace },
    payload: { query, type, limit },
  }
}

export function isFindFilesPrivateRequestValid(query: unknown, dir: unknown, limit: unknown): boolean {
  if (typeof query !== "string" || query.length === 0 || query.length > 256) return false
  if (query.includes("\0")) return false
  if (typeof dir !== "string" || dir.length === 0 || !isAbsolute(dir)) return false
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 50) return false
  return true
}

export type FindFilesAttempt =
  | { kind: "ok"; files: FindFilesEntry[] }
  | { kind: "terminal"; code?: string }
  | { kind: "fallback"; reason: string }

export function parseFindFilesResult(result: unknown, req: FindFilesContractRequest): FindFilesAttempt {
  const rec = result as { status?: unknown; accepted?: unknown; transportUnknown?: unknown } | null
  if (!rec || typeof rec !== "object") return { kind: "fallback", reason: "invalid" }
  if (rec.transportUnknown === true) return { kind: "fallback", reason: "transportUnknown" }
  if (rec.status === "ambiguous") return { kind: "fallback", reason: "ambiguous" }
  if (rec.status === "succeeded") {
    try {
      const out = validateFindFilesResult(result, req)
      if (out.status !== "succeeded" || out.accepted !== true) return { kind: "fallback", reason: "invalid" }
      return { kind: "ok", files: out.data.files }
    } catch {
      return { kind: "fallback", reason: "invalid" }
    }
  }
  if (rec.status === "failed") {
    try {
      const out = validateFindFilesResult(result, req)
      if (out.status !== "failed") return { kind: "fallback", reason: "invalid" }
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

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`private find-files timeout after ${ms}ms`)), ms)
    ;(timer as unknown as { unref?: () => void })?.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  }) as Promise<T>
}

export async function attemptFindFilesPrivate(
  connection: FindFilesPrivateConnection | null | undefined,
  req: FindFilesContractRequest,
  ms = FIND_FILES_PRIVATE_TIMEOUT_MS,
): Promise<FindFilesAttempt> {
  if (!connection) return { kind: "fallback", reason: "unavailable" }
  try {
    if (!connection.isPrivateAvailable()) return { kind: "fallback", reason: "unavailable" }
  } catch {
    return { kind: "fallback", reason: "unavailable" }
  }
  let handle: { id: number; promise: Promise<unknown>; cancel?: (msg?: string) => boolean | "stale" } | null = null
  try {
    handle = connection.privateFindFilesOutcomeWithHandle(req)
    const outcome = (await withTimeout(handle.promise, ms)) as
      | { kind: "valid"; result: unknown }
      | { kind: "invalid"; detail: string }
    if (outcome.kind === "invalid") return { kind: "fallback", reason: "invalid" }
    return parseFindFilesResult(outcome.result, req)
  } catch (e) {
    if (isFindFilesValidationError(e)) return { kind: "fallback", reason: "invalid" }
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes("private find-files timeout") && handle) {
      try {
        handle.cancel?.(`private find-files timeout opId=${req.opId}`)
      } catch {}
      return { kind: "fallback", reason: "timeout" }
    }
    if (/unavailable|capability|disposed|closed/i.test(msg)) return { kind: "fallback", reason: "transport" }
    return { kind: "fallback", reason: msg.slice(0, 120) }
  }
}

type SdkClient = {
  find: {
    files: (
      args: { query: string; directory: string; workspace?: string; type: "file" | "directory"; limit: number },
      opts?: { throwOnError?: boolean },
    ) => Promise<{ data?: unknown }>
  }
}

export type FindFilesTypePrivateFirstOutcome =
  | { kind: "ok"; via: "private"; files: string[] }
  | { kind: "ok"; via: "sdk"; files: string[] }
  | { kind: "terminal"; code?: string }
  | { kind: "unavailable" }

function coerceSdkFiles(data: unknown): string[] | null {
  if (!Array.isArray(data)) return null
  for (const item of data) if (typeof item !== "string") return null
  return [...(data as string[])]
}

// Shared private-first find/files read for one logical type: valid private
// returns the projected paths with zero SDK; validated terminal closes with
// zero SDK; otherwise exactly one same-tuple SDK fallback with no retry; SDK
// failure or malformed SDK data returns `unavailable` for the caller to fail
// soft. Invalid request shape skips the private attempt and goes straight to
// the single SDK fallback so the user-visible tuple never changes.
export async function fetchFindFilesTypePrivateFirst(opts: {
  connection?: FindFilesPrivateConnection | null
  client: SdkClient | null | undefined
  directory: string
  query: string
  type: "file" | "directory"
  limit?: number
  workspace?: string
  timeoutMs?: number
}): Promise<FindFilesTypePrivateFirstOutcome> {
  const limit = opts.limit ?? FIND_FILES_PRIVATE_LIMIT
  const valid = isFindFilesPrivateRequestValid(opts.query, opts.directory, limit)
  if (valid) {
    const req = buildFindFilesReq(opts.directory, opts.query, opts.type, limit, opts.workspace)
    const attempt = await attemptFindFilesPrivate(opts.connection ?? null, req, opts.timeoutMs ?? 3000)
    if (attempt.kind === "ok") return { kind: "ok", via: "private", files: attempt.files.map((e) => e.path) }
    if (attempt.kind === "terminal") return { kind: "terminal", code: attempt.code }
  }
  const client = opts.client
  if (!client?.find?.files) return { kind: "unavailable" }
  try {
    const args =
      opts.workspace === undefined
        ? { query: opts.query, directory: opts.directory, type: opts.type, limit }
        : { query: opts.query, directory: opts.directory, workspace: opts.workspace, type: opts.type, limit }
    const res = await client.find.files(args, { throwOnError: true })
    const coerced = coerceSdkFiles(res.data)
    if (!coerced) return { kind: "unavailable" }
    return { kind: "ok", via: "sdk", files: coerced }
  } catch {
    return { kind: "unavailable" }
  }
}

function norm(p: string): string {
  return p.replaceAll("\\", "/")
}

export function digestFindFilesSet(paths: string[], type: "file" | "directory"): string {
  const uniq = [...new Set(paths.map(norm))].sort()
  const h = crypto.createHash("sha256")
  h.update(`find-files/membership\x00${type}\x00`, "utf8")
  for (const p of uniq) h.update(`${p}\x00`, "utf8")
  return h.digest("hex").slice(0, 16)
}

export interface FindFilesTypeParity {
  match: boolean
  sdkCount: number
  privateCount: number
  missingCount: number
  extraCount: number
  sdkDigest: string
  privateDigest: string
}

// Pure diagnostic only (never wired to production: private-first issues at
// most one private result plus at most one SDK result per type per search, so
// a comparator would need a third request to add signal). Compares only
// per-type `{path,type}` membership; order is ignored.
export function compareFindFilesTypeParity(
  sdkPaths: string[],
  privateEntries: FindFilesEntry[],
  type: "file" | "directory",
): FindFilesTypeParity {
  const sdk = [...new Set(sdkPaths.map(norm))]
  const priv = [...new Set(privateEntries.filter((e) => e.type === type).map((e) => norm(e.path)))]
  const sdkSet = new Set(sdk)
  const privSet = new Set(priv)
  let missing = 0
  for (const p of sdk) if (!privSet.has(p)) missing += 1
  let extra = 0
  for (const p of priv) if (!sdkSet.has(p)) extra += 1
  const sdkDigest = digestFindFilesSet(sdk, type)
  const privateDigest = digestFindFilesSet(priv, type)
  return {
    match: missing === 0 && extra === 0,
    sdkCount: sdk.length,
    privateCount: priv.length,
    missingCount: missing,
    extraCount: extra,
    sdkDigest,
    privateDigest,
  }
}
