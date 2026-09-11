import { Effect } from "effect"
import { Session } from "../session/session"
import { SessionID } from "../session/schema"
import { SessionRevertBoundary } from "../session/revert-boundary"
import { SnapshotJournal } from "./journal"

// kilocode_change - Snapshot v2 journal restore coverage planner. Read-only
// safety adjudicator: given a revert target it returns a verdict deciding
// whether the interval may later enter journal CAS (complete) or must fall
// back to the old Snapshot path as a whole (incomplete, never mixed). It
// reads authoritative messages/parts and the journal only; it never reads
// blobs or the filesystem, never checks current hashes, and never executes
// any restore.

export namespace SnapshotCoveragePlan {
  export const ReasonCode = {
    BoundaryNotFound: "boundary_not_found",
    ToolPending: "tool_pending",
    OpaqueTool: "opaque_tool",
    JournalMissing: "journal_missing",
    JournalCoverage: "journal_coverage",
    RowMissing: "row_missing",
    RowStatus: "row_status",
    RowScopeMismatch: "row_scope_mismatch",
    RowOrderMismatch: "row_order_mismatch",
    OrphanRow: "orphan_row",
  } as const
  export type ReasonCode = (typeof ReasonCode)[keyof typeof ReasonCode]

  export interface Reason {
    readonly code: ReasonCode
    readonly messageID?: string
    readonly callID?: string
    readonly tool?: string
    readonly rowID?: string
    readonly detail?: string
  }

  export interface Call {
    readonly messageID: string
    readonly callID: string
    readonly tool: string
    readonly partID: string
  }

  export interface Boundary {
    readonly messageID: string
    readonly partID?: string
  }

  export interface Plan {
    readonly sessionID: string
    readonly boundary?: Boundary
    readonly messages: string[]
    readonly calls: Call[]
    readonly applyOrder: string[]
    readonly verdict: "complete" | "incomplete"
    readonly reasons: Reason[]
    readonly fallback: "journal-cas" | "old-snapshot"
  }

  export interface InputMessage {
    readonly info: { readonly id: string; readonly role: string }
    readonly parts: readonly InputPart[]
  }

  export interface InputPart {
    readonly id: string
    readonly type: string
    readonly callID?: string
    readonly tool?: string
    readonly state?: { readonly status: string; readonly metadata?: Record<string, unknown> }
    readonly metadata?: Record<string, unknown>
  }

  export type Kind = "writer" | "safe" | "opaque"

  // edit|write|apply_patch are the only journal-capable writers.
  const writers = new Set(["edit", "write", "apply_patch"])

  // Minimal closed set of read-only / file-side-effect-free builtins,
  // evidenced by the ToolRegistry builtin list. Everything else (shell/bash,
  // task, background_process, interactive_terminal, MCP, custom/plugin,
  // unknown) defaults to opaque.
  const safe = new Set([
    "read",
    "glob",
    "grep",
    "webfetch",
    "websearch",
    "codebase_search",
    "skill",
    "question",
    "todowrite",
    "invalid",
  ])

  export const classify = (tool: string): Kind => {
    if (writers.has(tool)) return "writer"
    if (safe.has(tool)) return "safe"
    return "opaque"
  }

  // Undo order is defined as reverse(apply); it is never stored separately.
  export const undo = (plan: Plan): string[] => [...plan.applyOrder].reverse()

  // NUL separator avoids message/call collisions; fromCharCode keeps the file text-reviewable.
  const key = (messageID: string, callID: string) => messageID + String.fromCharCode(0) + callID

  const journalOf = (part: InputPart): { coverage: unknown; ids: unknown } | undefined => {
    const sources = [part.metadata, part.state?.metadata]
    for (const source of sources) {
      const journal = (source as { journal?: unknown } | undefined)?.journal
      if (journal && typeof journal === "object") return journal as { coverage: unknown; ids: unknown }
    }
    return undefined
  }

  const byPath = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

  const orderRows = <T extends { item: number; sub: number; path: string; id: string }>(rows: readonly T[]): T[] =>
    [...rows].sort((a, b) => a.item - b.item || a.sub - b.sub || byPath(a.path, b.path) || byPath(a.id, b.id))

  export const plan = (input: {
    readonly sessionID: string
    readonly messageID: string
    readonly partID?: string
    readonly messages: readonly InputMessage[]
    readonly rows: readonly SnapshotJournal.Row[]
  }): Plan => {
    const base = {
      sessionID: input.sessionID,
      messages: [] as string[],
      calls: [] as Call[],
      applyOrder: [] as string[],
      reasons: [] as Reason[],
    }
    const boundary = SessionRevertBoundary.resolve(input.messages, {
      messageID: input.messageID,
      partID: input.partID,
    })
    if (!boundary)
      return {
        ...base,
        verdict: "incomplete",
        fallback: "old-snapshot",
        reasons: [{ code: ReasonCode.BoundaryNotFound, detail: input.partID ?? input.messageID }],
      }

    const out: Boundary = boundary.partID
      ? { messageID: boundary.messageID, partID: boundary.partID }
      : { messageID: boundary.messageID }

    type Hit = Call & { msg: number; idx: number; part: InputPart }
    const hits: Hit[] = []
    // Tool-call interval follows cleanup-deletion semantics, not patch
    // collection semantics (SessionRevertBoundary.patchesAfter is strictly
    // after the physical anchor). A part-level target is deleted by cleanup
    // slice(idx), so the target tool itself is included; a message-level
    // target (including part-level fallback with no resolved partID) deletes
    // the whole physical message, so all its tool calls are included.
    const fromInclusive = boundary.partID !== undefined ? boundary.partIndex : 0
    for (let i = boundary.messageIndex; i < input.messages.length; i++) {
      const msg = input.messages[i]!
      const from = i === boundary.messageIndex ? fromInclusive : 0
      for (let j = from; j < msg.parts.length; j++) {
        const part = msg.parts[j]!
        if (part.type !== "tool" || !part.callID || !part.tool) continue
        hits.push({ messageID: msg.info.id, callID: part.callID, tool: part.tool, partID: part.id, msg: i, idx: j, part })
      }
    }

    const seen = new Set<string>()
    const messages = hits.filter((hit) => (seen.has(hit.messageID) ? false : (seen.add(hit.messageID), true))).map((hit) => hit.messageID)

    const reasons: Reason[] = []
    const byId = new Map(input.rows.map((row) => [row.id, row]))
    const claimed = new Set<string>()
    type Applied = { id: string; msg: number; idx: number; item: number; sub: number; path: string }
    const applied: Applied[] = []

    for (const hit of hits) {
      const status = hit.part.state?.status
      if (status === "pending" || status === "running") {
        reasons.push({ code: ReasonCode.ToolPending, messageID: hit.messageID, callID: hit.callID, tool: hit.tool })
        continue
      }
      const kind = classify(hit.tool)
      if (kind === "opaque") {
        reasons.push({ code: ReasonCode.OpaqueTool, messageID: hit.messageID, callID: hit.callID, tool: hit.tool })
        continue
      }
      if (kind === "safe") continue

      const raw = journalOf(hit.part)
      if (!raw) {
        reasons.push({ code: ReasonCode.JournalMissing, messageID: hit.messageID, callID: hit.callID, tool: hit.tool })
        continue
      }
      const coverage = typeof raw.coverage === "string" ? raw.coverage : ""
      const ids = Array.isArray(raw.ids) ? raw.ids.filter((id): id is string => typeof id === "string") : []
      if (coverage !== "full" || ids.length === 0) {
        for (const id of ids) {
          const row = byId.get(id)
          if (row) claimed.add(id)
        }
        reasons.push({
          code: ReasonCode.JournalCoverage,
          messageID: hit.messageID,
          callID: hit.callID,
          tool: hit.tool,
          detail: coverage || "(missing)",
        })
        continue
      }

      let ok = true
      const found: SnapshotJournal.Row[] = []
      for (const id of ids) {
        const row = byId.get(id)
        if (!row) {
          reasons.push({ code: ReasonCode.RowMissing, messageID: hit.messageID, callID: hit.callID, tool: hit.tool, rowID: id })
          ok = false
          continue
        }
        claimed.add(id)
        found.push(row)
        if (row.status !== "applied") {
          reasons.push({
            code: ReasonCode.RowStatus,
            messageID: hit.messageID,
            callID: hit.callID,
            tool: hit.tool,
            rowID: id,
            detail: row.status,
          })
          ok = false
        }
        if (row.session_id !== input.sessionID || row.message_id !== hit.messageID || row.call_id !== hit.callID || row.tool !== hit.tool) {
          reasons.push({
            code: ReasonCode.RowScopeMismatch,
            messageID: hit.messageID,
            callID: hit.callID,
            tool: hit.tool,
            rowID: id,
          })
          ok = false
        }
        if (row.op === "move") {
          reasons.push({
            code: ReasonCode.RowOrderMismatch,
            messageID: hit.messageID,
            callID: hit.callID,
            tool: hit.tool,
            rowID: id,
            detail: "legacy single-row move",
          })
          ok = false
        }
      }
      if (!ok) continue

      const want = orderRows(found.map((row) => ({ id: row.id, item: row.item_index, sub: row.sub_index, path: row.path }))).map(
        (row) => row.id,
      )
      if (want.length !== ids.length || want.some((id, at) => id !== ids[at])) {
        reasons.push({
          code: ReasonCode.RowOrderMismatch,
          messageID: hit.messageID,
          callID: hit.callID,
          tool: hit.tool,
          detail: "ids order differs from canonical item/sub/path order",
        })
        continue
      }
      const subs = new Map<number, number[]>()
      for (const row of found) {
        const list = subs.get(row.item_index) ?? []
        list.push(row.sub_index)
        subs.set(row.item_index, list)
      }
      const dangling = [...subs.values()].some((list) => list.includes(1) && !list.includes(0))
      if (dangling) {
        reasons.push({
          code: ReasonCode.RowOrderMismatch,
          messageID: hit.messageID,
          callID: hit.callID,
          tool: hit.tool,
          detail: "move source delete without target fact",
        })
        continue
      }
      for (const row of found)
        applied.push({ id: row.id, msg: hit.msg, idx: hit.idx, item: row.item_index, sub: row.sub_index, path: row.path })
    }

    const keys = new Set(hits.map((hit) => key(hit.messageID, hit.callID)))
    for (const row of input.rows) {
      if (row.session_id !== input.sessionID) continue
      if (!keys.has(key(row.message_id, row.call_id))) continue
      if (claimed.has(row.id)) continue
      reasons.push({
        code: ReasonCode.OrphanRow,
        messageID: row.message_id,
        callID: row.call_id,
        tool: row.tool,
        rowID: row.id,
        detail: row.status,
      })
    }

    const applyOrder = [...applied]
      .sort((a, b) => a.msg - b.msg || a.idx - b.idx || a.item - b.item || a.sub - b.sub || byPath(a.path, b.path) || byPath(a.id, b.id))
      .map((row) => row.id)

    const calls: Call[] = hits.map((hit) => ({ messageID: hit.messageID, callID: hit.callID, tool: hit.tool, partID: hit.partID }))
    return {
      sessionID: input.sessionID,
      boundary: out,
      messages,
      calls,
      applyOrder,
      reasons,
      verdict: reasons.length === 0 ? "complete" : "incomplete",
      fallback: reasons.length === 0 ? "journal-cas" : "old-snapshot",
    }
  }

  // Thin read-only adapter. The caller injects Session.Service and
  // SnapshotJournal.Service (production AppLayer provides the single
  // canonical journal); this module owns no layer and creates no instance.
  export const planFor = (input: { readonly sessionID: string; readonly messageID: string; readonly partID?: string }) =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const journal = yield* SnapshotJournal.Service
      const messages = yield* sessions.messages({ sessionID: input.sessionID as SessionID }).pipe(Effect.orDie)
      const rows = yield* journal.list({ sessionID: input.sessionID })
      return plan({ sessionID: input.sessionID, messageID: input.messageID, partID: input.partID, messages, rows })
    })
}
