import { resolve, relative as relativePath } from "path"
import { MessageV2 } from "@/session/message-v2"
import { KiloPartLifecycle } from "./part-lifecycle"

export { canonicalDirectory } from "./canonical-directory"

const task = "task"
const stale = /^[ \t]*task_id:[^\r\n]*(?:(?:\r?\n){1,2}|$)/m

export function getForkedTitle(title: string): string {
  const match = title.match(/^(.+) \(fork #(\d+)\)$/)
  if (match) {
    const base = match[1]
    const num = parseInt(match[2]!, 10)
    return `${base} (fork #${num + 1})`
  }
  return `${title} (fork #1)`
}

export function sessionPath(worktree: string, cwd: string): string {
  return relativePath(resolve(worktree), resolve(cwd)).replaceAll("\\", "/")
}

export function filterMessagesForFork<T extends { id: string }>(items: T[], checkpointId?: string | null): T[] {
  if (!checkpointId) return items
  const idx = items.findIndex((r) => (r.id as string) >= (checkpointId as string))
  if (idx === -1) return items.slice()
  return items.slice(0, idx)
}

export type ForkModel = { id: string; providerID: string; variant?: string }

function normalizeForkModel(raw: unknown): ForkModel | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const r = raw as Record<string, unknown>
  const id = (r.id as string) ?? (r.modelID as string)
  const providerID = r.providerID as string
  if (typeof id !== "string" || typeof providerID !== "string") return undefined
  const variant = r.variant as string | undefined
  return { id, providerID, ...(variant !== undefined ? { variant } : {}) }
}

export function resolveForkModelAtCheckpoint(input: {
  sourceModel?: ForkModel | null
  checkpointId?: string | null
  orderedMessages: Array<{ id: string; role: string; model?: unknown }>
}): ForkModel | undefined {
  if (!input.checkpointId) {
    return input.sourceModel ? { ...input.sourceModel } : undefined
  }
  const idx = input.orderedMessages.findIndex((m) => m.id >= (input.checkpointId as string))
  const filtered = idx === -1 ? input.orderedMessages : input.orderedMessages.slice(0, idx)
  for (let i = filtered.length - 1; i >= 0; i--) {
    const row = filtered[i]!
    if (row.role !== "user") continue
    const normalized = normalizeForkModel(row.model)
    if (normalized) return normalized
    return undefined
  }
  return undefined
}

export function cloneMessageDataForFork(oldData: Record<string, unknown>, idMap: Map<string, string>): Record<string, unknown> {
  const role = oldData.role as string | undefined
  const rawParent = oldData.parentID as string | undefined
  const mappedParent = role === "assistant" && rawParent ? idMap.get(rawParent) : undefined
  const cloned: Record<string, unknown> = {
    ...oldData,
    ...(rawParent !== undefined ? { parentID: mappedParent ?? rawParent } : {}),
    ...(role === "assistant" ? { cost: 0 } : {}),
  }
  return cloned
}

export function clonePartDataForFork(prepared: MessageV2.Part, idMap: Map<string, string>): Record<string, unknown> {
  const base: Record<string, unknown> = {
    ...prepared,
    ...(prepared.type === "step-finish" ? { cost: 0 } : {}),
  }
  if ((base as { type: string }).type === "compaction" && (base as { tail_start_id?: string }).tail_start_id) {
    const raw = (base as { tail_start_id: string }).tail_start_id
    const mapped = idMap.get(raw)
    // canonical compaction-tail contract: preserve legacy unmapped behavior (mapped may be undefined -> assign undefined)
    ;(base as Record<string, unknown>).tail_start_id = mapped as unknown as string | undefined
  }
  return base
}

// Prepare a source part for a forked transcript copy: drop transient parts (returns undefined) and detach
// task calls into historical results. The caller assigns fresh ids and publishes via Session.updatePart.
export function prepareForkedPart(part: MessageV2.Part): MessageV2.Part | undefined {
  if (KiloPartLifecycle.transient(part)) return undefined
  return structuredClone(detachPart(part))
}

function metadata(value: Record<string, unknown> | undefined) {
  if (!value) return value
  const copy = { ...value }
  delete copy.sessionId
  delete copy.sessionID
  return copy
}

function input(value: Record<string, unknown>) {
  const copy = { ...value }
  delete copy.task_id
  return copy
}

/**
 * Turns copied task calls into detached historical results.
 *
 * Child sessions are execution state, not conversation context. Their final
 * result is already embedded in the parent task part, so a fork keeps that
 * result while dropping references that could resume, stream, or route prompts
 * to a child owned by the source session.
 */
function detachPart(part: MessageV2.Part): MessageV2.Part {
  if (part.type !== "tool" || part.tool !== task) return part

  const top = metadata(part.metadata)
  const state = part.state
  if (state.status === "pending") {
    const now = Date.now()
    return {
      ...part,
      metadata: top,
      state: {
        status: "error",
        input: input(state.input),
        error: "Task was still pending when this session was forked.",
        time: { start: now, end: now },
      },
    }
  }

  if (state.status === "running") {
    return {
      ...part,
      metadata: top,
      state: {
        status: "error",
        input: input(state.input),
        error: "Task was still running when this session was forked.",
        metadata: metadata(state.metadata),
        time: { start: state.time.start, end: Date.now() },
      },
    }
  }

  if (state.status === "error") {
    return {
      ...part,
      metadata: top,
      state: {
        ...state,
        input: input(state.input),
        metadata: metadata(state.metadata),
      },
    }
  }

  return {
    ...part,
    metadata: top,
    state: {
      ...state,
      input: input(state.input),
      output: state.output.replace(stale, ""),
      metadata: metadata(state.metadata) ?? {},
    },
  }
}
