import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Session } from "@/session/session"
import { MessageID, PartID } from "@/session/schema"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { SnapshotJournal } from "@/snapshot/journal"
import { SnapshotCoveragePlan } from "@/snapshot/coverage-plan"
import { SessionRevertBoundary } from "@/session/revert-boundary"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

type Msg = SnapshotCoveragePlan.InputMessage
type Seg = Msg["parts"][number]

const text = (id: string): Seg => ({ id, type: "text" })
const tool = (id: string, name: string, call: string, opts?: { status?: string; journal?: unknown }): Seg => ({
  id,
  type: "tool",
  callID: call,
  tool: name,
  state: { status: opts?.status ?? "completed" },
  ...(opts?.journal !== undefined ? { metadata: { journal: opts.journal } } : {}),
})
const msg = (id: string, role: string, parts: Seg[]): Msg => ({ info: { id, role }, parts })
const full = (ids: string[]) => ({ coverage: "full", ids })

const row = (over: Partial<SnapshotJournal.Row> & { id: string }): SnapshotJournal.Row =>
  ({
    session_id: "s",
    message_id: "a",
    call_id: "c1",
    tool: "edit",
    item_index: 0,
    sub_index: 0,
    directory: "/tmp",
    worktree: "/tmp",
    path: "f.txt",
    target_path: null,
    op: "update",
    status: "applied",
    before_blob: null,
    after_blob: null,
    before_hash: null,
    before_size: null,
    after_hash: null,
    after_size: null,
    encoding: null,
    bom: null,
    diagnostic: null,
    error: null,
    time_applied: null,
    time_created: 0,
    time_updated: 0,
    ...over,
  }) as SnapshotJournal.Row

const codes = (plan: SnapshotCoveragePlan.Plan) => plan.reasons.map((item) => item.code)

describe("SnapshotCoveragePlan boundary", () => {
  test("message-level revert to a tool-led message falls back to the last user", () => {
    const c = tool("p1", "edit", "c1", { journal: full(["r1"]) })
    const messages = [msg("u", "user", [text("t0")]), msg("a", "assistant", [c])]
    const rows = [row({ id: "r1", message_id: "a", call_id: "c1" })]
    const plan = SnapshotCoveragePlan.plan({ sessionID: "s", messageID: "a", messages, rows })
    expect(plan.boundary).toEqual({ messageID: "u" })
    expect(plan.calls.map((item) => item.callID)).toEqual(["c1"])
    expect(plan.verdict).toBe("complete")
  })

  test("partID midpoint retains earlier calls and includes later calls", () => {
    const c1 = tool("p1", "edit", "c1", { journal: full(["r1"]) })
    const c2 = tool("p3", "edit", "c2", { journal: full(["r2"]) })
    const messages = [msg("u", "user", [text("t0")]), msg("a", "assistant", [c1, text("t1"), c2])]
    const rows = [
      row({ id: "r1", message_id: "a", call_id: "c1" }),
      row({ id: "r2", message_id: "a", call_id: "c2" }),
    ]
    const plan = SnapshotCoveragePlan.plan({ sessionID: "s", messageID: "a", partID: "t1", messages, rows })
    expect(plan.boundary).toEqual({ messageID: "a", partID: "t1" })
    expect(plan.calls.map((item) => item.callID)).toEqual(["c2"])
    expect(plan.applyOrder).toEqual(["r2"])
    expect(plan.verdict).toBe("complete")
  })

  test("target tool call preceded by text keeps its own part boundary", () => {
    const c1 = tool("p2", "edit", "c1", { journal: full(["r1"]) })
    const messages = [msg("u", "user", [text("t0")]), msg("a", "assistant", [text("t1"), c1])]
    const rows = [row({ id: "r1", message_id: "a", call_id: "c1" })]
    const plan = SnapshotCoveragePlan.plan({ sessionID: "s", messageID: "a", partID: "p2", messages, rows })
    expect(plan.boundary).toEqual({ messageID: "a", partID: "p2" })
    expect(plan.calls.map((item) => item.callID)).toEqual(["c1"])
    expect(plan.verdict).toBe("complete")
  })

  test("unknown target yields boundary_not_found", () => {
    const plan = SnapshotCoveragePlan.plan({ sessionID: "s", messageID: "nope", messages: [], rows: [] })
    expect(plan.verdict).toBe("incomplete")
    expect(plan.fallback).toBe("old-snapshot")
    expect(codes(plan)).toEqual([SnapshotCoveragePlan.ReasonCode.BoundaryNotFound])
    expect(SessionRevertBoundary.resolve([], { messageID: "nope" })).toBeUndefined()
  })
})

describe("SnapshotCoveragePlan complete intervals", () => {
  const setup = () => {
    const e = tool("p1", "edit", "c1", { journal: full(["r1"]) })
    const w = tool("p2", "write", "c2", { journal: full(["r2"]) })
    const m = tool("p3", "apply_patch", "c3", { journal: full(["r3", "r4"]) })
    const messages = [msg("u", "user", [text("t0")]), msg("a", "assistant", [e, w, m])]
    const rows = [
      row({ id: "r1", message_id: "a", call_id: "c1", tool: "edit", item_index: 0, sub_index: 0, path: "a.txt" }),
      row({ id: "r2", message_id: "a", call_id: "c2", tool: "write", item_index: 0, sub_index: 0, path: "b.txt" }),
      row({ id: "r3", message_id: "a", call_id: "c3", tool: "apply_patch", item_index: 0, sub_index: 0, path: "new.txt", op: "add" }),
      row({ id: "r4", message_id: "a", call_id: "c3", tool: "apply_patch", item_index: 0, sub_index: 1, path: "old.txt", op: "delete" }),
    ]
    return { messages, rows }
  }

  test("full edit/write/apply_patch with move pair completes", () => {
    const { messages, rows } = setup()
    const plan = SnapshotCoveragePlan.plan({ sessionID: "s", messageID: "u", messages, rows })
    expect(plan.verdict).toBe("complete")
    expect(plan.fallback).toBe("journal-cas")
    expect(plan.reasons).toEqual([])
    expect(plan.calls).toEqual([
      { messageID: "a", callID: "c1", tool: "edit", partID: "p1" },
      { messageID: "a", callID: "c2", tool: "write", partID: "p2" },
      { messageID: "a", callID: "c3", tool: "apply_patch", partID: "p3" },
    ])
    expect(plan.messages).toEqual(["a"])
    expect(plan.applyOrder).toEqual(["r1", "r2", "r3", "r4"])
    expect(SnapshotCoveragePlan.undo(plan)).toEqual(["r4", "r3", "r2", "r1"])
  })

  test("row order follows authoritative message order, not row time", () => {
    const { messages, rows } = setup()
    const timed = rows.map((item, at) => ({ ...item, time_created: 1000 - at * 10 }) as SnapshotJournal.Row)
    const plan = SnapshotCoveragePlan.plan({ sessionID: "s", messageID: "u", messages, rows: [...timed].reverse() })
    expect(plan.verdict).toBe("complete")
    expect(plan.applyOrder).toEqual(["r1", "r2", "r3", "r4"])
  })

  test("read-only tools and empty intervals complete as no-op", () => {
    const messages = [msg("u", "user", [text("t0")]), msg("a", "assistant", [tool("p1", "read", "c1"), tool("p2", "glob", "c2")])]
    const plan = SnapshotCoveragePlan.plan({ sessionID: "s", messageID: "u", messages, rows: [] })
    expect(plan.verdict).toBe("complete")
    expect(plan.applyOrder).toEqual([])
    const empty = SnapshotCoveragePlan.plan({ sessionID: "s", messageID: "u", messages: [msg("u", "user", [text("t0")])], rows: [] })
    expect(empty.verdict).toBe("complete")
    expect(empty.applyOrder).toEqual([])
  })

  test("declared read-only builtins never block", () => {
    const names = ["read", "glob", "grep", "webfetch", "websearch", "codebase_search", "skill", "question", "todowrite", "invalid"]
    const parts = names.map((name, at) => tool(`p${at}`, name, `c${at}`))
    const plan = SnapshotCoveragePlan.plan({ sessionID: "s", messageID: "u", messages: [msg("u", "user", [text("t0")]), msg("a", "assistant", parts)], rows: [] })
    expect(plan.verdict).toBe("complete")
    expect(plan.calls).toHaveLength(names.length)
  })
})

describe("SnapshotCoveragePlan incomplete intervals", () => {
  const single = (part: Seg, rows: SnapshotJournal.Row[]) =>
    SnapshotCoveragePlan.plan({
      sessionID: "s",
      messageID: "u",
      messages: [msg("u", "user", [text("t0")]), msg("a", "assistant", [part])],
      rows,
    })

  test("partial and failed coverage never enter journal CAS", () => {
    for (const coverage of ["partial", "failed"]) {
      const plan = single(tool("p1", "edit", "c1", { journal: { coverage, ids: ["r1"] } }), [
        row({ id: "r1", message_id: "a", call_id: "c1", status: "prepared" }),
      ])
      expect(plan.verdict).toBe("incomplete")
      expect(plan.fallback).toBe("old-snapshot")
      expect(codes(plan)).toEqual([SnapshotCoveragePlan.ReasonCode.JournalCoverage])
    }
  })

  test("historic writer without journal falls back", () => {
    const plan = single(tool("p1", "write", "c1"), [])
    expect(plan.verdict).toBe("incomplete")
    expect(codes(plan)).toEqual([SnapshotCoveragePlan.ReasonCode.JournalMissing])
  })

  test("referenced prepared row reports row_status", () => {
    const plan = single(tool("p1", "edit", "c1", { journal: full(["r1"]) }), [
      row({ id: "r1", message_id: "a", call_id: "c1", status: "prepared" }),
    ])
    expect(codes(plan)).toEqual([SnapshotCoveragePlan.ReasonCode.RowStatus])
  })

  test("dangling pointer reports row_missing", () => {
    const plan = single(tool("p1", "edit", "c1", { journal: full(["r9"]) }), [])
    expect(codes(plan)).toEqual([SnapshotCoveragePlan.ReasonCode.RowMissing])
  })

  test("cross-call pointer reports row_scope_mismatch", () => {
    const plan = single(tool("p1", "edit", "c1", { journal: full(["r1"]) }), [
      row({ id: "r1", message_id: "a", call_id: "other", tool: "edit" }),
    ])
    expect(codes(plan)).toEqual([SnapshotCoveragePlan.ReasonCode.RowScopeMismatch])
  })

  test("unlisted prepared fact for an interval call reports orphan_row", () => {
    const plan = single(tool("p1", "edit", "c1", { journal: full(["r1"]) }), [
      row({ id: "r1", message_id: "a", call_id: "c1", status: "applied" }),
      row({ id: "rx", message_id: "a", call_id: "c1", status: "prepared", item_index: 1, path: "x.txt" }),
    ])
    expect(plan.verdict).toBe("incomplete")
    expect(codes(plan)).toEqual([SnapshotCoveragePlan.ReasonCode.OrphanRow])
    expect(plan.reasons[0]).toMatchObject({ messageID: "a", callID: "c1", rowID: "rx" })
  })

  test("shuffled ids report row_order_mismatch", () => {
    const plan = single(tool("p1", "apply_patch", "c1", { journal: full(["r2", "r1"]) }), [
      row({ id: "r1", message_id: "a", call_id: "c1", tool: "apply_patch", item_index: 0, path: "a.txt" }),
      row({ id: "r2", message_id: "a", call_id: "c1", tool: "apply_patch", item_index: 1, path: "b.txt" }),
    ])
    expect(codes(plan)).toEqual([SnapshotCoveragePlan.ReasonCode.RowOrderMismatch])
  })

  test("legacy single-row move and dangling source delete report row_order_mismatch", () => {
    const legacy = single(tool("p1", "apply_patch", "c1", { journal: full(["r1"]) }), [
      row({ id: "r1", message_id: "a", call_id: "c1", tool: "apply_patch", op: "move" }),
    ])
    expect(codes(legacy)).toEqual([SnapshotCoveragePlan.ReasonCode.RowOrderMismatch])
    const dangling = single(tool("p1", "apply_patch", "c1", { journal: full(["r1"]) }), [
      row({ id: "r1", message_id: "a", call_id: "c1", tool: "apply_patch", item_index: 0, sub_index: 1, op: "delete" }),
    ])
    expect(codes(dangling)).toEqual([SnapshotCoveragePlan.ReasonCode.RowOrderMismatch])
  })

  test("opaque tools always fall back, even when claiming no writes", () => {
    for (const name of ["bash", "task", "background_process", "interactive_terminal", "mcp__fs__read", "custom_tool", "mystery"]) {
      const plan = single(tool("p1", name, "c1"), [])
      expect(plan.verdict).toBe("incomplete")
      expect(codes(plan)).toEqual([SnapshotCoveragePlan.ReasonCode.OpaqueTool])
    }
  })

  test("pending and running parts report tool_pending", () => {
    for (const status of ["pending", "running"]) {
      const plan = single(tool("p1", "read", "c1", { status }), [])
      expect(codes(plan)).toEqual([SnapshotCoveragePlan.ReasonCode.ToolPending])
    }
  })

  test("classifier keeps writers closed and unknown opaque", () => {
    for (const name of ["edit", "write", "apply_patch"]) expect(SnapshotCoveragePlan.classify(name)).toBe("writer")
    for (const name of ["read", "glob", "grep", "todowrite"]) expect(SnapshotCoveragePlan.classify(name)).toBe("safe")
    for (const name of ["bash", "task", "background_process", "plan_exit", "repo_clone", "nope"]) expect(SnapshotCoveragePlan.classify(name)).toBe("opaque")
  })

  test("planner owns no layer and cannot create a second journal", () => {
    expect((SnapshotCoveragePlan as Record<string, unknown>).defaultLayer).toBeUndefined()
    expect((SnapshotCoveragePlan as Record<string, unknown>).layer).toBeUndefined()
  })
})

describe("SessionRevertBoundary physical anchor and old patch collection", () => {
  const patch = (id: string): Seg => ({ id, type: "patch" })

  test("message-level excludes first matched patch, includes later patches", () => {
    const messages = [msg("u", "user", [text("t0")]), msg("a", "assistant", [patch("q0"), patch("q1"), text("t1"), patch("q2")])]
    const boundary = SessionRevertBoundary.resolve(messages, { messageID: "a" })!
    expect(boundary.messageID as string).toBe("u")
    expect(boundary.partID).toBeUndefined()
    expect(boundary.messageIndex).toBe(1)
    expect(boundary.partIndex).toBe(0)
    expect(SessionRevertBoundary.patchesAfter(messages, boundary).map((part) => part.id)).toEqual(["q1", "q2"])
  })

  test("part-level keep=false excludes before and target, includes after", () => {
    const messages = [msg("u", "user", [text("t0")]), msg("a", "assistant", [patch("pre"), patch("tgt"), patch("post")])]
    const boundary = SessionRevertBoundary.resolve(messages, { messageID: "a", partID: "tgt" })!
    expect(boundary.messageID as string).toBe("u")
    expect(boundary.partID).toBeUndefined()
    expect(boundary.messageIndex).toBe(1)
    expect(boundary.partIndex).toBe(1)
    expect(SessionRevertBoundary.patchesAfter(messages, boundary).map((part) => part.id)).toEqual(["post"])
  })
})

describe("SnapshotCoveragePlan deletion interval", () => {
  test("message-level includes first tool of the deleted message", () => {
    const c1 = tool("p1", "edit", "c1", { journal: full(["r1"]) })
    const c2 = tool("p2", "edit", "c2", { journal: full(["r2"]) })
    const messages = [msg("u", "user", [text("t0")]), msg("a", "assistant", [c1, c2])]
    const rows = [row({ id: "r1", message_id: "a", call_id: "c1" }), row({ id: "r2", message_id: "a", call_id: "c2" })]
    const plan = SnapshotCoveragePlan.plan({ sessionID: "s", messageID: "a", messages, rows })
    expect(plan.calls.map((item) => item.callID)).toEqual(["c1", "c2"])
    expect(plan.verdict).toBe("complete")
  })

  test("part-level includes target and after, retains before", () => {
    const before = tool("p0", "edit", "c0", { journal: full(["r0"]) })
    const target = tool("p1", "edit", "c1", { journal: full(["r1"]) })
    const after = tool("p2", "edit", "c2", { journal: full(["r2"]) })
    const messages = [msg("u", "user", [text("t0")]), msg("a", "assistant", [before, text("t1"), target, after])]
    const rows = [
      row({ id: "r0", message_id: "a", call_id: "c0" }),
      row({ id: "r1", message_id: "a", call_id: "c1" }),
      row({ id: "r2", message_id: "a", call_id: "c2" }),
    ]
    const plan = SnapshotCoveragePlan.plan({ sessionID: "s", messageID: "a", partID: "p1", messages, rows })
    expect(plan.boundary).toEqual({ messageID: "a", partID: "p1" })
    expect(plan.calls.map((item) => item.callID)).toEqual(["c1", "c2"])
    expect(plan.verdict).toBe("complete")
  })
})

const env = Layer.mergeAll(Session.defaultLayer, SnapshotJournal.defaultLayer, CrossSpawnSpawner.defaultLayer)
const it = testEffect(env)

describe("SnapshotCoveragePlan production wiring", () => {
  it.live(
    "planFor reads Session boundary and the injected journal instance",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const journal = yield* SnapshotJournal.Service
          const info = yield* sessions.create({})
          const sid = info.id
          const uid = MessageID.ascending()
          yield* sessions.updateMessage({
            id: uid,
            role: "user",
            sessionID: sid as never,
            agent: "default",
            model: { providerID: ProviderV2.ID.make("openai"), modelID: ModelV2.ID.make("gpt-4") },
            time: { created: Date.now() },
          })
          yield* sessions.updatePart({ id: PartID.ascending(), messageID: uid as never, sessionID: sid as never, type: "text", text: "hi" })
          const aid = MessageID.ascending()
          yield* sessions.updateMessage({
            id: aid,
            role: "assistant",
            sessionID: sid as never,
            mode: "default",
            agent: "default",
            path: { cwd: dir, root: dir },
            cost: 0,
            tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: ModelV2.ID.make("gpt-4"),
            providerID: ProviderV2.ID.make("openai"),
            parentID: uid as never,
            time: { created: Date.now() },
            finish: "end_turn",
          })
          const file = `${dir}/note.txt`
          yield* Effect.promise(() => Bun.write(file, "before"))
          const call = `call_${Date.now()}`
          const noted = yield* journal.prepare({
            sessionID: sid,
            messageID: aid,
            callID: call,
            tool: "edit",
            item: 0,
            directory: dir,
            worktree: dir,
            path: file,
            op: "update",
            before: Buffer.from("before"),
          })
          yield* journal.apply({ id: noted.row.id, after: Buffer.from("after") })
          const pid = PartID.ascending()
          yield* sessions.updatePart({
            id: pid,
            sessionID: sid as never,
            messageID: aid as never,
            type: "tool",
            callID: call,
            tool: "edit",
            state: {
              status: "completed",
              input: {},
              output: "ok",
              title: "edit",
              metadata: {},
              time: { start: Date.now(), end: Date.now() },
            },
            metadata: { journal: { coverage: "full", ids: [noted.row.id] } },
          })

          const complete = yield* SnapshotCoveragePlan.planFor({ sessionID: sid, messageID: uid })
          expect(complete.verdict).toBe("complete")
          expect(complete.fallback).toBe("journal-cas")
          expect(complete.applyOrder).toEqual([noted.row.id])
          expect(complete.calls).toEqual([{ messageID: aid, callID: call, tool: "edit", partID: pid }])

          yield* sessions.updatePart({
            id: PartID.ascending(),
            sessionID: sid as never,
            messageID: aid as never,
            type: "tool",
            callID: `${call}-shell`,
            tool: "bash",
            state: {
              status: "completed",
              input: {},
              output: "ok",
              title: "bash",
              metadata: {},
              time: { start: Date.now(), end: Date.now() },
            },
          })
          const opaque = yield* SnapshotCoveragePlan.planFor({ sessionID: sid, messageID: uid })
          expect(opaque.verdict).toBe("incomplete")
          expect(opaque.fallback).toBe("old-snapshot")
          expect(opaque.reasons.map((item) => item.code)).toEqual([SnapshotCoveragePlan.ReasonCode.OpaqueTool])
        }),
      { git: true },
    ),
  )
})
