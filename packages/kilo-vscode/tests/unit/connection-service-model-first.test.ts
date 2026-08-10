import { afterEach, describe, expect, test } from "bun:test"
import { KiloConnectionService } from "../../src/services/cli-backend/connection-service"
import type { SSEPayload } from "../../src/services/cli-backend/sdk-sse-adapter"

const PREFIX = "[Kilo New][P0-Perf] "

function capture(): { logs: unknown[][]; restore: () => void } {
  const logs: unknown[][] = []
  const log = console.log
  console.log = (...args: unknown[]) => logs.push(args)
  return { logs, restore: () => (console.log = log) }
}

function records(logs: unknown[][]): Array<Record<string, unknown>> {
  return logs
    .map((args) => args.join(" "))
    .filter((line) => line.startsWith(PREFIX))
    .map((line) => JSON.parse(line.slice(PREFIX.length)))
}

function messageUpdated(data: Record<string, unknown>): SSEPayload {
  return { type: "sync", name: "message.updated.1", id: "e1", seq: 1, aggregateID: "ses", data } as unknown as SSEPayload
}

const assistantInfo = (id: string, parentID: string) => ({
  id,
  sessionID: "ses1",
  role: "assistant",
  parentID,
  time: { created: 1 },
  mode: "code",
  agent: "code",
  path: { cwd: "/w", root: "/w" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  modelID: "m",
  providerID: "p",
})

const userInfo = (id: string) => ({
  id,
  sessionID: "ses1",
  role: "user",
  time: { created: 1 },
  agent: "code",
  model: { providerID: "p", modelID: "m" },
})

describe("KiloConnectionService P0 model-first records", () => {
  afterEach(() => {
    delete process.env.KILO_P0_PERF
  })

  test("user message updates never produce a model.firstEvent record", () => {
    process.env.KILO_P0_PERF = "1"
    const service = new KiloConnectionService({} as any)
    const handler = service as unknown as { recordFirstModelEvent(event: SSEPayload, directory?: string): void }
    const { logs, restore } = capture()
    try {
      handler.recordFirstModelEvent(messageUpdated({ sessionID: "ses1", info: userInfo("user-msg-1") }), "/w")
    } finally {
      restore()
    }
    expect(records(logs)).toEqual([])
  })

  test("first assistant message update emits one record with session/message/parent ids", () => {
    process.env.KILO_P0_PERF = "1"
    const service = new KiloConnectionService({} as any)
    const handler = service as unknown as { recordFirstModelEvent(event: SSEPayload, directory?: string): void }
    const { logs, restore } = capture()
    try {
      handler.recordFirstModelEvent(
        messageUpdated({ sessionID: "ses1", info: assistantInfo("assistant-msg-1", "user-msg-1") }),
        "/w",
      )
    } finally {
      restore()
    }
    const recs = records(logs)
    expect(recs).toHaveLength(1)
    expect(recs[0]!.stage).toBe("model.firstEvent")
    expect(recs[0]!.sessionID).toBe("ses1")
    expect(recs[0]!.messageID).toBe("assistant-msg-1")
    expect(recs[0]!.parentID).toBe("user-msg-1")
    expect(recs[0]!.dir).toBe("/w")
  })

  test("repeated updates of the same assistant message dedupe to one record per turn", () => {
    process.env.KILO_P0_PERF = "1"
    const service = new KiloConnectionService({} as any)
    const handler = service as unknown as { recordFirstModelEvent(event: SSEPayload, directory?: string): void }
    const { logs, restore } = capture()
    try {
      handler.recordFirstModelEvent(
        messageUpdated({ sessionID: "ses1", info: assistantInfo("assistant-msg-1", "user-msg-1") }),
        "/w",
      )
      handler.recordFirstModelEvent(
        messageUpdated({ sessionID: "ses1", info: assistantInfo("assistant-msg-1", "user-msg-1") }),
        "/w",
      )
      handler.recordFirstModelEvent(
        messageUpdated({ sessionID: "ses1", info: assistantInfo("assistant-msg-1", "user-msg-1") }),
        "/w",
      )
    } finally {
      restore()
    }
    expect(records(logs)).toHaveLength(1)
  })

  test("a second turn in the same session emits its own per-turn record", () => {
    process.env.KILO_P0_PERF = "1"
    const service = new KiloConnectionService({} as any)
    const handler = service as unknown as { recordFirstModelEvent(event: SSEPayload, directory?: string): void }
    const { logs, restore } = capture()
    try {
      handler.recordFirstModelEvent(
        messageUpdated({ sessionID: "ses1", info: assistantInfo("assistant-msg-1", "user-msg-1") }),
        "/w",
      )
      handler.recordFirstModelEvent(
        messageUpdated({ sessionID: "ses1", info: assistantInfo("assistant-msg-2", "user-msg-2") }),
        "/w",
      )
    } finally {
      restore()
    }
    const recs = records(logs)
    expect(recs).toHaveLength(2)
    expect(recs.map((r) => r.messageID)).toEqual(["assistant-msg-1", "assistant-msg-2"])
    expect(recs.map((r) => r.parentID)).toEqual(["user-msg-1", "user-msg-2"])
  })

  test("disabled path emits nothing even for assistant updates", () => {
    delete process.env.KILO_P0_PERF
    const service = new KiloConnectionService({} as any)
    const handler = service as unknown as { recordFirstModelEvent(event: SSEPayload, directory?: string): void }
    const { logs, restore } = capture()
    try {
      handler.recordFirstModelEvent(
        messageUpdated({ sessionID: "ses1", info: assistantInfo("assistant-msg-1", "user-msg-1") }),
        "/w",
      )
    } finally {
      restore()
    }
    expect(records(logs)).toEqual([])
  })

  test("question.rejected emits question.rejected while question.replied emits question.replied", () => {
    process.env.KILO_P0_PERF = "1"
    const service = new KiloConnectionService({} as any)
    const handler = service as unknown as {
      handleQuestionEvent(event: unknown, directory?: string): void
    }
    const { logs, restore } = capture()
    try {
      handler.handleQuestionEvent({
        type: "question.asked",
        properties: { id: "q1", sessionID: "ses1", questions: [] },
      })
      handler.handleQuestionEvent({
        type: "question.replied",
        properties: { requestID: "q1", sessionID: "ses1", answers: [] },
      })
      handler.handleQuestionEvent({
        type: "question.rejected",
        properties: { requestID: "q1", sessionID: "ses1" },
      })
    } finally {
      restore()
    }
    const stages = records(logs)
      .filter((r) => r.stage === "question.replied" || r.stage === "question.rejected")
      .map((r) => r.stage)
    expect(stages).toEqual(["question.replied", "question.rejected"])
  })
})
