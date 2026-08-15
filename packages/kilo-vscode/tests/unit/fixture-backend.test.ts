import { describe, expect, it } from "bun:test"
import {
  summarizeMcp,
  summarizeMessage,
  summarizePermissions,
  summarizeQuestions,
  summarizeSession,
  summarizeStatuses,
  summarizeToolParts,
  type BackendSnapshot,
} from "../../src/agent-manager/fixture-backend"
import type { McpStatus, Message, Part, PermissionRequest, QuestionRequest, Session, SessionStatus } from "@kilocode/sdk/v2/client"

function session(overrides: Partial<Session>): Session {
  return {
    id: "sess-1",
    slug: "s1",
    projectID: "project",
    directory: "/ws",
    title: "T",
    version: "1",
    time: { created: 1000, updated: 2000 },
    ...overrides,
  }
}

function messageRow(overrides: Partial<{ info: Message; parts: Part[] }>): { info: Message; parts: Part[] } {
  return {
    info: {
      id: "msg-1",
      sessionID: "sess-1",
      role: "user",
      time: { created: 1500 },
      path: { cwd: "/ws", root: "/ws" },
      providerID: "e2e-local",
      modelID: "e2e-model",
      mode: "primary",
      agent: "e2e-agent",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [{ id: "p1", sessionID: "sess-1", messageID: "msg-1", type: "text", text: "hello" }],
    ...overrides,
  } as { info: Message; parts: Part[] }
}

describe("fixture-backend summaries", () => {
  it("normalizes the Session model (id key) and agent into SessionTruth", () => {
    const s = session({
      agent: "e2e-agent",
      model: { id: "e2e-model", providerID: "e2e-local", variant: "low" },
      title: "E2E Session",
    })
    expect(summarizeSession(s)).toEqual({
      id: "sess-1",
      title: "E2E Session",
      agent: "e2e-agent",
      model: { providerID: "e2e-local", modelID: "e2e-model", variant: "low" },
      parentID: null,
      createdAt: 1000,
      updatedAt: 2000,
    })
  })

  it("keeps the backend parentID edge on the session truth (H-2/H-7)", () => {
    const child = session({ parentID: "sess-1", title: "Child" })
    expect(summarizeSession(child).parentID).toBe("sess-1")
    expect(summarizeSession(session({ parentID: undefined })).parentID).toBeNull()
  })

  it("summarizes completed tool parts (task delegation child id, user tool, skill, mcp, question)", () => {
    const row = messageRow({
      parts: [
        {
          id: "p-task",
          sessionID: "sess-1",
          messageID: "msg-2",
          type: "tool",
          callID: "call-task",
          tool: "task",
          state: {
            status: "completed",
            input: { description: "E2E delegated sub-task", subagent_type: "general" },
            output: '<task id="sess-child" state="completed">\n<task_result>\nE2E delegated result marker\n</task_result>\n</task>',
            title: "Sub-agent",
            metadata: { sessionId: "sess-child", parentSessionId: "sess-1" },
            time: { start: 1, end: 2 },
          },
        },
        { id: "p-pending", sessionID: "sess-1", messageID: "msg-2", type: "tool", callID: "call-x", tool: "read", state: { status: "running", input: {}, time: { start: 1 } } },
      ] as Part[],
    })
    const summary = summarizeMessage(row)
    const tools = summary.tools
    expect(tools).toHaveLength(1)
    expect(tools![0]).toEqual({
      tool: "task",
      status: "completed",
      callID: "call-task",
      output: '<task id="sess-child" state="completed">\n<task_result>\nE2E delegated result marker\n</task_result>\n</task>',
      title: "Sub-agent",
      metadata: { sessionId: "sess-child", parentSessionId: "sess-1" },
    })
  })

  it("omits tools when the message has no completed tool parts", () => {
    const row = messageRow({
      parts: [
        {
          id: "p-run",
          sessionID: "sess-1",
          messageID: "msg-2",
          type: "tool",
          callID: "call-run",
          tool: "read",
          state: { status: "running", input: {}, time: { start: 1 } },
        },
      ] as Part[],
    })
    expect(summarizeMessage(row).tools).toBeUndefined()
    expect(summarizeToolParts([])).toBeUndefined()
  })

  it("reduces the served MCP status map to status types (H-5)", () => {
    const statuses: Record<string, McpStatus> = {
      "e2e-fixture": { status: "connected" },
      other: { status: "disabled" },
      bad: { status: "failed", error: "boom" },
    }
    expect(summarizeMcp(statuses)).toEqual({ "e2e-fixture": "connected", other: "disabled", bad: "failed" })
  })

  it("keeps the minimal pending-permission facts (H-6)", () => {
    const perms: PermissionRequest[] = [
      {
        id: "perm-1",
        sessionID: "sess-1",
        permission: "read",
        patterns: ["ask.txt"],
        metadata: {},
        always: ["*"],
      },
    ]
    expect(summarizePermissions(perms)).toEqual([
      { id: "perm-1", sessionID: "sess-1", permission: "read", patterns: ["ask.txt"] },
    ])
  })

  it("keeps the minimal pending-question facts (H-6)", () => {
    const questions: QuestionRequest[] = [
      {
        id: "que-1",
        sessionID: "sess-1",
        questions: [
          {
            question: "Pick an option",
            header: "Pick",
            options: [
              { label: "A", description: "first" },
              { label: "B", description: "second" },
            ],
          },
        ],
      },
    ]
    expect(summarizeQuestions(questions)).toEqual([
      {
        id: "que-1",
        sessionID: "sess-1",
        questions: [{ question: "Pick an option", options: ["A", "B"] }],
      },
    ])
  })

  it("keeps agent null and model null when the backend session has neither", () => {
    expect(summarizeSession(session({ agent: undefined, model: undefined })).agent).toBeNull()
    expect(summarizeSession(session({ agent: undefined, model: undefined })).model).toBeNull()
  })

  it("carries the backend revert/checkpoint fact with the boundary message id (H-12)", () => {
    const s = session({
      revert: {
        messageID: "msg-edit",
        snapshot: "abc123",
        diff: "--- a/rollback.txt\n+++ b/rollback.txt\n",
      },
      summary: {
        additions: 1,
        deletions: 1,
        files: 1,
        diffs: [{ file: "rollback.txt", additions: 1, deletions: 1, status: "modified" }],
      },
    })
    expect(summarizeSession(s).revert).toEqual({
      messageID: "msg-edit",
      snapshot: "abc123",
      diff: "--- a/rollback.txt\n+++ b/rollback.txt\n",
    })
    expect(summarizeSession(s).summary).toEqual({
      additions: 1,
      deletions: 1,
      files: 1,
      diffs: [{ file: "rollback.txt", additions: 1, deletions: 1, status: "modified" }],
    })
  })

  it("omits revert/summary when the backend session has neither (idle/clean)", () => {
    const out = summarizeSession(session({ revert: undefined, summary: undefined }))
    expect(out.revert).toBeUndefined()
    expect(out.summary).toBeUndefined()
  })

  it("omits summary.diffs when the backend summary has no per-file diffs", () => {
    const out = summarizeSession(session({ summary: { additions: 0, deletions: 0, files: 0, diffs: [] } }))
    expect(out.summary).toEqual({ additions: 0, deletions: 0, files: 0 })
    expect(out.summary?.diffs).toBeUndefined()
  })

  it("pins the per-session provider/model/variant on the user message", () => {
    const row = messageRow({
      info: {
        id: "msg-1",
        sessionID: "sess-1",
        role: "user",
        time: { created: 1500 },
        path: { cwd: "/ws", root: "/ws" },
        agent: "e2e-agent",
        model: { providerID: "e2e-local", modelID: "e2e-model", variant: "high" },
        mode: "primary",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      } as Message,
    })
    expect(summarizeMessage(row)).toEqual({
      id: "msg-1",
      role: "user",
      agent: "e2e-agent",
      model: { providerID: "e2e-local", modelID: "e2e-model", variant: "high" },
      text: "hello",
    })
  })

  it("joins only text parts into the transcript text", () => {
    const row = messageRow({
      parts: [
        { id: "p1", sessionID: "sess-1", messageID: "msg-1", type: "text", text: "a" },
        { id: "p2", sessionID: "sess-1", messageID: "msg-1", type: "reasoning", text: "not content" },
        { id: "p3", sessionID: "sess-1", messageID: "msg-1", type: "text", text: "b" },
      ] as Part[],
    })
    expect(summarizeMessage(row).text).toBe("a\nb")
  })

  it("H-13: surfaces the compaction part as a typed auto-compaction fact (overflow/tail from raw JSON)", () => {
    const row = messageRow({
      info: {
        id: "msg-c",
        sessionID: "sess-1",
        role: "user",
        time: { created: 1500 },
        path: { cwd: "/ws", root: "/ws" },
        mode: "primary",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      } as Message,
      parts: [
        {
          id: "p-c",
          sessionID: "sess-1",
          messageID: "msg-c",
          type: "compaction",
          auto: true,
          overflow: false,
          tail_start_id: "msg-1",
        } as unknown as Part,
      ],
    })
    expect(summarizeMessage(row)).toMatchObject({
      id: "msg-c",
      role: "user",
      text: "",
      compaction: { auto: true, overflow: false, tailStartID: "msg-1" },
    })
  })

  it("H-13: marks the compaction summary assistant message (summary: true)", () => {
    const row = messageRow({
      info: {
        id: "msg-s",
        sessionID: "sess-1",
        role: "assistant",
        parentID: "msg-c",
        summary: true,
        time: { created: 1600, completed: 1700 },
        path: { cwd: "/ws", root: "/ws" },
        mode: "compaction",
        agent: "compaction",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        finish: "stop",
      } as Message,
      parts: [
        { id: "p-t", sessionID: "sess-1", messageID: "msg-s", type: "text", text: "E2E_COMPACTION_SUMMARY_MARKER" },
      ] as Part[],
    })
    expect(summarizeMessage(row)).toMatchObject({
      id: "msg-s",
      role: "assistant",
      summary: true,
      text: "E2E_COMPACTION_SUMMARY_MARKER",
    })
  })

  it("H-13: the per-message session summary object on USER messages is NOT the summary flag", () => {
    // The served backend attaches `summary: {diffs}` to user messages; only
    // the strict boolean marks the compaction summary assistant.
    const row = messageRow({
      info: {
        id: "msg-u",
        sessionID: "sess-1",
        role: "user",
        summary: { diffs: [] },
        time: { created: 1500 },
        path: { cwd: "/ws", root: "/ws" },
        mode: "primary",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      } as Message,
    })
    expect(summarizeMessage(row).summary).toBeUndefined()
  })

  it("H-13: marks the synthetic automatic-continuation user message (compaction_continue metadata)", () => {
    const row = messageRow({
      info: {
        id: "msg-cont",
        sessionID: "sess-1",
        role: "user",
        time: { created: 1700 },
        path: { cwd: "/ws", root: "/ws" },
        mode: "primary",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      } as Message,
      parts: [
        {
          id: "p-cont",
          sessionID: "sess-1",
          messageID: "msg-cont",
          type: "text",
          text: "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.",
          synthetic: true,
          metadata: { compaction_continue: true },
        } as Part,
      ],
    })
    const summary = summarizeMessage(row)
    expect(summary.continuation).toBe(true)
    // The synthetic instruction is still surfaced as the message text (the
    // panel hides it from the user bubble; the backend fact stays intact).
    expect(summary.text).toContain("Continue if you have next steps")
  })

  it("H-13: omits compaction/summary/continuation facts for ordinary turns", () => {
    const row = messageRow({})
    const summary = summarizeMessage(row)
    expect(summary.compaction).toBeUndefined()
    expect(summary.summary).toBeUndefined()
    expect(summary.continuation).toBeUndefined()
  })

  it("omits the model truth for assistant messages (no user model pin)", () => {
    const row = messageRow({
      info: {
        id: "msg-2",
        sessionID: "sess-1",
        role: "assistant",
        parentID: "msg-1",
        time: { created: 1600, completed: 1700 },
        path: { cwd: "/ws", root: "/ws" },
        providerID: "e2e-local",
        modelID: "e2e-model",
        mode: "primary",
        agent: "e2e-agent",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        finish: "error",
      } as Message,
    })
    const summary = summarizeMessage(row)
    expect(summary.role).toBe("assistant")
    expect(summary.model).toBeUndefined()
  })

  it("reduces SessionStatus objects to their type strings", () => {
    const statuses: Record<string, SessionStatus> = {
      "sess-1": { type: "busy" },
      "sess-2": { type: "idle" },
    }
    expect(summarizeStatuses(statuses)).toEqual({ "sess-1": "busy", "sess-2": "idle" })
  })
})
