// PROBE ONLY — inter-page sequential mutation private observations. No product contract asserted.
import { afterEach, describe, expect } from "bun:test"
import { PassThrough } from "stream"
import { Context, Effect } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { JsonRpcPeer } from "../../../src/private-worker/peer"
import { createFdCarrier } from "../../../src/kilocode/server/fd-carrier"
import { FD_PROTOCOL_NAME } from "../../../src/kilocode/server/fd-carrier-protocol"
import { AppLayer } from "../../../src/effect/app-runtime"
import { Session } from "../../../src/session/session"
import type { SessionID } from "../../../src/session/schema"
import { InstanceStore } from "../../../src/project/instance-store"
import { InstanceRef } from "../../../src/effect/instance-ref"
import type { InstanceContext } from "../../../src/project/instance-context"
import { runInInstance } from "../../../src/kilocode/effect/als-bridge"
import { testEffectShared } from "../../lib/effect"
import { tmpdir, disposeAllInstances } from "../../fixture/fixture"
import { resetDatabase } from "../../fixture/db"

const it = testEffectShared(AppLayer)

type ListResult = {
  v: number
  status: string
  accepted: boolean
  data?: { sessions: unknown[]; nextCursor?: unknown }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function asRecord(v: unknown): Record<string, unknown> {
  if (!isRecord(v)) throw new Error("expected record response")
  return v
}

function asListResult(v: unknown): ListResult {
  const record = asRecord(v)
  if (record.v !== 2) throw new Error("expected response.v to be 2")
  const status = record.status
  if (status !== "succeeded" && status !== "failed") throw new Error("expected status")
  const accepted = record.accepted
  if (typeof accepted !== "boolean") throw new Error("expected accepted")
  let data: ListResult["data"]
  if (record.data !== undefined) {
    if (!isRecord(record.data)) throw new Error("expected data")
    const sessions = (record.data as Record<string, unknown>).sessions
    if (!Array.isArray(sessions)) throw new Error("expected sessions")
    const next = (record.data as Record<string, unknown>).nextCursor
    if (next !== undefined && (typeof next !== "string" || next.length === 0))
      throw new Error("expected opaque nextCursor")
    data = next !== undefined ? { sessions, nextCursor: next } : { sessions }
  }
  return { v: 2, status, accepted, ...(data !== undefined ? { data } : {}) }
}

function summaryOf(item: unknown): { id: string; title: string; updated: number } {
  if (!isRecord(item)) throw new Error("expected record summary")
  const { id, title, updated } = item as Record<string, unknown>
  if (typeof id !== "string" || !id.startsWith("ses")) throw new Error("expected SessionID")
  if (typeof title !== "string") throw new Error("expected title")
  if (typeof updated !== "number") throw new Error("expected updated")
  return { id, title, updated }
}

function noteCleanup(label: string, err: unknown): void {
  console.warn(`[cleanup:${label}] ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`)
}

function linked() {
  let extToCarrier: PassThrough | undefined
  let carrierToExt: PassThrough | undefined
  let carrier: ReturnType<typeof createFdCarrier> | undefined
  let ext: JsonRpcPeer | undefined
  try {
    extToCarrier = new PassThrough()
    carrierToExt = new PassThrough()
    carrier = createFdCarrier(extToCarrier, carrierToExt)
    ext = new JsonRpcPeer({ reader: carrierToExt, writer: extToCarrier })
    const out = { carrier: carrier as ReturnType<typeof createFdCarrier>, ext: ext as JsonRpcPeer }
    carrier = undefined
    ext = undefined
    extToCarrier = undefined
    carrierToExt = undefined
    return out
  } catch (err) {
    if (ext) {
      try {
        ext.dispose()
      } catch (cleanupErr) {
        noteCleanup("ext-dispose", cleanupErr)
      }
    }
    if (carrier) {
      try {
        carrier.dispose()
      } catch (cleanupErr) {
        noteCleanup("carrier-dispose", cleanupErr)
      }
    }
    throw err
  }
}

function pageReq(
  dir: string,
  search: string,
  limit: number,
  token: string,
  reqId: string,
  cursor?: string,
): Record<string, unknown> {
  const opId = `experimental-session-list:${token}`
  return {
    v: 2,
    requestId: reqId,
    opId,
    op: "experimental/session/list",
    idempotencyKey: opId,
    context: { directory: dir },
    payload: { filter: cursor ? { search, limit, cursor } : { search, limit } },
  }
}

async function init(ext: JsonRpcPeer): Promise<Record<string, unknown>> {
  return asRecord(
    await ext.request("initialize", {
      protocol: { name: FD_PROTOCOL_NAME, major: 1, minor: 0 },
      clientInfo: { name: "kilo-vscode", version: "7.4.11" },
      capabilities: ["experimental/session/list"],
    }),
  )
}

function ownParentPid(): () => void {
  const prior = process.env.KILO_PARENT_PID
  process.env.KILO_PARENT_PID = "1"
  return () => {
    if (prior === undefined) delete process.env.KILO_PARENT_PID
    else process.env.KILO_PARENT_PID = prior
  }
}

function scoped(ctx: InstanceContext, captured: Context.Context<never>) {
  return <A, E, R>(work: Effect.Effect<A, E, R>): Effect.Effect<A, E, never> =>
    runInInstance(
      ctx,
      work.pipe(Effect.provide(captured as unknown as Context.Context<R>), Effect.provideService(InstanceRef, ctx)),
    )
}

type Page = { ids: string[]; cursor: string | null }

function toPage(res: ListResult): Page {
  const sessions = (res.data?.sessions ?? []).map(summaryOf)
  const cursor = res.data?.nextCursor as string | undefined
  return { ids: sessions.map((s) => s.id), cursor: cursor ?? null }
}

function requirePage1Cursor(page: Page): void {
  expect(typeof page.cursor).toBe("string")
  expect((page.cursor ?? "").length).toBeGreaterThan(0)
}

function report(scenario: string, detail: Record<string, unknown>): void {
  console.log(`[probe-inter-page-mutation:private] scenario=${scenario} ${JSON.stringify(detail)}`)
}

function summarize(page1: Page, page2: Page, baseline: string[]) {
  const union = [...page1.ids, ...page2.ids]
  const dupes = union.filter((id, i) => union.indexOf(id) !== i)
  const missing = baseline.filter((id) => !union.includes(id))
  const extra = union.filter((id) => !baseline.includes(id))
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

const BASE = 1700000000000

describe("probe: inter-page sequential mutation private carrier (raw observations only)", () => {
  afterEach(async () => {
    await disposeAllInstances()
    await resetDatabase()
  })

  it.live("insert between pages", () =>
    Effect.gen(function* () {
      const restore = ownParentPid()
      try {
        const tmp = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir({ git: true })),
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
        )
        const dir = tmp.path
        const prefix = "probe-ins"
        const store = yield* InstanceStore.Service
        const ctx = yield* store.load({ directory: dir })
        const captured = yield* Effect.context()
        const run = scoped(ctx, captured)
        const fixture = yield* run(
          Effect.gen(function* () {
            const svc = yield* Session.Service
            const a = yield* svc.create({ title: `${prefix}-a` })
            const b = yield* svc.create({ title: `${prefix}-b` })
            const c = yield* svc.create({ title: `${prefix}-c` })
            const d = yield* svc.create({ title: `${prefix}-d` })
            return { a, b, c, d }
          }),
        )
        yield* run(
          Effect.gen(function* () {
            const { db } = yield* Database.Service
            const pins: Array<[SessionID, number]> = [
              [fixture.a.id, BASE],
              [fixture.b.id, BASE + 1000],
              [fixture.c.id, BASE + 2000],
              [fixture.d.id, BASE + 3000],
            ]
            for (const [id, updated] of pins) {
              yield* db
                .update(SessionTable)
                .set({ time_updated: updated })
                .where(eq(SessionTable.id, id))
                .run()
                .pipe(Effect.orDie)
            }
          }),
        )
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => init(ext))
          const raw1 = yield* Effect.promise(() =>
            ext.request("experimental/session/list", pageReq(dir, prefix, 2, "ins-p1", "req-ins-p1")),
          )
          const res1 = asListResult(raw1)
          expect(res1.status).toBe("succeeded")
          expect(res1.accepted).toBeTrue()
          const page1 = toPage(res1)
          expect(page1.ids.length).toBe(2)
          requirePage1Cursor(page1)
          const fresh = yield* run(
            Effect.gen(function* () {
              const svc = yield* Session.Service
              return yield* svc.create({ title: `${prefix}-new` })
            }),
          )
          yield* run(
            Effect.gen(function* () {
              const { db } = yield* Database.Service
              yield* db
                .update(SessionTable)
                .set({ time_updated: BASE + 4000 })
                .where(eq(SessionTable.id, fresh.id))
                .run()
                .pipe(Effect.orDie)
            }),
          )
          const raw2 = yield* Effect.promise(() =>
            ext.request("experimental/session/list", pageReq(dir, prefix, 2, "ins-p2", "req-ins-p2", page1.cursor!)),
          )
          const res2 = asListResult(raw2)
          expect(res2.status).toBe("succeeded")
          const page2 = toPage(res2)
          const rawFull = yield* Effect.promise(() =>
            ext.request("experimental/session/list", pageReq(dir, prefix, 100, "ins-full", "req-ins-full")),
          )
          const baseline = toPage(asListResult(rawFull))
          report("insert", { ...summarize(page1, page2, baseline.ids), fullListAfter: baseline.ids })
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        restore()
      }
    }),
  )

  it.live("update page-1 row between pages", () =>
    Effect.gen(function* () {
      const restore = ownParentPid()
      try {
        const tmp = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir({ git: true })),
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
        )
        const dir = tmp.path
        const prefix = "probe-upd1"
        const store = yield* InstanceStore.Service
        const ctx = yield* store.load({ directory: dir })
        const captured = yield* Effect.context()
        const run = scoped(ctx, captured)
        const fixture = yield* run(
          Effect.gen(function* () {
            const svc = yield* Session.Service
            const a = yield* svc.create({ title: `${prefix}-a` })
            const b = yield* svc.create({ title: `${prefix}-b` })
            const c = yield* svc.create({ title: `${prefix}-c` })
            const d = yield* svc.create({ title: `${prefix}-d` })
            return { a, b, c, d }
          }),
        )
        yield* run(
          Effect.gen(function* () {
            const { db } = yield* Database.Service
            for (const [id, updated] of [
              [fixture.a.id, BASE],
              [fixture.b.id, BASE + 1000],
              [fixture.c.id, BASE + 2000],
              [fixture.d.id, BASE + 3000],
            ] as Array<[SessionID, number]>) {
              yield* db
                .update(SessionTable)
                .set({ time_updated: updated })
                .where(eq(SessionTable.id, id))
                .run()
                .pipe(Effect.orDie)
            }
          }),
        )
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => init(ext))
          const raw1 = yield* Effect.promise(() =>
            ext.request("experimental/session/list", pageReq(dir, prefix, 2, "upd1-p1", "req-upd1-p1")),
          )
          const res1 = asListResult(raw1)
          expect(res1.status).toBe("succeeded")
          const page1 = toPage(res1)
          expect(page1.ids.length).toBe(2)
          requirePage1Cursor(page1)
          const mutated = page1.ids[0]!
          yield* run(
            Effect.gen(function* () {
              const { db } = yield* Database.Service
              yield* db
                .update(SessionTable)
                .set({ time_updated: BASE + 5000 })
                .where(eq(SessionTable.id, mutated as SessionID))
                .run()
                .pipe(Effect.orDie)
            }),
          )
          const raw2 = yield* Effect.promise(() =>
            ext.request("experimental/session/list", pageReq(dir, prefix, 2, "upd1-p2", "req-upd1-p2", page1.cursor!)),
          )
          const res2 = asListResult(raw2)
          expect(res2.status).toBe("succeeded")
          const page2 = toPage(res2)
          const rawFull = yield* Effect.promise(() =>
            ext.request("experimental/session/list", pageReq(dir, prefix, 100, "upd1-full", "req-upd1-full")),
          )
          const baseline = toPage(asListResult(rawFull))
          report("update-page1-row", {
            ...summarize(page1, page2, baseline.ids),
            mutatedId: mutated,
            fullListAfter: baseline.ids,
          })
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        restore()
      }
    }),
  )

  it.live("update not-yet-returned row between pages", () =>
    Effect.gen(function* () {
      const restore = ownParentPid()
      try {
        const tmp = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir({ git: true })),
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
        )
        const dir = tmp.path
        const prefix = "probe-upd2"
        const store = yield* InstanceStore.Service
        const ctx = yield* store.load({ directory: dir })
        const captured = yield* Effect.context()
        const run = scoped(ctx, captured)
        const fixture = yield* run(
          Effect.gen(function* () {
            const svc = yield* Session.Service
            const a = yield* svc.create({ title: `${prefix}-a` })
            const b = yield* svc.create({ title: `${prefix}-b` })
            const c = yield* svc.create({ title: `${prefix}-c` })
            const d = yield* svc.create({ title: `${prefix}-d` })
            return { a, b, c, d }
          }),
        )
        yield* run(
          Effect.gen(function* () {
            const { db } = yield* Database.Service
            for (const [id, updated] of [
              [fixture.a.id, BASE],
              [fixture.b.id, BASE + 1000],
              [fixture.c.id, BASE + 2000],
              [fixture.d.id, BASE + 3000],
            ] as Array<[SessionID, number]>) {
              yield* db
                .update(SessionTable)
                .set({ time_updated: updated })
                .where(eq(SessionTable.id, id))
                .run()
                .pipe(Effect.orDie)
            }
          }),
        )
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => init(ext))
          const raw1 = yield* Effect.promise(() =>
            ext.request("experimental/session/list", pageReq(dir, prefix, 2, "upd2-p1", "req-upd2-p1")),
          )
          const res1 = asListResult(raw1)
          expect(res1.status).toBe("succeeded")
          const page1 = toPage(res1)
          expect(page1.ids.length).toBe(2)
          requirePage1Cursor(page1)
          yield* run(
            Effect.gen(function* () {
              const { db } = yield* Database.Service
              yield* db
                .update(SessionTable)
                .set({ time_updated: BASE + 5000 })
                .where(eq(SessionTable.id, fixture.b.id))
                .run()
                .pipe(Effect.orDie)
            }),
          )
          const raw2 = yield* Effect.promise(() =>
            ext.request("experimental/session/list", pageReq(dir, prefix, 2, "upd2-p2", "req-upd2-p2", page1.cursor!)),
          )
          const res2 = asListResult(raw2)
          expect(res2.status).toBe("succeeded")
          const page2 = toPage(res2)
          const rawFull = yield* Effect.promise(() =>
            ext.request("experimental/session/list", pageReq(dir, prefix, 100, "upd2-full", "req-upd2-full")),
          )
          const baseline = toPage(asListResult(rawFull))
          report("update-unreturned-row", {
            ...summarize(page1, page2, baseline.ids),
            mutatedId: fixture.b.id,
            fullListAfter: baseline.ids,
          })
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        restore()
      }
    }),
  )

  it.live("delete cursor-anchor row between pages", () =>
    Effect.gen(function* () {
      const restore = ownParentPid()
      try {
        const tmp = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir({ git: true })),
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
        )
        const dir = tmp.path
        const prefix = "probe-del"
        const store = yield* InstanceStore.Service
        const ctx = yield* store.load({ directory: dir })
        const captured = yield* Effect.context()
        const run = scoped(ctx, captured)
        const fixture = yield* run(
          Effect.gen(function* () {
            const svc = yield* Session.Service
            const a = yield* svc.create({ title: `${prefix}-a` })
            const b = yield* svc.create({ title: `${prefix}-b` })
            const c = yield* svc.create({ title: `${prefix}-c` })
            const d = yield* svc.create({ title: `${prefix}-d` })
            return { a, b, c, d }
          }),
        )
        yield* run(
          Effect.gen(function* () {
            const { db } = yield* Database.Service
            for (const [id, updated] of [
              [fixture.a.id, BASE],
              [fixture.b.id, BASE + 1000],
              [fixture.c.id, BASE + 2000],
              [fixture.d.id, BASE + 3000],
            ] as Array<[SessionID, number]>) {
              yield* db
                .update(SessionTable)
                .set({ time_updated: updated })
                .where(eq(SessionTable.id, id))
                .run()
                .pipe(Effect.orDie)
            }
          }),
        )
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => init(ext))
          const raw1 = yield* Effect.promise(() =>
            ext.request("experimental/session/list", pageReq(dir, prefix, 2, "del-p1", "req-del-p1")),
          )
          const res1 = asListResult(raw1)
          expect(res1.status).toBe("succeeded")
          const page1 = toPage(res1)
          expect(page1.ids.length).toBe(2)
          requirePage1Cursor(page1)
          const deleted = page1.ids[1]!
          yield* run(
            Effect.gen(function* () {
              const svc = yield* Session.Service
              return yield* svc.remove(deleted as never)
            }),
          )
          const raw2 = yield* Effect.promise(() =>
            ext.request("experimental/session/list", pageReq(dir, prefix, 2, "del-p2", "req-del-p2", page1.cursor!)),
          )
          const res2 = asListResult(raw2)
          expect(res2.status).toBe("succeeded")
          const page2 = toPage(res2)
          const rawFull = yield* Effect.promise(() =>
            ext.request("experimental/session/list", pageReq(dir, prefix, 100, "del-full", "req-del-full")),
          )
          const baseline = toPage(asListResult(rawFull))
          report("delete-anchor", {
            ...summarize(page1, page2, baseline.ids),
            deletedId: deleted,
            fullListAfter: baseline.ids,
          })
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        restore()
      }
    }),
  )

  it.live("archive unreturned row between pages", () =>
    Effect.gen(function* () {
      const restore = ownParentPid()
      try {
        const tmp = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir({ git: true })),
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
        )
        const dir = tmp.path
        const prefix = "probe-arch"
        const store = yield* InstanceStore.Service
        const ctx = yield* store.load({ directory: dir })
        const captured = yield* Effect.context()
        const run = scoped(ctx, captured)
        const fixture = yield* run(
          Effect.gen(function* () {
            const svc = yield* Session.Service
            const a = yield* svc.create({ title: `${prefix}-a` })
            const b = yield* svc.create({ title: `${prefix}-b` })
            const c = yield* svc.create({ title: `${prefix}-c` })
            const d = yield* svc.create({ title: `${prefix}-d` })
            return { a, b, c, d }
          }),
        )
        yield* run(
          Effect.gen(function* () {
            const { db } = yield* Database.Service
            for (const [id, updated] of [
              [fixture.a.id, BASE],
              [fixture.b.id, BASE + 1000],
              [fixture.c.id, BASE + 2000],
              [fixture.d.id, BASE + 3000],
            ] as Array<[SessionID, number]>) {
              yield* db
                .update(SessionTable)
                .set({ time_updated: updated })
                .where(eq(SessionTable.id, id))
                .run()
                .pipe(Effect.orDie)
            }
          }),
        )
        const { carrier, ext } = linked()
        try {
          yield* Effect.promise(() => init(ext))
          const raw1 = yield* Effect.promise(() =>
            ext.request("experimental/session/list", pageReq(dir, prefix, 2, "arch-p1", "req-arch-p1")),
          )
          const res1 = asListResult(raw1)
          expect(res1.status).toBe("succeeded")
          const page1 = toPage(res1)
          expect(page1.ids.length).toBe(2)
          requirePage1Cursor(page1)
          yield* run(
            Effect.gen(function* () {
              const svc = yield* Session.Service
              return yield* svc.setArchived({ sessionID: fixture.b.id, time: BASE + 4000 })
            }),
          )
          const raw2 = yield* Effect.promise(() =>
            ext.request("experimental/session/list", pageReq(dir, prefix, 2, "arch-p2", "req-arch-p2", page1.cursor!)),
          )
          const res2 = asListResult(raw2)
          expect(res2.status).toBe("succeeded")
          const page2 = toPage(res2)
          const rawFull = yield* Effect.promise(() =>
            ext.request("experimental/session/list", pageReq(dir, prefix, 100, "arch-full", "req-arch-full")),
          )
          const baseline = toPage(asListResult(rawFull))
          report("archive-unreturned", {
            ...summarize(page1, page2, baseline.ids),
            archivedId: fixture.b.id,
            fullListAfter: baseline.ids,
          })
        } finally {
          carrier.dispose()
          ext.dispose()
        }
      } finally {
        restore()
      }
    }),
  )
})
