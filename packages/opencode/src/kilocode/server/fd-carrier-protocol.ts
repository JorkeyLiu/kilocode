import { ErrorCode } from "@/private-worker/json-rpc"

export const FD_PROTOCOL_NAME = "kilo-private"
export const FD_PROTOCOL_MAJOR = 1
export const FD_PROTOCOL_MINOR = 0
export const FD_PROTOCOL_VERSION = "1.0"
export const FD_SERVER_NAME = "kilo"
export const FD_SERVER_VERSION = "7.4.11"
export const FD_CAPABILITIES = [
  "session/cancelQueued",
  "session/update",
  "session/fork",
  "session/create",
  "session/delete",
  "session/revert",
  "session/unrevert",
  "session/abort",
  "question/reply",
  "question/reject",
  "permission/save-always-rules",
  "permission/reply",
  "session/status",
  "session/get",
  "session/messages",
  "session/children",
  "remote/status",
  "experimental/session/list",
  "path/get",
  "command/list",
  "config/warnings",
  "project/current",
  "find/files",
  "agent/requirements",
  "session/model-usage",
  "session/prompt",
  "session/command",
  "config/convergence/acquire",
  "config/convergence/resolve",
  "config/convergence/observe",
] as const

export const FD_REVERSE_CAPABILITY_MAX_LENGTH = 128
export const FD_REVERSE_CAPABILITIES_MAX_COUNT = 64

/**
 * Reverse capabilities offered by the client on the initialize request
 * wire field `reverseCapabilities`: the set of CLI->host methods the
 * extension can receive. Distinct from the legacy `capabilities` request
 * field (server-method list, ignored by the CLI) and from the
 * server-provided capabilities in `FdInitializeResult`. Unknown entries
 * are stored forward-compatible and do not imply CLI use.
 */
export type ReverseCapabilities = readonly string[]

export function isReservedReverseCapability(name: string): boolean {
  if (name === "initialize") return true
  if (name === "$/cancelRequest") return true
  if (name.startsWith("$/")) return true
  return false
}

export interface FdInitializeParams {
  protocol?: { name?: string; major?: number; minor?: number }
  protocolVersion?: string | { major?: number; minor?: number }
  clientInfo?: { name?: string; version?: string }
  /** Legacy request field: server-method list, ignored by the CLI. */
  capabilities?: unknown
  /** Reverse offer: CLI->host methods the extension can receive. */
  reverseCapabilities?: unknown
}

export interface FdInitializeResult {
  protocol: { name: string; major: number; minor: number }
  protocolVersion: string
  serverInfo: { name: string; version: string }
  /** Server-provided capabilities (CLI methods the client may call). */
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
    throw makeCarrierError(
      ErrorCode.InvalidParams,
      `Unsupported protocol name ${String(name)}, expected ${FD_PROTOCOL_NAME}`,
    )
  }
  const major = proto.major
  if (typeof major !== "number" || major !== FD_PROTOCOL_MAJOR) {
    throw makeCarrierError(
      ErrorCode.InvalidParams,
      `Unsupported protocol major ${String(major)}, expected ${FD_PROTOCOL_MAJOR}`,
    )
  }
}

function normalizeReverseCapabilities(params: Record<string, unknown>): ReverseCapabilities {
  const raw = params.reverseCapabilities
  // Missing offer means an old client with no reverse methods.
  if (raw === undefined) return []
  if (!Array.isArray(raw))
    throw makeCarrierError(ErrorCode.InvalidParams, "reverseCapabilities must be array when present")
  if (raw.length > FD_REVERSE_CAPABILITIES_MAX_COUNT)
    throw makeCarrierError(ErrorCode.InvalidParams, "reverseCapabilities too many entries")
  const seen = new Set<string>()
  for (const entry of raw) {
    if (typeof entry !== "string" || entry.length === 0)
      throw makeCarrierError(ErrorCode.InvalidParams, "reverseCapabilities entries must be non-empty strings")
    if (entry.length > FD_REVERSE_CAPABILITY_MAX_LENGTH)
      throw makeCarrierError(ErrorCode.InvalidParams, "reverseCapabilities entry too long")
    if (entry.includes("\0")) throw makeCarrierError(ErrorCode.InvalidParams, "reverseCapabilities entry invalid")
    if (isReservedReverseCapability(entry))
      throw makeCarrierError(ErrorCode.InvalidParams, "reverseCapabilities entry reserved")
    if (seen.has(entry)) throw makeCarrierError(ErrorCode.InvalidParams, "reverseCapabilities entries must be unique")
    seen.add(entry)
  }
  // Unknown non-reserved entries are kept forward-compatible; storage does
  // not imply use.
  return Object.freeze([...seen])
}

/**
 * One-shot initialize validation: protocol identity plus normalized
 * reverse offer. Handlers must use this single call instead of parsing the
 * offer a second time. The legacy `capabilities` request field is ignored.
 *
 * Protocol stays 1.0: `reverseCapabilities` is an optional additive field.
 * Old CLIs ignore the unknown field and old extensions omit it (empty).
 * Mixed-version fails closed: new CLI + old extension negotiates empty so
 * no reverse call is ever attempted; new extension + old CLI produces no
 * reverse calls because the old CLI has no registry/domain caller.
 */
export function validateInitialize(params: unknown): { reverseCapabilities: ReverseCapabilities } {
  validateProtocolVersion(params)
  const p = params as Record<string, unknown>
  return { reverseCapabilities: normalizeReverseCapabilities(p) }
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
