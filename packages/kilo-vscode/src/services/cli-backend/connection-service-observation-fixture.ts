/**
 * Fixture-only observation/changed helper for KiloConnectionService.
 * Extracted to keep connection-service.ts under its max-lines cap while
 * preserving public call sites (extension.ts fixture commands) and production
 * privateCreateWithHandle/epoch semantics.
 * Only active when KILO_E2E_FIXTURE=1; no new SDK fallback, no broad refactor.
 */

import * as crypto from "crypto"
import * as fs from "node:fs"
import * as vscode from "vscode"
import { isE2EFixtureEnabled, isValidE2EScratch } from "../../util/e2e-fixture"
import type {
  ServePrivateCreateRequest,
  ServePrivateCreateResult,
  ServePrivateDeleteRequest,
  ServePrivateDeleteResult,
  ServePrivateForkRequest,
  ServePrivateForkResult,
  ServePrivatePeer,
  ServePrivateSessionUpdateRequest,
  ServePrivateSessionUpdateResult,
} from "./serve-private-peer"
import type { ServePrivateRevertRequest, ServePrivateRevertResult, ServePrivateUnrevertRequest, ServePrivateUnrevertResult } from "./serve-private-revert-contract"
import type { E2ERevertSeedRequest, E2ERevertSeedResult } from "./serve-private-e2e-revert-seed"
import type {
  E2ESandboxGrantReadRequest,
  E2ESandboxGrantReadResult,
  E2ESandboxPolicyReadRequest,
  E2ESandboxPolicyReadResult,
  E2ESandboxSetRequest,
  E2ESandboxSetResult,
  E2ESandboxTokenIssueRequest,
  E2ESandboxTokenIssueResult,
} from "./serve-private-e2e-sandbox"
import type { PromptContractRequest, PromptResult } from "./serve-private-prompt-contract"

interface Deps {
  getPeer: () => ServePrivatePeer | null
  isAvailable: () => boolean
  createWithHandle: (req: ServePrivateCreateRequest) => { promise: Promise<ServePrivateCreateResult> }
  updateWithHandle: (req: ServePrivateSessionUpdateRequest) => { promise: Promise<ServePrivateSessionUpdateResult> }
  deleteWithHandle: (req: ServePrivateDeleteRequest) => { promise: Promise<ServePrivateDeleteResult> }
  forkWithHandle: (req: ServePrivateForkRequest) => { promise: Promise<ServePrivateForkResult> }
  revertWithHandle: (req: ServePrivateRevertRequest) => { promise: Promise<ServePrivateRevertResult> }
  unrevertWithHandle: (req: ServePrivateUnrevertRequest) => { promise: Promise<ServePrivateUnrevertResult> }
  e2eRevertSeedWithHandle: (req: E2ERevertSeedRequest) => { promise: Promise<E2ERevertSeedResult> }
  e2eSandboxTokenIssueWithHandle: (req: E2ESandboxTokenIssueRequest) => { promise: Promise<E2ESandboxTokenIssueResult> }
  e2eSandboxPolicyReadWithHandle: (req: E2ESandboxPolicyReadRequest) => { promise: Promise<E2ESandboxPolicyReadResult> }
  e2eSandboxSetWithHandle: (req: E2ESandboxSetRequest) => { promise: Promise<E2ESandboxSetResult> }
  e2eSandboxGrantReadWithHandle: (req: E2ESandboxGrantReadRequest) => { promise: Promise<E2ESandboxGrantReadResult> }
  promptWithHandle: (req: PromptContractRequest) => { id: number; promise: Promise<PromptResult>; cancel?: (msg?: string) => boolean }
  getCurrentDirectory: () => string | undefined
  getRootDirectory: () => string | undefined
}

function boundedPromptTimeoutMs(): number {
  return 12_000
}

function epochSnapshot(peer: ServePrivatePeer | null): number | null {
  try {
    return (peer as unknown as { getEpoch?: () => number })?.getEpoch?.() ?? null
  } catch {
    return null
  }
}

async function withPromptBounded<T>(handle: { id: number; promise: Promise<T>; cancel?: (msg?: string) => boolean }, timeoutMs: number): Promise<{ result: T | null; timedOut: boolean; cancelled: boolean }> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error(`prompt timeout ${timeoutMs}`)), timeoutMs)
    ;(timer as unknown as { unref?: () => void })?.unref?.()
  })
  try {
    const result = (await Promise.race([handle.promise, timeout])) as T
    return { result, timedOut: false, cancelled: false }
  } catch (err) {
    const msg = String(err)
    const isTimeout = msg.includes("prompt timeout")
    if (isTimeout && handle.cancel) {
      let ok = false
      try {
        ok = handle.cancel("prompt fixture timeout")
      } catch {}
      return { result: null, timedOut: true, cancelled: ok }
    }
    if (isTimeout) return { result: null, timedOut: true, cancelled: false }
    throw err
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function writeFixtureDiag(scratch: string | undefined, name: string, payload: unknown): void {
  if (!scratch || !isValidE2EScratch(scratch)) return
  try {
    const { join } = require("node:path") as typeof import("node:path")
    const { writeFileSync } = require("node:fs") as typeof import("node:fs")
    writeFileSync(join(scratch, name), JSON.stringify(payload, null, 2))
  } catch {}
}

function resolveDirectory(inputDir: string | undefined, deps: Deps): string {
  const rawDir = inputDir ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? deps.getCurrentDirectory() ?? deps.getRootDirectory()
  if (!rawDir) throw new Error("fixture sessionCreate: no directory")
  // Use server's canonicalDirectory semantics (normalize+resolve, no realpath) so
  // fixture creates and backendSnapshot directory filters align on Darwin where
  // /var -> /private/var symlink would otherwise diverge between fixture realpath
  // and snapshot's host path. This keeps FD3/FD4 private dispatch canonical.
  const { resolve, normalize } = require("node:path") as typeof import("node:path")
  try {
    const normalized = normalize(resolve(rawDir))
    return normalized
  } catch (err) {
    console.warn("[Kilo New] fixture resolveDirectory normalize failed, using raw directory:", String(err).slice(0, 200), { dir: rawDir })
    let dir = rawDir
    try {
      dir = fs.realpathSync(rawDir)
    } catch {}
    return dir
  }
}

function buildCreateRequest(
  dir: string,
  token: string,
  title: string,
  parentSessionId: string | null,
  sandboxInheritanceToken?: string,
): ServePrivateCreateRequest {
  const opId = `create:${token}`
  const idempotencyKey = `create:${token}`
  const requestId = crypto.randomUUID()
  return {
    v: 1,
    requestId,
    opId,
    op: "session/create",
    idempotencyKey,
    context: { directory: dir, parentSessionId: null },
    payload: {
      ...(title ? { title } : {}),
      ...(parentSessionId ? { parentID: parentSessionId } : {}),
      ...(sandboxInheritanceToken ? { sandboxInheritanceToken } : {}),
    },
  }
}

function buildE2ESandboxTokenIssueRequest(
  dir: string,
  token: string,
  sourceSessionId: string,
  sourceDirectory: string,
  count: number,
): E2ESandboxTokenIssueRequest {
  const opId = `e2eSandboxTokenIssue:${token}`
  const idempotencyKey = `e2eSandboxTokenIssue:${token}`
  const requestId = crypto.randomUUID()
  return {
    v: 1,
    requestId,
    opId,
    op: "session/e2eSandboxTokenIssue",
    idempotencyKey,
    context: { directory: dir },
    payload: { sourceSessionId, sourceDirectory, count },
  }
}

function buildE2ESandboxPolicyReadRequest(dir: string, token: string, sessionId: string): E2ESandboxPolicyReadRequest {
  const opId = `e2eSandboxPolicyRead:${token}`
  const idempotencyKey = `e2eSandboxPolicyRead:${token}`
  const requestId = crypto.randomUUID()
  return {
    v: 1,
    requestId,
    opId,
    op: "session/e2eSandboxPolicyRead",
    idempotencyKey,
    context: { directory: dir },
    payload: { sessionId },
  }
}

function buildE2ESandboxSetRequest(dir: string, token: string, sessionId: string): E2ESandboxSetRequest {
  const opId = `e2eSandboxSet:${token}`
  const idempotencyKey = `e2eSandboxSet:${token}`
  const requestId = crypto.randomUUID()
  return {
    v: 1,
    requestId,
    opId,
    op: "session/e2eSandboxSet",
    idempotencyKey,
    context: { directory: dir },
    payload: { sessionId },
  }
}

function buildE2ESandboxGrantReadRequest(dir: string, token: string, hash: string): E2ESandboxGrantReadRequest {
  const opId = `e2eSandboxGrantRead:${token}`
  const idempotencyKey = `e2eSandboxGrantRead:${token}`
  const requestId = crypto.randomUUID()
  return {
    v: 1,
    requestId,
    opId,
    op: "session/e2eSandboxGrantRead",
    idempotencyKey,
    context: { directory: dir },
    payload: { hash },
  }
}

function buildUpdateRequest(dir: string, sessionId: string, token: string, title: string): ServePrivateSessionUpdateRequest {
  const opId = `sessionUpdate:${sessionId}:${token}`
  const idempotencyKey = `sessionUpdate:${sessionId}:${token}`
  const requestId = crypto.randomUUID()
  return {
    v: 1,
    requestId,
    opId,
    op: "session/update",
    idempotencyKey,
    context: { directory: dir, sessionId, parentSessionId: null },
    payload: { title },
  }
}

function buildDeleteRequest(dir: string, sessionId: string, token: string): ServePrivateDeleteRequest {
  const opId = `delete:${sessionId}:${token}`
  const idempotencyKey = `delete:${sessionId}:${token}`
  const requestId = crypto.randomUUID()
  return {
    v: 1,
    requestId,
    opId,
    op: "session/delete",
    idempotencyKey,
    context: { directory: dir, sessionId, parentSessionId: null },
    payload: {},
  }
}

function buildForkRequest(dir: string, sessionId: string, token: string): ServePrivateForkRequest {
  const opId = `fork:${sessionId}:${token}`
  const idempotencyKey = `fork:${sessionId}:${token}`
  const requestId = crypto.randomUUID()
  return {
    v: 1,
    requestId,
    opId,
    op: "session/fork",
    idempotencyKey,
    context: { directory: dir, sessionId, parentSessionId: null },
    payload: {},
  }
}

function buildRevertRequest(dir: string, sessionId: string, token: string, messageId: string, partId?: string): ServePrivateRevertRequest {
  const opId = `revert:${sessionId}:${token}`
  const idempotencyKey = `revert:${sessionId}:${token}`
  const requestId = crypto.randomUUID()
  return {
    v: 1,
    requestId,
    opId,
    op: "session/revert",
    idempotencyKey,
    context: { directory: dir, sessionId, parentSessionId: null },
    payload: { ...(messageId ? { messageId } : {}), ...(partId ? { partId } : {}) },
  }
}

function buildUnrevertRequest(dir: string, sessionId: string, token: string): ServePrivateUnrevertRequest {
  const opId = `unrevert:${sessionId}:${token}`
  const idempotencyKey = `unrevert:${sessionId}:${token}`
  const requestId = crypto.randomUUID()
  return {
    v: 1,
    requestId,
    opId,
    op: "session/unrevert",
    idempotencyKey,
    context: { directory: dir, sessionId, parentSessionId: null },
    payload: {},
  }
}

function buildE2ERevertSeedRequest(dir: string, token: string, title?: string): E2ERevertSeedRequest {
  const opId = `e2eRevertSeed:${token}`
  const idempotencyKey = `e2eRevertSeed:${token}`
  const requestId = crypto.randomUUID()
  return {
    v: 1,
    requestId,
    opId,
    op: "session/e2eRevertSeed",
    idempotencyKey,
    context: { directory: dir },
    payload: { ...(title ? { title } : {}) },
  }
}

function buildPromptRequest(
  dir: string,
  sessionId: string,
  messageId: string,
  text: string,
): PromptContractRequest {
  if (!messageId.startsWith("msg")) throw new Error("messageId must be msg*")
  const opId = `prompt:${messageId}`
  const idempotencyKey = `prompt:${messageId}`
  const requestId = crypto.randomUUID()
  return {
    v: 1,
    requestId,
    opId,
    op: "session/prompt",
    idempotencyKey,
    context: { directory: dir, sessionId, parentSessionId: null },
    payload: {
      messageId,
      parts: [{ type: "text", text }],
      noReply: true,
      // Provide explicit model so user message can be created without provider lookup
      model: { providerID: "anthropic", modelID: "claude-3-5-sonnet-20241022" },
    },
  }
}

export class ConnectionObservationFixture {
  private fixCreateReq: ServePrivateCreateRequest | null = null
  private fixUpdateReqs = new Map<string, ServePrivateSessionUpdateRequest>()
  private fixDeleteReqs = new Map<string, ServePrivateDeleteRequest>()
  private fixForkReqs = new Map<string, ServePrivateForkRequest>()
  private fixRevertReqs = new Map<string, ServePrivateRevertRequest>()
  private fixUnrevertReqs = new Map<string, ServePrivateUnrevertRequest>()
  private fixSeedReq: E2ERevertSeedRequest | null = null
  private fixSeedInfo: { sessionId: string; messageId: string; partId: string } | null = null
  private fixSandboxReq: ServePrivateCreateRequest | null = null
  private fixSandboxSecondReq: ServePrivateCreateRequest | null = null
  private fixPromptReqs = new Map<string, PromptContractRequest>()

  constructor(private readonly deps: Deps) {}

  snapshot(): { startOrdinal: number; nextOrdinal: number; entries: Array<{ ordinal: number; method: string; params: unknown; receivedAt: number }> } {
    if (!isE2EFixtureEnabled()) throw new Error("fixture observationChanged snapshot requires KILO_E2E_FIXTURE")
    const peer = this.deps.getPeer()
    if (!peer) return { startOrdinal: 0, nextOrdinal: 0, entries: [] }
    return peer.getObservationChangedSnapshot()
  }

  clear(): boolean {
    if (!isE2EFixtureEnabled()) throw new Error("fixture observationChanged clear requires KILO_E2E_FIXTURE")
    const peer = this.deps.getPeer()
    if (!peer) return false
    peer.clearObservationChangedSnapshot()
    return true
  }

  async create(input?: { directory?: string; title?: string; parentSessionId?: string | null; token?: string; sandboxInheritanceToken?: string }): Promise<{
    opId: string
    idempotencyKey: string
    requestId: string
    directory: string
    result: ServePrivateCreateResult
    sessionId?: string
  }> {
    if (!isE2EFixtureEnabled()) throw new Error("fixture sessionCreate requires KILO_E2E_FIXTURE")
    if (!this.deps.isAvailable() || !this.deps.getPeer()) throw new Error("Private peer unavailable")
    const dir = resolveDirectory(input?.directory, this.deps)
    const token = input?.token ?? crypto.randomUUID()
    if (typeof token !== "string" || token.length === 0 || token.includes(":")) throw new Error("token invalid")
    const title = input?.title ?? `E2E Obs Prod ${token.slice(0, 8)}`
    const parentSessionId = input?.parentSessionId ?? null
    const req = buildCreateRequest(dir, token, title, parentSessionId, input?.sandboxInheritanceToken)
    this.fixCreateReq = req
    const handle = this.deps.createWithHandle(req)
    const result = await handle.promise
    const sid = (result as { data?: { session?: { id?: string } } }).data?.session?.id as string | undefined
    return { opId: req.opId, idempotencyKey: req.idempotencyKey, requestId: req.requestId, directory: dir, result, ...(sid ? { sessionId: sid } : {}) }
  }

  async createSandboxChild(input: { directory?: string; title?: string; sandboxInheritanceToken: string }): Promise<{
    opId: string
    idempotencyKey: string
    requestId: string
    directory: string
    result: ServePrivateCreateResult
    sessionId?: string
  }> {
    if (!isE2EFixtureEnabled()) throw new Error("fixture sandboxChild requires KILO_E2E_FIXTURE")
    if (!this.deps.isAvailable() || !this.deps.getPeer()) throw new Error("Private peer unavailable")
    if (!input.sandboxInheritanceToken || typeof input.sandboxInheritanceToken !== "string" || !/^si-/.test(input.sandboxInheritanceToken))
      throw new Error("sandboxInheritanceToken invalid")
    const dir = resolveDirectory(input.directory, this.deps)
    const token = crypto.randomUUID()
    const title = input.title ?? `E2E Sandbox Child ${token.slice(0, 8)}`
    const req = buildCreateRequest(dir, token, title, null, input.sandboxInheritanceToken)
    const isFirst = !this.fixSandboxReq
    if (isFirst) this.fixSandboxReq = req
    else if (!this.fixSandboxSecondReq) this.fixSandboxSecondReq = req
    const handle = this.deps.createWithHandle(req)
    const result = await handle.promise
    const sid = (result as { data?: { session?: { id?: string } } }).data?.session?.id as string | undefined
    return { opId: req.opId, idempotencyKey: req.idempotencyKey, requestId: req.requestId, directory: dir, result, ...(sid ? { sessionId: sid } : {}) }
  }

  async replaySandbox(): Promise<{
    opId: string
    idempotencyKey: string
    requestId: string
    directory: string
    result: ServePrivateCreateResult
    sessionId?: string
  }> {
    if (!isE2EFixtureEnabled()) throw new Error("fixture sandbox replay requires KILO_E2E_FIXTURE")
    const stored = this.fixSandboxReq
    if (!stored) throw new Error("no stored sandbox create to replay")
    if (!this.deps.isAvailable() || !this.deps.getPeer()) throw new Error("Private peer unavailable")
    const handle = this.deps.createWithHandle(stored)
    const result = await handle.promise
    const sid = (result as { data?: { session?: { id?: string } } }).data?.session?.id as string | undefined
    return {
      opId: stored.opId,
      idempotencyKey: stored.idempotencyKey,
      requestId: stored.requestId,
      directory: stored.context.directory,
      result,
      ...(sid ? { sessionId: sid } : {}),
    }
  }

  async sandboxTokenIssue(input: { directory?: string; sourceSessionId: string; sourceDirectory?: string; count?: number }): Promise<{
    opId: string
    idempotencyKey: string
    requestId: string
    directory: string
    result: E2ESandboxTokenIssueResult
    token?: string
  }> {
    if (!isE2EFixtureEnabled()) throw new Error("fixture sandboxTokenIssue requires KILO_E2E_FIXTURE")
    if (!this.deps.isAvailable() || !this.deps.getPeer()) throw new Error("Private peer unavailable")
    const dir = resolveDirectory(input.directory, this.deps)
    const sourceDir = input.sourceDirectory ? resolveDirectory(input.sourceDirectory, this.deps) : dir
    const count = input.count ?? 2
    if (typeof count !== "number" || !Number.isInteger(count) || count < 2) throw new Error("count must be >=2")
    const token = crypto.randomUUID()
    const req = buildE2ESandboxTokenIssueRequest(dir, token, input.sourceSessionId, sourceDir, count)
    const handle = this.deps.e2eSandboxTokenIssueWithHandle(req)
    const result = await handle.promise
    const tok = (result as { data?: { token?: string } }).data?.token as string | undefined
    return { opId: req.opId, idempotencyKey: req.idempotencyKey, requestId: req.requestId, directory: dir, result, ...(tok ? { token: tok } : {}) }
  }

  async sandboxPolicyRead(input: { directory?: string; sessionId: string }): Promise<{
    opId: string
    idempotencyKey: string
    requestId: string
    directory: string
    result: E2ESandboxPolicyReadResult
  }> {
    if (!isE2EFixtureEnabled()) throw new Error("fixture sandboxPolicyRead requires KILO_E2E_FIXTURE")
    if (!this.deps.isAvailable() || !this.deps.getPeer()) throw new Error("Private peer unavailable")
    const dir = resolveDirectory(input.directory, this.deps)
    const token = crypto.randomUUID()
    const req = buildE2ESandboxPolicyReadRequest(dir, token, input.sessionId)
    const handle = this.deps.e2eSandboxPolicyReadWithHandle(req)
    const result = await handle.promise
    return { opId: req.opId, idempotencyKey: req.idempotencyKey, requestId: req.requestId, directory: dir, result }
  }

  async sandboxSet(input: { directory?: string; sessionId: string }): Promise<{
    opId: string
    idempotencyKey: string
    requestId: string
    directory: string
    result: E2ESandboxSetResult
  }> {
    if (!isE2EFixtureEnabled()) throw new Error("fixture sandboxSet requires KILO_E2E_FIXTURE")
    if (!this.deps.isAvailable() || !this.deps.getPeer()) throw new Error("Private peer unavailable")
    const dir = resolveDirectory(input.directory, this.deps)
    const token = crypto.randomUUID()
    const req = buildE2ESandboxSetRequest(dir, token, input.sessionId)
    const handle = this.deps.e2eSandboxSetWithHandle(req)
    const result = await handle.promise
    return { opId: req.opId, idempotencyKey: req.idempotencyKey, requestId: req.requestId, directory: dir, result }
  }

  async sandboxGrantRead(input: { directory?: string; hash: string }): Promise<{
    opId: string
    idempotencyKey: string
    requestId: string
    directory: string
    result: E2ESandboxGrantReadResult
  }> {
    if (!isE2EFixtureEnabled()) throw new Error("fixture sandboxGrantRead requires KILO_E2E_FIXTURE")
    if (!this.deps.isAvailable() || !this.deps.getPeer()) throw new Error("Private peer unavailable")
    if (!input.hash || typeof input.hash !== "string" || !/^[0-9a-f]{64}$/i.test(input.hash)) throw new Error("hash must be 64 hex")
    const dir = resolveDirectory(input.directory, this.deps)
    const token = crypto.randomUUID()
    const req = buildE2ESandboxGrantReadRequest(dir, token, input.hash.toLowerCase())
    const handle = this.deps.e2eSandboxGrantReadWithHandle(req)
    const result = await handle.promise
    return { opId: req.opId, idempotencyKey: req.idempotencyKey, requestId: req.requestId, directory: dir, result }
  }

  async replay(): Promise<{
    opId: string
    idempotencyKey: string
    requestId: string
    directory: string
    result: ServePrivateCreateResult
    sessionId?: string
  }> {
    if (!isE2EFixtureEnabled()) throw new Error("fixture sessionCreate replay requires KILO_E2E_FIXTURE")
    const stored = this.fixCreateReq
    if (!stored) throw new Error("no stored fixture create identity to replay")
    if (!this.deps.isAvailable() || !this.deps.getPeer()) throw new Error("Private peer unavailable")
    const handle = this.deps.createWithHandle(stored)
    const result = await handle.promise
    const sid = (result as { data?: { session?: { id?: string } } }).data?.session?.id as string | undefined
    return {
      opId: stored.opId,
      idempotencyKey: stored.idempotencyKey,
      requestId: stored.requestId,
      directory: stored.context.directory,
      result,
      ...(sid ? { sessionId: sid } : {}),
    }
  }

  async update(input: { directory?: string; sessionId: string; title?: string; token?: string }): Promise<{
    opId: string
    idempotencyKey: string
    requestId: string
    directory: string
    result: ServePrivateSessionUpdateResult
    sessionId: string
  }> {
    if (!isE2EFixtureEnabled()) throw new Error("fixture sessionUpdate requires KILO_E2E_FIXTURE")
    if (!this.deps.isAvailable() || !this.deps.getPeer()) throw new Error("Private peer unavailable")
    if (!input.sessionId || typeof input.sessionId !== "string" || !input.sessionId.startsWith("ses"))
      throw new Error("sessionId must be ses*")
    if (input.token !== undefined && (typeof input.token !== "string" || input.token.length === 0 || input.token.includes(":")))
      throw new Error("token invalid")
    const dir = resolveDirectory(input.directory, this.deps)
    const token = input.token ?? crypto.randomUUID()
    if (token.includes(":")) throw new Error("token invalid")
    const title = input.title ?? `E2E Obs Update ${token.slice(0, 8)}`
    if (typeof title !== "string" || title.trim().length === 0) throw new Error("title required")
    const req = buildUpdateRequest(dir, input.sessionId, token, title)
    this.fixUpdateReqs.set(input.sessionId, req)
    const handle = this.deps.updateWithHandle(req)
    const result = await handle.promise
    return { opId: req.opId, idempotencyKey: req.idempotencyKey, requestId: req.requestId, directory: dir, result, sessionId: input.sessionId }
  }

  async replayUpdate(sessionId: string): Promise<{
    opId: string
    idempotencyKey: string
    requestId: string
    directory: string
    result: ServePrivateSessionUpdateResult
    sessionId: string
  }> {
    if (!isE2EFixtureEnabled()) throw new Error("fixture sessionUpdate replay requires KILO_E2E_FIXTURE")
    if (!sessionId || typeof sessionId !== "string") throw new Error("sessionId required")
    const stored = this.fixUpdateReqs.get(sessionId)
    if (!stored) throw new Error("no stored fixture update identity to replay")
    if (!this.deps.isAvailable() || !this.deps.getPeer()) throw new Error("Private peer unavailable")
    const handle = this.deps.updateWithHandle(stored)
    const result = await handle.promise
    return {
      opId: stored.opId,
      idempotencyKey: stored.idempotencyKey,
      requestId: stored.requestId,
      directory: stored.context.directory,
      result,
      sessionId,
    }
  }

  async delete(input: { directory?: string; sessionId: string; token?: string }): Promise<{
    opId: string
    idempotencyKey: string
    requestId: string
    directory: string
    result: ServePrivateDeleteResult
    sessionId: string
  }> {
    if (!isE2EFixtureEnabled()) throw new Error("fixture sessionDelete requires KILO_E2E_FIXTURE")
    if (!this.deps.isAvailable() || !this.deps.getPeer()) throw new Error("Private peer unavailable")
    if (!input.sessionId || typeof input.sessionId !== "string" || !input.sessionId.startsWith("ses"))
      throw new Error("sessionId must be ses*")
    if (input.token !== undefined && (typeof input.token !== "string" || input.token.length === 0 || input.token.includes(":")))
      throw new Error("token invalid")
    const dir = resolveDirectory(input.directory, this.deps)
    const token = input.token ?? crypto.randomUUID()
    if (token.includes(":")) throw new Error("token invalid")
    const req = buildDeleteRequest(dir, input.sessionId, token)
    this.fixDeleteReqs.set(input.sessionId, req)
    const handle = this.deps.deleteWithHandle(req)
    const result = await handle.promise
    return { opId: req.opId, idempotencyKey: req.idempotencyKey, requestId: req.requestId, directory: dir, result, sessionId: input.sessionId }
  }

  async replayDelete(sessionId: string): Promise<{
    opId: string
    idempotencyKey: string
    requestId: string
    directory: string
    result: ServePrivateDeleteResult
    sessionId: string
  }> {
    if (!isE2EFixtureEnabled()) throw new Error("fixture sessionDelete replay requires KILO_E2E_FIXTURE")
    if (!sessionId || typeof sessionId !== "string") throw new Error("sessionId required")
    const stored = this.fixDeleteReqs.get(sessionId)
    if (!stored) throw new Error("no stored fixture delete identity to replay")
    if (!this.deps.isAvailable() || !this.deps.getPeer()) throw new Error("Private peer unavailable")
    const handle = this.deps.deleteWithHandle(stored)
    const result = await handle.promise
    return {
      opId: stored.opId,
      idempotencyKey: stored.idempotencyKey,
      requestId: stored.requestId,
      directory: stored.context.directory,
      result,
      sessionId,
    }
  }

  async fork(input: { directory?: string; sessionId: string; token?: string }): Promise<{
    opId: string
    idempotencyKey: string
    requestId: string
    directory: string
    result: ServePrivateForkResult
    sessionId: string
    childSessionId?: string
  }> {
    if (!isE2EFixtureEnabled()) throw new Error("fixture sessionFork requires KILO_E2E_FIXTURE")
    if (!this.deps.isAvailable() || !this.deps.getPeer()) throw new Error("Private peer unavailable")
    if (!input.sessionId || typeof input.sessionId !== "string" || !input.sessionId.startsWith("ses"))
      throw new Error("sessionId must be ses*")
    if (input.token !== undefined && (typeof input.token !== "string" || input.token.length === 0 || input.token.includes(":")))
      throw new Error("token invalid")
    const dir = resolveDirectory(input.directory, this.deps)
    const token = input.token ?? crypto.randomUUID()
    if (token.includes(":")) throw new Error("token invalid")
    const req = buildForkRequest(dir, input.sessionId, token)
    this.fixForkReqs.set(input.sessionId, req)
    const handle = this.deps.forkWithHandle(req)
    const result = await handle.promise
    const child = (result as { data?: { session?: { id?: string } } }).data?.session?.id as string | undefined
    return { opId: req.opId, idempotencyKey: req.idempotencyKey, requestId: req.requestId, directory: dir, result, sessionId: input.sessionId, ...(child ? { childSessionId: child } : {}) }
  }

  async replayFork(sessionId: string): Promise<{
    opId: string
    idempotencyKey: string
    requestId: string
    directory: string
    result: ServePrivateForkResult
    sessionId: string
    childSessionId?: string
  }> {
    if (!isE2EFixtureEnabled()) throw new Error("fixture sessionFork replay requires KILO_E2E_FIXTURE")
    if (!sessionId || typeof sessionId !== "string") throw new Error("sessionId required")
    const stored = this.fixForkReqs.get(sessionId)
    if (!stored) throw new Error("no stored fixture fork identity to replay")
    if (!this.deps.isAvailable() || !this.deps.getPeer()) throw new Error("Private peer unavailable")
    const handle = this.deps.forkWithHandle(stored)
    const result = await handle.promise
    const child = (result as { data?: { session?: { id?: string } } }).data?.session?.id as string | undefined
    return {
      opId: stored.opId,
      idempotencyKey: stored.idempotencyKey,
      requestId: stored.requestId,
      directory: stored.context.directory,
      result,
      sessionId,
      ...(child ? { childSessionId: child } : {}),
    }
  }

  async seedRevert(input?: { directory?: string; title?: string; token?: string }): Promise<{
    opId: string
    idempotencyKey: string
    requestId: string
    directory: string
    result: E2ERevertSeedResult
    sessionId: string
    messageId: string
    partId: string
  }> {
    if (!isE2EFixtureEnabled()) throw new Error("fixture e2eRevertSeed requires KILO_E2E_FIXTURE")
    if (!this.deps.isAvailable() || !this.deps.getPeer()) throw new Error("Private peer unavailable")
    const dir = resolveDirectory(input?.directory, this.deps)
    const token = input?.token ?? crypto.randomUUID()
    if (typeof token !== "string" || token.length === 0 || token.includes(":")) throw new Error("token invalid")
    const req = buildE2ERevertSeedRequest(dir, token, input?.title)
    this.fixSeedReq = req
    const handle = this.deps.e2eRevertSeedWithHandle(req)
    const result = await handle.promise
    if (result.status !== "succeeded") throw new Error(`e2eRevertSeed not succeeded: ${JSON.stringify(result).slice(0, 400)}`)
    const data = result.data as unknown as { sessionId: string; messageId: string; partId: string }
    this.fixSeedInfo = { sessionId: data.sessionId, messageId: data.messageId, partId: data.partId }
    return { opId: req.opId, idempotencyKey: req.idempotencyKey, requestId: req.requestId, directory: dir, result, sessionId: data.sessionId, messageId: data.messageId, partId: data.partId }
  }

  async revert(input: { directory?: string; sessionId: string; messageId: string; partId?: string; token?: string }): Promise<{
    opId: string
    idempotencyKey: string
    requestId: string
    directory: string
    result: ServePrivateRevertResult
    sessionId: string
  }> {
    if (!isE2EFixtureEnabled()) throw new Error("fixture sessionRevert requires KILO_E2E_FIXTURE")
    if (!this.deps.isAvailable() || !this.deps.getPeer()) throw new Error("Private peer unavailable")
    if (!input.sessionId || typeof input.sessionId !== "string" || !input.sessionId.startsWith("ses")) throw new Error("sessionId must be ses*")
    if (!input.messageId || typeof input.messageId !== "string" || !input.messageId.startsWith("msg")) throw new Error("messageId must be msg*")
    if (input.token !== undefined && (typeof input.token !== "string" || input.token.length === 0 || input.token.includes(":"))) throw new Error("token invalid")
    const dir = resolveDirectory(input.directory, this.deps)
    const token = input.token ?? crypto.randomUUID()
    if (token.includes(":")) throw new Error("token invalid")
    const req = buildRevertRequest(dir, input.sessionId, token, input.messageId, input.partId)
    this.fixRevertReqs.set(input.sessionId, req)
    const handle = this.deps.revertWithHandle(req)
    const result = await handle.promise
    return { opId: req.opId, idempotencyKey: req.idempotencyKey, requestId: req.requestId, directory: dir, result, sessionId: input.sessionId }
  }

  async replayRevert(sessionId: string): Promise<{
    opId: string
    idempotencyKey: string
    requestId: string
    directory: string
    result: ServePrivateRevertResult
    sessionId: string
  }> {
    if (!isE2EFixtureEnabled()) throw new Error("fixture sessionRevert replay requires KILO_E2E_FIXTURE")
    if (!sessionId || typeof sessionId !== "string") throw new Error("sessionId required")
    const stored = this.fixRevertReqs.get(sessionId)
    if (!stored) throw new Error("no stored fixture revert identity to replay")
    if (!this.deps.isAvailable() || !this.deps.getPeer()) throw new Error("Private peer unavailable")
    const handle = this.deps.revertWithHandle(stored)
    const result = await handle.promise
    return { opId: stored.opId, idempotencyKey: stored.idempotencyKey, requestId: stored.requestId, directory: stored.context.directory, result, sessionId }
  }

  async unrevert(input: { directory?: string; sessionId: string; token?: string }): Promise<{
    opId: string
    idempotencyKey: string
    requestId: string
    directory: string
    result: ServePrivateUnrevertResult
    sessionId: string
  }> {
    if (!isE2EFixtureEnabled()) throw new Error("fixture sessionUnrevert requires KILO_E2E_FIXTURE")
    if (!this.deps.isAvailable() || !this.deps.getPeer()) throw new Error("Private peer unavailable")
    if (!input.sessionId || typeof input.sessionId !== "string" || !input.sessionId.startsWith("ses")) throw new Error("sessionId must be ses*")
    if (input.token !== undefined && (typeof input.token !== "string" || input.token.length === 0 || input.token.includes(":"))) throw new Error("token invalid")
    const dir = resolveDirectory(input.directory, this.deps)
    const token = input.token ?? crypto.randomUUID()
    if (token.includes(":")) throw new Error("token invalid")
    const req = buildUnrevertRequest(dir, input.sessionId, token)
    this.fixUnrevertReqs.set(input.sessionId, req)
    const handle = this.deps.unrevertWithHandle(req)
    const result = await handle.promise
    return { opId: req.opId, idempotencyKey: req.idempotencyKey, requestId: req.requestId, directory: dir, result, sessionId: input.sessionId }
  }

  async replayUnrevert(sessionId: string): Promise<{
    opId: string
    idempotencyKey: string
    requestId: string
    directory: string
    result: ServePrivateUnrevertResult
    sessionId: string
  }> {
    if (!isE2EFixtureEnabled()) throw new Error("fixture sessionUnrevert replay requires KILO_E2E_FIXTURE")
    if (!sessionId || typeof sessionId !== "string") throw new Error("sessionId required")
    const stored = this.fixUnrevertReqs.get(sessionId)
    if (!stored) throw new Error("no stored fixture unrevert identity to replay")
    if (!this.deps.isAvailable() || !this.deps.getPeer()) throw new Error("Private peer unavailable")
    const handle = this.deps.unrevertWithHandle(stored)
    const result = await handle.promise
    return { opId: stored.opId, idempotencyKey: stored.idempotencyKey, requestId: stored.requestId, directory: stored.context.directory, result, sessionId }
  }

  async prompt(input: { directory?: string; sessionId: string; messageId: string; text: string }): Promise<{
    opId: string
    idempotencyKey: string
    requestId: string
    directory: string
    result: PromptResult
    sessionId: string
    messageId: string
  }> {
    if (!isE2EFixtureEnabled()) throw new Error("fixture sessionPrompt requires KILO_E2E_FIXTURE")
    if (!this.deps.isAvailable() || !this.deps.getPeer()) throw new Error("Private peer unavailable")
    if (!input.sessionId || typeof input.sessionId !== "string" || !input.sessionId.startsWith("ses")) throw new Error("sessionId must be ses*")
    if (!input.messageId || typeof input.messageId !== "string" || !input.messageId.startsWith("msg")) throw new Error("messageId must be msg*")
    if (typeof input.text !== "string" || input.text.length === 0) throw new Error("text required")
    const dir = resolveDirectory(input.directory, this.deps)
    const req = buildPromptRequest(dir, input.sessionId, input.messageId, input.text)
    this.fixPromptReqs.set(input.sessionId + ":" + input.messageId, req)
    const peerBefore = this.deps.getPeer()
    const epochBefore = epochSnapshot(peerBefore)
    const startedAt = Date.now()
    const handle = this.deps.promptWithHandle(req)
    const bounded = await withPromptBounded(handle, boundedPromptTimeoutMs())
    const peerAfter = this.deps.getPeer()
    const epochAfter = epochSnapshot(peerAfter)
    const durationMs = Date.now() - startedAt
    const timedOut = bounded.timedOut
    let result: PromptResult
    if (bounded.result !== null) {
      result = bounded.result as PromptResult
    } else {
      // Timeout maps to ambiguous transportUnknown so runner can record and optionally retry once
      result = {
        v: 1,
        requestId: req.requestId,
        opId: req.opId,
        op: "session/prompt",
        idempotencyKey: req.idempotencyKey,
        status: "ambiguous",
        outcome: { type: "ambiguous", time: Date.now() },
        accepted: false,
        transportUnknown: true,
      } as unknown as PromptResult
    }
    // Read-only diagnostics only: no additional session/prompt dispatch; probe must never write message state
    const diag = {
      kind: "prompt",
      opId: req.opId,
      requestId: req.requestId,
      directory: dir,
      sessionId: input.sessionId,
      messageId: input.messageId,
      epochBefore,
      epochAfter,
      startedAt,
      durationMs,
      timedOut,
      cancelled: bounded.cancelled,
      resultStatus: (result as unknown as { status?: string }).status,
      transportUnknown: (result as unknown as { transportUnknown?: boolean }).transportUnknown,
      peerAvailableBefore: (() => {
        try {
          return peerBefore?.isAvailable?.() ?? null
        } catch {
          return null
        }
      })(),
      peerAvailableAfter: (() => {
        try {
          return peerAfter?.isAvailable?.() ?? null
        } catch {
          return null
        }
      })(),
    }
    writeFixtureDiag(process.env.KILO_E2E_SCRATCH, `prompt-fixture-attempt-${req.requestId.slice(0, 8)}.json`, diag)
    return { opId: req.opId, idempotencyKey: req.idempotencyKey, requestId: req.requestId, directory: dir, result, sessionId: input.sessionId, messageId: input.messageId }
  }

  async replayPrompt(sessionId: string, messageId: string): Promise<{
    opId: string
    idempotencyKey: string
    requestId: string
    directory: string
    result: PromptResult
    sessionId: string
    messageId: string
  }> {
    if (!isE2EFixtureEnabled()) throw new Error("fixture sessionPrompt replay requires KILO_E2E_FIXTURE")
    if (!sessionId || typeof sessionId !== "string") throw new Error("sessionId required")
    if (!messageId || typeof messageId !== "string") throw new Error("messageId required")
    const key = sessionId + ":" + messageId
    const stored = this.fixPromptReqs.get(key)
    if (!stored) throw new Error("no stored fixture prompt identity to replay")
    if (!this.deps.isAvailable() || !this.deps.getPeer()) throw new Error("Private peer unavailable")
    const peerBefore = this.deps.getPeer()
    const epochBefore = epochSnapshot(peerBefore)
    const startedAt = Date.now()
    const handle = this.deps.promptWithHandle(stored)
    const bounded = await withPromptBounded(handle, boundedPromptTimeoutMs())
    const peerAfter = this.deps.getPeer()
    const epochAfter = epochSnapshot(peerAfter)
    const durationMs = Date.now() - startedAt
    let result: PromptResult
    if (bounded.result !== null) {
      result = bounded.result as PromptResult
    } else {
      result = {
        v: 1,
        requestId: stored.requestId,
        opId: stored.opId,
        op: "session/prompt",
        idempotencyKey: stored.idempotencyKey,
        status: "ambiguous",
        outcome: { type: "ambiguous", time: Date.now() },
        accepted: false,
        transportUnknown: true,
      } as unknown as PromptResult
    }
    const diag = {
      kind: "replayPrompt",
      opId: stored.opId,
      requestId: stored.requestId,
      sessionId,
      messageId,
      epochBefore,
      epochAfter,
      startedAt,
      durationMs,
      timedOut: bounded.timedOut,
      cancelled: bounded.cancelled,
      resultStatus: (result as unknown as { status?: string }).status,
      transportUnknown: (result as unknown as { transportUnknown?: boolean }).transportUnknown,
    }
    writeFixtureDiag(process.env.KILO_E2E_SCRATCH, `prompt-fixture-replay-${stored.requestId.slice(0, 8)}.json`, diag)
    return { opId: stored.opId, idempotencyKey: stored.idempotencyKey, requestId: stored.requestId, directory: stored.context.directory, result, sessionId, messageId }
  }
}
