import { describe, expect, it } from "bun:test"
import { MessageV2 } from "../../src/session/message-v2"
import * as Core from "@opencode-ai/core/session/message-read"
import { Snapshot } from "../../src/snapshot"

describe("message-read parity with MessageV2", () => {
  it("shares cap and cursor codec", () => {
    expect(Snapshot.MAX_DIFF_SIZE).toBe(Core.MAX_MESSAGE_PATCH_SIZE)
    expect(Core.MAX_MESSAGE_PATCH_SIZE).toBe(256 * 1024)
    const c = Core.encodeMessageCursor({ id: "msg_x1", time: 42 })
    expect(MessageV2.cursor.decode(c)).toEqual({ id: "msg_x1", time: 42 })
    const c2 = MessageV2.cursor.encode({ id: "msg_y2", time: 7 } as never)
    expect(Core.decodeMessageCursor(c2)).toEqual({ id: "msg_y2", time: 7 })
  })

  it("strip parity for tool metadata and user summary", () => {
    const input = {
      id: "prt_1",
      sessionID: "ses_1",
      messageID: "msg_1",
      type: "tool",
      callID: "c",
      tool: "edit",
      state: { status: "completed", input: {}, output: "ok", title: "t", metadata: { diff: "d", filediff: { file: "a", patch: "p", before: "b", after: "a" } }, time: { start: 0, end: 1 } },
    } as unknown as Parameters<typeof MessageV2.stripPartMetadata>[0]
    expect(MessageV2.stripPartMetadata(input)).toEqual(Core.stripPartMetadata(input as never))
    const u = {
      id: "msg_1",
      sessionID: "ses_1",
      role: "user",
      time: { created: 1 },
      agent: "a",
      model: { providerID: "p", modelID: "m" },
      summary: { diffs: [{ file: "a", patch: "x".repeat(Snapshot.MAX_DIFF_SIZE + 1), additions: 1, deletions: 1 }] },
    } as unknown as Parameters<typeof MessageV2.stripMessageMetadata>[0]
    expect(MessageV2.stripMessageMetadata(u)).toEqual(Core.stripMessageMetadata(u as never))
  })

  it("256KiB boundary retained, over removed", () => {
    const exact = "x".repeat(Snapshot.MAX_DIFF_SIZE)
    const over = "x".repeat(Snapshot.MAX_DIFF_SIZE + 1)
    const mk = (patch: string) =>
      ({
        id: "prt_1",
        sessionID: "ses_1",
        messageID: "msg_1",
        type: "tool",
        callID: "c",
        tool: "edit",
        state: { status: "completed", input: {}, output: "ok", title: "t", metadata: { filediff: { file: "a", patch } }, time: { start: 0, end: 1 } },
      }) as unknown as Parameters<typeof MessageV2.stripPartMetadata>[0]
    const kept = MessageV2.stripPartMetadata(mk(exact)) as unknown as { state: { status: "completed"; metadata: { filediff: { patch?: string } } } }
    expect(kept.state.metadata.filediff.patch).toBe(exact)
    const dropped = MessageV2.stripPartMetadata(mk(over)) as unknown as { state: { status: "completed"; metadata: { filediff: { patch?: string } } } }
    expect(dropped.state.metadata.filediff.patch).toBeUndefined()
  })
})
