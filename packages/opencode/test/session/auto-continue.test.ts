import { describe, expect, test } from "bun:test"
import { Effect, Layer, Option } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { Session } from "../../src/session/session"
import { testEffect } from "../lib/effect"
import {
  composeTaskReport,
  CONTINUE_FROM_KEY,
  hasUnsafeTool,
  isAutoContinueMarker,
  lastText,
  taskReport,
  UNKNOWN_FINISH_CONTINUE_INSTRUCTION,
} from "../../src/session/prompt/auto-continue"

const sid = SessionID.descending("ses_auto_continue_test")
const model = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

function text(
  messageID: MessageID,
  text: string,
  opts?: { synthetic?: boolean; metadata?: Record<string, unknown> },
): SessionV1.TextPart {
  return {
    id: PartID.ascending(`prt_text_${messageID}`),
    sessionID: sid,
    messageID,
    type: "text",
    text,
    ...(opts?.synthetic ? { synthetic: true } : {}),
    ...(opts?.metadata ? { metadata: opts.metadata } : {}),
  }
}

function user(id: string, parts: SessionV1.Part[]): SessionV1.WithParts {
  const messageID = MessageID.ascending(`msg_${id}`)
  return {
    info: {
      id: messageID,
      sessionID: sid,
      role: "user",
      time: { created: 1 },
      agent: "build",
      model,
    },
    parts,
  }
}

function assistant(
  id: string,
  parentID: MessageID,
  opts: { finish?: string; text?: string; error?: boolean } = {},
): SessionV1.WithParts {
  const messageID = MessageID.ascending(`msg_${id}`)
  return {
    info: {
      id: messageID,
      sessionID: sid,
      role: "assistant",
      parentID,
      mode: "build",
      agent: "build",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: model.modelID,
      providerID: model.providerID,
      time: { created: 2 },
      ...(opts.finish ? { finish: opts.finish } : {}),
      ...(opts.error
        ? { error: new SessionV1.APIError({ message: "provider refused", isRetryable: true }).toObject() }
        : {}),
    },
    parts: opts.text ? [text(messageID, opts.text)] : [],
  }
}

function tool(
  messageID: MessageID,
  status: SessionV1.ToolState["status"],
  opts?: { providerExecuted?: boolean },
): SessionV1.ToolPart {
  const states: Record<SessionV1.ToolState["status"], SessionV1.ToolState> = {
    pending: { status: "pending", input: {}, raw: "{}" },
    running: { status: "running", input: {}, time: { start: 1 } },
    error: { status: "error", input: {}, error: "Tool execution aborted", time: { start: 1, end: 2 } },
    completed: {
      status: "completed",
      input: {},
      output: "done",
      title: "edit",
      metadata: {},
      time: { start: 1, end: 2 },
    },
  }
  return {
    id: PartID.ascending(`prt_tool_${messageID}_${status}`),
    sessionID: sid,
    messageID,
    type: "tool",
    callID: `call_${messageID}_${status}`,
    tool: "edit",
    state: states[status],
    ...(opts?.providerExecuted ? { metadata: { providerExecuted: true } } : {}),
  }
}

const u1 = user("u1", [text(MessageID.ascending("msg_u1"), "original turn")])
const a1 = assistant("a1", MessageID.ascending("msg_u1"), { finish: "unknown", text: "child partial" })
const u2 = user("u2", [
  text(MessageID.ascending("msg_u2"), UNKNOWN_FINISH_CONTINUE_INSTRUCTION, {
    synthetic: true,
    metadata: { [CONTINUE_FROM_KEY]: MessageID.ascending("msg_a1") },
  }),
])
const a2 = assistant("a2", MessageID.ascending("msg_u2"), { finish: "stop", text: "child completed report" })

function stubSessions(messages: SessionV1.WithParts[]): Layer.Layer<Session.Service> {
  return Layer.mock(Session.Service, {
    findMessage: (_sessionID: SessionID, predicate: (m: SessionV1.WithParts) => boolean) => {
      const found = messages.find(predicate)
      return Effect.succeed(found ? Option.some(found) : Option.none())
    },
  })
}

const it = testEffect(Layer.empty)

describe("hasUnsafeTool", () => {
  test("false without tool parts", () => {
    expect(hasUnsafeTool(undefined)).toBe(false)
    expect(hasUnsafeTool([])).toBe(false)
    expect(hasUnsafeTool([text(MessageID.ascending("msg_u1"), "plain")])).toBe(false)
  })

  test("false when every tool part is completed", () => {
    expect(hasUnsafeTool([tool(MessageID.ascending("msg_a1"), "completed")])).toBe(false)
  })

  test("true for pending, running, and error states", () => {
    expect(hasUnsafeTool([tool(MessageID.ascending("msg_a1"), "pending")])).toBe(true)
    expect(hasUnsafeTool([tool(MessageID.ascending("msg_a1"), "running")])).toBe(true)
    expect(hasUnsafeTool([tool(MessageID.ascending("msg_a1"), "error")])).toBe(true)
  })

  test("true when a completed tool coexists with an unresolved one", () => {
    expect(
      hasUnsafeTool([tool(MessageID.ascending("msg_a1"), "completed"), tool(MessageID.ascending("msg_a1"), "running")]),
    ).toBe(true)
  })

  test("provider-executed unresolved tools still block", () => {
    expect(hasUnsafeTool([tool(MessageID.ascending("msg_a1"), "pending", { providerExecuted: true })])).toBe(true)
    expect(hasUnsafeTool([tool(MessageID.ascending("msg_a1"), "running", { providerExecuted: true })])).toBe(true)
  })
})

describe("lastText", () => {
  test("returns the last text part", () => {
    expect(
      lastText([text(MessageID.ascending("msg_a1"), "first"), text(MessageID.ascending("msg_a1"), "second")]),
    ).toBe("second")
  })

  test("returns empty string without text parts", () => {
    expect(lastText([])).toBe("")
    expect(lastText([tool(MessageID.ascending("msg_a1"), "completed")])).toBe("")
  })
})

describe("isAutoContinueMarker", () => {
  test("true only for the user message carrying the exact synthetic marker", () => {
    expect(isAutoContinueMarker(u2)).toBe(true)
    expect(isAutoContinueMarker(u1)).toBe(false)
  })

  test("false for undefined, assistants, and other roles", () => {
    expect(isAutoContinueMarker(undefined)).toBe(false)
    expect(isAutoContinueMarker(a1)).toBe(false)
  })

  test("false for a synthetic part without the marker key", () => {
    const plain = user("u2", [
      text(MessageID.ascending("msg_u2"), UNKNOWN_FINISH_CONTINUE_INSTRUCTION, { synthetic: true }),
    ])
    expect(isAutoContinueMarker(plain)).toBe(false)
  })

  test("false for a non-synthetic part carrying the marker key", () => {
    const fake = user("u2", [
      text(MessageID.ascending("msg_u2"), "not a marker", {
        metadata: { [CONTINUE_FROM_KEY]: MessageID.ascending("msg_a1") },
      }),
    ])
    expect(isAutoContinueMarker(fake)).toBe(false)
  })

  test("false for a malformed marker value", () => {
    const malformed = user("u2", [
      text(MessageID.ascending("msg_u2"), UNKNOWN_FINISH_CONTINUE_INSTRUCTION, {
        synthetic: true,
        metadata: { [CONTINUE_FROM_KEY]: 42 },
      }),
    ])
    expect(isAutoContinueMarker(malformed)).toBe(false)
  })
})

describe("composeTaskReport", () => {
  test("returns the final text normally without an auto-continuation marker", () => {
    expect(composeTaskReport({ final: a2, parent: u1, source: undefined })).toBe("child completed report")
  })

  test("returns partial then final, in order, when the marker and source line up", () => {
    expect(composeTaskReport({ final: a2, parent: u2, source: a1 })).toBe("child partial\nchild completed report")
  })

  test("falls back to final text when the source assistant is missing", () => {
    expect(composeTaskReport({ final: a2, parent: u2, source: undefined })).toBe("child completed report")
  })

  test("falls back to final text when the source id does not match the marker", () => {
    const other = assistant("a3", MessageID.ascending("msg_u1"), { finish: "unknown", text: "older unrelated turn" })
    expect(composeTaskReport({ final: a2, parent: u2, source: other })).toBe("child completed report")
  })

  test("falls back when the source did not end with unknown finish", () => {
    const stopped = assistant("a1", MessageID.ascending("msg_u1"), { finish: "stop", text: "child partial" })
    expect(composeTaskReport({ final: a2, parent: u2, source: stopped })).toBe("child completed report")
  })

  test("falls back when the source assistant carries an error", () => {
    const errored = assistant("a1", MessageID.ascending("msg_u1"), {
      finish: "unknown",
      text: "child partial",
      error: true,
    })
    expect(composeTaskReport({ final: a2, parent: u2, source: errored })).toBe("child completed report")
  })

  test("falls back when the source belongs to a different session", () => {
    const foreign = {
      ...a1,
      info: { ...a1.info, sessionID: SessionID.descending("ses_other") },
    }
    expect(composeTaskReport({ final: a2, parent: u2, source: foreign })).toBe("child completed report")
  })

  test("falls back when the source has no text", () => {
    const silent = assistant("a1", MessageID.ascending("msg_u1"), { finish: "unknown" })
    expect(composeTaskReport({ final: a2, parent: u2, source: silent })).toBe("child completed report")
  })

  test("ignores a marker on a non-synthetic part", () => {
    const parent = user("u2", [
      text(MessageID.ascending("msg_u2"), "not a marker", {
        metadata: { [CONTINUE_FROM_KEY]: MessageID.ascending("msg_a1") },
      }),
    ])
    expect(composeTaskReport({ final: a2, parent, source: a1 })).toBe("child completed report")
  })

  test("ignores a malformed marker value", () => {
    const parent = user("u2", [
      text(MessageID.ascending("msg_u2"), UNKNOWN_FINISH_CONTINUE_INSTRUCTION, {
        synthetic: true,
        metadata: { [CONTINUE_FROM_KEY]: 42 },
      }),
    ])
    expect(composeTaskReport({ final: a2, parent, source: a1 })).toBe("child completed report")
  })

  test("never includes the continuation instruction or older-turn text", () => {
    const report = composeTaskReport({ final: a2, parent: u2, source: a1 })
    expect(report).not.toContain(UNKNOWN_FINISH_CONTINUE_INSTRUCTION)
    expect(report).not.toContain("original turn")
  })

  test("falls back to an empty report when the final has no text", () => {
    const silent = assistant("a2", MessageID.ascending("msg_u2"), { finish: "stop" })
    expect(composeTaskReport({ final: silent, parent: u2, source: a1 })).toBe("")
  })
})

describe("taskReport", () => {
  it.effect("returns partial then final when the session resolves the marker", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const report = yield* taskReport({ sessions, sessionID: sid, final: a2 })
      expect(report).toBe("child partial\nchild completed report")
    }).pipe(Effect.provide(stubSessions([u1, a1, u2, a2]))),
  )

  it.effect("returns final text when the marker lookup misses", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const report = yield* taskReport({ sessions, sessionID: sid, final: a2 })
      expect(report).toBe("child completed report")
    }).pipe(Effect.provide(stubSessions([u1, a2]))),
  )

  it.effect("returns final text for a non-assistant final result", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const report = yield* taskReport({ sessions, sessionID: sid, final: u1 })
      expect(report).toBe("original turn")
    }).pipe(Effect.provide(stubSessions([u1, a1, u2, a2]))),
  )
})
