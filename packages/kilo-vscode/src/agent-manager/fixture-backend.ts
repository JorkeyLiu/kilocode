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
  /**
   * Fixture-only SDK read availability (LOCK-PERF-6). Absent means the read
   * succeeded (backward-compatible with pre-flag snapshots and ordinary
   * consumers, which ignore these fields). Explicit `false` means the SDK
   * read failed and the corresponding shape must be treated as
   * snapshot-unobservable — never as idle/marker-absent. No error details
   * are stored here (no secrets/noise).
   */
  statusReadable?: boolean
  messagesReadable?: Record<string, boolean>
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

/**
 * G3/B9 investigation-only queued observation (fixture-only, KILO_E2E_FIXTURE).
 *
 * SDK-visible message/status shape only — NOT backend queue truth, NOT an
 * abort outcome. Records what the served SDK snapshot shows (user-message
 * counts + marker-text presence + status value + assistant presence) after a
 * DOM Send click on a busy session. The true per-session FIFO lives in the
 * `kilo serve` child-process memory and is never read here (no backend queue
 * introspection, no FD/HTTP read, no private carrier). `backendHintAvailable`
 * is always false so a live run never impersonates queue internals.
 * Classification names describe only the SDK-visible shape; the nonbusy bucket
 * covers any non-busy SDK status (idle/retry/offline/unknown) or an assistant
 * message, and is explicitly NOT a terminal/durable abort outcome —
 * Stop/queue-clear semantics are unchanged and unclaimed.
 */
export type QueuedStatus = "busy" | "idle" | "retry" | "offline" | "unknown"

export type QueuedClassification =
  | "marker-visible-busy-no-assistant"
  | "marker-visible-nonbusy-or-assistant"
  | "marker-absent"
  | "snapshot-unobservable"

export interface QueuedObservation {
  scenario: string
  observedAt: string
  sessionID: string
  baselineStatus: QueuedStatus
  status: QueuedStatus
  baselineUserCount: number
  currentUserCount: number
  secondTextPresent: boolean
  hasAssistant: boolean
  backendHintAvailable: boolean
  sendClickAccepted: boolean
  classification: QueuedClassification
}

const QUEUED_SESSION_ID_LIMIT = 256
const QUEUED_MARKER_LIMIT = 200
const QUEUED_COUNT_LIMIT = 1000

function queuedSessionExists(snap: BackendSnapshot, sessionID: string): boolean {
  return snap.sessions.some((s) => s.id === sessionID)
}

/** True when the fixture status read succeeded (absent flag means readable). */
function isQueuedStatusReadable(snap: BackendSnapshot): boolean {
  return snap.statusReadable !== false
}

/** True when the fixture messages read for the session succeeded (absent entry means readable). */
function isQueuedMessagesReadable(snap: BackendSnapshot, sessionID: string): boolean {
  return snap.messagesReadable?.[sessionID] !== false
}

/** User-message count for one session; undefined when the snapshot cannot show it. */
export function countQueuedUserMessages(snap: BackendSnapshot, sessionID: string): number | undefined {
  if (!isQueuedMessagesReadable(snap, sessionID)) return undefined
  if (!queuedSessionExists(snap, sessionID)) return undefined
  const rows = snap.messages[sessionID]
  if (!rows) return undefined
  return rows.filter((m) => m.role === "user").length
}

/** True when any user message of the session contains the bounded marker substring. */
export function queuedSecondMarkerPresent(snap: BackendSnapshot, sessionID: string, marker: string): boolean {
  if (!isQueuedMessagesReadable(snap, sessionID)) return false
  if (marker.length === 0 || marker.length > QUEUED_MARKER_LIMIT) return false
  const rows = snap.messages[sessionID]
  if (!rows) return false
  return rows.some((m) => m.role === "user" && m.text.includes(marker))
}

/** True when the session has any assistant message (no parent linkage in MessageTruth). */
export function queuedHasAssistant(snap: BackendSnapshot, sessionID: string): boolean {
  if (!isQueuedMessagesReadable(snap, sessionID)) return false
  const rows = snap.messages[sessionID]
  if (!rows) return false
  return rows.some((m) => m.role === "assistant")
}

/**
 * SDK-visible status for the queued probe. Only a missing status entry is
 * read as idle (the status endpoint deletes idle sessions from its map).
 * An explicit retry/offline/unknown entry is retained as-is and never folded
 * to idle; an unobservable session (no session row or no messages) is
 * unknown. Any other unexpected raw value is unknown (fail-closed, never
 * asserted as backend queue truth).
 */
export function queuedStatusForSession(snap: BackendSnapshot, sessionID: string): QueuedStatus {
  if (!isQueuedStatusReadable(snap) || !isQueuedMessagesReadable(snap, sessionID)) return "unknown"
  if (!queuedSessionExists(snap, sessionID) || !snap.messages[sessionID]) return "unknown"
  const raw = snap.statuses[sessionID]
  if (raw === undefined) return "idle"
  if (raw === "busy" || raw === "idle" || raw === "retry" || raw === "offline" || raw === "unknown") return raw
  return "unknown"
}

/**
 * Four-bucket SDK-visible-shape classification (marker, not length, is the
 * follow-up signal). Names describe only the SDK snapshot shape — never
 * backend queue truth (queue internals unclaimed):
 * - snapshot-unobservable: the snapshot cannot show the session/messages.
 * - marker-absent: the second marker text is absent from SDK-visible messages.
 * - marker-visible-busy-no-assistant: marker present, SDK status busy, no
 *   assistant message visible.
 * - marker-visible-nonbusy-or-assistant: marker present but the SDK shape is
 *   no longer purely busy-without-assistant (any non-busy status — idle,
 *   retry, offline, unknown — or an assistant message exists). Recorded as
 *   SDK-shape observation only, never as a terminal/durable abort outcome,
 *   never as active-generation interruption.
 */
export function classifyQueuedObservation(
  snap: BackendSnapshot,
  sessionID: string,
  marker: string,
): QueuedClassification {
  if (!isQueuedStatusReadable(snap) || !isQueuedMessagesReadable(snap, sessionID)) return "snapshot-unobservable"
  if (!queuedSessionExists(snap, sessionID) || !snap.messages[sessionID]) return "snapshot-unobservable"
  if (!queuedSecondMarkerPresent(snap, sessionID, marker)) return "marker-absent"
  if (queuedStatusForSession(snap, sessionID) === "busy" && !queuedHasAssistant(snap, sessionID)) {
    return "marker-visible-busy-no-assistant"
  }
  return "marker-visible-nonbusy-or-assistant"
}

function isCanonicalIso(value: unknown): value is string {
  if (typeof value !== "string") return false
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false
  const ms = Date.parse(value)
  if (Number.isNaN(ms)) return false
  return new Date(ms).toISOString() === value
}

/**
 * Build the bounded/redacted queued artifact (SDK-visible shape only, not
 * backend queue truth). Never stores prompt text, titles, paths, or secrets —
 * only the baseline/current SDK-visible status facts, user-message counts,
 * booleans, the run-owned session id, the DOM Send-click fact, and the
 * SDK-shape classification. A failed fixture status/messages read (explicit
 * `false` readability flag) forces `snapshot-unobservable` with the zeroed
 * shape (status unknown, no marker, no assistant, count 0) — never
 * idle/marker-absent. `sendClickAccepted` records only that the DOM Send
 * button click succeeded — never SDK/backend receipt, never queue success.
 * No message count is stored as queue depth. Throws on out-of-bound inputs
 * (fail-fast, no silent clamp).
 */
export function summarizeQueuedObservation(input: {
  scenario: string
  observedAt: string
  sessionID: string
  baselineUserCount: number
  baselineStatus: QueuedStatus
  snap: BackendSnapshot
  marker: string
  sendClickAccepted: boolean
}): QueuedObservation {
  const { scenario, observedAt, sessionID, baselineUserCount, baselineStatus, snap, marker, sendClickAccepted } = input
  if (scenario !== "real-session") throw new Error("queued observation scenario must be real-session")
  if (!isCanonicalIso(observedAt)) throw new Error("queued observation observedAt must be canonical ISO")
  if (!sessionID || sessionID.length > QUEUED_SESSION_ID_LIMIT) throw new Error("queued observation sessionID out of bound")
  if (!Number.isInteger(baselineUserCount) || baselineUserCount < 0 || baselineUserCount > QUEUED_COUNT_LIMIT) {
    throw new Error("queued observation baselineUserCount out of bound")
  }
  if (
    baselineStatus !== "busy" &&
    baselineStatus !== "idle" &&
    baselineStatus !== "retry" &&
    baselineStatus !== "offline" &&
    baselineStatus !== "unknown"
  ) {
    throw new Error("queued observation baselineStatus invalid")
  }
  if (marker.length === 0 || marker.length > QUEUED_MARKER_LIMIT) throw new Error("queued observation marker out of bound")
  const classification = classifyQueuedObservation(snap, sessionID, marker)
  if (classification === "snapshot-unobservable") {
    return {
      scenario,
      observedAt,
      sessionID,
      baselineStatus,
      status: "unknown",
      baselineUserCount,
      currentUserCount: 0,
      secondTextPresent: false,
      hasAssistant: false,
      backendHintAvailable: false,
      sendClickAccepted,
      classification,
    }
  }
  const current = countQueuedUserMessages(snap, sessionID)
  const status = queuedStatusForSession(snap, sessionID)
  const secondTextPresent = queuedSecondMarkerPresent(snap, sessionID, marker)
  const hasAssistant = queuedHasAssistant(snap, sessionID)
  const currentUserCount = current ?? 0
  if (!Number.isInteger(currentUserCount) || currentUserCount < 0 || currentUserCount > QUEUED_COUNT_LIMIT) {
    throw new Error("queued observation currentUserCount out of bound")
  }
  return {
    scenario,
    observedAt,
    sessionID,
    baselineStatus,
    status,
    baselineUserCount,
    currentUserCount,
    secondTextPresent,
    hasAssistant,
    backendHintAvailable: false,
    sendClickAccepted,
    classification,
  }
}

/**
 * Exact-keys bounded validator for `queued-observation.json` (fixture-only
 * SDK-visible-shape artifact). Fail-closed: exact keys, real-session scenario
 * only, canonical ISO, bounded counts, SDK status enums (retry/offline kept,
 * never folded), new SDK-shape classification only (prior overclaim
 * classification values rejected), and
 * cross-field invariants binding classification to the SDK-visible
 * status/marker/assistant/count combination. `sendClickAccepted` is a DOM-click
 * fact only and is never bound to classification success.
 */
// eslint-disable-next-line complexity
export function validateQueuedObservation(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "not an object"
  const p = parsed as Record<string, unknown>
  const keys = Object.keys(p).sort()
  const want = [
    "backendHintAvailable",
    "baselineStatus",
    "baselineUserCount",
    "classification",
    "currentUserCount",
    "hasAssistant",
    "observedAt",
    "scenario",
    "secondTextPresent",
    "sendClickAccepted",
    "sessionID",
    "status",
  ].sort()
  if (keys.length !== want.length || !keys.every((k, i) => k === want[i])) {
    return `keys mismatch: got [${keys.join(",")}] want [${want.join(",")}]`
  }
  if (p.scenario !== "real-session") return "scenario must be real-session"
  if (!isCanonicalIso(p.observedAt)) return "observedAt must be canonical ISO date (toISOString with milliseconds and UTC)"
  if (typeof p.sessionID !== "string" || p.sessionID.length === 0 || p.sessionID.length > QUEUED_SESSION_ID_LIMIT) {
    return "sessionID invalid"
  }
  const isQueuedStatus = (v: unknown): v is QueuedStatus =>
    v === "busy" || v === "idle" || v === "retry" || v === "offline" || v === "unknown"
  if (!isQueuedStatus(p.status)) return "status invalid"
  if (!isQueuedStatus(p.baselineStatus)) return "baselineStatus invalid"
  for (const k of ["baselineUserCount", "currentUserCount"] as const) {
    const v = p[k]
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > QUEUED_COUNT_LIMIT) return `${k} invalid`
  }
  for (const k of ["secondTextPresent", "hasAssistant", "backendHintAvailable", "sendClickAccepted"] as const) {
    if (typeof p[k] !== "boolean") return `${k} must be boolean`
  }
  if (
    p.classification !== "marker-visible-busy-no-assistant" &&
    p.classification !== "marker-visible-nonbusy-or-assistant" &&
    p.classification !== "marker-absent" &&
    p.classification !== "snapshot-unobservable"
  ) {
    return "classification invalid"
  }
  if (p.backendHintAvailable !== false) return "backendHintAvailable must be false (SDK-only path)"
  const c = p.classification as QueuedClassification
  const status = p.status as QueuedStatus
  const marker = p.secondTextPresent as boolean
  const assistant = p.hasAssistant as boolean
  const baseline = p.baselineUserCount as number
  const current = p.currentUserCount as number
  if (c === "snapshot-unobservable") {
    if (status !== "unknown") return "classification/status mismatch: snapshot-unobservable requires status unknown"
    if (marker !== false) return "classification/shape mismatch: snapshot-unobservable requires secondTextPresent false"
    if (assistant !== false) return "classification/shape mismatch: snapshot-unobservable requires hasAssistant false"
    if (current !== 0) return "classification/shape mismatch: snapshot-unobservable requires currentUserCount 0"
  } else {
    if (current < baseline) return "count mismatch: currentUserCount must be >= baselineUserCount when observable"
    if (c === "marker-absent") {
      if (marker !== false) return "classification/marker mismatch: marker-absent requires secondTextPresent false"
    } else if (c === "marker-visible-busy-no-assistant") {
      if (!marker || status !== "busy" || assistant !== false) {
        return "classification/shape mismatch: marker-visible-busy-no-assistant requires marker present, status busy, no assistant"
      }
    } else {
      if (!marker) return "classification/marker mismatch: marker-visible-nonbusy-or-assistant requires secondTextPresent true"
      if (status === "busy" && assistant === false) {
        return "classification/shape mismatch: busy without assistant must be marker-visible-busy-no-assistant"
      }
    }
    if (status === "busy" && marker && !assistant && c !== "marker-visible-busy-no-assistant") {
      return "classification/shape mismatch: SDK-visible busy marker without assistant must classify busy-no-assistant"
    }
  }
  const text = JSON.stringify(parsed)
  if (text.includes("e2e-fixture-key") || text.includes("KILO_SERVER_PASSWORD")) return "leaked secret string"
  return null
}
