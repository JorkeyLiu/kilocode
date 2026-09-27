import { describe, it, expect } from "bun:test"
import { fetchMessagePage } from "../../src/kilo-provider/message-page"
import { canonicalDirectory } from "../../src/private-worker/canonical-directory"
import { decodeMessageCursor, encodeMessageCursor } from "../../src/private-worker/message-read"

// Private-authority contract: paged transcript reads come from
// `tryPrivateMessagesPage` on the `PrivateSessionReader`; the SDK client is
// never a source. The mock below answers the real private reader API
// (`observation/messages` shaped result: version + status + messages +
// nextCursor) and enforces the same scope/ordering/cursor invariants the
// controller boundary validates.
const DIR = "/repo"
const SID = "ses_s1"

type Message = {
  info: Record<string, unknown> & { id: string; sessionID: string; role: string; time: { created: number } }
  parts: unknown[]
}

function message(id: string, role: "user" | "assistant", time: number): Message {
  const common = { id, sessionID: SID, role, time: { created: time } }
  return role === "user"
    ? { info: { ...common, agent: "build", model: { providerID: "anthropic", modelID: "claude" } }, parts: [] }
    : {
        info: {
          ...common,
          parentID: "msg_parent",
          modelID: "claude",
          providerID: "anthropic",
          mode: "build",
          agent: "build",
          path: { cwd: DIR, root: DIR },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
        parts: [],
      }
}

// Wire invariant: `nextCursor` anchors the oldest (first, ASC) message of the
// page it was returned with.
function oldest(items: Message[]): string {
  return encodeMessageCursor({ id: items[0]!.info.id, time: items[0]!.info.time.created })
}

type Page = {
  items: Message[]
  // undefined: server anchors the full page; null: server returned a full page
  // with no cursor; string: explicit server cursor.
  cursor?: string | null
}

function mockReader(pages: Page[]) {
  const calls: { sessionId: string; directory: string; limit: number; cursor?: string }[] = []
  let idx = 0
  const reader = {
    isEnabled: () => true,
    isStarted: () => true,
    list: async () => ({ v: "1.0", entries: [] }),
    get: async (input: { directory: string; sessionId: string }) => ({
      v: "1.0",
      status: "found",
      session: {
        id: input.sessionId,
        title: "Session",
        parentID: null,
        directory: input.directory,
        projectID: "proj_test",
        createdAt: 1000,
        updatedAt: 2000,
      },
    }),
    messages: async (input: { directory: string; sessionId: string; limit: number; cursor?: string }) => {
      calls.push({ sessionId: input.sessionId, directory: input.directory, limit: input.limit, cursor: input.cursor })
      // Private scope binding: the worker only answers for the canonical
      // directory it was asked for, and never for a foreign spelling.
      if (canonicalDirectory(input.directory) !== input.directory) return { v: "1.0", status: "scope_mismatch" }
      const page = pages[idx++]
      if (!page) throw new Error("no more mock pages")
      const cursor =
        page.cursor === undefined
          ? page.items.length === input.limit
            ? oldest(page.items)
            : undefined
          : (page.cursor ?? undefined)
      return {
        v: "1.0",
        status: "found",
        messages: page.items.map((item) => ({ info: { ...item.info, sessionID: input.sessionId }, parts: item.parts })),
        ...(cursor ? { nextCursor: cursor } : {}),
      }
    },
  }
  return { reader, calls }
}

// Private-authority: any SDK transcript read is a contract violation, so the
// client stub records the attempt and fails loudly instead of silently
// answering.
function mockSdk() {
  const calls: unknown[] = []
  return {
    calls,
    client: {
      session: {
        messages: async (params: unknown) => {
          calls.push(params)
          throw new Error("SDK session.messages must not be used (private-authority)")
        },
      },
    },
  }
}

describe("fetchMessagePage / private page cursor", () => {
  it("returns the private page cursor for the oldest message on a full page", async () => {
    const { reader, calls } = mockReader([
      {
        items: [message("msg_m1", "user", 1), message("msg_m2", "assistant", 2), message("msg_m3", "user", 3)],
      },
    ])
    const { client, calls: sdk } = mockSdk()

    const page = await fetchMessagePage(
      client as never,
      { sessionID: SID, workspaceDir: DIR, limit: 3 },
      null,
      reader as never,
    )

    expect(page.items.map((item) => item.info.id)).toEqual(["msg_m1", "msg_m2", "msg_m3"])
    // Cursor must be a base64url-encoded { id, time } anchor of the oldest
    // item so the next private page request is accepted as its `before`.
    const decoded = JSON.parse(Buffer.from(page.cursor!, "base64url").toString("utf8"))
    expect(decoded).toEqual({ id: "msg_m1", time: 1 })
    expect(calls).toEqual([{ sessionId: SID, directory: DIR, limit: 3, cursor: undefined }])
    expect(sdk).toEqual([])
  })

  it("synthesizes no cursor and issues no second page when a full private page omits nextCursor", async () => {
    // Private-authority invariant: the reader is the only cursor authority. A
    // full page that carries no `nextCursor` means the worker has no older
    // rows, so the page must end there — no invented cursor, no SDK retry,
    // and no follow-up private page.
    const { reader, calls } = mockReader([
      {
        items: [
          message("msg_m1", "user", 10),
          message("msg_m2", "assistant", 20),
          message("msg_m3", "user", 30),
          message("msg_m4", "assistant", 40),
        ],
        // Intentionally cursorless: the reader reported no older rows.
        cursor: null,
      },
    ])
    const { client, calls: sdk } = mockSdk()

    const page = await fetchMessagePage(
      client as never,
      { sessionID: SID, workspaceDir: DIR, limit: 4 },
      null,
      reader as never,
    )

    expect(page.items).toHaveLength(4)
    expect(page.cursor).toBeUndefined()
    expect(calls).toHaveLength(1)
    expect(sdk).toEqual([])
  })

  it("leaves cursor undefined when the private page is not full (truly no more)", async () => {
    const { reader, calls } = mockReader([
      {
        items: [message("msg_m1", "user", 10), message("msg_m2", "assistant", 20)],
      },
    ])
    const { client, calls: sdk } = mockSdk()

    const page = await fetchMessagePage(
      client as never,
      { sessionID: SID, workspaceDir: DIR, limit: 80 },
      null,
      reader as never,
    )

    expect(page.cursor).toBeUndefined()
    expect(calls).toHaveLength(1)
    expect(sdk).toEqual([])
  })

  it("round-trips the private page cursor into the next private page request", async () => {
    // First page: full page -> cursor anchored on its oldest message.
    // The next request carries that cursor and returns the older page.
    const first = [message("msg_m3", "user", 30), message("msg_m4", "assistant", 40)]
    const { reader, calls } = mockReader([
      { items: first },
      {
        items: [message("msg_m1", "user", 10), message("msg_m2", "assistant", 20)],
      },
    ])
    const { client, calls: sdk } = mockSdk()

    const head = await fetchMessagePage(
      client as never,
      { sessionID: SID, workspaceDir: DIR, limit: 2 },
      null,
      reader as never,
    )
    expect(head.cursor).toBe(oldest(first))

    const older = await fetchMessagePage(
      client as never,
      { sessionID: SID, workspaceDir: DIR, limit: 2, before: head.cursor },
      null,
      reader as never,
    )

    expect(older.items.map((item) => item.info.id)).toEqual(["msg_m1", "msg_m2"])
    expect(calls[1]?.cursor).toBe(head.cursor)
    expect(decodeMessageCursor(older.cursor!)).toEqual({ id: "msg_m1", time: 10 })
    expect(sdk).toEqual([])
  })

  it("keeps all fetched older messages when filling a partial assistant turn", async () => {
    const tail = [message("msg_m4", "assistant", 40), message("msg_m5", "user", 50), message("msg_m6", "user", 60)]
    const { reader, calls } = mockReader([
      { items: tail },
      {
        items: [message("msg_m1", "user", 10), message("msg_m2", "assistant", 20), message("msg_m3", "user", 30)],
      },
    ])
    const { client, calls: sdk } = mockSdk()

    const page = await fetchMessagePage(
      client as never,
      { sessionID: SID, workspaceDir: DIR, limit: 3 },
      null,
      reader as never,
    )

    expect(calls.map((call) => call.cursor)).toEqual([undefined, oldest(tail)])
    expect(page.items.map((item) => item.info.id)).toEqual(["msg_m1", "msg_m2", "msg_m3", "msg_m4", "msg_m5", "msg_m6"])
    expect(page.cursor).toBe(encodeMessageCursor({ id: "msg_m1", time: 10 }))
    expect(sdk).toEqual([])
  })

  it("continues fetching until a partial assistant turn reaches the first user message", async () => {
    const tail = [message("msg_m4", "assistant", 40), message("msg_m5", "user", 50)]
    const mid = [message("msg_m2", "assistant", 20), message("msg_m3", "user", 30)]
    const { reader, calls } = mockReader([
      { items: tail },
      { items: mid },
      {
        items: [message("msg_m1", "user", 10)],
      },
    ])
    const { client, calls: sdk } = mockSdk()

    const page = await fetchMessagePage(
      client as never,
      { sessionID: SID, workspaceDir: DIR, limit: 2 },
      null,
      reader as never,
    )

    expect(calls.map((call) => call.cursor)).toEqual([undefined, oldest(tail), oldest(mid)])
    expect(page.items.map((item) => item.info.id)).toEqual(["msg_m1", "msg_m2", "msg_m3", "msg_m4", "msg_m5"])
    expect(page.cursor).toBeUndefined()
    expect(sdk).toEqual([])
  })

  it("bounds assistant turn filling when older pages never reach a user message", async () => {
    const tail = [message("msg_m5", "assistant", 50), message("msg_m6", "assistant", 60)]
    const mid = [message("msg_m3", "assistant", 30), message("msg_m4", "assistant", 40)]
    const oldestPage = [message("msg_m1", "assistant", 10), message("msg_m2", "assistant", 20)]
    const { reader, calls } = mockReader([
      { items: tail },
      { items: mid },
      { items: oldestPage },
      {
        items: [message("msg_m0", "user", 0)],
      },
    ])
    const { client, calls: sdk } = mockSdk()

    const page = await fetchMessagePage(
      client as never,
      { sessionID: SID, workspaceDir: DIR, limit: 2 },
      null,
      reader as never,
    )

    expect(calls.map((call) => call.cursor)).toEqual([undefined, oldest(tail), oldest(mid)])
    expect(page.items.map((item) => item.info.id)).toEqual(["msg_m1", "msg_m2", "msg_m3", "msg_m4", "msg_m5", "msg_m6"])
    expect(page.cursor).toBe(oldest(oldestPage))
    expect(sdk).toEqual([])
  })

  it("fails closed with the scope terminal when the private reader reports an out-of-scope session", async () => {
    // A non-canonical requested directory is out of scope for the worker, so
    // the private terminal surfaces instead of any SDK transcript read.
    const { reader, calls } = mockReader([
      {
        items: [message("msg_m1", "user", 1)],
      },
    ])
    const { client, calls: sdk } = mockSdk()

    await expect(
      fetchMessagePage(
        client as never,
        { sessionID: SID, workspaceDir: "/repo/../repo", limit: 1 },
        null,
        reader as never,
      ),
    ).rejects.toThrow(/scope/i)
    expect(calls).toHaveLength(1)
    expect(sdk).toEqual([])
  })
})
