import { createHash } from "node:crypto"
import { isAbsolute } from "node:path"
import { ErrorCode } from "@/private-worker/json-rpc"
import { isE2EFixtureEnabled } from "@/kilocode/config/e2e-provider"
import { canonicalDirectory } from "@/kilocode/session/canonical-directory"
import * as SandboxInheritance from "@/kilocode/sandbox/inheritance"
import { SandboxStore } from "@/kilocode/sandbox/store"

function shapeValid(token: string): boolean {
  return /^si-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)
}

export async function handleE2ESandboxTokenIssue(params: unknown): Promise<unknown> {
  if (!isE2EFixtureEnabled()) {
    const err = new Error("e2eSandboxTokenIssue requires KILO_E2E_FIXTURE") as Error & { code: number }
    err.code = ErrorCode.InvalidRequest
    throw err
  }
  const p = params as Record<string, unknown>
  if (p.v !== 1) {
    const err = new Error("v must be 1") as Error & { code: number }
    err.code = ErrorCode.InvalidParams
    throw err
  }
  if (typeof p.requestId !== "string" || !p.requestId) {
    const err = new Error("requestId must be non-empty string") as Error & { code: number }
    err.code = ErrorCode.InvalidParams
    throw err
  }
  if (typeof p.opId !== "string" || !p.opId) {
    const err = new Error("opId must be non-empty string") as Error & { code: number }
    err.code = ErrorCode.InvalidParams
    throw err
  }
  if (p.op !== "session/e2eSandboxTokenIssue") {
    const err = new Error("op must be session/e2eSandboxTokenIssue") as Error & { code: number }
    err.code = ErrorCode.InvalidParams
    throw err
  }
  if (typeof p.idempotencyKey !== "string" || !p.idempotencyKey) {
    const err = new Error("idempotencyKey must be non-empty string") as Error & { code: number }
    err.code = ErrorCode.InvalidParams
    throw err
  }
  const ctx = p.context as Record<string, unknown> | undefined
  if (!ctx || typeof ctx.directory !== "string" || !isAbsolute(ctx.directory as string)) {
    const err = new Error("context.directory must be absolute path") as Error & { code: number }
    err.code = ErrorCode.InvalidParams
    throw err
  }
  const dir = canonicalDirectory(ctx.directory as string)
  const payload = p.payload as Record<string, unknown> | undefined
  if (!payload || typeof payload.sourceSessionId !== "string" || !payload.sourceSessionId.startsWith("ses")) {
    const err = new Error("payload.sourceSessionId must be ses*") as Error & { code: number }
    err.code = ErrorCode.InvalidParams
    throw err
  }
  if (typeof payload.sourceDirectory !== "string" || !isAbsolute(payload.sourceDirectory as string)) {
    const err = new Error("payload.sourceDirectory must be absolute path") as Error & { code: number }
    err.code = ErrorCode.InvalidParams
    throw err
  }
  const sourceDir = canonicalDirectory(payload.sourceDirectory as string)
  const countRaw = payload.count as unknown
  const count = countRaw === undefined ? 2 : (countRaw as number)
  if (typeof count !== "number" || !Number.isInteger(count) || count < 2 || count > 10) {
    const err = new Error("payload.count must be integer 2..10") as Error & { code: number }
    err.code = ErrorCode.InvalidParams
    throw err
  }
  const token = SandboxInheritance.issue({ sessionID: payload.sourceSessionId as unknown as never, directory: sourceDir, count })
  const hash = createHash("sha256").update(token).digest("hex")
  return {
    v: 1,
    requestId: p.requestId,
    opId: p.opId,
    op: "session/e2eSandboxTokenIssue",
    idempotencyKey: p.idempotencyKey,
    status: "succeeded" as const,
    outcome: { type: "succeeded" as const, time: Date.now() },
    accepted: true as const,
    data: {
      token,
      hash,
      sourceSessionId: payload.sourceSessionId,
      sourceDirectory: sourceDir,
      count,
      directory: dir,
    },
  }
}

export async function handleE2ESandboxSet(params: unknown): Promise<unknown> {
  if (!isE2EFixtureEnabled()) {
    const err = new Error("e2eSandboxSet requires KILO_E2E_FIXTURE") as Error & { code: number }
    err.code = ErrorCode.InvalidRequest
    throw err
  }
  const p = params as Record<string, unknown>
  if (p.v !== 1) {
    const err = new Error("v must be 1") as Error & { code: number }
    err.code = ErrorCode.InvalidParams
    throw err
  }
  if (typeof p.requestId !== "string" || !p.requestId) {
    const err = new Error("requestId must be non-empty string") as Error & { code: number }
    err.code = ErrorCode.InvalidParams
    throw err
  }
  if (typeof p.opId !== "string" || !p.opId) {
    const err = new Error("opId must be non-empty string") as Error & { code: number }
    err.code = ErrorCode.InvalidParams
    throw err
  }
  if (p.op !== "session/e2eSandboxSet") {
    const err = new Error("op must be session/e2eSandboxSet") as Error & { code: number }
    err.code = ErrorCode.InvalidParams
    throw err
  }
  if (typeof p.idempotencyKey !== "string" || !p.idempotencyKey) {
    const err = new Error("idempotencyKey must be non-empty string") as Error & { code: number }
    err.code = ErrorCode.InvalidParams
    throw err
  }
  const ctx = p.context as Record<string, unknown> | undefined
  if (!ctx || typeof ctx.directory !== "string" || !isAbsolute(ctx.directory as string)) {
    const err = new Error("context.directory must be absolute path") as Error & { code: number }
    err.code = ErrorCode.InvalidParams
    throw err
  }
  const dir = canonicalDirectory(ctx.directory as string)
  const payload = p.payload as Record<string, unknown> | undefined
  if (!payload || typeof payload.sessionId !== "string" || !payload.sessionId.startsWith("ses")) {
    const err = new Error("payload.sessionId must be ses*") as Error & { code: number }
    err.code = ErrorCode.InvalidParams
    throw err
  }
  const sessionId = payload.sessionId as string
  const snapshot = {
    enabled: true,
    mode: "deny" as const,
    allowedHosts: [] as string[],
    writablePaths: [] as string[],
    version: 0,
  }
  await SandboxStore.write(dir, sessionId as unknown as never, snapshot)
  return {
    v: 1,
    requestId: p.requestId,
    opId: p.opId,
    op: "session/e2eSandboxSet",
    idempotencyKey: p.idempotencyKey,
    status: "succeeded" as const,
    outcome: { type: "succeeded" as const, time: Date.now() },
    accepted: true as const,
    data: { sessionId, directory: dir, snapshot },
  }
}

export async function handleE2ESandboxGrantRead(params: unknown): Promise<unknown> {
  if (!isE2EFixtureEnabled()) {
    const err = new Error("e2eSandboxGrantRead requires KILO_E2E_FIXTURE") as Error & { code: number }
    err.code = ErrorCode.InvalidRequest
    throw err
  }
  const p = params as Record<string, unknown>
  if (p.v !== 1) {
    const err = new Error("v must be 1") as Error & { code: number }
    err.code = ErrorCode.InvalidParams
    throw err
  }
  if (typeof p.requestId !== "string" || !p.requestId) {
    const err = new Error("requestId must be non-empty string") as Error & { code: number }
    err.code = ErrorCode.InvalidParams
    throw err
  }
  if (typeof p.opId !== "string" || !p.opId) {
    const err = new Error("opId must be non-empty string") as Error & { code: number }
    err.code = ErrorCode.InvalidParams
    throw err
  }
  if (p.op !== "session/e2eSandboxGrantRead") {
    const err = new Error("op must be session/e2eSandboxGrantRead") as Error & { code: number }
    err.code = ErrorCode.InvalidParams
    throw err
  }
  if (typeof p.idempotencyKey !== "string" || !p.idempotencyKey) {
    const err = new Error("idempotencyKey must be non-empty string") as Error & { code: number }
    err.code = ErrorCode.InvalidParams
    throw err
  }
  const ctx = p.context as Record<string, unknown> | undefined
  if (!ctx || typeof ctx.directory !== "string" || !isAbsolute(ctx.directory as string)) {
    const err = new Error("context.directory must be absolute path") as Error & { code: number }
    err.code = ErrorCode.InvalidParams
    throw err
  }
  const payload = p.payload as Record<string, unknown> | undefined
  if (!payload || typeof payload.hash !== "string" || !/^[0-9a-f]{64}$/i.test(payload.hash as string)) {
    const err = new Error("payload.hash must be 64 hex") as Error & { code: number }
    err.code = ErrorCode.InvalidParams
    throw err
  }
  const hash = (payload.hash as string).toLowerCase()
  const scanned = (SandboxInheritance as unknown as { _findGrantByHash?: (h: string) => { remaining: number; directory: string; sessionID: string } | undefined })._findGrantByHash?.(hash)
  const found = !!scanned
  return {
    v: 1,
    requestId: p.requestId,
    opId: p.opId,
    op: "session/e2eSandboxGrantRead",
    idempotencyKey: p.idempotencyKey,
    status: "succeeded" as const,
    outcome: { type: "succeeded" as const, time: Date.now() },
    accepted: true as const,
    data: { hash, found, ...(found ? { remaining: scanned!.remaining, directory: scanned!.directory, sourceSessionId: String(scanned!.sessionID) } : {}) },
  }
}

export async function handleE2ESandboxPolicyRead(params: unknown): Promise<unknown> {
  if (!isE2EFixtureEnabled()) {
    const err = new Error("e2eSandboxPolicyRead requires KILO_E2E_FIXTURE") as Error & { code: number }
    err.code = ErrorCode.InvalidRequest
    throw err
  }
  const p = params as Record<string, unknown>
  if (p.v !== 1) {
    const err = new Error("v must be 1") as Error & { code: number }
    err.code = ErrorCode.InvalidParams
    throw err
  }
  if (typeof p.requestId !== "string" || !p.requestId) {
    const err = new Error("requestId must be non-empty string") as Error & { code: number }
    err.code = ErrorCode.InvalidParams
    throw err
  }
  if (typeof p.opId !== "string" || !p.opId) {
    const err = new Error("opId must be non-empty string") as Error & { code: number }
    err.code = ErrorCode.InvalidParams
    throw err
  }
  if (p.op !== "session/e2eSandboxPolicyRead") {
    const err = new Error("op must be session/e2eSandboxPolicyRead") as Error & { code: number }
    err.code = ErrorCode.InvalidParams
    throw err
  }
  if (typeof p.idempotencyKey !== "string" || !p.idempotencyKey) {
    const err = new Error("idempotencyKey must be non-empty string") as Error & { code: number }
    err.code = ErrorCode.InvalidParams
    throw err
  }
  const ctx = p.context as Record<string, unknown> | undefined
  if (!ctx || typeof ctx.directory !== "string" || !isAbsolute(ctx.directory as string)) {
    const err = new Error("context.directory must be absolute path") as Error & { code: number }
    err.code = ErrorCode.InvalidParams
    throw err
  }
  const dir = canonicalDirectory(ctx.directory as string)
  const payload = p.payload as Record<string, unknown> | undefined
  if (!payload || typeof payload.sessionId !== "string" || !payload.sessionId.startsWith("ses")) {
    const err = new Error("payload.sessionId must be ses*") as Error & { code: number }
    err.code = ErrorCode.InvalidParams
    throw err
  }
  const sessionId = payload.sessionId as string
  const snapshot = await SandboxStore.read(dir, sessionId as unknown as never).catch(() => undefined)
  return {
    v: 1,
    requestId: p.requestId,
    opId: p.opId,
    op: "session/e2eSandboxPolicyRead",
    idempotencyKey: p.idempotencyKey,
    status: "succeeded" as const,
    outcome: { type: "succeeded" as const, time: Date.now() },
    accepted: true as const,
    data: {
      sessionId,
      directory: dir,
      found: !!snapshot,
      snapshot: snapshot ?? null,
    },
  }
}
