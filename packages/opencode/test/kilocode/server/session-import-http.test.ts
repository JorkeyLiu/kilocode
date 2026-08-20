import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClientResponse } from "effect/unstable/http"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionID } from "../../../src/session/schema"
import { SessionImportPaths } from "../../../src/kilocode/server/httpapi/groups/session-import"
import { resetDatabase } from "../../fixture/db"
import { disposeAllInstances, TestInstance } from "../../fixture/fixture"
import { testEffect } from "../../lib/effect"
import { httpApiLayer, requestInDirectory } from "../../server/httpapi-layer"

const it = testEffect(Layer.mergeAll(Database.defaultLayer, httpApiLayer))

const json = (res: HttpClientResponse.HttpClientResponse) => res.json

/** Query session revision via Database.Service.use for synchronous Drizzle .get(). */
function sessionRevision(sessionID: string) {
  return Database.Service.use(({ db }) =>
    db
      .select()
      .from(SessionTable)
      .where(eq(SessionTable.id, SessionID.make(sessionID)))
      .get(),
  ).pipe(Effect.map((row) => row?.revision ?? 0))
}

/** POST to a session-import path through the HTTP test harness. */
function postImport(path: string, dir: string, body: unknown) {
  return requestInDirectory(path, dir, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

/**
 * Create a project via the session-import project endpoint and return the
 * server-assigned project ID. The payload id is ignored by the service
 * (it resolves from the worktree directory).
 */
function createProject(dir: string) {
  return Effect.gen(function* () {
    const res = yield* postImport(SessionImportPaths.project, dir, {
      id: "unused",
      worktree: dir,
      timeCreated: 1,
      timeUpdated: 1,
      sandboxes: [],
    })
    expect(res.status).toBe(200)
    const body = (yield* json(res)) as { ok: boolean; id: string }
    return body.id
  })
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("Session import HTTP handler — negative evidence via registered route", () => {
  it.instance(
    "invalid parent session → 400 and no state change",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const dir = test.directory

        // Seed project via HTTP — use returned server-assigned ID
        const projectID = yield* createProject(dir)

        // Seed session via HTTP
        const sessRes = yield* postImport(SessionImportPaths.session, dir, {
          id: "ses_http_test",
          projectID,
          slug: "test-task",
          directory: dir,
          title: "Test task",
          version: "v2",
          timeCreated: 1,
          timeUpdated: 1,
        })
        expect(sessRes.status).toBe(200)

        // Record revision before the bad request
        const revisionBefore = yield* sessionRevision("ses_http_test")

        // Send invalid parent request via actual HTTP handler
        const res = yield* postImport(SessionImportPaths.session, dir, {
          id: "ses_child_http",
          projectID,
          slug: "child",
          directory: dir,
          title: "Child",
          version: "v2",
          parentID: "ses_nonexistent",
          timeCreated: 1,
          timeUpdated: 1,
        })
        expect(res.status).toBe(400)

        // Verify revision unchanged — no state mutation on invalid parent
        const revisionAfter = yield* sessionRevision("ses_http_test")
        expect(revisionAfter).toBe(revisionBefore)
      }),
    { config: { formatter: false, lsp: false } },
  )

  it.instance(
    "cross-session message → 400 and no revision change",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const dir = test.directory

        const projectID = yield* createProject(dir)

        // Create session A
        yield* postImport(SessionImportPaths.session, dir, {
          id: "ses_http_test",
          projectID,
          slug: "a",
          directory: dir,
          title: "A",
          version: "v2",
          timeCreated: 1,
          timeUpdated: 1,
        })

        // Create session B
        yield* postImport(SessionImportPaths.session, dir, {
          id: "ses_parent_http",
          projectID,
          slug: "b",
          directory: dir,
          title: "B",
          version: "v2",
          timeCreated: 1,
          timeUpdated: 1,
        })

        // Import message into session A
        yield* postImport(SessionImportPaths.message, dir, {
          id: "msg_shared_http",
          sessionID: "ses_http_test",
          timeCreated: 1,
          data: { role: "user", time: { created: 1 }, agent: "test", model: { providerID: "t", modelID: "t" } },
        })

        // Record session B revision
        const revisionBBefore = yield* sessionRevision("ses_parent_http")

        // Attempt to import same message ID into session B → 400 via HTTP
        const res = yield* postImport(SessionImportPaths.message, dir, {
          id: "msg_shared_http",
          sessionID: "ses_parent_http",
          timeCreated: 1,
          data: { role: "user", time: { created: 1 }, agent: "test", model: { providerID: "t", modelID: "t" } },
        })
        expect(res.status).toBe(400)

        // Verify session B revision unchanged
        const revisionBAfter = yield* sessionRevision("ses_parent_http")
        expect(revisionBAfter).toBe(revisionBBefore)
      }),
    { config: { formatter: false, lsp: false } },
  )

  it.instance(
    "cross-session part → 400 and no revision change",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const dir = test.directory

        const projectID = yield* createProject(dir)

        // Create session A with message and part
        yield* postImport(SessionImportPaths.session, dir, {
          id: "ses_http_test",
          projectID,
          slug: "a",
          directory: dir,
          title: "A",
          version: "v2",
          timeCreated: 1,
          timeUpdated: 1,
        })
        yield* postImport(SessionImportPaths.message, dir, {
          id: "msg_own_http",
          sessionID: "ses_http_test",
          timeCreated: 1,
          data: { role: "user", time: { created: 1 }, agent: "test", model: { providerID: "t", modelID: "t" } },
        })
        yield* postImport(SessionImportPaths.part, dir, {
          id: "prt_shared_http",
          messageID: "msg_own_http",
          sessionID: "ses_http_test",
          timeCreated: 1,
          data: { type: "text", text: "hello" },
        })

        // Create session B with a message
        yield* postImport(SessionImportPaths.session, dir, {
          id: "ses_parent_http",
          projectID,
          slug: "b",
          directory: dir,
          title: "B",
          version: "v2",
          timeCreated: 1,
          timeUpdated: 1,
        })
        yield* postImport(SessionImportPaths.message, dir, {
          id: "msg_b_http",
          sessionID: "ses_parent_http",
          timeCreated: 1,
          data: { role: "user", time: { created: 2 }, agent: "other", model: { providerID: "x", modelID: "x" } },
        })

        // Record session B revision
        const revisionBBefore = yield* sessionRevision("ses_parent_http")

        // Attempt to import prt_shared_http into session B's msg → 400 via HTTP
        const res = yield* postImport(SessionImportPaths.part, dir, {
          id: "prt_shared_http",
          messageID: "msg_b_http",
          sessionID: "ses_parent_http",
          timeCreated: 1,
          data: { type: "text", text: "hello" },
        })
        expect(res.status).toBe(400)

        // Verify session B revision unchanged
        const revisionBAfter = yield* sessionRevision("ses_parent_http")
        expect(revisionBAfter).toBe(revisionBBefore)
      }),
    { config: { formatter: false, lsp: false } },
  )
})
