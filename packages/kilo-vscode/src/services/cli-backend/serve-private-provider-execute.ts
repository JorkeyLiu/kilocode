import { ErrorCode } from "../../private-worker/json-rpc"
import {
  execute,
  CanonicalExecuteError,
  type CanonicalExecuteInput,
  type CanonicalHostDeps,
  type CanonicalSuccess,
} from "../../canonical-provider/canonical-executor"
import {
  PROVIDER_EXECUTE_METHOD as SHARED_METHOD,
  ProviderExecuteWire,
  type ProviderExecuteRequest,
} from "@opencode-ai/core/kilocode/provider-execute"

export const PROVIDER_EXECUTE_METHOD = SHARED_METHOD

export interface ProviderExecuteParams {
  readonly providerId: string
  readonly modelId: string
  readonly record: unknown
  readonly prompt: string
}

export type ProviderExecuteResult = CanonicalSuccess

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
  // Delegate to the shared wire validator so the cross-process request shape
  // is defined once in `@opencode-ai/core/kilocode/provider-execute`.
  // The host keeps InvalidParams mapping and does not expand the full
  // CanonicalProviderPayload AST here; executor handles canonical codes.
  // No cast to a proven CanonicalProviderPayload — `record` stays opaque
  // until `canonical-executor` fully validates it.
  let validated: ProviderExecuteRequest
  try {
    validated = ProviderExecuteWire.validateRequest(raw)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    throwInvalid(message)
  }
  return {
    providerId: validated.providerId,
    modelId: validated.modelId,
    record: validated.record,
    prompt: validated.prompt,
  }
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
