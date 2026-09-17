import { describe, it, expect } from "bun:test"
import * as path from "path"
import * as fs from "fs"
import * as os from "os"
import { ObservationController, OBSERVATION_METHODS } from "../../src/private-worker/observation"
import { PassThrough } from "stream"
import { JsonRpcPeer } from "../../src/private-worker/peer"
import { ErrorCode } from "../../src/private-worker/json-rpc"

const DIR = "/tmp/ws"
const SID = "ses_model0000000000001"
const PROJ = "proj_get_model"

function found(over: Record<string, unknown> = {}) {
  return {
    v: "1.0",
    status: "found",
    session: {
      id: SID,
      title: "t",
      parentID: null,
      directory: DIR,
      projectID: PROJ,
      createdAt: 1,
      updatedAt: 2,
      ...over,
    },
  }
}

function pair(ctrl: ObservationController) {
  const a = new PassThrough()
  const b = new PassThrough()
  const server = new JsonRpcPeer({ reader: a, writer: b, onRequest: (m, p) => ctrl.handle(m, p) })
  const client = new JsonRpcPeer({ reader: b, writer: a })
  return { client, server }
}

function ctrlWith(session: Record<string, unknown>) {
  return new ObservationController({
    getSnapshot: async () => ({ cursor: 0, snapshot: null }),
    readAfter: async () => ({ type: "deltas" as const, cursor: 0, entries: [] }),
    ack: async () => {},
    get: async () => ({ v: "1.0", status: "found", session } as never),
  })
}

describe("observation/get model contract", () => {
  it("accepts fixed-size model and preserves exact keys", async () => {
    const sess = {
      id: SID,
      title: "t",
      parentID: null,
      directory: DIR,
      projectID: PROJ,
      createdAt: 1,
      updatedAt: 2,
      model: { providerID: "p", id: "m", variant: "v" },
    } as unknown as Record<string, unknown>
    const ctrl = ctrlWith(sess)
    const { client, server } = pair(ctrl)
    try {
      const res = (await client.request(OBSERVATION_METHODS.GET, { v: "1.0", directory: DIR, sessionId: SID })) as {
        status: string
        session: Record<string, unknown>
      }
      expect(res.status).toBe("found")
      expect(res.session.model).toEqual({ providerID: "p", id: "m", variant: "v" })
      expect(Object.keys(res.session).sort()).toEqual(["createdAt", "directory", "id", "model", "parentID", "projectID", "title", "updatedAt"])
    } finally {
      client.dispose()
      server.dispose()
    }
  })

  it("accepts model without variant and rejects malformed model shapes", async () => {
    const bare = {
      id: SID,
      title: "t",
      parentID: null,
      directory: DIR,
      projectID: PROJ,
      createdAt: 1,
      updatedAt: 2,
      model: { providerID: "p", id: "m" },
    } as unknown as Record<string, unknown>
    const c1 = ctrlWith(bare)
    const p1 = pair(c1)
    try {
      const res = (await p1.client.request(OBSERVATION_METHODS.GET, { v: "1.0", directory: DIR, sessionId: SID })) as { status: string }
      expect(res.status).toBe("found")
    } finally {
      p1.client.dispose()
      p1.server.dispose()
    }
    const bad: unknown[] = [
      { providerID: "", id: "m" },
      { providerID: "p", id: "" },
      { providerID: "p", id: "m", variant: 1 },
      { providerID: "p", id: "m", extra: 1 },
      { providerID: "p" },
      "str",
      null,
    ]
    for (const model of bad) {
      const sess = { id: SID, title: "t", parentID: null, directory: DIR, projectID: PROJ, createdAt: 1, updatedAt: 2, model } as unknown as Record<string, unknown>
      const ctrl = ctrlWith(sess)
      const { client, server } = pair(ctrl)
      try {
        await client.request(OBSERVATION_METHODS.GET, { v: "1.0", directory: DIR, sessionId: SID })
        expect(false).toBe(true)
      } catch (e) {
        expect((e as { code?: number }).code).toBe(ErrorCode.InternalError)
      } finally {
        client.dispose()
        server.dispose()
      }
    }
  })
})

describe("observation/get model adapter round-trip", () => {
  it("carries stored model and omits key when null", async () => {
    const { Database } = await import("@opencode-ai/core/database/database")
    const { SessionTable } = await import("@opencode-ai/core/session/sql")
    const { ProjectTable } = await import("@opencode-ai/core/project/sql")
    const { Effect, ManagedRuntime } = await import("effect")
    const { createSessionGetDeps } = await import("../../src/private-worker/session-get-adapter")
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-get-model-"))
    const file = path.join(tmp, "kilo.db")
    try {
      const layer = Database.layerNoLease(file)
      const rt = ManagedRuntime.make(layer)
      const db = await rt.runPromise(Effect.gen(function* () { return (yield* Database.Service).db }))
      await Effect.runPromise(
        db.insert(ProjectTable).values({ id: PROJ as never, worktree: DIR as never, vcs: "git" as never, time_created: 1, time_updated: 1, sandboxes: [] as never } as never).onConflictDoNothing().run().pipe(Effect.orDie),
      )
      await Effect.runPromise(
        db.insert(SessionTable).values({ id: SID as never, project_id: PROJ as never, slug: "slug-m", directory: DIR, title: "t", version: "1", parent_id: null as never, time_created: 1, time_updated: 2, model: { providerID: "p", id: "m", variant: "v" } as never } as never).run().pipe(Effect.orDie),
      )
      await Effect.runPromise(
        db.insert(SessionTable).values({ id: "ses_model0000000000002" as never, project_id: PROJ as never, slug: "slug-n", directory: DIR, title: "n", version: "1", parent_id: null as never, time_created: 1, time_updated: 2, model: null as never } as never).run().pipe(Effect.orDie),
      )
      const deps = createSessionGetDeps(db)
      const hit = await deps.get({ directory: DIR, sessionId: SID })
      expect(hit.status).toBe("found")
      if (hit.status !== "found") throw new Error("expected found")
      expect(hit.session.model).toEqual({ providerID: "p", id: "m", variant: "v" })
      const miss = await deps.get({ directory: DIR, sessionId: "ses_model0000000000002" })
      expect(miss.status).toBe("found")
      if (miss.status !== "found") throw new Error("expected found")
      expect("model" in miss.session).toBe(false)
      await rt.dispose()
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe("observation/get model detail boundary", () => {
  it("validatePrivateGetResult accepts model and detail mapper stays compatible", async () => {
    const { validatePrivateGetResult, observationSessionToDetail, detailToWebview } = await import("../../src/kilo-provider/session-detail")
    const raw = found({ model: { providerID: "p", id: "m", variant: "v" } })
    const res = validatePrivateGetResult(raw, DIR, SID)
    expect(res.status).toBe("found")
    if (res.status !== "found") throw new Error("expected found")
    expect(res.session.model).toEqual({ providerID: "p", id: "m", variant: "v" })
    const detail = observationSessionToDetail(res.session)
    expect(detail.id).toBe(SID)
    expect(detail.title).toBe("t")
    const webview = detailToWebview(detail)
    expect(webview.id).toBe(SID)
    expect("model" in webview).toBe(false)
    const bad = found({ model: { providerID: "", id: "m" } })
    let threw = false
    try {
      validatePrivateGetResult(bad, DIR, SID)
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  })
})
