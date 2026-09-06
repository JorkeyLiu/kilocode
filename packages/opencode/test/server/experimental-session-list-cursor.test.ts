// kilocode_change - composite session-list cursor HTTP coverage
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import path from "path"
import type { InstanceContext } from "../../src/project/instance-context"
import { InstanceRef } from "../../src/effect/instance-ref"
import * as Log from "@opencode-ai/core/util/log"
import { resetDatabase } from "../fixture/db"
import { tmpdir, withTestInstance } from "../fixture/fixture"
import { RemoteSender } from "../../src/kilo-sessions/remote-sender"
import { Effect } from "effect"
import { decodeGlobalListCursor } from "../../src/session/global-cursor"

beforeEach(() => {
  spyOn(RemoteSender, "create").mockReturnValue({ handle() {}, dispose() {} })
})

Log.init({ print: false })

afterEach(async () => {
  mock.restore()
  await resetDatabase()
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

const pinUpdated = async (ids: Array<string & { readonly brand?: never }>, updated: number) => {
  const [{ AppRuntime }, { Database }, { SessionTable }, { eq }] = await Promise.all([
    import("../../src/effect/app-runtime"),
    import("@opencode-ai/core/database/database"),
    import("@opencode-ai/core/session/sql"),
    import("drizzle-orm"),
  ])
  await AppRuntime.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      for (const id of ids) {
        yield* db
          .update(SessionTable)
          .set({ time_updated: updated })
          .where(eq(SessionTable.id, id as never))
          .run()
          .pipe(Effect.orDie)
      }
    }),
  )
}

describe("experimental.session.list composite cursor", () => {
  test("three equal-updated sessions paginate 2 then 1 with no omission or duplication", async () => {
    await using dir = await tmpdir({ git: true })
    const pinned = 1700000000000
    const sessions = await withTestInstance({
      directory: dir.path,
      fn: async (ctx) => {
        const one = await create("cursor-tie-one", ctx)
        const two = await create("cursor-tie-two", ctx)
        const three = await create("cursor-tie-three", ctx)
        return [one, two, three]
      },
    })
    await pinUpdated(
      sessions.map((s) => s.id),
      pinned,
    )
    const { Server } = await import("../../src/server/server")
    const app = Server.Default().app
    const headers = { "x-kilo-directory": dir.path }

    const page1 = await app.request(
      `/experimental/session?directory=${encodeURIComponent(dir.path)}&search=${encodeURIComponent("cursor-tie-")}&limit=2`,
      { headers },
    )
    expect(page1.status).toBe(200)
    const body1 = (await page1.json()) as Array<{ id: string; time: { updated: number } }>
    expect(body1.length).toBe(2)
    const next = page1.headers.get("x-next-cursor")
    expect(typeof next).toBe("string")
    expect((next ?? "").length).toBeGreaterThan(0)
    const decoded = decodeGlobalListCursor(next)
    expect(decoded.updated).toBe(pinned)
    expect(decoded.id).toBe(body1[1]!.id)

    // Exact LOCK-001 ordering: updated DESC, id DESC.
    const expectedOrder = [...sessions.map((s) => s.id)].sort().reverse()
    expect(body1.map((s) => s.id)).toEqual(expectedOrder.slice(0, 2))

    const page2 = await app.request(
      `/experimental/session?directory=${encodeURIComponent(dir.path)}&search=${encodeURIComponent("cursor-tie-")}&limit=2&cursor=${encodeURIComponent(next!)}`,
      { headers },
    )
    expect(page2.status).toBe(200)
    const body2 = (await page2.json()) as Array<{ id: string }>
    expect(body2.length).toBe(1)
    expect(page2.headers.get("x-next-cursor")).toBeNull()

    // Exact continuation: page2 is the remainder in the same canonical order.
    expect(body2.map((s) => s.id)).toEqual(expectedOrder.slice(2))
    expect([...body1.map((s) => s.id), ...body2.map((s) => s.id)]).toEqual(expectedOrder)

    const union = [...body1.map((s) => s.id), ...body2.map((s) => s.id)].sort()
    expect(union).toEqual(sessions.map((s) => s.id).sort())
    expect(new Set(union).size).toBe(3)
  })

  test("composite cursor grammar is identical across HTTP and private carrier decoders", async () => {
    const [{ decodeSessionListCursor }, { encodeGlobalListCursor }] = await Promise.all([
      import("../../src/kilocode/server/fd-carrier"),
      import("../../src/session/global-cursor"),
    ])
    // Same-fixture agreement: one canonical value decodes identically on both paths.
    const fixture = encodeGlobalListCursor(1700000000000, "ses_tie_agree")
    expect(decodeGlobalListCursor(fixture)).toEqual({ v: 1, updated: 1700000000000, id: "ses_tie_agree" })
    expect(decodeSessionListCursor(fixture)).toEqual({ v: 1, updated: 1700000000000, id: "ses_tie_agree" })
  })

  test("numeric cursor is rejected with 400", async () => {
    await using dir = await tmpdir({ git: true })
    await withTestInstance({
      directory: dir.path,
      fn: (ctx) => create("cursor-reject-one", ctx),
    })
    const { Server } = await import("../../src/server/server")
    const app = Server.Default().app
    const response = await app.request(
      `/experimental/session?directory=${encodeURIComponent(dir.path)}&limit=2&cursor=${encodeURIComponent("1700000000000")}`,
      { headers: { "x-kilo-directory": dir.path } },
    )
    expect(response.status).toBe(400)
  })

  test("invalid opaque cursor is rejected with 400", async () => {
    await using dir = await tmpdir({ git: true })
    const { Server } = await import("../../src/server/server")
    const app = Server.Default().app
    const response = await app.request(
      `/experimental/session?directory=${encodeURIComponent(dir.path)}&limit=2&cursor=${encodeURIComponent("not-a-cursor")}`,
      { headers: { "x-kilo-directory": dir.path } },
    )
    expect(response.status).toBe(400)
    void path
  })

  test("malformed encoded payloads are rejected with 400", async () => {
    await using dir = await tmpdir({ git: true })
    const { Server } = await import("../../src/server/server")
    const app = Server.Default().app
    const headers = { "x-kilo-directory": dir.path }
    const enc = (v: unknown): string => Buffer.from(JSON.stringify(v), "utf8").toString("base64url")
    const cases: Array<[string, string]> = [
      ["numeric legacy", "1700000000000"],
      ["empty", ""],
      ["extra field", enc({ v: 1, updated: 7, id: "ses_abc", extra: 1 })],
      ["missing id", enc({ v: 1, updated: 7 })],
      ["version mismatch", enc({ v: 2, updated: 7, id: "ses_abc" })],
      ["negative updated", enc({ v: 1, updated: -1, id: "ses_abc" })],
      ["float updated", enc({ v: 1, updated: 7.5, id: "ses_abc" })],
      ["non-ses id", enc({ v: 1, updated: 7, id: "abc" })],
      ["nul id", enc({ v: 1, updated: 7, id: "ses_ab\0c" })],
    ]
    for (const [label, cursor] of cases) {
      const res = await app.request(
        `/experimental/session?directory=${encodeURIComponent(dir.path)}&limit=2&cursor=${encodeURIComponent(cursor)}`,
        { headers },
      )
      expect(res.status).toBe(400)
      void label
    }
  })
})
