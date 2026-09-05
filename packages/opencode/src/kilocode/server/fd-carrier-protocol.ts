import { ErrorCode } from "@/private-worker/json-rpc"

export const FD_PROTOCOL_NAME = "kilo-private"
export const FD_PROTOCOL_MAJOR = 1
export const FD_PROTOCOL_MINOR = 0
export const FD_PROTOCOL_VERSION = "1.0"
export const FD_SERVER_NAME = "kilo"
export const FD_SERVER_VERSION = "7.4.11"
export const FD_CAPABILITIES = ["session/cancelQueued", "session/update", "session/fork", "session/create", "session/status", "session/get", "session/messages", "session/children", "remote/status", "experimental/session/list"] as const

export interface FdInitializeParams {
  protocol?: { name?: string; major?: number; minor?: number }
  protocolVersion?: string | { major?: number; minor?: number }
  clientInfo?: { name?: string; version?: string }
  capabilities?: unknown
}

export interface FdInitializeResult {
  protocol: { name: string; major: number; minor: number }
  protocolVersion: string
  serverInfo: { name: string; version: string }
  capabilities: string[]
}

export function parseMajor(v: unknown): number | undefined {
  if (typeof v === "string") {
    const parts = v.split(".")
    const n = Number(parts[0])
    if (!Number.isNaN(n)) return n
    return undefined
  }
  if (typeof v === "object" && v !== null) {
    const o = v as Record<string, unknown>
    if (typeof o.major === "number") return o.major
  }
  return undefined
}

export function validateProtocolVersion(params: unknown): void {
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    throw makeCarrierError(ErrorCode.InvalidParams, "Invalid initialize params")
  }
  const p = params as Record<string, unknown>
  const proto = p.protocol as Record<string, unknown> | undefined
  if (!proto || typeof proto !== "object" || Array.isArray(proto)) {
    throw makeCarrierError(ErrorCode.InvalidParams, "Missing protocol identity")
  }
  const name = proto.name
  if (name !== FD_PROTOCOL_NAME) {
    throw makeCarrierError(ErrorCode.InvalidParams, `Unsupported protocol name ${String(name)}, expected ${FD_PROTOCOL_NAME}`)
  }
  const major = proto.major
  if (typeof major !== "number" || major !== FD_PROTOCOL_MAJOR) {
    throw makeCarrierError(ErrorCode.InvalidParams, `Unsupported protocol major ${String(major)}, expected ${FD_PROTOCOL_MAJOR}`)
  }
}

export function buildInitializeResult(): FdInitializeResult {
  return {
    protocol: { name: FD_PROTOCOL_NAME, major: FD_PROTOCOL_MAJOR, minor: FD_PROTOCOL_MINOR },
    protocolVersion: FD_PROTOCOL_VERSION,
    serverInfo: { name: FD_SERVER_NAME, version: FD_SERVER_VERSION },
    capabilities: [...FD_CAPABILITIES],
  }
}

function makeCarrierError(code: number, message: string): Error & { code: number } {
  const e = new Error(message) as Error & { code: number }
  e.code = code
  return e
}
