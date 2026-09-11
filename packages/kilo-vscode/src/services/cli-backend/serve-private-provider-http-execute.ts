import { ErrorCode } from "../../private-worker/json-rpc"
import { executeHttp, CanonicalHttpExecuteError, type CanonicalHttpExecuteInput, type CanonicalHttpDeps } from "../../canonical-provider/canonical-http-executor"
import { PROVIDER_HTTP_EXECUTE_METHOD as SHARED_METHOD, ProviderHttpExecuteWire } from "@opencode-ai/core/kilocode/provider-http-execute"
import type { RequestContext } from "../../private-worker/peer"

export const PROVIDER_HTTP_EXECUTE_METHOD = SHARED_METHOD

export type ProviderHttpExecuteParams = CanonicalHttpExecuteInput

export function validateProviderHttpExecuteParams(raw: unknown): ProviderHttpExecuteParams {
  let validated
  try {
    validated = ProviderHttpExecuteWire.validateRequest(raw)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    const err = new Error(message) as Error & { code?: number }
    err.code = ErrorCode.InvalidParams
    throw err
  }
  return {
    providerId: validated.providerId,
    modelId: validated.modelId,
    record: validated.record,
    body: validated.body,
    ...(validated.headers !== undefined ? { headers: validated.headers } : {}),
  }
}

export function isProviderHttpExecuteAvailable(): boolean {
  try {
    return typeof executeHttp === "function"
  } catch {
    return false
  }
}

export type ProviderHttpExecuteDeps = CanonicalHttpDeps

const INVALID_PARAM_CODES = new Set([
  "invalid-record",
  "invalid-endpoint",
  "unknown-protocol",
  "unknown-model",
  "missing-credential-ref",
  "invalid-credential-ref",
])

export async function handleProviderHttpExecute(
  raw: unknown,
  deps: ProviderHttpExecuteDeps,
  ctx: RequestContext,
): Promise<import("@opencode-ai/core/kilocode/provider-http-execute").ProviderHttpExecuteResult> {
  if (ctx.signal.aborted) {
    const err = new Error("Request cancelled") as Error & { code?: number; data?: unknown }
    err.code = ErrorCode.InternalError
    ;(err as unknown as { data: unknown }).data = { code: "aborted" }
    throw err
  }
  const params = validateProviderHttpExecuteParams(raw)
  const input: CanonicalHttpExecuteInput = {
    providerId: params.providerId,
    modelId: params.modelId,
    record: params.record,
    body: params.body,
    ...(params.headers !== undefined ? { headers: params.headers } : {}),
  }
  try {
    const result = await executeHttp(input, deps, ctx.signal, ctx.emit)
    return result
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      const e = new Error("Request cancelled") as Error & { code?: number; data?: unknown }
      e.code = ErrorCode.InternalError
      ;(e as unknown as { data: unknown }).data = { code: "aborted" }
      throw e
    }
    if (err instanceof CanonicalHttpExecuteError) {
      const code = err.code
      const message = err.message
      const e = new Error(message) as Error & { code?: number; data?: unknown }
      if (INVALID_PARAM_CODES.has(code)) e.code = ErrorCode.InvalidParams
      else e.code = ErrorCode.InternalError
      ;(e as unknown as { data: unknown }).data = { code }
      throw e
    }
    throw err
  }
}
