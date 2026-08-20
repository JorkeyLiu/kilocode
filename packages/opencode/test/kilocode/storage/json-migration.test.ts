import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { Database } from "bun:sqlite"
import { drizzle, type SQLiteBunDatabase } from "drizzle-orm/bun-sqlite"
import { migrate } from "drizzle-orm/bun-sqlite/migrator"
import { eq } from "drizzle-orm"
import path from "path"
import fs from "fs/promises"
import { readFileSync, readdirSync } from "fs"
import { JsonMigration } from "@/kilocode/storage/json-migration"
import { Global } from "@opencode-ai/core/global"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionTable, MessageTable, PartTable, TodoTable } from "@opencode-ai/core/session/sql"
import { PermissionTable } from "@opencode-ai/core/permission/sql"
import { SessionShareTable } from "@opencode-ai/core/share/sql"
import { ProjectV2 } from "@opencode-ai/core/project"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Flag } from "@opencode-ai/core/flag/flag"
import { remove as cleanup } from "../cleanup"

// Test fixtures
const fixtures = {
  project: {
    id: "proj_test123abc",
    name: "Test Project",
    worktree: "/test/path",
    vcs: "git" as const,
    sandboxes: [],
  },
  session: {
    id: "ses_test456def",
    projectID: "proj_test123abc",
    slug: "test-session",
    directory: "/test/path",
    title: "Test Session",
    version: "1.0.0",
    time: { created: 1700000000000, updated: 1700000001000 },
  },
  message: {
    id: "msg_test789ghi",
    sessionID: "ses_test456def",
    role: "user" as const,
    agent: "default",
    model: { providerID: "openai", modelID: "gpt-4" },
    time: { created: 1700000000000 },
  },
  part: {
    id: "prt_testabc123",
    messageID: "msg_test789ghi",
    sessionID: "ses_test456def",
    type: "text" as const,
    text: "Hello, world!",
  },
}

// Helper to create test storage directory structure
async function setupStorageDir() {
  const storageDir = path.join(Global.Path.data, "storage")
  await fs.rm(storageDir, { recursive: true, force: true })
  await fs.mkdir(path.join(storageDir, "project"), { recursive: true })
  await fs.mkdir(path.join(storageDir, "session", "proj_test123abc"), { recursive: true })
  await fs.mkdir(path.join(storageDir, "message", "ses_test456def"), { recursive: true })
  await fs.mkdir(path.join(storageDir, "part", "msg_test789ghi"), { recursive: true })
  await fs.mkdir(path.join(storageDir, "session_diff"), { recursive: true })
  await fs.mkdir(path.join(storageDir, "todo"), { recursive: true })
  await fs.mkdir(path.join(storageDir, "permission"), { recursive: true })
  await fs.mkdir(path.join(storageDir, "session_share"), { recursive: true })
  // Create legacy marker to indicate JSON storage exists
  await Bun.write(path.join(storageDir, "migration"), "1")
  return storageDir
}

async function writeProject(storageDir: string, project: Record<string, unknown> & { id: string }) {
  await Bun.write(path.join(storageDir, "project", `${project.id}.json`), JSON.stringify(project))
}

async function writeSession(storageDir: string, projectID: string, session: Record<string, unknown> & { id: string }) {
  await Bun.write(path.join(storageDir, "session", projectID, `${session.id}.json`), JSON.stringify(session))
}

// Helper to create in-memory test database with schema
function createTestDb() {
  const sqlite = new Database(":memory:")
  sqlite.exec("PRAGMA foreign_keys = ON")

  // Apply schema migrations using drizzle migrate
  const dir = path.join(import.meta.dirname, "../../../../core/migration")
  const entries = readdirSync(dir, { withFileTypes: true })
  const migrations = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      sql: readFileSync(path.join(dir, entry.name, "migration.sql"), "utf-8"),
      timestamp: Number(entry.name.split("_")[0]),
      name: entry.name,
    }))
    .sort((a, b) => a.timestamp - b.timestamp)

  const db = drizzle({ client: sqlite })
  migrate(db, migrations)

  return [sqlite, db] as const
}

describe("JSON to SQLite migration", () => {
  let storageDir: string
  let sqlite: Database
  let db: SQLiteBunDatabase

  beforeEach(async () => {
    storageDir = await setupStorageDir()
    ;[sqlite, db] = createTestDb()
  })

  afterEach(async () => {
    sqlite.close()
    await fs.rm(storageDir, { recursive: true, force: true })
  })

  test("migrates project", async () => {
    await writeProject(storageDir, {
      id: "proj_test123abc",
      worktree: "/test/path",
      vcs: "git",
      name: "Test Project",
      time: { created: 1700000000000, updated: 1700000001000 },
      sandboxes: ["/test/sandbox"],
    })

    const stats = await JsonMigration.run(db)

    expect(stats?.projects).toBe(1)

    const projects = db.select().from(ProjectTable).all()
    expect(projects.length).toBe(1)
    expect(projects[0].id).toBe(ProjectV2.ID.make("proj_test123abc"))
    expect(projects[0].worktree).toBe(AbsolutePath.make("/test/path"))
    expect(projects[0].name).toBe("Test Project")
    expect(projects[0].sandboxes).toEqual([AbsolutePath.make("/test/sandbox")])
  })

  test("uses filename for project id when JSON has different value", async () => {
    await Bun.write(
      path.join(storageDir, "project", "proj_filename.json"),
      JSON.stringify({
        id: "proj_different_in_json", // Stale! Should be ignored
        worktree: "/test/path",
        vcs: "git",
        name: "Test Project",
        sandboxes: [],
      }),
    )

    const stats = await JsonMigration.run(db)

    expect(stats?.projects).toBe(1)

    const projects = db.select().from(ProjectTable).all()
    expect(projects.length).toBe(1)
    expect(projects[0].id).toBe(ProjectV2.ID.make("proj_filename")) // Uses filename, not JSON id
  })

  test("migrates project with commands", async () => {
    await writeProject(storageDir, {
      id: "proj_with_commands",
      worktree: "/test/path",
      vcs: "git",
      name: "Project With Commands",
      time: { created: 1700000000000, updated: 1700000001000 },
      sandboxes: ["/test/sandbox"],
      commands: { start: "npm run dev" },
    })

    const stats = await JsonMigration.run(db)

    expect(stats?.projects).toBe(1)

    const projects = db.select().from(ProjectTable).all()
    expect(projects.length).toBe(1)
    expect(projects[0].id).toBe(ProjectV2.ID.make("proj_with_commands"))
    expect(projects[0].commands).toEqual({ start: "npm run dev" })
  })

  test("migrates project without commands field", async () => {
    await writeProject(storageDir, {
      id: "proj_no_commands",
      worktree: "/test/path",
      vcs: "git",
      name: "Project Without Commands",
      time: { created: 1700000000000, updated: 1700000001000 },
      sandboxes: [],
    })

    const stats = await JsonMigration.run(db)

    expect(stats?.projects).toBe(1)

    const projects = db.select().from(ProjectTable).all()
    expect(projects.length).toBe(1)
    expect(projects[0].id).toBe(ProjectV2.ID.make("proj_no_commands"))
    expect(projects[0].commands).toBeNull()
  })

  test("migrates session with individual columns", async () => {
    await writeProject(storageDir, {
      id: "proj_test123abc",
      worktree: "/test/path",
      time: { created: Date.now(), updated: Date.now() },
      sandboxes: [],
    })

    await writeSession(storageDir, "proj_test123abc", {
      id: "ses_test456def",
      projectID: "proj_test123abc",
      slug: "test-session",
      directory: "/test/dir",
      title: "Test Session Title",
      version: "1.0.0",
      time: { created: 1700000000000, updated: 1700000001000 },
      summary: { additions: 10, deletions: 5, files: 3 },
      share: { url: "https://example.com/share" },
    })

    await JsonMigration.run(db)

    const sessions = db.select().from(SessionTable).all()
    expect(sessions.length).toBe(1)
    expect(sessions[0].id).toBe(SessionSchema.ID.make("ses_test456def"))
    expect(sessions[0].project_id).toBe(ProjectV2.ID.make("proj_test123abc"))
    expect(sessions[0].slug).toBe("test-session")
    expect(sessions[0].title).toBe("Test Session Title")
    expect(sessions[0].summary_additions).toBe(10)
    expect(sessions[0].summary_deletions).toBe(5)
    expect(sessions[0].share_url).toBe("https://example.com/share")
  })

  test("migrates messages and parts", async () => {
    await writeProject(storageDir, {
      id: "proj_test123abc",
      worktree: "/",
      time: { created: Date.now(), updated: Date.now() },
      sandboxes: [],
    })
    await writeSession(storageDir, "proj_test123abc", { ...fixtures.session })
    await Bun.write(
      path.join(storageDir, "message", "ses_test456def", "msg_test789ghi.json"),
      JSON.stringify({ ...fixtures.message }),
    )
    await Bun.write(
      path.join(storageDir, "part", "msg_test789ghi", "prt_testabc123.json"),
      JSON.stringify({ ...fixtures.part }),
    )

    const stats = await JsonMigration.run(db)

    expect(stats?.messages).toBe(1)
    expect(stats?.parts).toBe(1)

    const messages = db.select().from(MessageTable).all()
    expect(messages.length).toBe(1)
    expect(messages[0].id).toBe(SessionV1.MessageID.make("msg_test789ghi"))

    const parts = db.select().from(PartTable).all()
    expect(parts.length).toBe(1)
    expect(parts[0].id).toBe(SessionV1.PartID.make("prt_testabc123"))
  })

  test("migrates legacy parts without ids in body", async () => {
    await writeProject(storageDir, {
      id: "proj_test123abc",
      worktree: "/",
      time: { created: Date.now(), updated: Date.now() },
      sandboxes: [],
    })
    await writeSession(storageDir, "proj_test123abc", { ...fixtures.session })
    await Bun.write(
      path.join(storageDir, "message", "ses_test456def", "msg_test789ghi.json"),
      JSON.stringify({
        role: "user",
        agent: "default",
        model: { providerID: "openai", modelID: "gpt-4" },
        time: { created: 1700000000000 },
      }),
    )
    await Bun.write(
      path.join(storageDir, "part", "msg_test789ghi", "prt_testabc123.json"),
      JSON.stringify({
        type: "text",
        text: "Hello, world!",
      }),
    )

    const stats = await JsonMigration.run(db)

    expect(stats?.messages).toBe(1)
    expect(stats?.parts).toBe(1)

    const messages = db.select().from(MessageTable).all()
    expect(messages.length).toBe(1)
    expect(messages[0].id).toBe(SessionV1.MessageID.make("msg_test789ghi"))
    expect(messages[0].session_id).toBe(SessionSchema.ID.make("ses_test456def"))
    expect(messages[0].data).not.toHaveProperty("id")
    expect(messages[0].data).not.toHaveProperty("sessionID")

    const parts = db.select().from(PartTable).all()
    expect(parts.length).toBe(1)
    expect(parts[0].id).toBe(SessionV1.PartID.make("prt_testabc123"))
    expect(parts[0].message_id).toBe(SessionV1.MessageID.make("msg_test789ghi"))
    expect(parts[0].session_id).toBe(SessionSchema.ID.make("ses_test456def"))
    expect(parts[0].data).not.toHaveProperty("id")
    expect(parts[0].data).not.toHaveProperty("messageID")
    expect(parts[0].data).not.toHaveProperty("sessionID")
  })

  test("uses filename for message id when JSON has different value", async () => {
    await writeProject(storageDir, {
      id: "proj_test123abc",
      worktree: "/",
      time: { created: Date.now(), updated: Date.now() },
      sandboxes: [],
    })
    await writeSession(storageDir, "proj_test123abc", { ...fixtures.session })
    await Bun.write(
      path.join(storageDir, "message", "ses_test456def", "msg_from_filename.json"),
      JSON.stringify({
        id: "msg_different_in_json", // Stale! Should be ignored
        sessionID: "ses_test456def",
        role: "user",
        agent: "default",
        time: { created: 1700000000000 },
      }),
    )

    const stats = await JsonMigration.run(db)

    expect(stats?.messages).toBe(1)

    const messages = db.select().from(MessageTable).all()
    expect(messages.length).toBe(1)
    expect(messages[0].id).toBe(SessionV1.MessageID.make("msg_from_filename")) // Uses filename, not JSON id
    expect(messages[0].session_id).toBe(SessionSchema.ID.make("ses_test456def"))
  })

  test("uses paths for part id and messageID when JSON has different values", async () => {
    await writeProject(storageDir, {
      id: "proj_test123abc",
      worktree: "/",
      time: { created: Date.now(), updated: Date.now() },
      sandboxes: [],
    })
    await writeSession(storageDir, "proj_test123abc", { ...fixtures.session })
    await Bun.write(
      path.join(storageDir, "message", "ses_test456def", "msg_realmsgid.json"),
      JSON.stringify({
        role: "user",
        agent: "default",
        time: { created: 1700000000000 },
      }),
    )
    await Bun.write(
      path.join(storageDir, "part", "msg_realmsgid", "prt_from_filename.json"),
      JSON.stringify({
        id: "prt_different_in_json", // Stale! Should be ignored
        messageID: "msg_different_in_json", // Stale! Should be ignored
        sessionID: "ses_test456def",
        type: "text",
        text: "Hello",
      }),
    )

    const stats = await JsonMigration.run(db)

    expect(stats?.parts).toBe(1)

    const parts = db.select().from(PartTable).all()
    expect(parts.length).toBe(1)
    expect(parts[0].id).toBe(SessionV1.PartID.make("prt_from_filename")) // Uses filename, not JSON id
    expect(parts[0].message_id).toBe(SessionV1.MessageID.make("msg_realmsgid")) // Uses parent dir, not JSON messageID
  })

  test("skips orphaned sessions (no parent project)", async () => {
    await Bun.write(
      path.join(storageDir, "session", "proj_test123abc", "ses_orphan.json"),
      JSON.stringify({
        id: "ses_orphan",
        projectID: "proj_nonexistent",
        slug: "orphan",
        directory: "/",
        title: "Orphan",
        version: "1.0.0",
        time: { created: Date.now(), updated: Date.now() },
      }),
    )

    const stats = await JsonMigration.run(db)

    expect(stats?.sessions).toBe(0)
  })

  test("uses directory path for projectID when JSON has stale value", async () => {
    // Simulates the scenario where earlier migration moved sessions to new
    // git-based project directories but didn't update the projectID field
    const gitBasedProjectID = "abc123gitcommit"
    await writeProject(storageDir, {
      id: gitBasedProjectID,
      worktree: "/test/path",
      vcs: "git",
      time: { created: Date.now(), updated: Date.now() },
      sandboxes: [],
    })

    // Session is in the git-based directory but JSON still has old projectID
    await writeSession(storageDir, gitBasedProjectID, {
      id: "ses_migrated",
      projectID: "old-project-name", // Stale! Should be ignored
      slug: "migrated-session",
      directory: "/test/path",
      title: "Migrated Session",
      version: "1.0.0",
      time: { created: 1700000000000, updated: 1700000001000 },
    })

    const stats = await JsonMigration.run(db)

    expect(stats?.sessions).toBe(1)

    const sessions = db.select().from(SessionTable).all()
    expect(sessions.length).toBe(1)
    expect(sessions[0].id).toBe(SessionSchema.ID.make("ses_migrated"))
    expect(sessions[0].project_id).toBe(ProjectV2.ID.make(gitBasedProjectID)) // Uses directory, not stale JSON
  })

  test("uses filename for session id when JSON has different value", async () => {
    await writeProject(storageDir, {
      id: "proj_test123abc",
      worktree: "/test/path",
      time: { created: Date.now(), updated: Date.now() },
      sandboxes: [],
    })

    await Bun.write(
      path.join(storageDir, "session", "proj_test123abc", "ses_from_filename.json"),
      JSON.stringify({
        id: "ses_different_in_json", // Stale! Should be ignored
        projectID: "proj_test123abc",
        slug: "test-session",
        directory: "/test/path",
        title: "Test Session",
        version: "1.0.0",
        time: { created: 1700000000000, updated: 1700000001000 },
      }),
    )

    const stats = await JsonMigration.run(db)

    expect(stats?.sessions).toBe(1)

    const sessions = db.select().from(SessionTable).all()
    expect(sessions.length).toBe(1)
    expect(sessions[0].id).toBe(SessionSchema.ID.make("ses_from_filename")) // Uses filename, not JSON id
    expect(sessions[0].project_id).toBe(ProjectV2.ID.make("proj_test123abc"))
  })

  test("is idempotent (running twice doesn't duplicate)", async () => {
    await writeProject(storageDir, {
      id: "proj_test123abc",
      worktree: "/",
      time: { created: Date.now(), updated: Date.now() },
      sandboxes: [],
    })

    await JsonMigration.run(db)
    await JsonMigration.run(db)

    const projects = db.select().from(ProjectTable).all()
    expect(projects.length).toBe(1) // Still only 1 due to onConflictDoNothing
  })

  test("bootstraps before the database marker exists", async () => {
    await writeProject(storageDir, {
      id: "proj_test123abc",
      worktree: "/test/path",
      vcs: "git",
      name: "Test Project",
      time: { created: 1700000000000, updated: 1700000001000 },
      sandboxes: [],
    })
    await writeSession(storageDir, "proj_test123abc", { ...fixtures.session })
    await Bun.write(
      path.join(storageDir, "message", "ses_test456def", "msg_usage.json"),
      JSON.stringify({
        role: "assistant",
        cost: 1.25,
        tokens: {
          input: 10,
          output: 20,
          reasoning: 3,
          cache: { read: 4, write: 5 },
        },
        time: { created: 1700000000000, completed: 1700000001000 },
      }),
    )

    const marker = path.join(Global.Path.data, "json-migration-bootstrap.db")
    const pending = marker + ".json-migration"
    const previous = Flag.KILO_DB
    Flag.KILO_DB = marker
    try {
      await JsonMigration.bootstrap()
      expect(await Bun.file(marker).exists()).toBe(true)
      expect(await Bun.file(pending).exists()).toBe(false)
      const sqlite = new Database(marker)
      const migrated = drizzle({ client: sqlite })
      expect(migrated.select().from(ProjectTable).all()).toHaveLength(1)
      expect(migrated.select().from(SessionTable).get()).toMatchObject({
        cost: 1.25,
        tokens_input: 10,
        tokens_output: 20,
        tokens_reasoning: 3,
        tokens_cache_read: 4,
        tokens_cache_write: 5,
      })
      sqlite.close()

      await JsonMigration.bootstrap()
      const reopened = new Database(marker)
      expect(drizzle({ client: reopened }).select().from(ProjectTable).all()).toHaveLength(1)
      reopened.close()
    } finally {
      Flag.KILO_DB = previous
      await Promise.all([marker, marker + "-shm", marker + "-wal", pending].map(cleanup))
    }
  })

  test("retries bootstrap after a partial import", async () => {
    await writeProject(storageDir, {
      id: "proj_test123abc",
      worktree: "/test/path",
      vcs: "git",
      sandboxes: [],
    })
    const broken = path.join(storageDir, "project", "proj_retry.json")
    await Bun.write(broken, "{ invalid json")

    const marker = path.join(Global.Path.data, "json-migration-retry.db")
    const pending = marker + ".json-migration"
    const previous = Flag.KILO_DB
    Flag.KILO_DB = marker
    try {
      await JsonMigration.bootstrap()
      expect(await Bun.file(pending).exists()).toBe(true)

      await Bun.write(broken, JSON.stringify({ id: "proj_retry", worktree: "/retry", vcs: "git", sandboxes: [] }))
      await JsonMigration.bootstrap()
      expect(await Bun.file(pending).exists()).toBe(false)

      const sqlite = new Database(marker)
      expect(drizzle({ client: sqlite }).select().from(ProjectTable).all()).toHaveLength(2)
      sqlite.close()
    } finally {
      Flag.KILO_DB = previous
      await Promise.all([marker, marker + "-shm", marker + "-wal", pending].map(cleanup))
    }
  })

  test("migrates todos", async () => {
    await writeProject(storageDir, {
      id: "proj_test123abc",
      worktree: "/",
      time: { created: Date.now(), updated: Date.now() },
      sandboxes: [],
    })
    await writeSession(storageDir, "proj_test123abc", { ...fixtures.session })

    // Create todo file (named by sessionID, contains array of todos)
    await Bun.write(
      path.join(storageDir, "todo", "ses_test456def.json"),
      JSON.stringify([
        {
          id: "todo_1",
          content: "First todo",
          status: "pending",
          priority: "high",
        },
        {
          id: "todo_2",
          content: "Second todo",
          status: "completed",
          priority: "medium",
        },
      ]),
    )

    const stats = await JsonMigration.run(db)

    expect(stats?.todos).toBe(2)

    const todos = db.select().from(TodoTable).orderBy(TodoTable.position).all()
    expect(todos.length).toBe(2)
    expect(todos[0].content).toBe("First todo")
    expect(todos[0].status).toBe("pending")
    expect(todos[0].priority).toBe("high")
    expect(todos[0].position).toBe(0)
    expect(todos[1].content).toBe("Second todo")
    expect(todos[1].position).toBe(1)
  })

  test("todos are ordered by position", async () => {
    await writeProject(storageDir, {
      id: "proj_test123abc",
      worktree: "/",
      time: { created: Date.now(), updated: Date.now() },
      sandboxes: [],
    })
    await writeSession(storageDir, "proj_test123abc", { ...fixtures.session })

    await Bun.write(
      path.join(storageDir, "todo", "ses_test456def.json"),
      JSON.stringify([
        { content: "Third", status: "pending", priority: "low" },
        { content: "First", status: "pending", priority: "high" },
        { content: "Second", status: "in_progress", priority: "medium" },
      ]),
    )

    await JsonMigration.run(db)

    const todos = db.select().from(TodoTable).orderBy(TodoTable.position).all()

    expect(todos.length).toBe(3)
    expect(todos[0].content).toBe("Third")
    expect(todos[0].position).toBe(0)
    expect(todos[1].content).toBe("First")
    expect(todos[1].position).toBe(1)
    expect(todos[2].content).toBe("Second")
    expect(todos[2].position).toBe(2)
  })

  test("skips legacy permission rules removed by the current schema", async () => {
    await writeProject(storageDir, {
      id: "proj_test123abc",
      worktree: "/",
      time: { created: Date.now(), updated: Date.now() },
      sandboxes: [],
    })

    // Create permission file (named by projectID, contains array of rules)
    const permissionData = [
      { permission: "file.read", pattern: "/test/file1.ts", action: "allow" as const },
      { permission: "file.write", pattern: "/test/file2.ts", action: "ask" as const },
      { permission: "command.run", pattern: "npm install", action: "deny" as const },
    ]
    await Bun.write(path.join(storageDir, "permission", "proj_test123abc.json"), JSON.stringify(permissionData))

    const stats = await JsonMigration.run(db)

    expect(stats?.permissions).toBe(0)

    const permissions = db.select().from(PermissionTable).all()
    expect(permissions).toEqual([])
  })

  test("migrates session shares", async () => {
    await writeProject(storageDir, {
      id: "proj_test123abc",
      worktree: "/",
      time: { created: Date.now(), updated: Date.now() },
      sandboxes: [],
    })
    await writeSession(storageDir, "proj_test123abc", { ...fixtures.session })

    // Create session share file (named by sessionID)
    await Bun.write(
      path.join(storageDir, "session_share", "ses_test456def.json"),
      JSON.stringify({
        id: "share_123",
        secret: "supersecretkey",
        url: "https://share.example.com/ses_test456def",
      }),
    )

    const stats = await JsonMigration.run(db)

    expect(stats?.shares).toBe(1)

    const shares = db.select().from(SessionShareTable).all()
    expect(shares.length).toBe(1)
    expect(shares[0].session_id).toBe("ses_test456def")
    expect(shares[0].id).toBe("share_123")
    expect(shares[0].secret).toBe("supersecretkey")
    expect(shares[0].url).toBe("https://share.example.com/ses_test456def")
  })

  test("returns empty stats when storage directory does not exist", async () => {
    await fs.rm(storageDir, { recursive: true, force: true })

    const stats = await JsonMigration.run(db)

    expect(stats.projects).toBe(0)
    expect(stats.sessions).toBe(0)
    expect(stats.messages).toBe(0)
    expect(stats.parts).toBe(0)
    expect(stats.todos).toBe(0)
    expect(stats.permissions).toBe(0)
    expect(stats.shares).toBe(0)
    expect(stats.errors).toEqual([])
  })

  test("continues when a project JSON file is unreadable and records an error", async () => {
    await writeProject(storageDir, {
      id: "proj_test123abc",
      worktree: "/",
      time: { created: Date.now(), updated: Date.now() },
      sandboxes: [],
    })
    await Bun.write(path.join(storageDir, "project", "broken.json"), "{ invalid json")

    const stats = await JsonMigration.run(db)

    expect(stats.projects).toBe(1)
    expect(stats.errors.some((x) => x.includes("failed to read") && x.includes("broken.json"))).toBe(true)

    const projects = db.select().from(ProjectTable).all()
    expect(projects.length).toBe(1)
    expect(projects[0].id).toBe(ProjectV2.ID.make("proj_test123abc"))
  })

  test("skips invalid todo entries while preserving source positions", async () => {
    await writeProject(storageDir, {
      id: "proj_test123abc",
      worktree: "/",
      time: { created: Date.now(), updated: Date.now() },
      sandboxes: [],
    })
    await writeSession(storageDir, "proj_test123abc", { ...fixtures.session })

    await Bun.write(
      path.join(storageDir, "todo", "ses_test456def.json"),
      JSON.stringify([
        { content: "keep-0", status: "pending", priority: "high" },
        { content: "drop-1", priority: "low" },
        { content: "keep-2", status: "completed", priority: "medium" },
      ]),
    )

    const stats = await JsonMigration.run(db)
    expect(stats.todos).toBe(2)

    const todos = db.select().from(TodoTable).orderBy(TodoTable.position).all()
    expect(todos.length).toBe(2)
    expect(todos[0].content).toBe("keep-0")
    expect(todos[0].position).toBe(0)
    expect(todos[1].content).toBe("keep-2")
    expect(todos[1].position).toBe(2)
  })

  test("skips orphaned permissions and shares", async () => {
    await writeProject(storageDir, {
      id: "proj_test123abc",
      worktree: "/",
      time: { created: Date.now(), updated: Date.now() },
      sandboxes: [],
    })
    await writeSession(storageDir, "proj_test123abc", { ...fixtures.session })

    await Bun.write(
      path.join(storageDir, "todo", "ses_test456def.json"),
      JSON.stringify([{ content: "valid", status: "pending", priority: "high" }]),
    )
    await Bun.write(
      path.join(storageDir, "todo", "ses_missing.json"),
      JSON.stringify([{ content: "orphan", status: "pending", priority: "high" }]),
    )

    await Bun.write(
      path.join(storageDir, "permission", "proj_test123abc.json"),
      JSON.stringify([{ permission: "file.read" }]),
    )
    await Bun.write(
      path.join(storageDir, "permission", "proj_missing.json"),
      JSON.stringify([{ permission: "file.write" }]),
    )

    await Bun.write(
      path.join(storageDir, "session_share", "ses_test456def.json"),
      JSON.stringify({ id: "share_ok", secret: "secret", url: "https://ok.example.com" }),
    )
    await Bun.write(
      path.join(storageDir, "session_share", "ses_missing.json"),
      JSON.stringify({ id: "share_missing", secret: "secret", url: "https://missing.example.com" }),
    )

    const stats = await JsonMigration.run(db)

    expect(stats.todos).toBe(1)
    expect(stats.permissions).toBe(0)
    expect(stats.shares).toBe(1)

    expect(db.select().from(TodoTable).all().length).toBe(1)
    expect(db.select().from(PermissionTable).all().length).toBe(0)
    expect(db.select().from(SessionShareTable).all().length).toBe(1)
  })

  test("handles mixed corruption and partial validity: failed family rolls back, successful families commit", async () => {
    // Family A: ses_test456def — has a broken message file → entire family rolls back
    // Family B: ses_ok — clean → commits successfully
    // Family C: ses_orphan — in nonexistent project dir → skipped as orphan
    await writeProject(storageDir, {
      id: "proj_test123abc",
      worktree: "/ok",
      time: { created: 1700000000000, updated: 1700000001000 },
      sandboxes: [],
    })
    await Bun.write(path.join(storageDir, "project", "proj_broken.json"), "{ nope")

    // Family A: broken message causes rollback
    await writeSession(storageDir, "proj_test123abc", {
      id: "ses_test456def",
      projectID: "proj_test123abc",
      slug: "broken-fam",
      directory: "/ok",
      title: "Broken Family",
      version: "1",
      time: { created: 1700000000000, updated: 1700000001000 },
    })
    await Bun.write(
      path.join(storageDir, "message", "ses_test456def", "msg_ok.json"),
      JSON.stringify({ role: "user", time: { created: 1700000000000 } }),
    )
    await Bun.write(path.join(storageDir, "message", "ses_test456def", "msg_broken.json"), "{ nope")
    await Bun.write(
      path.join(storageDir, "todo", "ses_test456def.json"),
      JSON.stringify([{ content: "should-rollback", status: "pending", priority: "high" }]),
    )

    // Family B: clean → commits
    await writeSession(storageDir, "proj_test123abc", {
      id: "ses_ok",
      projectID: "proj_test123abc",
      slug: "ok",
      directory: "/ok",
      title: "OK Family",
      version: "1",
      time: { created: 1700000000000, updated: 1700000001000 },
    })
    await Bun.write(
      path.join(storageDir, "message", "ses_ok", "msg_ok.json"),
      JSON.stringify({ role: "user", time: { created: 1700000000000 } }),
    )
    await Bun.write(
      path.join(storageDir, "part", "msg_ok", "part_ok.json"),
      JSON.stringify({ type: "text", text: "ok" }),
    )

    // Family C: orphan — in a project dir that doesn't exist in projectIds
    await fs.mkdir(path.join(storageDir, "session", "proj_missing"), { recursive: true })
    await Bun.write(
      path.join(storageDir, "session", "proj_missing", "ses_orphan.json"),
      JSON.stringify({
        id: "ses_orphan",
        projectID: "proj_missing",
        slug: "orphan",
        directory: "/bad",
        title: "Orphan",
        version: "1",
        time: { created: 1700000000000, updated: 1700000001000 },
      }),
    )

    // Share for broken family → orphan (session not committed)
    await Bun.write(
      path.join(storageDir, "session_share", "ses_test456def.json"),
      JSON.stringify({ id: "share_broken", secret: "secret", url: "https://broken.example.com" }),
    )
    // Share for OK family → committed
    await Bun.write(
      path.join(storageDir, "session_share", "ses_ok.json"),
      JSON.stringify({ id: "share_ok", secret: "secret", url: "https://ok.example.com" }),
    )

    const stats = await JsonMigration.run(db)

    // Projects: proj_test123abc (valid), proj_broken (unreadable, skipped)
    // Family A: rolled back (broken message) → 0 sessions/messages/todos
    // Family B: committed → 1 session, 1 message, 1 part
    // Family C: skipped (orphan) → 0 sessions
    expect(stats.projects).toBe(1)
    expect(stats.sessions).toBe(1)
    expect(stats.messages).toBe(1)
    expect(stats.parts).toBe(1)
    expect(stats.todos).toBe(0)
    expect(stats.shares).toBe(1) // only ses_ok share
    expect(stats.errors.length).toBeGreaterThanOrEqual(1) // at least the family error + project error

    expect(db.select().from(ProjectTable).all().length).toBe(1)
    expect(db.select().from(SessionTable).all().length).toBe(1)
    expect(db.select().from(MessageTable).all().length).toBe(1)
    expect(db.select().from(PartTable).all().length).toBe(1)
    expect(db.select().from(TodoTable).all().length).toBe(0)
    expect(db.select().from(SessionShareTable).all().length).toBe(1)
  })

  test("failed family leaves zero rows; neighboring family commits", async () => {
    // Setup: two valid projects
    await writeProject(storageDir, {
      id: "proj_a",
      worktree: "/a",
      time: { created: 1700000000000, updated: 1700000001000 },
      sandboxes: [],
    })
    await writeProject(storageDir, {
      id: "proj_b",
      worktree: "/b",
      time: { created: 1700000000000, updated: 1700000001000 },
      sandboxes: [],
    })

    // Family A: broken session file → rollback
    await Bun.write(path.join(storageDir, "session", "proj_a", "ses_a.json"), "{ bad json")
    await Bun.write(
      path.join(storageDir, "message", "ses_a", "msg_a.json"),
      JSON.stringify({ role: "user", time: { created: 1700000000000 } }),
    )
    await Bun.write(path.join(storageDir, "part", "msg_a", "part_a.json"), JSON.stringify({ type: "text", text: "a" }))
    await Bun.write(
      path.join(storageDir, "todo", "ses_a.json"),
      JSON.stringify([{ content: "todo-a", status: "pending", priority: "high" }]),
    )

    // Family B: clean → commits
    await writeSession(storageDir, "proj_b", {
      id: "ses_b",
      projectID: "proj_b",
      slug: "b",
      directory: "/b",
      title: "B",
      version: "1",
      time: { created: 1700000000000, updated: 1700000001000 },
    })
    await Bun.write(
      path.join(storageDir, "message", "ses_b", "msg_b.json"),
      JSON.stringify({ role: "assistant", time: { created: 1700000000000 }, cost: 0.5 }),
    )
    await Bun.write(path.join(storageDir, "part", "msg_b", "part_b.json"), JSON.stringify({ type: "text", text: "b" }))
    await Bun.write(
      path.join(storageDir, "todo", "ses_b.json"),
      JSON.stringify([{ content: "todo-b", status: "completed", priority: "low" }]),
    )

    const stats = await JsonMigration.run(db)

    expect(stats.sessions).toBe(1) // only ses_b
    expect(stats.messages).toBe(1) // only msg_b
    expect(stats.parts).toBe(1) // only part_b
    expect(stats.todos).toBe(1) // only todo-b
    expect(stats.errors.length).toBeGreaterThanOrEqual(1) // ses_a family error

    // Verify DB: only family B rows exist
    const sessions = db.select().from(SessionTable).all()
    expect(sessions.length).toBe(1)
    expect(sessions[0].id).toBe(SessionSchema.ID.make("ses_b"))

    const messages = db.select().from(MessageTable).all()
    expect(messages.length).toBe(1)
    expect(messages[0].session_id).toBe(SessionSchema.ID.make("ses_b"))

    const parts = db.select().from(PartTable).all()
    expect(parts.length).toBe(1)
    expect(parts[0].session_id).toBe(SessionSchema.ID.make("ses_b"))

    const todos = db.select().from(TodoTable).all()
    expect(todos.length).toBe(1)
    expect(todos[0].session_id).toBe(SessionSchema.ID.make("ses_b"))
  })

  test("retry after failed family: onConflictDoNothing makes re-run safe", async () => {
    await writeProject(storageDir, {
      id: "proj_retry",
      worktree: "/r",
      time: { created: 1700000000000, updated: 1700000001000 },
      sandboxes: [],
    })

    // First run: broken session file → family rolls back
    await Bun.write(path.join(storageDir, "session", "proj_retry", "ses_r.json"), "{ bad")
    await writeSession(storageDir, "proj_retry", {
      id: "ses_ok_retry",
      projectID: "proj_retry",
      slug: "ok",
      directory: "/r",
      title: "OK",
      version: "1",
      time: { created: 1700000000000, updated: 1700000001000 },
    })

    const stats1 = await JsonMigration.run(db)
    expect(stats1.sessions).toBe(1) // only ses_ok_retry

    // Second run: fix the broken file → family now commits; ses_ok_retry deduped
    await writeSession(storageDir, "proj_retry", {
      id: "ses_r",
      projectID: "proj_retry",
      slug: "r",
      directory: "/r",
      title: "R",
      version: "1",
      time: { created: 1700000000000, updated: 1700000001000 },
    })

    const stats2 = await JsonMigration.run(db)
    expect(stats2.sessions).toBe(2) // both ses_ok_retry and ses_r commit (onConflictDoNothing for dedup)
    expect(db.select().from(SessionTable).all().length).toBe(2) // both committed
  })

  test("no orphan children: rolled-back family leaves zero session/message/part/todo rows", async () => {
    await writeProject(storageDir, {
      id: "proj_orphan",
      worktree: "/o",
      time: { created: 1700000000000, updated: 1700000001000 },
      sandboxes: [],
    })

    // Create a family with all child types, then break the session file
    await Bun.write(path.join(storageDir, "session", "proj_orphan", "ses_break.json"), "{ broken")
    await Bun.write(
      path.join(storageDir, "message", "ses_break", "msg1.json"),
      JSON.stringify({ role: "user", time: { created: 1700000000000 } }),
    )
    await Bun.write(path.join(storageDir, "part", "msg1", "prt1.json"), JSON.stringify({ type: "text", text: "x" }))
    await Bun.write(
      path.join(storageDir, "todo", "ses_break.json"),
      JSON.stringify([{ content: "orphan-todo", status: "pending", priority: "high" }]),
    )

    await JsonMigration.run(db)

    // All rows for this family must be absent
    expect(db.select().from(SessionTable).all().length).toBe(0)
    expect(db.select().from(MessageTable).all().length).toBe(0)
    expect(db.select().from(PartTable).all().length).toBe(0)
    expect(db.select().from(TodoTable).all().length).toBe(0)
  })

  test("bounded iteration: per-family glob enumeration", async () => {
    // Verify that messages/parts are enumerated per-family, not globally.
    // Create two sessions with their own messages; a broken message in
    // session A should not affect session B (different families).
    await writeProject(storageDir, {
      id: "proj_bound",
      worktree: "/b",
      time: { created: 1700000000000, updated: 1700000001000 },
      sandboxes: [],
    })
    await writeSession(storageDir, "proj_bound", {
      id: "ses_a_bound",
      projectID: "proj_bound",
      slug: "a",
      directory: "/b",
      title: "A",
      version: "1",
      time: { created: 1700000000000, updated: 1700000001000 },
    })
    await writeSession(storageDir, "proj_bound", {
      id: "ses_b_bound",
      projectID: "proj_bound",
      slug: "b",
      directory: "/b",
      title: "B",
      version: "1",
      time: { created: 1700000000000, updated: 1700000001000 },
    })

    // ses_a_bound: has a broken message → family rolls back
    await Bun.write(
      path.join(storageDir, "message", "ses_a_bound", "msg_a.json"),
      JSON.stringify({ role: "user", time: { created: 1700000000000 } }),
    )
    await Bun.write(path.join(storageDir, "message", "ses_a_bound", "msg_a_bad.json"), "{ bad")

    // ses_b_bound: clean → commits
    await Bun.write(
      path.join(storageDir, "message", "ses_b_bound", "msg_b.json"),
      JSON.stringify({ role: "user", time: { created: 1700000000000 } }),
    )
    await Bun.write(path.join(storageDir, "part", "msg_b", "part_b.json"), JSON.stringify({ type: "text", text: "ok" }))

    const stats = await JsonMigration.run(db)

    expect(stats.sessions).toBe(1) // only ses_b_bound
    expect(stats.messages).toBe(1) // only msg_b
    expect(stats.parts).toBe(1) // only part_b

    const sessions = db.select().from(SessionTable).all()
    expect(sessions.length).toBe(1)
    expect(sessions[0].id).toBe(SessionSchema.ID.make("ses_b_bound"))

    const messages = db.select().from(MessageTable).all()
    expect(messages.length).toBe(1)
    expect(messages[0].session_id).toBe(SessionSchema.ID.make("ses_b_bound"))
  })

  test("successful migration leaves transaction closed", async () => {
    // Verify that if the outer transaction itself fails (not a family),
    // the entire transaction is rolled back cleanly.
    await writeProject(storageDir, {
      id: "proj_tx",
      worktree: "/t",
      time: { created: 1700000000000, updated: 1700000001000 },
      sandboxes: [],
    })
    await writeSession(storageDir, "proj_tx", {
      id: "ses_tx",
      projectID: "proj_tx",
      slug: "tx",
      directory: "/t",
      title: "TX",
      version: "1",
      time: { created: 1700000000000, updated: 1700000001000 },
    })

    // Migration should complete without leaving an open transaction
    await JsonMigration.run(db)

    // Verify the DB is usable after migration (no open transaction)
    const projects = db.select().from(ProjectTable).all()
    expect(projects.length).toBe(1)
    const sessions = db.select().from(SessionTable).all()
    expect(sessions.length).toBe(1)
  })

  test("read-failure family rolls back while neighboring family commits", async () => {
    // Test that BOTH read errors and insert errors trigger family rollback
    await writeProject(storageDir, {
      id: "proj_err",
      worktree: "/e",
      time: { created: 1700000000000, updated: 1700000001000 },
      sandboxes: [],
    })

    // Read failure: broken JSON in session file
    await Bun.write(path.join(storageDir, "session", "proj_err", "ses_read_err.json"), "{ bad")
    await Bun.write(
      path.join(storageDir, "message", "ses_read_err", "msg1.json"),
      JSON.stringify({ role: "user", time: { created: 1700000000000 } }),
    )

    // Neighbor: clean
    await writeSession(storageDir, "proj_err", {
      id: "ses_clean",
      projectID: "proj_err",
      slug: "clean",
      directory: "/e",
      title: "Clean",
      version: "1",
      time: { created: 1700000000000, updated: 1700000001000 },
    })

    const stats = await JsonMigration.run(db)

    // Only the clean family committed
    expect(stats.sessions).toBe(1)
    expect(db.select().from(SessionTable).all().length).toBe(1)
    expect(db.select().from(SessionTable).all()[0].id).toBe(SessionSchema.ID.make("ses_clean"))

    // The failed family has zero rows
    const failedSessionRows = db
      .select()
      .from(SessionTable)
      .where(eq(SessionTable.id, SessionSchema.ID.make("ses_read_err")))
      .all()
    expect(failedSessionRows.length).toBe(0)
  })

  test("outer rollback failure is visible alongside the original error", async () => {
    // Simulate: outer transaction fails (throws before COMMIT) AND the
    // compensating ROLLBACK also fails. The thrown error must contain both.
    await writeProject(storageDir, {
      id: "proj_rollback",
      worktree: "/r",
      time: { created: Date.now(), updated: Date.now() },
      sandboxes: [],
    })
    await writeSession(storageDir, "proj_rollback", {
      id: "ses_rollback",
      projectID: "proj_rollback",
      slug: "rollback",
      directory: "/r",
      title: "Rollback",
      version: "1",
      time: { created: Date.now(), updated: Date.now() },
    })

    // Wrap the drizzle DB so that the usage SQL (run just before COMMIT)
    // throws to simulate an outer-transaction error, and then the
    // compensating ROLLBACK also throws.
    let outerFailed = false
    const proxy = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "run") {
          return (sql: string) => {
            const sqlStr = typeof sql === "string" ? sql : String(sql)
            // After an outer error, make ROLLBACK also fail
            if (outerFailed && sqlStr.includes("ROLLBACK") && !sqlStr.includes("SAVEPOINT")) {
              throw new Error("simulated rollback failure")
            }
            // Trigger outer error on the usage UPDATE (runs right before COMMIT)
            if (!outerFailed && sqlStr.includes("coalesce")) {
              outerFailed = true
              throw new Error("simulated outer transaction failure")
            }
            return Reflect.get(target, prop, receiver).call(target, sql)
          }
        }
        const val = Reflect.get(target, prop, receiver)
        if (typeof val === "function") return val.bind(target)
        return val
      },
    }) as unknown as SQLiteBunDatabase

    await expect(JsonMigration.run(proxy)).rejects.toThrow(
      /outer transaction failed.*simulated outer transaction failure.*rollback also failed.*simulated rollback failure/,
    )
  })

  test("family rollback+release succeeds: savepoint is cleaned up after failure", async () => {
    // Verify that after a failed family, both ROLLBACK TO SAVEPOINT and
    // RELEASE SAVEPOINT execute successfully, leaving no stale savepoint.
    await writeProject(storageDir, {
      id: "proj_sp",
      worktree: "/s",
      time: { created: 1700000000000, updated: 1700000001000 },
      sandboxes: [],
    })

    // Family A: broken session → triggers rollback + release
    await Bun.write(path.join(storageDir, "session", "proj_sp", "ses_bad.json"), "{ bad")
    await Bun.write(
      path.join(storageDir, "message", "ses_bad", "msg1.json"),
      JSON.stringify({ role: "user", time: { created: 1700000000000 } }),
    )

    // Family B: clean → should commit successfully, proving no stale savepoint
    await writeSession(storageDir, "proj_sp", {
      id: "ses_good",
      projectID: "proj_sp",
      slug: "good",
      directory: "/s",
      title: "Good",
      version: "1",
      time: { created: 1700000000000, updated: 1700000001000 },
    })

    const stats = await JsonMigration.run(db)

    // Family B committed despite family A failure → transaction state was clean
    expect(stats.sessions).toBe(1)
    expect(db.select().from(SessionTable).all().length).toBe(1)
    expect(db.select().from(SessionTable).all()[0].id).toBe(SessionSchema.ID.make("ses_good"))

    // Family A: zero rows
    const badSessions = db
      .select()
      .from(SessionTable)
      .where(eq(SessionTable.id, SessionSchema.ID.make("ses_bad")))
      .all()
    expect(badSessions.length).toBe(0)

    // Error recorded for family A
    expect(stats.errors.some((e) => e.includes("ses_bad"))).toBe(true)
  })

  test("family rollback failure aborts outer transaction and preserves original error", async () => {
    // Simulate: family fails (broken message), then ROLLBACK TO SAVEPOINT
    // also fails. The migration must throw, preventing COMMIT. The thrown
    // error must contain the original family error and the rollback failure.
    await writeProject(storageDir, {
      id: "proj_rb",
      worktree: "/r",
      time: { created: 1700000000000, updated: 1700000001000 },
      sandboxes: [],
    })
    await writeSession(storageDir, "proj_rb", {
      id: "ses_rb",
      projectID: "proj_rb",
      slug: "rb",
      directory: "/r",
      title: "RB",
      version: "1",
      time: { created: 1700000000000, updated: 1700000001000 },
    })
    // Broken message triggers family failure via readOrThrow
    await Bun.write(path.join(storageDir, "message", "ses_rb", "msg1.json"), "{ bad")

    // Proxy: track SAVEPOINT creation, then make ROLLBACK TO SAVEPOINT fail.
    // Check ROLLBACK before SAVEPOINT to avoid re-arming.
    let sawFamilySp = false
    const proxy = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "run") {
          return (sql: string) => {
            const sqlStr = typeof sql === "string" ? sql : String(sql)
            if (sawFamilySp && sqlStr.includes("ROLLBACK TO SAVEPOINT")) {
              sawFamilySp = false
              throw new Error("simulated rollback failure")
            }
            if (sqlStr.includes("SAVEPOINT") && !sqlStr.includes("ROLLBACK") && !sqlStr.includes("RELEASE")) {
              sawFamilySp = true
            }
            return Reflect.get(target, prop, receiver).call(target, sql)
          }
        }
        const val = Reflect.get(target, prop, receiver)
        if (typeof val === "function") return val.bind(target)
        return val
      },
    }) as unknown as SQLiteBunDatabase

    // Rollback failure must throw to abort the outer transaction
    await expect(JsonMigration.run(proxy)).rejects.toThrow(
      /rollback failed.*simulated rollback failure.*original:.*ses_rb/,
    )
  })

  test("family rollback failure prevents partial rows from committing", async () => {
    // Prove that when ROLLBACK TO SAVEPOINT fails, no rows from any
    // family persist — the outer transaction is rolled back.
    await writeProject(storageDir, {
      id: "proj_nopersist",
      worktree: "/n",
      time: { created: 1700000000000, updated: 1700000001000 },
      sandboxes: [],
    })

    // Family A: broken session → triggers rollback failure via proxy
    await Bun.write(path.join(storageDir, "session", "proj_nopersist", "ses_a.json"), "{ bad")
    await Bun.write(
      path.join(storageDir, "message", "ses_a", "msg_a.json"),
      JSON.stringify({ role: "user", time: { created: 1700000000000 } }),
    )

    // Family B: clean → would commit if rollback failure didn't abort
    await writeSession(storageDir, "proj_nopersist", {
      id: "ses_b",
      projectID: "proj_nopersist",
      slug: "b",
      directory: "/n",
      title: "B",
      version: "1",
      time: { created: 1700000000000, updated: 1700000001000 },
    })
    await Bun.write(
      path.join(storageDir, "message", "ses_b", "msg_b.json"),
      JSON.stringify({ role: "user", time: { created: 1700000000000 } }),
    )

    // Proxy: make ROLLBACK TO SAVEPOINT fail for the broken family
    let sawFamilySp = false
    const proxy = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "run") {
          return (sql: string) => {
            const sqlStr = typeof sql === "string" ? sql : String(sql)
            if (sawFamilySp && sqlStr.includes("ROLLBACK TO SAVEPOINT")) {
              sawFamilySp = false
              throw new Error("simulated rollback failure")
            }
            if (sqlStr.includes("SAVEPOINT") && !sqlStr.includes("ROLLBACK") && !sqlStr.includes("RELEASE")) {
              sawFamilySp = true
            }
            return Reflect.get(target, prop, receiver).call(target, sql)
          }
        }
        const val = Reflect.get(target, prop, receiver)
        if (typeof val === "function") return val.bind(target)
        return val
      },
    }) as unknown as SQLiteBunDatabase

    await expect(JsonMigration.run(proxy)).rejects.toThrow()

    // No rows from any family should persist — outer ROLLBACK undoes everything
    expect(db.select().from(SessionTable).all().length).toBe(0)
    expect(db.select().from(MessageTable).all().length).toBe(0)
  })

  test("family release-after-rollback failure aborts outer transaction", async () => {
    // Simulate: family fails (broken message), ROLLBACK TO SAVEPOINT succeeds,
    // but RELEASE SAVEPOINT fails. The migration must throw, preventing COMMIT.
    // The thrown error must contain the original family error and the release failure.
    await writeProject(storageDir, {
      id: "proj_rel",
      worktree: "/l",
      time: { created: 1700000000000, updated: 1700000001000 },
      sandboxes: [],
    })
    await writeSession(storageDir, "proj_rel", {
      id: "ses_rel",
      projectID: "proj_rel",
      slug: "rel",
      directory: "/l",
      title: "Rel",
      version: "1",
      time: { created: 1700000000000, updated: 1700000001000 },
    })
    // Broken message triggers family failure via readOrThrow
    await Bun.write(path.join(storageDir, "message", "ses_rel", "msg1.json"), "{ bad")

    // Proxy: track SAVEPOINT creation and ROLLBACK, then make RELEASE fail.
    // Check ROLLBACK/RELEASE before SAVEPOINT to avoid re-arming.
    let sawFamilySp = false
    let sawRollback = false
    const proxy = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "run") {
          return (sql: string) => {
            const sqlStr = typeof sql === "string" ? sql : String(sql)
            if (sawFamilySp && sqlStr.includes("ROLLBACK TO SAVEPOINT")) {
              sawRollback = true
              return Reflect.get(target, prop, receiver).call(target, sql)
            }
            if (sawRollback && sqlStr.includes("RELEASE SAVEPOINT")) {
              sawFamilySp = false
              sawRollback = false
              throw new Error("simulated release failure")
            }
            if (sqlStr.includes("SAVEPOINT") && !sqlStr.includes("ROLLBACK") && !sqlStr.includes("RELEASE")) {
              sawFamilySp = true
            }
            return Reflect.get(target, prop, receiver).call(target, sql)
          }
        }
        const val = Reflect.get(target, prop, receiver)
        if (typeof val === "function") return val.bind(target)
        return val
      },
    }) as unknown as SQLiteBunDatabase

    // Release failure must throw to abort the outer transaction
    await expect(JsonMigration.run(proxy)).rejects.toThrow(
      /release after rollback failed.*simulated release failure.*original:.*ses_rel/,
    )
  })

  test("family release-after-rollback failure prevents partial rows from committing", async () => {
    // Prove that when RELEASE fails after successful ROLLBACK, no rows
    // from any family persist — the outer transaction is rolled back.
    await writeProject(storageDir, {
      id: "proj_norel",
      worktree: "/r",
      time: { created: 1700000000000, updated: 1700000001000 },
      sandboxes: [],
    })

    // Family A: broken session → triggers release failure via proxy
    await Bun.write(path.join(storageDir, "session", "proj_norel", "ses_a.json"), "{ bad")

    // Family B: clean → would commit if release failure didn't abort
    await writeSession(storageDir, "proj_norel", {
      id: "ses_b",
      projectID: "proj_norel",
      slug: "b",
      directory: "/r",
      title: "B",
      version: "1",
      time: { created: 1700000000000, updated: 1700000001000 },
    })

    // Proxy: make RELEASE fail after successful ROLLBACK
    let sawFamilySp = false
    let sawRollback = false
    const proxy = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "run") {
          return (sql: string) => {
            const sqlStr = typeof sql === "string" ? sql : String(sql)
            if (sawFamilySp && sqlStr.includes("ROLLBACK TO SAVEPOINT")) {
              sawRollback = true
              return Reflect.get(target, prop, receiver).call(target, sql)
            }
            if (sawRollback && sqlStr.includes("RELEASE SAVEPOINT")) {
              sawFamilySp = false
              sawRollback = false
              throw new Error("simulated release failure")
            }
            if (sqlStr.includes("SAVEPOINT") && !sqlStr.includes("ROLLBACK") && !sqlStr.includes("RELEASE")) {
              sawFamilySp = true
            }
            return Reflect.get(target, prop, receiver).call(target, sql)
          }
        }
        const val = Reflect.get(target, prop, receiver)
        if (typeof val === "function") return val.bind(target)
        return val
      },
    }) as unknown as SQLiteBunDatabase

    await expect(JsonMigration.run(proxy)).rejects.toThrow()

    // No rows from any family should persist — outer ROLLBACK undoes everything
    expect(db.select().from(SessionTable).all().length).toBe(0)
  })
})
