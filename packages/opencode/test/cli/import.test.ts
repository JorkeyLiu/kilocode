import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import type { Session as SDKSession, Message, Part } from "@kilocode/sdk/v2"
import {
  parseShareUrl,
  transformShareData,
  bootstrapImportedSessionIngest,
  ingestBootstrapWarning,
  shouldAttachShareAuthHeaders,
  applyImportAggregate,
  type ShareData,
} from "../../src/cli/cmd/import"
import { Database } from "@opencode-ai/core/database/database"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionTable, MessageTable, PartTable } from "@opencode-ai/core/session/sql"
import { ProjectV2 } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { makeRuntime } from "@opencode-ai/core/effect/runtime"
import { Effect } from "effect"
import { eq } from "drizzle-orm"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import type { SessionImportType } from "../../src/kilocode/session-import/types"

// parseShareUrl tests
test("parses valid Kilo share URLs", () => {
  expect(parseShareUrl("https://app.kilo.ai/s/7a755b04-b0fe-4e66-8b30-0ab52a181bd4")).toBe(
    "7a755b04-b0fe-4e66-8b30-0ab52a181bd4",
  )
  expect(parseShareUrl("https://app.kilo.ai/s/Jsj3hNIW")).toBe("Jsj3hNIW")
  expect(parseShareUrl("https://app.kilo.ai/s/test_id-123")).toBe("test_id-123")
})

test("rejects invalid URLs", () => {
  expect(parseShareUrl("https://app.kilo.ai/s/")).toBeNull()
  expect(parseShareUrl("https://app.kilo.ai/s/id/extra")).toBeNull()
  expect(parseShareUrl("https://opncd.ai/share/Jsj3hNIW")).toBeNull()
  expect(parseShareUrl("https://other.example.com/s/abc")).toBeNull()
  expect(parseShareUrl("not-a-url")).toBeNull()
})

test("only attaches share auth headers for same-origin URLs", () => {
  expect(shouldAttachShareAuthHeaders("https://control.example.com/share/abc", "https://control.example.com")).toBe(
    true,
  )
  expect(shouldAttachShareAuthHeaders("https://other.example.com/share/abc", "https://control.example.com")).toBe(false)
  expect(shouldAttachShareAuthHeaders("https://control.example.com:443/share/abc", "https://control.example.com")).toBe(
    true,
  )
  expect(shouldAttachShareAuthHeaders("not-a-url", "https://control.example.com")).toBe(false)
})

// transformShareData tests
test("transforms share data to storage format", () => {
  const data: ShareData[] = [
    { type: "session", data: { id: "sess-1", title: "Test" } as SDKSession },
    { type: "message", data: { id: "msg-1", sessionID: "sess-1" } as Message },
    { type: "part", data: { id: "part-1", messageID: "msg-1" } as Part },
    { type: "part", data: { id: "part-2", messageID: "msg-1" } as Part },
  ]

  const result = transformShareData(data)!

  expect(result.info.id).toBe("sess-1")
  expect(result.messages).toHaveLength(1)
  expect(result.messages[0].parts).toHaveLength(2)
})

test("returns null for invalid share data", () => {
  expect(transformShareData([])).toBeNull()
  expect(transformShareData([{ type: "message", data: {} as Message }])).toBeNull()
  expect(transformShareData([{ type: "session", data: { id: "s" } as SDKSession }])).toBeNull() // no messages
})

test("formats ingest bootstrap warning", () => {
  expect(ingestBootstrapWarning("session-123", new Error("network failed"))).toContain("session-123")
  expect(ingestBootstrapWarning("session-123", new Error("network failed"))).toContain("network failed")
  expect(ingestBootstrapWarning("session-123", "oops")).toContain("oops")
})

test("bootstrapImportedSessionIngest runs bootstrap and does not warn on success", async () => {
  const calls: string[] = []
  const warnings: string[] = []

  await bootstrapImportedSessionIngest("session-success", {
    bootstrap: async (sessionId) => {
      calls.push(sessionId)
    },
    warn: (message) => warnings.push(message),
  })

  expect(calls).toEqual(["session-success"])
  expect(warnings).toHaveLength(0)
})

test("bootstrapImportedSessionIngest warns and continues on failure", async () => {
  const warnings: string[] = []

  await expect(
    bootstrapImportedSessionIngest("session-fail", {
      bootstrap: async () => {
        throw new Error("boom")
      },
      warn: (message) => warnings.push(message),
    }),
  ).resolves.toBeUndefined()

  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain("session-fail")
  expect(warnings[0]).toContain("boom")
})

// --- CLI aggregate transaction integration tests ---
// These exercise the production `applyImportAggregate` code path to validate
// ownership, idempotency, and rollback semantics.

const projectID = ProjectV2.ID.make("proj_cli_test")
const runtime = makeRuntime(Database.Service, Database.defaultLayer)
const db = <A, E>(effect: Effect.Effect<A, E, Database.Service>) => runtime.runPromise(() => effect)

const sessID = SessionID.make("ses_cli_import")
const msgID = MessageID.make("msg_cli_1")
const partID = PartID.make("prt_cli_1")

async function seed() {
  await db(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db.delete(PartTable).where(eq(PartTable.session_id, sessID)).run()
      yield* db.delete(MessageTable).where(eq(MessageTable.session_id, sessID)).run()
      yield* db.delete(SessionTable).where(eq(SessionTable.id, sessID)).run()
      yield* db.delete(ProjectTable).where(eq(ProjectTable.id, projectID)).run()
      yield* db
        .insert(ProjectTable)
        .values({ id: projectID, worktree: AbsolutePath.make("/workspace/cli-test"), sandboxes: [] })
        .run()
    }),
  )
}

async function cleanup() {
  await db(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db.delete(PartTable).where(eq(PartTable.session_id, sessID)).run()
      yield* db.delete(MessageTable).where(eq(MessageTable.session_id, sessID)).run()
      yield* db.delete(SessionTable).where(eq(SessionTable.id, sessID)).run()
      yield* db.delete(ProjectTable).where(eq(ProjectTable.id, projectID)).run()
    }),
  )
}

function msgData(): SessionImportType.UserMessageData {
  return { role: "user", time: { created: 1 }, agent: "test", model: { providerID: "t", modelID: "t" } }
}

function partData(): SessionImportType.TextPartData {
  return { type: "text", text: "hello" }
}

/** Run the production CLI aggregate transaction via applyImportAggregate. */
async function runCliAggregate(opts: {
  session?: { id: string; project_id: string; directory: string; path?: string }
  messages: Array<{
    id: string
    data: SessionImportType.UserMessageData
    timeCreated?: number
    parts: Array<{ id: string; messageID: string; data: SessionImportType.TextPartData }>
  }>
}) {
  const sid = opts.session?.id ?? "ses_cli_import"
  const pid = opts.session?.project_id ?? "proj_cli_test"
  const dir = opts.session?.directory ?? "/workspace/cli-test"
  const pth = opts.session?.path ?? ""

  return db(
    applyImportAggregate({
      session: { id: sid, project_id: pid, directory: dir, path: pth },
      messages: opts.messages.map((m) => ({
        info: {
          id: m.id,
          sessionID: sid,
          role: m.data.role,
          time: m.data.time,
          agent: m.data.agent,
          model: m.data.model,
        } as Message,
        parts: m.parts.map((p) => ({
          id: p.id,
          sessionID: sid,
          messageID: p.messageID,
          ...p.data,
        })),
      })),
    }).pipe(Effect.orDie),
  )
}

describe("CLI import aggregate transaction", () => {
  beforeEach(seed)
  afterEach(cleanup)

  test("exact retry is a true no-op — revision unchanged", async () => {
    await runCliAggregate({
      messages: [{ id: "msg_1", data: msgData(), parts: [{ id: "prt_1", messageID: "msg_1", data: partData() }] }],
    })
    const afterFirst = await db(
      Database.Service.use(({ db }) => db.select().from(SessionTable).where(eq(SessionTable.id, sessID)).get()),
    )
    expect(afterFirst?.revision).toBe(0) // new session, no prior existing → no advance

    // Exact retry
    await runCliAggregate({
      messages: [{ id: "msg_1", data: msgData(), parts: [{ id: "prt_1", messageID: "msg_1", data: partData() }] }],
    })
    const afterRetry = await db(
      Database.Service.use(({ db }) => db.select().from(SessionTable).where(eq(SessionTable.id, sessID)).get()),
    )
    expect(afterRetry?.revision).toBe(0) // unchanged

    // Verify no duplicate rows
    const msgs = await db(
      Database.Service.use(({ db }) => db.select().from(MessageTable).where(eq(MessageTable.session_id, sessID)).all()),
    )
    expect(msgs).toHaveLength(1)
  })

  test("cross-session message ownership rejects the entire aggregate", async () => {
    // Insert a message into session A directly
    await db(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* db
          .insert(SessionTable)
          .values({
            id: SessionID.make("ses_cli_other"),
            project_id: projectID,
            slug: "other",
            directory: "/workspace/cli-test",
            title: "Other",
            version: "v2",
            time_created: 1,
            time_updated: 1,
            revision: 0,
          })
          .run()
        yield* db
          .insert(MessageTable)
          .values({ id: msgID, session_id: SessionID.make("ses_cli_other"), time_created: 1, data: msgData() as never })
          .run()
      }),
    )

    // Attempting to import msgID into ses_cli_import must fail
    await expect(
      runCliAggregate({
        messages: [{ id: "msg_cli_1", data: msgData(), parts: [] }],
      }),
    ).rejects.toThrow("belongs to session")

    // Session B revision must not have changed
    const other = await db(
      Database.Service.use(({ db }) =>
        db
          .select()
          .from(SessionTable)
          .where(eq(SessionTable.id, SessionID.make("ses_cli_other")))
          .get(),
      ),
    )
    expect(other?.revision).toBe(0)

    // Session A must not have been created (transaction rolled back)
    const self = await db(
      Database.Service.use(({ db }) => db.select().from(SessionTable).where(eq(SessionTable.id, sessID)).get()),
    )
    expect(self).toBeUndefined()

    // Cleanup the extra session
    await db(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* db
          .delete(MessageTable)
          .where(eq(MessageTable.session_id, SessionID.make("ses_cli_other")))
          .run()
        yield* db
          .delete(SessionTable)
          .where(eq(SessionTable.id, SessionID.make("ses_cli_other")))
          .run()
      }),
    )
  })

  test("cross-message part ownership rejects the entire aggregate", async () => {
    // Seed session + msg_a
    await db(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* db
          .insert(SessionTable)
          .values({
            id: sessID,
            project_id: projectID,
            slug: "test",
            directory: "/workspace/cli-test",
            title: "CLI Import",
            version: "v2",
            time_created: 1,
            time_updated: 1,
            revision: 0,
          })
          .run()
        yield* db
          .insert(MessageTable)
          .values({
            id: MessageID.make("msg_a"),
            session_id: sessID,
            time_created: 1,
            data: msgData() as never,
          })
          .run()
        yield* db
          .insert(PartTable)
          .values({
            id: partID,
            message_id: MessageID.make("msg_a"),
            session_id: sessID,
            data: partData() as never,
          })
          .run()
      }),
    )

    // Import msg_b + attempt to claim prt_cli_1 (already belongs to msg_a)
    await expect(
      runCliAggregate({
        messages: [
          {
            id: "msg_b",
            data: msgData(),
            parts: [{ id: "prt_cli_1", messageID: "msg_b", data: partData() }],
          },
        ],
      }),
    ).rejects.toThrow("belongs to message")
  })

  test("successful update import advances revision exactly once", async () => {
    // Initial import
    await runCliAggregate({
      messages: [
        { id: "msg_upd", data: msgData(), parts: [{ id: "prt_upd", messageID: "msg_upd", data: partData() }] },
      ],
    })

    // Update with changed data
    const changedMsgData = { ...msgData(), agent: "updated" }
    await runCliAggregate({
      messages: [
        { id: "msg_upd", data: changedMsgData, parts: [{ id: "prt_upd", messageID: "msg_upd", data: partData() }] },
      ],
    })

    const row = await db(
      Database.Service.use(({ db }) => db.select().from(SessionTable).where(eq(SessionTable.id, sessID)).get()),
    )
    // New session (revision 0) → changed session data → advance once = 1
    expect(row?.revision).toBe(1)
  })

  test("key-order equality — reinserted data with different key order is a no-op", async () => {
    // Initial import with specific key order
    await runCliAggregate({
      messages: [{ id: "msg_ko", data: msgData(), parts: [{ id: "prt_ko", messageID: "msg_ko", data: partData() }] }],
    })

    // Re-import with same logical data but different key ordering (isDeepStrictEqual is order-insensitive)
    await db(
      applyImportAggregate({
        session: { id: "ses_cli_import", project_id: "proj_cli_test", directory: "/workspace/cli-test", path: "" },
        messages: [
          {
            info: {
              sessionID: "ses_cli_import",
              id: "msg_ko",
              role: "user",
              model: { providerID: "t", modelID: "t" },
              time: { created: 1 },
              agent: "test",
            } as Message,
            parts: [
              { id: "prt_ko", sessionID: "ses_cli_import", messageID: "msg_ko", text: "hello", type: "text" } as Part,
            ],
          },
        ],
      }).pipe(Effect.orDie),
    )

    const row = await db(
      Database.Service.use(({ db }) => db.select().from(SessionTable).where(eq(SessionTable.id, sessID)).get()),
    )
    expect(row?.revision).toBe(0) // no-op, revision must not advance

    // Verify no duplicate rows
    const msgs = await db(
      Database.Service.use(({ db }) => db.select().from(MessageTable).where(eq(MessageTable.session_id, sessID)).all()),
    )
    expect(msgs).toHaveLength(1)
  })

  test("new part referencing a nonexistent message rejects the aggregate", async () => {
    await runCliAggregate({
      messages: [{ id: "msg_ex", data: msgData(), parts: [] }],
    })

    // Import a part referencing msg_ex but via a different message ID in the import payload
    await expect(
      runCliAggregate({
        messages: [
          {
            id: "msg_other",
            data: msgData(),
            parts: [{ id: "prt_orphan", messageID: "msg_ex", data: partData() }],
          },
        ],
      }),
    ).rejects.toThrow("not its containing message")
  })
})
