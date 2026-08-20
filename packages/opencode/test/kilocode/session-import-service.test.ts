import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { MessageTable, PartTable, SessionTable } from "@opencode-ai/core/session/sql"
import { ProjectV2 } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { makeRuntime } from "@opencode-ai/core/effect/runtime"
import { Effect } from "effect"
import { eq } from "drizzle-orm"
import { SessionImportService } from "../../src/kilocode/session-import/service"
import type { SessionImportType } from "../../src/kilocode/session-import/types"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

const projectID = ProjectV2.ID.make("proj_test")

const runtime = makeRuntime(Database.Service, Database.defaultLayer)
const db = <A, E>(effect: Effect.Effect<A, E, Database.Service>) => runtime.runPromise(() => effect)

async function prepare() {
  await db(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .delete(SessionTable)
        .where(eq(SessionTable.id, SessionID.make(input().id)))
        .run()
      yield* db.delete(ProjectTable).where(eq(ProjectTable.id, projectID)).run()
      yield* db
        .insert(ProjectTable)
        .values({ id: projectID, worktree: AbsolutePath.make("/workspace/testing"), sandboxes: [] })
        .run()
    }),
  )
}

function input(force?: boolean) {
  return {
    id: "ses_migrated_test",
    projectID: "proj_test",
    slug: "legacy-task",
    directory: "/workspace/testing",
    title: force ? "Reimported task" : "Legacy task",
    version: "v2",
    timeCreated: 1,
    timeUpdated: 1,
    ...(force ? { force: true } : {}),
  }
}

function project(worktree: string) {
  return {
    id: "legacy_project",
    worktree,
    timeCreated: 1,
    timeUpdated: 1,
    sandboxes: [],
  }
}

describe("SessionImportService.project", () => {
  afterEach(async () => {
    await resetDatabase()
  })

  test("rejects an empty legacy worktree", async () => {
    await expect(SessionImportService.project(project("  "))).rejects.toThrow(
      "Legacy project import requires a non-empty worktree",
    )
  })

  test("resolves a valid legacy project through Project.Service", async () => {
    await using tmp = await tmpdir({ git: true })

    const result = await SessionImportService.project(project(tmp.path))

    expect(result.ok).toBe(true)
    expect(result.id).not.toBe("global")
  })
})

describe("SessionImportService.session", () => {
  beforeEach(prepare)
  afterEach(prepare)

  test("returns skipped when the session already exists and force is false", async () => {
    await SessionImportService.session(input())

    const result = await SessionImportService.session(input())

    expect(result).toEqual({ ok: true, id: "ses_migrated_test", skipped: true })
  })

  test("deletes and recreates the session when force is true", async () => {
    await SessionImportService.session(input())

    // The forced delete must cascade to dependent messages and parts, not just replace the session row.
    const sessionID = SessionID.make(input().id)
    const messageID = MessageID.make("msg_forced_cleanup")
    await db(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* db
          .insert(MessageTable)
          .values({ id: messageID, session_id: sessionID, data: { role: "user" } as never })
          .run()
        yield* db
          .insert(PartTable)
          .values({
            id: PartID.make("prt_forced_cleanup"),
            message_id: messageID,
            session_id: sessionID,
            data: { type: "text", text: "seed" } as never,
          })
          .run()
      }),
    )

    const result = await SessionImportService.session(input(true))
    const [row, messages, parts] = await db(
      Database.Service.use(({ db }) =>
        Effect.all([
          db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get(),
          db.select().from(MessageTable).where(eq(MessageTable.session_id, sessionID)).all(),
          db.select().from(PartTable).where(eq(PartTable.session_id, sessionID)).all(),
        ]),
      ),
    )

    expect(result).toEqual({ ok: true, id: "ses_migrated_test" })
    expect(row?.title).toBe("Reimported task")
    expect(messages).toEqual([])
    expect(parts).toEqual([])
  })
})

describe("SessionImportService revision assertions", () => {
  beforeEach(prepare)
  afterEach(prepare)

  test("new session import starts at revision 0", async () => {
    const result = await SessionImportService.session(input())
    expect(result.ok).toBe(true)

    const row = await db(
      Database.Service.use(({ db }) =>
        db
          .select()
          .from(SessionTable)
          .where(eq(SessionTable.id, SessionID.make(input().id)))
          .get(),
      ),
    )
    expect(row?.revision).toBe(0)
  })

  test("forced reimport advances revision monotonically", async () => {
    // First import creates at revision 0
    await SessionImportService.session(input())
    // Force reimport advances to revision 1
    await SessionImportService.session(input(true))

    const row = await db(
      Database.Service.use(({ db }) =>
        db
          .select()
          .from(SessionTable)
          .where(eq(SessionTable.id, SessionID.make(input().id)))
          .get(),
      ),
    )
    expect(row?.revision).toBe(1)
    expect(row?.title).toBe("Reimported task")
  })

  test("imported message advances parent session revision", async () => {
    await SessionImportService.session(input())
    // Import a message — should advance session revision to 1
    await SessionImportService.message({
      id: "msg_import_rev",
      sessionID: input().id,
      timeCreated: 1,
      data: { role: "user", time: { created: 1 }, agent: "test", model: { providerID: "t", modelID: "t" } },
    })

    const row = await db(
      Database.Service.use(({ db }) =>
        db
          .select()
          .from(SessionTable)
          .where(eq(SessionTable.id, SessionID.make(input().id)))
          .get(),
      ),
    )
    expect(row?.revision).toBe(1)
  })

  test("imported part advances parent session revision", async () => {
    await SessionImportService.session(input())
    // Create a message first
    await SessionImportService.message({
      id: "msg_for_part",
      sessionID: input().id,
      timeCreated: 1,
      data: { role: "user", time: { created: 1 }, agent: "test", model: { providerID: "t", modelID: "t" } },
    })
    // Import a part — should advance session revision to 2
    await SessionImportService.part({
      id: "prt_import_rev",
      messageID: "msg_for_part",
      sessionID: input().id,
      timeCreated: 1,
      data: { type: "text", text: "hello" },
    })

    const row = await db(
      Database.Service.use(({ db }) =>
        db
          .select()
          .from(SessionTable)
          .where(eq(SessionTable.id, SessionID.make(input().id)))
          .get(),
      ),
    )
    expect(row?.revision).toBe(2) // session(0) → message(+1) → part(+1) = 2
  })
})

describe("SessionImportService.session affected-row assertion", () => {
  beforeEach(prepare)
  afterEach(prepare)

  test("new session: inserts exactly one row at revision 0", async () => {
    const result = await SessionImportService.session(input())
    expect(result).toEqual({ ok: true, id: "ses_migrated_test" })

    // Exactly one session row exists and has the expected revision.
    const rows = await db(
      Database.Service.use(({ db }) =>
        db
          .select()
          .from(SessionTable)
          .where(eq(SessionTable.id, SessionID.make(input().id)))
          .all(),
      ),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].revision).toBe(0)
  })

  test("force replacement: replaces exactly one row, revision = prior + 1", async () => {
    await SessionImportService.session(input())

    const result = await SessionImportService.session(input(true))
    expect(result).toEqual({ ok: true, id: "ses_migrated_test" })

    const rows = await db(
      Database.Service.use(({ db }) =>
        db
          .select()
          .from(SessionTable)
          .where(eq(SessionTable.id, SessionID.make(input().id)))
          .all(),
      ),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].revision).toBe(1)
    expect(rows[0].title).toBe("Reimported task")
  })

  test("force replacement after multiple revisions: exactly one row, revision = prior + 1", async () => {
    await SessionImportService.session(input())
    // Advance revision via message import: 0 → 1
    await SessionImportService.message({
      id: "msg_pre_force",
      sessionID: input().id,
      timeCreated: 1,
      data: { role: "user", time: { created: 1 }, agent: "test", model: { providerID: "t", modelID: "t" } },
    })
    // Advance revision via part import: 1 → 2
    await SessionImportService.message({
      id: "msg_pre_force_2",
      sessionID: input().id,
      timeCreated: 2,
      data: { role: "user", time: { created: 2 }, agent: "test", model: { providerID: "t", modelID: "t" } },
    })

    // Force reimport should land at revision 3 (prior 2 + 1)
    const result = await SessionImportService.session(input(true))
    expect(result).toEqual({ ok: true, id: "ses_migrated_test" })

    const rows = await db(
      Database.Service.use(({ db }) =>
        db
          .select()
          .from(SessionTable)
          .where(eq(SessionTable.id, SessionID.make(input().id)))
          .all(),
      ),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].revision).toBe(3)
    expect(rows[0].title).toBe("Reimported task")
  })

  test("skipped path: no row mutation, returns immediately", async () => {
    await SessionImportService.session(input())
    const result = await SessionImportService.session(input())
    expect(result).toEqual({ ok: true, id: "ses_migrated_test", skipped: true })

    const rows = await db(
      Database.Service.use(({ db }) =>
        db
          .select()
          .from(SessionTable)
          .where(eq(SessionTable.id, SessionID.make(input().id)))
          .all(),
      ),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].revision).toBe(0) // unchanged
  })
})

describe("SessionImportService.session parent validation", () => {
  const otherProjectID = ProjectV2.ID.make("proj_other")

  beforeEach(async () => {
    await db(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        // Clean slate for both projects
        yield* db
          .delete(SessionTable)
          .where(eq(SessionTable.id, SessionID.make(input().id)))
          .run()
        yield* db
          .delete(SessionTable)
          .where(eq(SessionTable.id, SessionID.make("ses_parent")))
          .run()
        yield* db.delete(ProjectTable).where(eq(ProjectTable.id, projectID)).run()
        yield* db.delete(ProjectTable).where(eq(ProjectTable.id, otherProjectID)).run()
        yield* db
          .insert(ProjectTable)
          .values({ id: projectID, worktree: AbsolutePath.make("/workspace/testing"), sandboxes: [] })
          .run()
        yield* db
          .insert(ProjectTable)
          .values({ id: otherProjectID, worktree: AbsolutePath.make("/workspace/other"), sandboxes: [] })
          .run()
      }),
    )
  })

  afterEach(async () => {
    await db(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* db
          .delete(SessionTable)
          .where(eq(SessionTable.id, SessionID.make(input().id)))
          .run()
        yield* db
          .delete(SessionTable)
          .where(eq(SessionTable.id, SessionID.make("ses_parent")))
          .run()
        yield* db.delete(ProjectTable).where(eq(ProjectTable.id, projectID)).run()
        yield* db.delete(ProjectTable).where(eq(ProjectTable.id, otherProjectID)).run()
      }),
    )
  })

  test("rejects session with a parent that does not exist", async () => {
    await expect(SessionImportService.session({ ...input(), parentID: "ses_nonexistent" })).rejects.toThrow(
      "Parent session ses_nonexistent not found",
    )
  })

  test("rejects session with a parent that belongs to a different project", async () => {
    // Create a parent in the other project
    await SessionImportService.session({
      id: "ses_parent",
      projectID: "proj_other",
      slug: "parent-task",
      directory: "/workspace/other",
      title: "Parent task",
      version: "v2",
      timeCreated: 1,
      timeUpdated: 1,
    })

    await expect(SessionImportService.session({ ...input(), parentID: "ses_parent" })).rejects.toThrow(
      "Parent session ses_parent belongs to a different project",
    )
  })

  test("accepts session with a valid parent in the same project", async () => {
    // Create a parent in the same project
    await SessionImportService.session({
      id: "ses_parent",
      projectID: "proj_test",
      slug: "parent-task",
      directory: "/workspace/testing",
      title: "Parent task",
      version: "v2",
      timeCreated: 1,
      timeUpdated: 1,
    })

    const result = await SessionImportService.session({ ...input(), parentID: "ses_parent" })
    expect(result.ok).toBe(true)
  })
})

describe("SessionImportService.message integrity", () => {
  beforeEach(prepare)
  afterEach(prepare)

  const msgData: SessionImportType.UserMessageData = {
    role: "user",
    time: { created: 1 },
    agent: "test",
    model: { providerID: "t", modelID: "t" },
  }

  test("rejects message for a non-existent session", async () => {
    await expect(
      SessionImportService.message({ id: "msg_orphan", sessionID: "ses_nonexistent", timeCreated: 1, data: msgData }),
    ).rejects.toThrow("Session ses_nonexistent not found")
  })

  test("rejects cross-session message ID ownership", async () => {
    // Create session A and insert a message into it
    await SessionImportService.session(input())
    await SessionImportService.message({ id: "msg_shared", sessionID: input().id, timeCreated: 1, data: msgData })

    // Create session B
    const sessB = { ...input(), id: "ses_other", slug: "other" }
    await SessionImportService.session(sessB)

    // Attempting to import the same message ID into session B must fail atomically.
    await expect(
      SessionImportService.message({ id: "msg_shared", sessionID: "ses_other", timeCreated: 1, data: msgData }),
    ).rejects.toThrow("belongs to session")

    // Verify session B revision was NOT advanced (no state change).
    const rowB = await db(
      Database.Service.use(({ db }) =>
        db
          .select()
          .from(SessionTable)
          .where(eq(SessionTable.id, SessionID.make("ses_other")))
          .get(),
      ),
    )
    expect(rowB?.revision).toBe(0)
  })

  test("no-op when re-importing identical message data does not advance revision", async () => {
    await SessionImportService.session(input())
    await SessionImportService.message({ id: "msg_idempotent", sessionID: input().id, timeCreated: 1, data: msgData })

    // Record revision after first import
    const before = await db(
      Database.Service.use(({ db }) =>
        db
          .select()
          .from(SessionTable)
          .where(eq(SessionTable.id, SessionID.make(input().id)))
          .get(),
      ),
    )
    expect(before?.revision).toBe(1) // session(0) → message(+1)

    // Re-import with identical data
    const result = await SessionImportService.message({
      id: "msg_idempotent",
      sessionID: input().id,
      timeCreated: 1,
      data: msgData,
    })
    expect(result).toEqual({ ok: true, id: "msg_idempotent", skipped: true })

    // Revision must NOT have advanced
    const after = await db(
      Database.Service.use(({ db }) =>
        db
          .select()
          .from(SessionTable)
          .where(eq(SessionTable.id, SessionID.make(input().id)))
          .get(),
      ),
    )
    expect(after?.revision).toBe(1)
  })

  test("updating message data advances revision exactly once", async () => {
    await SessionImportService.session(input())
    await SessionImportService.message({ id: "msg_update", sessionID: input().id, timeCreated: 1, data: msgData })

    const changedData: SessionImportType.UserMessageData = { ...msgData, agent: "updated-agent" }
    await SessionImportService.message({ id: "msg_update", sessionID: input().id, timeCreated: 1, data: changedData })

    const row = await db(
      Database.Service.use(({ db }) =>
        db
          .select()
          .from(SessionTable)
          .where(eq(SessionTable.id, SessionID.make(input().id)))
          .get(),
      ),
    )
    // session(0) → first message(+1) → updated message(+1) = 2
    expect(row?.revision).toBe(2)
  })
})

describe("SessionImportService.part integrity", () => {
  beforeEach(prepare)
  afterEach(prepare)

  const partData: SessionImportType.TextPartData = { type: "text", text: "hello" }

  test("rejects part for a non-existent session", async () => {
    await expect(
      SessionImportService.part({
        id: "prt_orphan",
        messageID: "msg_orphan",
        sessionID: "ses_nonexistent",
        timeCreated: 1,
        data: partData,
      }),
    ).rejects.toThrow("Session ses_nonexistent not found")
  })

  test("rejects cross-message part ID ownership", async () => {
    await SessionImportService.session(input())
    // Create two messages
    await SessionImportService.message({
      id: "msg_a",
      sessionID: input().id,
      timeCreated: 1,
      data: { role: "user", time: { created: 1 }, agent: "test", model: { providerID: "t", modelID: "t" } },
    })
    await SessionImportService.message({
      id: "msg_b",
      sessionID: input().id,
      timeCreated: 2,
      data: { role: "user", time: { created: 2 }, agent: "test", model: { providerID: "t", modelID: "t" } },
    })
    // Insert a part into msg_a
    await SessionImportService.part({
      id: "prt_shared",
      messageID: "msg_a",
      sessionID: input().id,
      timeCreated: 1,
      data: partData,
    })

    // Attempting to import the same part ID into msg_b must fail atomically.
    await expect(
      SessionImportService.part({
        id: "prt_shared",
        messageID: "msg_b",
        sessionID: input().id,
        timeCreated: 1,
        data: partData,
      }),
    ).rejects.toThrow("belongs to message")

    // Verify session revision was NOT advanced by the failed import.
    const row = await db(
      Database.Service.use(({ db }) =>
        db
          .select()
          .from(SessionTable)
          .where(eq(SessionTable.id, SessionID.make(input().id)))
          .get(),
      ),
    )
    // session(0) → msg_a(+1) → msg_b(+1) → prt_shared(+1) = 3
    expect(row?.revision).toBe(3)
  })

  test("no-op when re-importing identical part data does not advance revision", async () => {
    await SessionImportService.session(input())
    await SessionImportService.message({
      id: "msg_for_noop_part",
      sessionID: input().id,
      timeCreated: 1,
      data: { role: "user", time: { created: 1 }, agent: "test", model: { providerID: "t", modelID: "t" } },
    })
    await SessionImportService.part({
      id: "prt_idempotent",
      messageID: "msg_for_noop_part",
      sessionID: input().id,
      timeCreated: 1,
      data: partData,
    })

    const before = await db(
      Database.Service.use(({ db }) =>
        db
          .select()
          .from(SessionTable)
          .where(eq(SessionTable.id, SessionID.make(input().id)))
          .get(),
      ),
    )
    expect(before?.revision).toBe(2) // session(0) → message(+1) → part(+1)

    // Re-import with identical data
    const result = await SessionImportService.part({
      id: "prt_idempotent",
      messageID: "msg_for_noop_part",
      sessionID: input().id,
      timeCreated: 1,
      data: partData,
    })
    expect(result).toEqual({ ok: true, id: "prt_idempotent", skipped: true })

    const after = await db(
      Database.Service.use(({ db }) =>
        db
          .select()
          .from(SessionTable)
          .where(eq(SessionTable.id, SessionID.make(input().id)))
          .get(),
      ),
    )
    expect(after?.revision).toBe(2) // unchanged
  })
})

describe("SessionImportService.part message ownership", () => {
  beforeEach(prepare)
  afterEach(prepare)

  const partData: SessionImportType.TextPartData = { type: "text", text: "hello" }

  test("rejects part referencing a nonexistent message", async () => {
    await SessionImportService.session(input())

    await expect(
      SessionImportService.part({
        id: "prt_no_msg",
        messageID: "msg_nonexistent",
        sessionID: input().id,
        timeCreated: 1,
        data: partData,
      }),
    ).rejects.toThrow("Message msg_nonexistent not found")
  })

  test("rejects part referencing a message in a different session", async () => {
    await SessionImportService.session(input())
    // Create message in session A
    await SessionImportService.message({
      id: "msg_in_a",
      sessionID: input().id,
      timeCreated: 1,
      data: { role: "user", time: { created: 1 }, agent: "test", model: { providerID: "t", modelID: "t" } },
    })

    // Create session B
    await SessionImportService.session({ ...input(), id: "ses_b", slug: "b" })

    // Attempt to import a part referencing msg_in_a into session B
    await expect(
      SessionImportService.part({
        id: "prt_cross",
        messageID: "msg_in_a",
        sessionID: "ses_b",
        timeCreated: 1,
        data: partData,
      }),
    ).rejects.toThrow("belongs to session")

    // Verify session B revision was NOT advanced
    const rowB = await db(
      Database.Service.use(({ db }) =>
        db
          .select()
          .from(SessionTable)
          .where(eq(SessionTable.id, SessionID.make("ses_b")))
          .get(),
      ),
    )
    expect(rowB?.revision).toBe(0)
  })

  test("rejects existing part that belongs to a different session", async () => {
    await SessionImportService.session(input())
    await SessionImportService.message({
      id: "msg_own_a",
      sessionID: input().id,
      timeCreated: 1,
      data: { role: "user", time: { created: 1 }, agent: "test", model: { providerID: "t", modelID: "t" } },
    })
    await SessionImportService.part({
      id: "prt_own",
      messageID: "msg_own_a",
      sessionID: input().id,
      timeCreated: 1,
      data: partData,
    })

    // Create session B with a different message
    await SessionImportService.session({ ...input(), id: "ses_b2", slug: "b2" })
    await SessionImportService.message({
      id: "msg_own_b",
      sessionID: "ses_b2",
      timeCreated: 1,
      data: { role: "user", time: { created: 2 }, agent: "other", model: { providerID: "x", modelID: "x" } },
    })

    // Attempt to import prt_own (already belongs to msg_own_a in session A) into session B's msg_own_b
    await expect(
      SessionImportService.part({
        id: "prt_own",
        messageID: "msg_own_b",
        sessionID: "ses_b2",
        timeCreated: 1,
        data: partData,
      }),
    ).rejects.toThrow("belongs to message")
  })
})

describe("SessionImportService isDeepStrictEqual key-order equality", () => {
  beforeEach(prepare)
  afterEach(prepare)

  test("message no-op ignores key ordering", async () => {
    await SessionImportService.session(input())
    const dataA: SessionImportType.UserMessageData = {
      role: "user",
      agent: "test",
      time: { created: 1 },
      model: { providerID: "t", modelID: "t" },
    }
    await SessionImportService.message({ id: "msg_ko", sessionID: input().id, timeCreated: 1, data: dataA })

    // Same data with different key order
    const dataB: SessionImportType.UserMessageData = {
      model: { modelID: "t", providerID: "t" },
      role: "user",
      time: { created: 1 },
      agent: "test",
    }
    const result = await SessionImportService.message({
      id: "msg_ko",
      sessionID: input().id,
      timeCreated: 1,
      data: dataB,
    })

    expect(result).toEqual({ ok: true, id: "msg_ko", skipped: true })
    // Revision must not have advanced beyond the initial message import
    const row = await db(
      Database.Service.use(({ db }) =>
        db
          .select()
          .from(SessionTable)
          .where(eq(SessionTable.id, SessionID.make(input().id)))
          .get(),
      ),
    )
    expect(row?.revision).toBe(1)
  })

  test("part no-op ignores key ordering", async () => {
    await SessionImportService.session(input())
    await SessionImportService.message({
      id: "msg_ko_part",
      sessionID: input().id,
      timeCreated: 1,
      data: { role: "user", time: { created: 1 }, agent: "test", model: { providerID: "t", modelID: "t" } },
    })

    const dataA: SessionImportType.TextPartData = { type: "text", text: "hello" }
    await SessionImportService.part({
      id: "prt_ko",
      messageID: "msg_ko_part",
      sessionID: input().id,
      timeCreated: 1,
      data: dataA,
    })

    // Same data with different key order
    const dataB: SessionImportType.TextPartData = { text: "hello", type: "text" }
    const result = await SessionImportService.part({
      id: "prt_ko",
      messageID: "msg_ko_part",
      sessionID: input().id,
      timeCreated: 1,
      data: dataB,
    })

    expect(result).toEqual({ ok: true, id: "prt_ko", skipped: true })
    const row = await db(
      Database.Service.use(({ db }) =>
        db
          .select()
          .from(SessionTable)
          .where(eq(SessionTable.id, SessionID.make(input().id)))
          .get(),
      ),
    )
    expect(row?.revision).toBe(2) // session(0) → msg(+1) → part(+1), no further advance
  })
})
