/**
 * Permission handlers — extracted from KiloProvider.
 *
 * Manages permission responses (once/always/reject) and recovery of
 * pending permissions after SSE reconnections. No vscode dependency.
 */

import type { KiloClient, PermissionRequest } from "@kilocode/sdk/v2/client"
import { readPermissionsForDir, replyPermissionPrivateFirst, savePermissionPrivateFirst } from "../permission-privatefirst"

type PrivateConn = Parameters<typeof replyPermissionPrivateFirst>[0]["connection"]

export type RecoverablePermission = PermissionRequest

export interface PermissionContext {
  readonly client: KiloClient | null
  readonly currentSessionId: string | undefined
  readonly trackedSessionIds: Set<string>
  readonly sessionDirectories: ReadonlyMap<string, string>
  readonly connection?: PrivateConn
  postMessage(msg: unknown): void
  getWorkspaceDirectory(sessionId?: string): string
  recordPermissionDirectory(requestID: string, directory: string): void
  getPermissionDirectory(requestID: string): string | undefined
  clearPermissionDirectory(requestID: string): void
  prunePermissionDirectories(active: Set<string>, dirs?: Set<string>): void
}

export function recoveryDirs(workspace: string, dirs: ReadonlyMap<string, string>) {
  return [...new Set([workspace, ...dirs.values()])]
}

export function recoverablePermissions(perms: RecoverablePermission[], tracked: Set<string>, seen: Set<string>) {
  return perms.filter((perm) => {
    if (seen.has(perm.id)) return false
    seen.add(perm.id)
    return tracked.has(perm.sessionID)
  })
}

function isNotFoundError(error: unknown): boolean {
  const record = (value: unknown) =>
    value && typeof value === "object" ? (value as Record<string, unknown>) : undefined
  const obj = record(error)
  if (!obj) return false

  const cause = record(obj.cause)
  const body = record(cause?.body)
  return [obj, record(obj.data), cause, body, record(body?.data)].some(
    (value) => value?.name === "NotFoundError" || value?.status === 404,
  )
}

async function saveAlwaysRulesSdk(
  ctx: PermissionContext,
  permissionId: string,
  dir: string,
  approvedAlways: string[],
  deniedAlways: string[],
): Promise<"ok" | "stale" | "error"> {
  return ctx.client!.permission
    .saveAlwaysRules(
      {
        requestID: permissionId,
        directory: dir,
        approvedAlways,
        deniedAlways,
      },
      { throwOnError: true },
    )
    .then(() => "ok" as const)
    .catch((error: unknown) => {
      if (isNotFoundError(error)) return "stale" as const
      console.error("[Kilo New] KiloProvider: Failed to save always-rules:", error)
      ctx.postMessage({ type: "permissionError", permissionID: permissionId })
      return "error" as const
    })
}

async function replySdk(
  ctx: PermissionContext,
  permissionId: string,
  dir: string,
  response: "once" | "always" | "reject",
): Promise<"ok" | "stale" | "error"> {
  return ctx.client!.permission
    .reply({ requestID: permissionId, reply: response, directory: dir }, { throwOnError: true })
    .then(() => "ok" as const)
    .catch((error: unknown) => {
      if (isNotFoundError(error)) return "stale" as const
      console.error("[Kilo New] KiloProvider: Failed to respond to permission:", error)
      ctx.postMessage({ type: "permissionError", permissionID: permissionId })
      return "error" as const
    })
}

// Accepted-only: after-send uncertainty never redispatches SDK and never
// issues the second step. Keep the request identity, re-observe pending once
// via the existing readPermissionsForDir (read-only, absence is not
// acceptance), then surface the existing failure message with no fabricated
// approval/rules. Limitation: the public UI message contract
// (`permissionError` with `permissionID`) cannot distinguish save vs reply
// uncertainty, so both steps surface the same existing failure message.
async function surfaceUnresolved(
  ctx: PermissionContext,
  permissionId: string,
  dir: string,
  opId: string,
  reason: string,
  step: "save" | "reply",
): Promise<void> {
  console.warn(`[Kilo New] KiloProvider: Private permission ${step} uncertain, re-observe pending once`, {
    permissionID: permissionId,
    opId,
    reason: String(reason).slice(0, 120),
  })
  try {
    if (ctx.client) {
      await readPermissionsForDir({ connection: ctx.connection ?? null, client: ctx.client, directory: dir })
    }
  } catch {
    // Read-only re-observation must not fail the unresolved surface.
  }
  console.error(`[Kilo New] KiloProvider: Failed to ${step === "save" ? "save always-rules" : "respond to permission"}: unresolved`, {
    permissionID: permissionId,
    opId,
  })
  ctx.postMessage({ type: "permissionError", permissionID: permissionId })
}

type SaveStep = { done: true } | { done: false; stop: boolean }

async function saveStep(
  ctx: PermissionContext,
  permissionId: string,
  dir: string,
  approvedAlways: string[],
  deniedAlways: string[],
  staleCleanup: () => void,
): Promise<SaveStep> {
  if (approvedAlways.length === 0 && deniedAlways.length === 0) return { done: true }
  let priv: Awaited<ReturnType<typeof savePermissionPrivateFirst>> | null = null
  try {
    priv = await savePermissionPrivateFirst({
      connection: ctx.connection ?? null,
      directory: dir,
      requestID: permissionId,
      approvedAlways,
      deniedAlways,
    })
  } catch (error) {
    await surfaceUnresolved(ctx, permissionId, dir, "unknown", String(error).slice(0, 200), "save")
    return { done: false, stop: true }
  }
  if (priv && priv.outcome.kind === "terminal") return { done: true }
  if (priv && priv.outcome.kind === "terminal-failure") {
    if (priv.outcome.code === "permission.not_found") staleCleanup()
    else {
      console.error("[Kilo New] KiloProvider: Failed to save always-rules:", priv.outcome.code)
      ctx.postMessage({ type: "permissionError", permissionID: permissionId })
    }
    return { done: false, stop: true }
  }
  if (priv && priv.outcome.kind === "unresolved") {
    await surfaceUnresolved(ctx, permissionId, dir, priv.outcome.opId, priv.outcome.reason, "save")
    return { done: false, stop: true }
  }
  const saveResult = await saveAlwaysRulesSdk(ctx, permissionId, dir, approvedAlways, deniedAlways)
  if (saveResult === "stale") staleCleanup()
  return saveResult === "ok" ? { done: true } : { done: false, stop: true }
}

async function replyStep(
  ctx: PermissionContext,
  permissionId: string,
  dir: string,
  response: "once" | "always" | "reject",
  staleCleanup: () => void,
): Promise<void> {
  let rpriv: Awaited<ReturnType<typeof replyPermissionPrivateFirst>> | null = null
  try {
    rpriv = await replyPermissionPrivateFirst({ connection: ctx.connection ?? null, directory: dir, requestID: permissionId, reply: response })
  } catch (error) {
    await surfaceUnresolved(ctx, permissionId, dir, "unknown", String(error).slice(0, 200), "reply")
    return
  }
  if (rpriv && rpriv.outcome.kind === "terminal") return
  if (rpriv && rpriv.outcome.kind === "terminal-failure") {
    if (rpriv.outcome.code === "permission.not_found") staleCleanup()
    else {
      console.error("[Kilo New] KiloProvider: Failed to respond to permission:", rpriv.outcome.code)
      ctx.postMessage({ type: "permissionError", permissionID: permissionId })
    }
    return
  }
  if (rpriv && rpriv.outcome.kind === "unresolved") {
    await surfaceUnresolved(ctx, permissionId, dir, rpriv.outcome.opId, rpriv.outcome.reason, "reply")
    return
  }
  const replyResult = await replySdk(ctx, permissionId, dir, response)
  if (replyResult === "stale") staleCleanup()
}

/**
 * Handle permission response from the webview.
 * Calls saveAlwaysRules first (if any), then reply — sequentially to avoid races.
 * Accepted-only: each step is private-first with exactly one SDK fallback only
 * on proven pre-send; after-send uncertainty surfaces explicit unresolved with
 * zero SDK and no second dispatch, and an unresolved save never issues reply.
 */
export async function handlePermissionResponse(
  ctx: PermissionContext,
  permissionId: string,
  sessionID: string,
  response: "once" | "always" | "reject",
  approvedAlways: string[],
  deniedAlways: string[],
): Promise<void> {
  if (!ctx.client) {
    ctx.postMessage({ type: "permissionError", permissionID: permissionId })
    return
  }

  const target = sessionID || ctx.currentSessionId
  if (!target) {
    console.error("[Kilo New] KiloProvider: No sessionID for permission response")
    ctx.postMessage({ type: "permissionError", permissionID: permissionId })
    return
  }

  const dir = ctx.getPermissionDirectory(permissionId) ?? ctx.getWorkspaceDirectory(target)

  const staleCleanup = () => {
    ctx.clearPermissionDirectory(permissionId)
    ctx.postMessage({ type: "permissionError", permissionID: permissionId, stale: true })
    void fetchAndSendPendingPermissions(ctx)
  }

  const saved = await saveStep(ctx, permissionId, dir, approvedAlways, deniedAlways, staleCleanup)
  if (!saved.done) return
  await replyStep(ctx, permissionId, dir, response, staleCleanup)
}

/**
 * Fetch all pending permissions from the backend and forward any that belong
 * to tracked sessions to the webview. Called after SSE reconnects and after
 * loading messages for a session so that missed permission.asked events are
 * recovered instead of leaving the server blocked indefinitely.
 */
export async function fetchAndSendPendingPermissions(ctx: PermissionContext): Promise<void> {
  if (!ctx.client) return
  try {
    const dirs = recoveryDirs(ctx.getWorkspaceDirectory(), ctx.sessionDirectories)

    const seen = new Set<string>()
    const valid = new Set<string>()
    for (const dir of dirs) {
      let perms: RecoverablePermission[]
      try {
        const read = await readPermissionsForDir({
          connection: ctx.connection ?? null,
          client: ctx.client,
          directory: dir,
        })
        if (read.kind !== "ok") continue
        perms = read.perms as unknown as RecoverablePermission[]
      } catch (error) {
        console.error(`[Kilo New] KiloProvider: Failed to fetch pending permissions for ${dir}:`, error)
        continue
      }
      valid.add(dir)
      for (const perm of recoverablePermissions(perms, ctx.trackedSessionIds, seen)) {
        ctx.recordPermissionDirectory(perm.id, dir)
        ctx.postMessage({
          type: "permissionRequest",
          permission: {
            id: perm.id,
            sessionID: perm.sessionID,
            toolName: perm.permission,
            patterns: perm.patterns,
            always: perm.always,
            args: perm.metadata,
            message: `Permission required: ${perm.permission}`,
            tool: perm.tool,
          },
        })
      }
    }
    ctx.prunePermissionDirectories(seen, valid)
  } catch (error) {
    console.error("[Kilo New] KiloProvider: Failed to fetch pending permissions:", error)
  }
}
