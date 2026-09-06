// PROBE ONLY — inter-page sequential mutation pagination observations. No product contract asserted.
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import type { InstanceContext } from "../../src/project/instance-context"
import { InstanceRef } from "../../src/effect/instance-ref"
import * as Log from "@opencode-ai/core/util/log"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir, withTestInstance } from "../fixture/fixture"
import { RemoteSender } from "../../src/kilo-sessions/remote-sender"
import { Effect } from "effect"

beforeEach(() => {
  spyOn(RemoteSender, "create").mockReturnValue({ handle() {}, dispose() {} })
})

Log.init({ print: false })

afterEach(async () => {
  mock.restore()
  await resetDatabase()
  await disposeAllInstances()
})

const create = async (title: string, ctx: InstanceContext) => {
  const [{ AppRuntime }, { Session }] = await Promise.all([
    import("../../src/effect/app-runtime"),
    import("../../src/session/session"),
  ])
  return AppRuntime.runPromise(
    Session.Service.use((svc) => svc.create({ title })).pipe(Effect.provideService(InstanceRef, ctx)),
  )
}

const pinOne = async (id: string, updated: number) => {
  const [{ AppRuntime }, { Database }, { SessionTable }, { eq }] = await Promise.all([
    import("../../src/effect/app-runtime"),
    import("@opencode-ai/core/database/database"),
    import("@opencode-ai/core/session/sql"),
    import("drizzle-orm"),
  ])
  await AppRuntime.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({ time_updated: updated })
        .where(eq(SessionTable.id, id as never))
        .run()
        .pipe(Effect.orDie)
    }),
  )
}

const archiveOne = async (id: string, archived: number) => {
  const [{ AppRuntime }, { Database }, { SessionTable }, { eq }] = await Promise.all([
    import("../../src/effect/app-runtime"),
    import("@opencode-ai/core/database/database"),
    import("@opencode-ai/core/session/sql"),
    import("drizzle-orm"),
  ])
  await AppRuntime.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({ time_archived: archived })
        .where(eq(SessionTable.id, id as never))
        .run()
        .pipe(Effect.orDie)
    }),
  )
}

const removeOne = async (id: string, ctx: InstanceContext) => {
  const [{ AppRuntime }, { Session }] = await Promise.all([
    import("../../src/effect/app-runtime"),
    import("../../src/session/session"),
  ])
  await AppRuntime.runPromise(
    Session.Service.use((svc) => svc.remove(id as never)).pipe(Effect.provideService(InstanceRef, ctx)),
  )
}

type Page = { status: number; ids: string[]; cursor: string | null }

const getPage = async (
  app: { request: (url: string, init?: RequestInit) => Promise<Response> },
  dir: string,
  search: string,
  limit: number,
  cursor?: string,
): Promise<Page> => {
  const headers = { "x-kilo-directory": dir }
  const base = `/experimental/session?directory=${encodeURIComponent(dir)}&search=${encodeURIComponent(search)}&limit=${limit}`
  const url = cursor ? `${base}&cursor=${encodeURIComponent(cursor)}` : base
  const res = await app.request(url, { headers })
  const body = (await res.json()) as Array<{ id: string }>
  return { status: res.status, ids: body.map((s) => s.id), cursor: res.headers.get("x-next-cursor") }
}

const report = (scenario: string, detail: Record<string, unknown>) => {
  console.log(`[probe-inter-page-mutation:http] scenario=${scenario} ${JSON.stringify(detail)}`)
}

const requirePage1Cursor = (page1: Page) => {
  expect(typeof page1.cursor).toBe("string")
  expect((page1.cursor ?? "").length).toBeGreaterThan(0)
}

const BASE = 1700000000000

// Deterministic 4-row fixture: distinct updated so canonical order is fully pinned.
const setupFixture = async (prefix: string, ctx: InstanceContext) => {
  const a = await create(`${prefix}-a`, ctx)
  const b = await create(`${prefix}-b`, ctx)
  const c = await create(`${prefix}-c`, ctx)
  const d = await create(`${prefix}-d`, ctx)
  await pinOne(a.id, BASE)
  await pinOne(b.id, BASE + 1000)
  await pinOne(c.id, BASE + 2000)
  await pinOne(d.id, BASE + 3000)
  // Canonical order newest-first: d, c, b, a.
  return { a, b, c, d }
}

const summarize = (page1: Page, page2: Page, order: string[]) => {
  const union = [...page1.ids, ...page2.ids]
  const dupes = union.filter((id, i) => union.indexOf(id) !== i)
  const missing = order.filter((id) => !union.includes(id))
  const extra = union.filter((id) => !order.includes(id))
  return {
    page1: page1.ids,
    page2: page2.ids,
    page2CursorPresent: page2.cursor !== null,
    union,
    unionSize: union.length,
    distinctSize: new Set(union).size,
    duplicates: [...new Set(dupes)],
    missingVsBaseline: missing,
    extraVsBaseline: extra,
  }
}

describe("probe: inter-page sequential mutation pagination (raw observations only)", () => {
  test("insert between pages", async () => {
    await using dir = await tmpdir({ git: true })
    const prefix = "probe-ins"
    const ctx = await withTestInstance({
      directory: dir.path,
      fn: async (c) => {
        await setupFixture(prefix, c)
        return c
      },
    })
    const { Server } = await import("../../src/server/server")
    const app = Server.Default().app
    const page1 = await getPage(app, dir.path, prefix, 2)
    expect(page1.status).toBe(200)
    requirePage1Cursor(page1)
    // Mutation: insert newest row above the whole fixture.
    const fresh = await create(`${prefix}-new`, ctx)
    await pinOne(fresh.id, BASE + 4000)
    const page2 = await getPage(app, dir.path, prefix, 2, page1.cursor!)
    expect(page2.status).toBe(200)
    const baseline = await getPage(app, dir.path, prefix, 100)
    report("insert", {
      ...summarize(page1, page2, baseline.ids),
      fullListAfter: baseline.ids,
      note: "new row pinned newest; baseline=full list after mutation",
    })
  })

  test("update page-1 row between pages", async () => {
    await using dir = await tmpdir({ git: true })
    const prefix = "probe-upd1"
    const ctx = await withTestInstance({
      directory: dir.path,
      fn: async (c) => {
        await setupFixture(prefix, c)
        return c
      },
    })
    const { Server } = await import("../../src/server/server")
    const app = Server.Default().app
    const page1 = await getPage(app, dir.path, prefix, 2)
    expect(page1.status).toBe(200)
    requirePage1Cursor(page1)
    // Mutation: bump first-returned row even newer (stays above cursor).
    await pinOne(page1.ids[0]!, BASE + 5000)
    const page2 = await getPage(app, dir.path, prefix, 2, page1.cursor!)
    expect(page2.status).toBe(200)
    const baseline = await getPage(app, dir.path, prefix, 100)
    report("update-page1-row", {
      ...summarize(page1, page2, baseline.ids),
      mutatedId: page1.ids[0],
      fullListAfter: baseline.ids,
    })
  })

  test("update not-yet-returned row between pages", async () => {
    await using dir = await tmpdir({ git: true })
    const prefix = "probe-upd2"
    const seen = await withTestInstance({
      directory: dir.path,
      fn: async (c) => {
        const f = await setupFixture(prefix, c)
        return f
      },
    })
    const { Server } = await import("../../src/server/server")
    const app = Server.Default().app
    const page1 = await getPage(app, dir.path, prefix, 2)
    expect(page1.status).toBe(200)
    requirePage1Cursor(page1)
    // Mutation: bump the first unreturned row (fixture b, third in canonical order) above cursor.
    await pinOne(seen.b.id, BASE + 5000)
    const page2 = await getPage(app, dir.path, prefix, 2, page1.cursor!)
    expect(page2.status).toBe(200)
    const baseline = await getPage(app, dir.path, prefix, 100)
    report("update-unreturned-row", {
      ...summarize(page1, page2, baseline.ids),
      mutatedId: seen.b.id,
      fullListAfter: baseline.ids,
    })
  })

  test("delete cursor-anchor row between pages", async () => {
    await using dir = await tmpdir({ git: true })
    const prefix = "probe-del"
    const ctx = await withTestInstance({
      directory: dir.path,
      fn: async (c) => {
        await setupFixture(prefix, c)
        return c
      },
    })
    const { Server } = await import("../../src/server/server")
    const app = Server.Default().app
    const page1 = await getPage(app, dir.path, prefix, 2)
    expect(page1.status).toBe(200)
    requirePage1Cursor(page1)
    // Mutation: delete the anchor row (last id of page 1).
    await removeOne(page1.ids[1]!, ctx)
    const page2 = await getPage(app, dir.path, prefix, 2, page1.cursor!)
    expect(page2.status).toBe(200)
    const baseline = await getPage(app, dir.path, prefix, 100)
    report("delete-anchor", {
      ...summarize(page1, page2, baseline.ids),
      deletedId: page1.ids[1],
      fullListAfter: baseline.ids,
    })
  })

  test("archive unreturned row between pages", async () => {
    await using dir = await tmpdir({ git: true })
    const prefix = "probe-arch"
    const seen = await withTestInstance({
      directory: dir.path,
      fn: async (c) => {
        const f = await setupFixture(prefix, c)
        return f
      },
    })
    const { Server } = await import("../../src/server/server")
    const app = Server.Default().app
    const page1 = await getPage(app, dir.path, prefix, 2)
    expect(page1.status).toBe(200)
    requirePage1Cursor(page1)
    // Mutation: archive the first unreturned row (fixture b) via direct DB pin.
    await archiveOne(seen.b.id, BASE + 4000)
    const page2 = await getPage(app, dir.path, prefix, 2, page1.cursor!)
    expect(page2.status).toBe(200)
    const baseline = await getPage(app, dir.path, prefix, 100)
    report("archive-unreturned", {
      ...summarize(page1, page2, baseline.ids),
      archivedId: seen.b.id,
      fullListAfter: baseline.ids,
    })
  })
})
