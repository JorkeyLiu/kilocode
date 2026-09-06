import { isAbsolute, normalize, resolve } from "path"
import * as crypto from "crypto"
import type {
  FindFilesContractRequest,
  FindFilesEntry,
  FindFilesResult,
  FindFilesWireOutcome,
} from "../services/cli-backend/serve-private-find-files-contract"
import {
  canonicalFindFilesOpId,
  isFindFilesValidationError,
  makeFindFilesAmbiguous,
} from "../services/cli-backend/serve-private-find-files-contract"

// Detached SDK-first `find/files` parity observer (warn-only).
//
// SDK remains sole authority: the two public `client.find.files` calls
// (type=file, type=directory) execute and settle exactly as before. This
// module only observes bounded private `{path,type}` membership per type,
// ignoring order, open-tab merge, active-file boosts, frecency, freshness,
// and SDK error parity beyond a fixed warn-only category.
//
// Known residual: transport exact-cancel clears the pending JSON-RPC slot
// but does not abort the underlying FileSystem/ripgrep scan or release its
// server drain lease until source completion. No AbortSignal or
// source-cancellation plumbing is added here, and no source-abort is claimed.

export interface FindFilesParityConnection {
  isPrivateAvailable(): boolean
  privateFindFilesOutcomeWithHandle(req: FindFilesContractRequest): {
    id: number
    promise: Promise<FindFilesWireOutcome>
    cancel?: (msg?: string) => boolean | "stale"
  }
  tryCancelPrivatePending?(id: number, msg?: string): boolean
  invalidatePrivatePeerOnObserverTimeout?(reason: string): void
  peekPrivatePeerNextId?(): number | null
  onPrivateAvailable?(listener: () => void): () => void
  getPrivateEpoch?(): number | null
  addDeferredFindFilesObserver?(
    dir: string,
    workspace: string | undefined,
    query: string,
    type: string,
    limit: number | undefined,
    listener: () => void,
  ): () => void
}

export const FIND_FILES_PARITY_TIMEOUT_MS = 3000
export const FIND_FILES_PARITY_LIMIT = 50

export function buildFindFilesIdentity(): { opId: string; idempotencyKey: string; requestId: string } {
  const token = crypto.randomUUID().replace(/-/g, "").slice(0, 8)
  const opId = canonicalFindFilesOpId(token)
  const requestId = crypto.randomUUID()
  return { opId, idempotencyKey: opId, requestId }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`private parity timeout after ${ms}ms`)), ms)
    ;(timer as unknown as { unref?: () => void })?.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  }) as Promise<T>
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

export function isFindFilesParityRequestValid(query: unknown, dir: unknown, limit: unknown): boolean {
  if (typeof query !== "string" || query.length === 0 || query.length > 256) return false
  if (query.includes("\0")) return false
  if (typeof dir !== "string" || dir.length === 0 || !isAbsolute(dir)) return false
  if (limit !== undefined && (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 50))
    return false
  return true
}

const deferredFindFilesKeysByConnection = new WeakMap<object, Set<string>>()

export function deferredFindFilesKey(
  epoch: number | null,
  dir: string,
  workspace: string | undefined,
  query: string,
  type: string,
  limit: number | undefined,
): string {
  let canonical = dir
  try {
    canonical = normalize(resolve(dir))
  } catch {
    canonical = dir
  }
  const epochPart =
    epoch === null
      ? "none"
      : `e-${crypto.createHash("sha256").update(`find-files/epoch\x00${epoch}`, "utf8").digest("hex")}`
  const dirPart = `d-${crypto.createHash("sha256").update(`find-files/dir\x00${canonical}`, "utf8").digest("hex")}`
  const wsPart =
    workspace === undefined
      ? "none"
      : `w-${crypto.createHash("sha256").update(`find-files/workspace\x00${workspace}`, "utf8").digest("hex")}`
  const qPart = `q-${crypto.createHash("sha256").update(`find-files/query\x00${query}`, "utf8").digest("hex")}`
  const tPart = `t-${crypto.createHash("sha256").update(`find-files/type\x00${type}`, "utf8").digest("hex")}`
  const lPart =
    limit === undefined
      ? "none"
      : `l-${crypto.createHash("sha256").update(`find-files/limit\x00${limit}`, "utf8").digest("hex")}`
  return `find-files:${epochPart}:${dirPart}:${wsPart}:${qPart}:${tPart}:${lPart}`
}

function ambiguousFindFilesResult(req: FindFilesContractRequest): FindFilesResult {
  return makeFindFilesAmbiguous(req, true)
}

function cancelObserverTimeout(
  connection: FindFilesParityConnection,
  handle: { cancel?: (msg?: string) => boolean | "stale" } | null,
  exactId: number | null,
  timeoutMs: number,
  epochAtStart: number | null,
  type: "file" | "directory",
): void {
  const tryCancel = connection.tryCancelPrivatePending?.bind(connection) ?? null
  const invalidate = connection.invalidatePrivatePeerOnObserverTimeout?.bind(connection) ?? null
  let result: boolean | "stale" = false
  if (handle?.cancel) {
    try {
      result = handle.cancel("private parity timeout")
    } catch {
      console.warn("[Kilo FindFiles] handle.cancel failed:", { op: "find/files", type, cancelFailed: true })
      result = false
    }
  } else if (exactId !== null && tryCancel) {
    try {
      result = tryCancel(exactId, "private parity timeout")
    } catch {
      console.warn("[Kilo FindFiles] tryCancelPrivatePending failed:", { op: "find/files", type, cancelFailed: true })
      result = false
    }
  }
  if (result === "stale") {
    console.warn("[Kilo FindFiles] stale observer timeout skipped invalidation (epoch changed):", {
      op: "find/files",
      type,
      stale: true,
    })
    return
  }
  if (result === true) {
    console.warn(`[Kilo FindFiles] private parity timeout after ${timeoutMs}ms:`, {
      op: "find/files",
      type,
      timeoutMs,
    })
    return
  }
  const epochNow = connection.getPrivateEpoch?.() ?? null
  if (epochAtStart !== null && epochNow !== null && epochNow !== epochAtStart) {
    console.warn("[Kilo FindFiles] stale observer timeout skipped invalidation (epoch changed):", {
      op: "find/files",
      type,
      stale: true,
    })
    return
  }
  if (invalidate) {
    try {
      invalidate("find-files observer timeout")
    } catch {
      console.warn("[Kilo FindFiles] invalidatePrivatePeerOnObserverTimeout failed:", {
        op: "find/files",
        type,
        invalidateFailed: true,
      })
    }
  }
  console.warn(`[Kilo FindFiles] private parity timeout after ${timeoutMs}ms:`, {
    op: "find/files",
    type,
    timeoutMs,
  })
}

function reportFindFilesTypeValid(result: FindFilesResult, sdkPaths: string[], type: "file" | "directory"): void {
  if (result.status === "failed") {
    console.warn("[Kilo FindFiles] private failure parity:", {
      op: "find/files",
      type,
      failed: true,
      retryable: result.failure.retryable,
    })
    return
  }
  if (result.status === "ambiguous") {
    console.warn("[Kilo FindFiles] transport-unknown parity:", {
      op: "find/files",
      type,
      transportUnknown: true,
    })
    return
  }
  const parity = compareFindFilesTypeParity(sdkPaths, result.data.files, type)
  if (!parity.match) {
    console.warn("[Kilo FindFiles] parity divergence:", {
      op: "find/files",
      type,
      sdkCount: parity.sdkCount,
      privateCount: parity.privateCount,
      missingCount: parity.missingCount,
      extraCount: parity.extraCount,
      sdkDigest: parity.sdkDigest,
      privateDigest: parity.privateDigest,
    })
  } else if ((result as Record<string, unknown>).transportUnknown) {
    console.warn("[Kilo FindFiles] transport-unknown parity:", {
      op: "find/files",
      type,
      transportUnknown: true,
    })
  }
}

async function observeViaOutcome(
  connection: FindFilesParityConnection,
  handle: { id: number; promise: Promise<FindFilesWireOutcome>; cancel?: (msg?: string) => boolean | "stale" },
  req: FindFilesContractRequest,
  sdkPaths: string[],
  type: "file" | "directory",
  timeoutMs: number,
  epochAtStart: number | null,
): Promise<void> {
  let outcome: FindFilesWireOutcome | null = null
  try {
    outcome = await withTimeout(handle.promise, timeoutMs).catch((e: unknown) => {
      if (isFindFilesValidationError(e)) {
        return { kind: "invalid", detail: (e as { detail: string }).detail } as FindFilesWireOutcome
      }
      if (e instanceof Error && e.message.includes("private parity timeout"))
        cancelObserverTimeout(connection, handle, handle.id, timeoutMs, epochAtStart, type)
      return { kind: "valid", result: ambiguousFindFilesResult(req) } as FindFilesWireOutcome
    })
  } catch (e) {
    if (isFindFilesValidationError(e)) {
      console.warn("[Kilo FindFiles] validation divergence:", { op: "find/files", type, invalid: true })
      return
    }
    outcome = { kind: "valid", result: ambiguousFindFilesResult(req) }
  }
  if (!outcome) return
  if (outcome.kind === "invalid") {
    console.warn("[Kilo FindFiles] validation divergence:", { op: "find/files", type, invalid: true })
    return
  }
  reportFindFilesTypeValid(outcome.result, sdkPaths, type)
}

async function observeFindFilesTypeParity(
  connection: FindFilesParityConnection,
  sdkPaths: string[],
  dir: string,
  workspace: string | undefined,
  query: string,
  type: "file" | "directory",
  limit: number,
  opId: string,
  idempotencyKey: string,
  requestId: string,
  timeoutMs: number,
): Promise<void> {
  if (!connection.isPrivateAvailable()) {
    deferFindFilesTypeParityAfterNegotiation(
      connection,
      sdkPaths,
      dir,
      workspace,
      query,
      type,
      limit,
      opId,
      idempotencyKey,
      requestId,
      timeoutMs,
    )
    return
  }
  if (!isAbsolute(dir)) return
  try {
    const req: FindFilesContractRequest = {
      v: 1,
      requestId,
      opId,
      op: "find/files",
      idempotencyKey,
      context: workspace === undefined ? { directory: dir } : { directory: dir, workspace },
      payload: { query, type, limit },
    }
    const epochAtStart = connection.getPrivateEpoch?.() ?? null
    try {
      const factory = connection.privateFindFilesOutcomeWithHandle.bind(connection)
      const handle = factory(req)
      await observeViaOutcome(connection, handle, req, sdkPaths, type, timeoutMs, epochAtStart)
      return
    } catch (e) {
      if (isFindFilesValidationError(e)) {
        console.warn("[Kilo FindFiles] validation divergence:", { op: "find/files", type, invalid: true })
        return
      }
      throw e
    }
  } catch {
    console.warn("[Kilo FindFiles] private parity observation failed (fail-closed):", {
      op: "find/files",
      type,
      observationFailed: true,
    })
  }
}

function deferFindFilesTypeParityAfterNegotiation(
  connection: FindFilesParityConnection,
  sdkPaths: string[],
  dir: string,
  workspace: string | undefined,
  query: string,
  type: "file" | "directory",
  limit: number,
  opId: string,
  idempotencyKey: string,
  requestId: string,
  timeoutMs: number,
): void {
  const observe = (): void => {
    void observeFindFilesTypeParity(
      connection,
      sdkPaths,
      dir,
      workspace,
      query,
      type,
      limit,
      opId,
      idempotencyKey,
      requestId,
      timeoutMs,
    ).catch(() =>
      console.warn("[Kilo FindFiles] private parity observation failed (fail-closed):", {
        op: "find/files",
        type,
        observationFailed: true,
      }),
    )
  }
  const add = connection.addDeferredFindFilesObserver?.bind(connection) ?? null
  if (add) {
    let unsub: (() => void) | undefined
    try {
      unsub = add(dir, workspace, query, type, limit, observe)
    } catch {
      console.warn("[Kilo FindFiles] deferred parity subscribe failed (fail-closed):", {
        op: "find/files",
        type,
        subscribeFailed: true,
      })
      return
    }
    if (connection.isPrivateAvailable()) {
      try {
        unsub?.()
      } catch {
        console.warn("[Kilo FindFiles] deferred parity unsubscribe failed (fail-closed):", {
          op: "find/files",
          type,
          unsubscribeFailed: true,
        })
      }
      observe()
    }
    return
  }
  deferFindFilesFallback(
    connection,
    sdkPaths,
    dir,
    workspace,
    query,
    type,
    limit,
    opId,
    idempotencyKey,
    requestId,
    timeoutMs,
    observe,
  )
}

function deferFindFilesFallback(
  connection: FindFilesParityConnection,
  sdkPaths: string[],
  dir: string,
  workspace: string | undefined,
  query: string,
  type: "file" | "directory",
  limit: number,
  opId: string,
  idempotencyKey: string,
  requestId: string,
  timeoutMs: number,
  observe: () => void,
): void {
  void sdkPaths
  void opId
  void idempotencyKey
  void requestId
  void timeoutMs
  const epochAtDefer = connection.getPrivateEpoch?.() ?? null
  const key = deferredFindFilesKey(epochAtDefer, dir, workspace, query, type, limit)
  let keys = deferredFindFilesKeysByConnection.get(connection)
  if (!keys) {
    keys = new Set<string>()
    deferredFindFilesKeysByConnection.set(connection, keys)
  }
  const seen: Set<string> = keys
  if (seen.has(key)) return
  seen.add(key)
  const sub = connection.onPrivateAvailable?.bind(connection) ?? null
  if (!sub) {
    seen.delete(key)
    return
  }
  try {
    const unsub = sub(() => {
      seen.delete(key)
      try {
        unsub()
      } catch {
        console.warn("[Kilo FindFiles] deferred parity unsubscribe failed (fail-closed):", {
          op: "find/files",
          type,
          unsubscribeFailed: true,
        })
      }
      fireDeferredFindFiles(connection, epochAtDefer, observe)
    })
    if (connection.isPrivateAvailable()) {
      seen.delete(key)
      try {
        unsub()
      } catch {
        console.warn("[Kilo FindFiles] deferred parity unsubscribe failed (fail-closed):", {
          op: "find/files",
          type,
          unsubscribeFailed: true,
        })
      }
      fireDeferredFindFiles(connection, epochAtDefer, observe)
    }
  } catch {
    seen.delete(key)
    console.warn("[Kilo FindFiles] deferred parity subscribe failed (fail-closed):", {
      op: "find/files",
      type,
      subscribeFailed: true,
    })
  }
}

function fireDeferredFindFiles(
  connection: FindFilesParityConnection,
  epochAtDefer: number | null,
  observe: () => void,
): void {
  const now = connection.getPrivateEpoch?.() ?? null
  if (epochAtDefer !== null && now !== epochAtDefer) {
    console.warn("[Kilo FindFiles] stale deferred parity skipped (epoch changed)")
    return
  }
  observe()
}

function launchFindFilesTypeParity(
  connection: FindFilesParityConnection,
  sdkPaths: string[],
  dir: string,
  workspace: string | undefined,
  query: string,
  type: "file" | "directory",
  limit: number,
  opId: string,
  idempotencyKey: string,
  requestId: string,
  timeoutMs: number,
): void {
  try {
    const pending = observeFindFilesTypeParity(
      connection,
      sdkPaths,
      dir,
      workspace,
      query,
      type,
      limit,
      opId,
      idempotencyKey,
      requestId,
      timeoutMs,
    )
    void pending.catch(() =>
      console.warn("[Kilo FindFiles] private parity observation failed (fail-closed):", {
        op: "find/files",
        type,
        observationFailed: true,
      }),
    )
  } catch {
    console.warn("[Kilo FindFiles] private parity observation failed (fail-closed):", {
      op: "find/files",
      type,
      observationFailed: true,
    })
  }
}

/**
 * Detached SDK-first `find/files` parity observer.
 *
 * Call with the settled SDK membership per type (`null` on SDK rejection or
 * otherwise unknown membership; fulfilled `[]` remains valid empty
 * membership). The SDK arrays stay authoritative: this never mutates search
 * results, merge output, requestId handling, cache, or error behavior, and
 * never retries/replays the SDK. It returns synchronously (non-blocking);
 * the private per-type observations run detached with the default bounded
 * timeout, each with its own request/correlation/timeout/cancel/deferred
 * key. A `null` SDK entry skips that type entirely (no private request, no
 * membership comparison, no divergence warning). Invalid private wire
 * bypasses the comparator and only logs a diagnostic. Only bounded private
 * `{path,type}` membership per type is compared (order ignored); open-tab
 * merge, active-file boosts, frecency, freshness, and SDK error parity
 * beyond the fixed warn-only category are never compared.
 */
export function observeFindFilesParityDetached(
  connection: FindFilesParityConnection,
  sdk: { files: string[] | null; directories: string[] | null },
  dir: string,
  query: string,
  workspace?: string,
  timeoutMs = FIND_FILES_PARITY_TIMEOUT_MS,
  limit = FIND_FILES_PARITY_LIMIT,
): void {
  if (!connection) return
  if (!sdk) return
  if (sdk.files !== null && !Array.isArray(sdk.files)) return
  if (sdk.directories !== null && !Array.isArray(sdk.directories)) return
  if (!isFindFilesParityRequestValid(query, dir, limit)) return
  if (workspace !== undefined && (typeof workspace !== "string" || workspace.length === 0)) return
  for (const type of ["file", "directory"] as const) {
    const settled = type === "file" ? sdk.files : sdk.directories
    if (settled === null) continue
    let opId: string
    let idempotencyKey: string
    let requestId: string
    try {
      const ident = buildFindFilesIdentity()
      opId = ident.opId
      idempotencyKey = ident.idempotencyKey
      requestId = ident.requestId
    } catch {
      console.warn("[Kilo FindFiles] private parity observation failed (fail-closed):", {
        op: "find/files",
        type,
        observationFailed: true,
      })
      continue
    }
    const sdkPaths = [...settled]
    launchFindFilesTypeParity(
      connection,
      sdkPaths,
      dir,
      workspace,
      query,
      type,
      limit,
      opId,
      idempotencyKey,
      requestId,
      timeoutMs,
    )
  }
}

function settledState(r: PromiseSettledResult<{ data: string[] }>): string[] | null {
  if (r.status === "fulfilled" && Array.isArray(r.value?.data)) return [...r.value.data]
  return null
}

/**
 * Promise-based detached launcher for the file-search consumer.
 *
 * Call immediately after the two SDK `client.find.files` requests are set
 * up, without awaiting. SDK promises settle exactly as before; this only
 * attaches a detached `allSettled` continuation that forwards settled
 * membership to {@link observeFindFilesParityDetached} (`null` per rejected
 * type, so rejected types skip comparison without divergence). Never throws,
 * never blocks the caller, and never adds a third request or AbortSignal.
 */
export function observeFindFilesParityFromSdkPromises(
  connection: FindFilesParityConnection | null | undefined,
  filePromise: Promise<{ data: string[] }>,
  dirPromise: Promise<{ data: string[] }>,
  dir: string,
  query: string,
  workspace?: string,
  timeoutMs = FIND_FILES_PARITY_TIMEOUT_MS,
  limit = FIND_FILES_PARITY_LIMIT,
): void {
  if (!connection) return
  if (!filePromise || !dirPromise) return
  if (!isFindFilesParityRequestValid(query, dir, limit)) return
  try {
    void Promise.allSettled([filePromise, dirPromise]).then(([fileRes, dirRes]) => {
      try {
        observeFindFilesParityDetached(
          connection,
          { files: settledState(fileRes), directories: settledState(dirRes) },
          dir,
          query,
          workspace,
          timeoutMs,
          limit,
        )
      } catch {
        console.warn("[Kilo FindFiles] private parity observation failed (fail-closed):", {
          op: "find/files",
          observationFailed: true,
        })
      }
    })
  } catch {
    console.warn("[Kilo FindFiles] private parity observation failed (fail-closed):", {
      op: "find/files",
      observationFailed: true,
    })
  }
}
