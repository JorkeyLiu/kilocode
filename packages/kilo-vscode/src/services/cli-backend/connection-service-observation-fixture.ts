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
import { isE2EFixtureEnabled } from "../../util/e2e-fixture"
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

interface Deps {
  getPeer: () => ServePrivatePeer | null
  isAvailable: () => boolean
  createWithHandle: (req: ServePrivateCreateRequest) => { promise: Promise<ServePrivateCreateResult> }
  updateWithHandle: (req: ServePrivateSessionUpdateRequest) => { promise: Promise<ServePrivateSessionUpdateResult> }
  deleteWithHandle: (req: ServePrivateDeleteRequest) => { promise: Promise<ServePrivateDeleteResult> }
  forkWithHandle: (req: ServePrivateForkRequest) => { promise: Promise<ServePrivateForkResult> }
  getCurrentDirectory: () => string | undefined
  getRootDirectory: () => string | undefined
}

function resolveDirectory(inputDir: string | undefined, deps: Deps): string {
  const rawDir = inputDir ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? deps.getCurrentDirectory() ?? deps.getRootDirectory()
  if (!rawDir) throw new Error("fixture sessionCreate: no directory")
  let dir = rawDir
  try {
    dir = fs.realpathSync(rawDir)
  } catch (err) {
    console.warn("[Kilo New] fixture resolveDirectory realpath failed, using raw directory:", String(err).slice(0, 200), { dir: rawDir })
  }
  return dir
}

function buildCreateRequest(dir: string, token: string, title: string, parentSessionId: string | null): ServePrivateCreateRequest {
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
    payload: { ...(title ? { title } : {}), ...(parentSessionId ? { parentID: parentSessionId } : {}) },
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

export class ConnectionObservationFixture {
  private fixCreateReq: ServePrivateCreateRequest | null = null
  private fixUpdateReqs = new Map<string, ServePrivateSessionUpdateRequest>()
  private fixDeleteReqs = new Map<string, ServePrivateDeleteRequest>()
  private fixForkReqs = new Map<string, ServePrivateForkRequest>()

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

  async create(input?: { directory?: string; title?: string; parentSessionId?: string | null; token?: string }): Promise<{
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
    const req = buildCreateRequest(dir, token, title, parentSessionId)
    this.fixCreateReq = req
    const handle = this.deps.createWithHandle(req)
    const result = await handle.promise
    const sid = (result as { data?: { session?: { id?: string } } }).data?.session?.id as string | undefined
    return { opId: req.opId, idempotencyKey: req.idempotencyKey, requestId: req.requestId, directory: dir, result, ...(sid ? { sessionId: sid } : {}) }
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
}
