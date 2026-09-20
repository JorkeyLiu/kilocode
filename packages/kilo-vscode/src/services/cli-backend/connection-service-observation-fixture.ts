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
import type { ServePrivateCreateRequest, ServePrivateCreateResult, ServePrivatePeer } from "./serve-private-peer"

interface Deps {
  getPeer: () => ServePrivatePeer | null
  isAvailable: () => boolean
  createWithHandle: (req: ServePrivateCreateRequest) => { promise: Promise<ServePrivateCreateResult> }
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
    context: { directory: dir, parentSessionId },
    payload: { ...(title ? { title } : {}) },
  }
}

export class ConnectionObservationFixture {
  private fixCreateReq: ServePrivateCreateRequest | null = null

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
}
