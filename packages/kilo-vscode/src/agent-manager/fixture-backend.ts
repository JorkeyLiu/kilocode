/**
 * E2E fixture backend-truth helpers (KILO_E2E_FIXTURE only).
 *
 * Pure normalization of served-backend responses into the compact snapshot the
 * extension-host runner writes for the harness to assert in the real-session
 * scenario. No vscode import, no production path dependence: the env-gated
 * fixture command in AgentManagerProvider is the only caller, and the harness
 * (script/e2e-probe.ts) shares this type so the asserted shape is the same
 * one the runner produced.
 */

import type {
  Message,
  McpStatus,
  Part,
  PermissionRequest,
  QuestionRequest,
  Session,
  SessionStatus,
  ToolStateCompleted,
} from "@kilocode/sdk/v2/client"

export interface ModelTruth {
  providerID: string
  modelID: string
  variant?: string
}

/** Backend session.revert fact — the active revert/checkpoint boundary (H-12). */
export interface RevertTruth {
  messageID: string
  partID?: string
  snapshot?: string
  diff?: string
}

/** Backend session.summary fact — file diff stats the RevertBanner renders. */
export interface SummaryFileTruth {
  file?: string
  additions: number
  deletions: number
  status?: "added" | "deleted" | "modified"
}

export interface SummaryTruth {
  additions: number
  deletions: number
  files: number
  diffs?: SummaryFileTruth[]
}

export interface SessionTruth {
  id: string
  title: string
  agent: string | null
  model: ModelTruth | null
  /** Backend parentID edge — the first-class parent-child relation (H-2/H-7). */
  parentID: string | null
  /** Active revert/checkpoint boundary, present while the session is reverted. */
  revert?: RevertTruth
  /** Backend diff summary (the RevertBanner's per-file diff source). */
  summary?: SummaryTruth
  createdAt: number
  updatedAt: number
}

/**
 * Relevant tool-part summary — the tool name, call status, output excerpt,
 * and the part metadata (e.g. the task child session id). Deliberately a
 * compact excerpt of served-backend truth, never a full transcript copy.
 */
export interface ToolPartTruth {
  tool: string
  status: string
  callID?: string
  output?: string
  title?: string
  metadata?: Record<string, unknown>
}

/**
 * H-13: typed fact for the internal context-overflow safeguard — the
 * `compaction` part the served backend writes on auto-compaction. The SDK's
 * generated CompactionPart type only declares `auto`, so `overflow` and
 * `tailStartID` are read defensively from the raw served JSON.
 */
export interface CompactionTruth {
  auto: boolean
  /**
   * Production meaning (session/prompt.ts → compaction.create): `true` is
   * reserved for unfinished-stream provider overflow (stream did not finish
   * with a compact error). The usage-threshold-at-finish and preflight
   * estimate paths write `false` (or omit the field), so the real-overflow
   * E2E scenario expects the compaction fact `false`/absent — never `true`.
   */
  overflow?: boolean
  tailStartID?: string
}

export interface MessageTruth {
  id: string
  role: "user" | "assistant"
  agent?: string
  model?: ModelTruth
  text: string
  /** Completed tool-part summaries (task delegation, user tool, skill, MCP, question). */
  tools?: ToolPartTruth[]
  /** H-13: the message carries the internal auto-compaction part (overflow safeguard). */
  compaction?: CompactionTruth
  /** H-13: the assistant message is the compaction summary (summary: true). */
  summary?: boolean
  /** H-13: the user message is the synthetic automatic-continuation prompt. */
  continuation?: boolean
}

/** Minimal pending-permission fact for the H-6 inline dock flow. */
export interface PermissionTruth {
  id: string
  sessionID: string
  permission: string
  patterns: string[]
}

/** Minimal pending-question fact for the H-6 inline dock flow. */
export interface QuestionTruth {
  id: string
  sessionID: string
  questions: Array<{ question: string; options: string[] }>
}

/** MCP server status map ({name} -> status type) for the H-5 connected assertion. */
export interface McpTruth {
  [name: string]: string
}

export interface BackendSnapshot {
  requestedAt: string
  sessions: SessionTruth[]
  messages: Record<string, MessageTruth[]>
  statuses: Record<string, string>
  agents: string[]
  connectedProviders: string[]
  /** Served MCP server statuses (absent when the fixture could not fetch them). */
  mcp?: McpTruth
  /** Pending permission/question requests observable through the real API. */
  pending?: { permissions: PermissionTruth[]; questions: QuestionTruth[] }
  /** Backend-derived children per session id (real session.children queries). */
  children?: Record<string, string[]>
}

/** Session.model carries `id`; the message model carries `modelID` — normalize both. */
function sessionModel(s: Session): ModelTruth | null {
  const m = s.model
  if (!m) return null
  return { providerID: m.providerID, modelID: m.id, ...(m.variant ? { variant: m.variant } : {}) }
}

/** Only user messages pin the per-session model/variant in the transcript. */
function messageModel(m: Message): ModelTruth | null {
  if (m.role !== "user" || !m.model) return null
  return {
    providerID: m.model.providerID,
    modelID: m.model.modelID,
    ...(m.model.variant ? { variant: m.model.variant } : {}),
  }
}

export function summarizeSession(s: Session): SessionTruth {
  return {
    id: s.id,
    title: s.title,
    agent: s.agent ?? null,
    model: sessionModel(s),
    parentID: s.parentID ?? null,
    ...(s.revert ? { revert: { ...s.revert } } : {}),
    ...(s.summary
      ? {
          summary: {
            additions: s.summary.additions,
            deletions: s.summary.deletions,
            files: s.summary.files,
            ...(s.summary.diffs && s.summary.diffs.length > 0 ? { diffs: s.summary.diffs } : {}),
          },
        }
      : {}),
    createdAt: s.time.created,
    updatedAt: s.time.updated,
  }
}

/** Only completed tool parts carry the facts the harness asserts on. */
export function summarizeToolParts(parts: Part[]): ToolPartTruth[] | undefined {
  const tools = parts
    .filter((p): p is Extract<Part, { type: "tool" }> => p.type === "tool")
    .filter(
      (p): p is Extract<Part, { type: "tool" }> & { state: ToolStateCompleted } => p.state.status === "completed",
    )
    .map((p) => {
      const out: ToolPartTruth = {
        tool: p.tool,
        status: p.state.status,
        callID: p.callID,
        ...(typeof p.state.output === "string" ? { output: p.state.output } : {}),
        ...(p.state.title ? { title: p.state.title } : {}),
        ...(Object.keys(p.state.metadata ?? {}).length > 0 ? { metadata: p.state.metadata } : {}),
      }
      return out
    })
  return tools.length > 0 ? tools : undefined
}

export function summarizeMessage(row: { info: Message; parts: Part[] }): MessageTruth {
  const text = row.parts
    .filter((p): p is Extract<Part, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("\n")
  const model = messageModel(row.info)
  const tools = summarizeToolParts(row.parts)
  // H-13: typed fact for the internal overflow safeguard — the compaction
  // part on a user message (auto + overflow + tail_start_id from the raw
  // served JSON), the summary flag on the compacting assistant, and the
  // synthetic automatic-continuation user message (text part metadata
  // `compaction_continue`, written by compaction.process).
  const compactionPart = row.parts.find(
    (p): p is Extract<Part, { type: "compaction" }> => p.type === "compaction",
  )
  const compaction: CompactionTruth | undefined = compactionPart
    ? {
        auto: compactionPart.auto,
        ...(typeof (compactionPart as { overflow?: unknown }).overflow === "boolean"
          ? { overflow: (compactionPart as { overflow: boolean }).overflow }
          : {}),
        ...(typeof (compactionPart as { tail_start_id?: unknown }).tail_start_id === "string"
          ? { tailStartID: (compactionPart as { tail_start_id: string }).tail_start_id }
          : {}),
      }
    : undefined
  const continuation =
    row.parts.some(
      (p) =>
        p.type === "text" &&
        !!(p as { metadata?: Record<string, unknown> }).metadata?.compaction_continue,
    ) || undefined
  return {
    id: row.info.id,
    role: row.info.role,
    agent: row.info.agent,
    ...(model ? { model } : {}),
    text,
    ...(tools ? { tools } : {}),
    ...(compaction ? { compaction } : {}),
    // H-13: the compaction summary assistant is flagged summary: true (the
    // served backend also attaches the per-message session summary object
    // `{diffs}` to USER messages, so only the strict boolean marks the
    // summary assistant).
    ...((row.info as { summary?: unknown }).summary === true ? { summary: true } : {}),
    ...(continuation ? { continuation } : {}),
  }
}

export function summarizeStatuses(statuses: Record<string, SessionStatus>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [id, status] of Object.entries(statuses)) out[id] = status.type
  return out
}

/** Normalize the served MCP status map to {name -> status type}. */
export function summarizeMcp(statuses: Record<string, McpStatus>): McpTruth {
  const out: McpTruth = {}
  for (const [name, status] of Object.entries(statuses)) out[name] = status.status
  return out
}

/** Minimal pending-permission facts (id/session/permission/patterns). */
export function summarizePermissions(perms: PermissionRequest[]): PermissionTruth[] {
  return perms.map((p) => ({
    id: p.id,
    sessionID: p.sessionID,
    permission: p.permission,
    patterns: p.patterns,
  }))
}

/** Minimal pending-question facts (id/session/question text + option labels). */
export function summarizeQuestions(questions: QuestionRequest[]): QuestionTruth[] {
  return questions.map((q) => ({
    id: q.id,
    sessionID: q.sessionID,
    questions: q.questions.map((item) => ({
      question: item.question,
      options: item.options.map((o) => o.label),
    })),
  }))
}
