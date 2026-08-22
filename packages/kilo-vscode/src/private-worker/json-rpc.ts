/**
 * JSON-RPC 2.0 types and validation helpers for the private worker transport.
 * Minimal carrier: requests as commands, notifications as event envelopes.
 * R9/R11-R14 semantics are intentionally absent — this is the R1 scaffold only.
 */

export const JSONRPC_VERSION = "2.0" as const

export const ErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const

export type JsonRpcId = string | number

export interface JsonRpcRequest {
  jsonrpc: typeof JSONRPC_VERSION
  id: JsonRpcId
  method: string
  params?: unknown
}

export interface JsonRpcNotification {
  jsonrpc: typeof JSONRPC_VERSION
  method: string
  params?: unknown
}

export interface JsonRpcSuccess {
  jsonrpc: typeof JSONRPC_VERSION
  id: JsonRpcId | null
  result: unknown
}

export interface JsonRpcError {
  jsonrpc: typeof JSONRPC_VERSION
  id: JsonRpcId | null
  error: { code: number; message: string; data?: unknown }
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcSuccess | JsonRpcError

export interface InitializeParams {
  clientInfo?: { name: string; version: string }
  protocolVersion?: string
}

export interface InitializeResult {
  protocolVersion: string
  serverInfo: { name: string; version: string }
  capabilities: Record<string, unknown>
}

export function isInitializeParams(v: unknown): v is InitializeParams {
  if (typeof v !== "object" || v === null) return false
  return true
}

export function makeSuccess(id: JsonRpcId | null, result: unknown): JsonRpcSuccess {
  return { jsonrpc: JSONRPC_VERSION, id, result }
}

export function makeError(
  id: JsonRpcId | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcError {
  const err: JsonRpcError = { jsonrpc: JSONRPC_VERSION, id, error: { code, message } }
  if (data !== undefined) err.error.data = data
  return err
}

export function parseMessage(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}

export function validateRequest(obj: unknown):
  | { kind: "request"; id: JsonRpcId; method: string; params: unknown }
  | { kind: "notification"; method: string; params: unknown }
  | { kind: "invalid"; id: JsonRpcId | null; code: number; message: string } {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    return { kind: "invalid", id: null, code: ErrorCode.InvalidRequest, message: "Invalid Request" }
  }
  const o = obj as Record<string, unknown>
  if (o.jsonrpc !== JSONRPC_VERSION) {
    const id = extractId(o.id)
    return { kind: "invalid", id, code: ErrorCode.InvalidRequest, message: "Invalid Request: jsonrpc must be 2.0" }
  }
  if (typeof o.method !== "string") {
    const id = extractId(o.id)
    return { kind: "invalid", id, code: ErrorCode.InvalidRequest, message: "Invalid Request: method must be string" }
  }
  if ("id" in o) {
    const raw = o.id
    if (typeof raw !== "string" && typeof raw !== "number") {
      return { kind: "invalid", id: null, code: ErrorCode.InvalidRequest, message: "Invalid Request: id must be string or number" }
    }
    return { kind: "request", id: raw, method: o.method, params: o.params }
  }
  return { kind: "notification", method: o.method, params: o.params }
}

function extractId(v: unknown): JsonRpcId | null {
  if (typeof v === "string" || typeof v === "number") return v
  if (v === null) return null
  return null
}
