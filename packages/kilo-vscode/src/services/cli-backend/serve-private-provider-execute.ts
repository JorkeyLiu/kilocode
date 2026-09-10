import { ErrorCode } from "../../private-worker/json-rpc"
import {
  execute,
  CanonicalExecuteError,
  type CanonicalExecuteInput,
  type CanonicalHostDeps,
  type CanonicalSuccess,
} from "../../canonical-provider/canonical-executor"
import { type CanonicalProviderPayload } from "../../config/types"

export const PROVIDER_EXECUTE_METHOD = "provider/execute" as const

export interface ProviderExecuteParams {
  readonly providerId: string
  readonly modelId: string
  readonly record: CanonicalProviderPayload
  readonly prompt: string
}

export type ProviderExecuteResult = CanonicalSuccess

const ALLOWED_KEYS = new Set(["providerId", "modelId", "record", "prompt"])

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

function throwInvalid(message: string): never {
  const err = new Error(message) as Error & { code?: number }
  err.code = ErrorCode.InvalidParams
  throw err
}

function throwWithData(code: number, message: string, data?: unknown): never {
  const err = new Error(message) as Error & { code?: number; data?: unknown }
  err.code = code
  if (data !== undefined) (err as unknown as { data: unknown }).data = data
  throw err
}

export function validateProviderExecuteParams(raw: unknown): ProviderExecuteParams {
  if (!isRecord(raw)) throwInvalid("Invalid params: request must be object")
  for (const key of Object.keys(raw as Record<string, unknown>)) {
    if (!ALLOWED_KEYS.has(key)) throwInvalid(`Invalid params: unexpected field ${key}`)
  }
  const providerId = (raw as Record<string, unknown>).providerId
  const modelId = (raw as Record<string, unknown>).modelId
  const record = (raw as Record<string, unknown>).record
  const prompt = (raw as Record<string, unknown>).prompt

  if (typeof providerId !== "string" || providerId.length === 0) throwInvalid("Invalid params: providerId must be non-empty string")
  if (providerId.includes("\0")) throwInvalid("Invalid params: providerId invalid")
  if (typeof modelId !== "string" || modelId.length === 0) throwInvalid("Invalid params: modelId must be non-empty string")
  if (modelId.includes("\0")) throwInvalid("Invalid params: modelId invalid")
  if (typeof prompt !== "string") throwInvalid("Invalid params: prompt must be string")
  if (prompt.includes("\0")) throwInvalid("Invalid params: prompt invalid")
  if (!isRecord(record)) throwInvalid("Invalid params: record must be object")
  // Do not deep-validate record here beyond shape presence; let executor handle canonical codes.
  // But we ensure it is at least an object with no prototype pollution.
  if (
    Object.getPrototypeOf(raw as object) !== Object.prototype ||
    Object.getPrototypeOf(record as object) !== Object.prototype ||
    Object.prototype.hasOwnProperty.call(raw as Record<string, unknown>, "__proto__") ||
    Object.prototype.hasOwnProperty.call(record as Record<string, unknown>, "__proto__") ||
    Object.prototype.hasOwnProperty.call(raw as Record<string, unknown>, "constructor") ||
    Object.prototype.hasOwnProperty.call(record as Record<string, unknown>, "constructor")
  ) {
    // Still treat as invalid params without leaking.
    throwInvalid("Invalid params: record invalid")
  }
  return { providerId, modelId, record: record as CanonicalProviderPayload, prompt }
}

export function isProviderExecuteAvailable(): boolean {
  // Execution dependencies are the canonical executor and llm route layers.
  // If the import succeeded, they are installed. Fail closed if not.
  try {
    return typeof execute === "function"
  } catch {
    return false
  }
}

export type ProviderExecuteDeps = CanonicalHostDeps

const INVALID_PARAM_CODES = new Set([
  "invalid-record",
  "invalid-endpoint",
  "unknown-protocol",
  "unknown-model",
  "missing-credential-ref",
  "invalid-credential-ref",
])

export async function handleProviderExecute(
  raw: unknown,
  deps: ProviderExecuteDeps,
  signal: AbortSignal,
): Promise<ProviderExecuteResult> {
  if (signal.aborted) {
    throwWithData(ErrorCode.InternalError, "Request cancelled", { code: "aborted" })
  }
  const params = validateProviderExecuteParams(raw)
  const input: CanonicalExecuteInput = {
    providerId: params.providerId,
    modelId: params.modelId,
    record: params.record,
    prompt: params.prompt,
  }
  try {
    const result = await execute(input, deps, signal)
    return result
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throwWithData(ErrorCode.InternalError, "Request cancelled", { code: "aborted" })
    }
    if (err instanceof CanonicalExecuteError) {
      const code = err.code
      const message = err.message
      // Map validation-like canonical codes to InvalidParams, others to InternalError.
      if (INVALID_PARAM_CODES.has(code)) {
        throwWithData(ErrorCode.InvalidParams, message, { code })
      }
      // missing-secret and provider are internal failures — preserve code in data.
      throwWithData(ErrorCode.InternalError, message, { code })
    }
    throw err
  }
}
