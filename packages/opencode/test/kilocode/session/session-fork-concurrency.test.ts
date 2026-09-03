// @ts-nocheck
import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { SessionOperation } from "@opencode-ai/core/session/operation"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { testEffect } from "../../lib/effect"
import { resetDatabase } from "../../fixture/db"
import { disposeAllInstances, tmpdirScoped } from "../../fixture/fixture"
import { Server } from "../../../src/server/server"
import * as Log from "@opencode-ai/core/util/log"

void Log.init({ print: false })

const it = testEffect(CrossSpawnSpawner.defaultLayer)

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("sessionFork durable concurrency", () => {
  it.live(
    "two distinct durable forks via real HTTP in parallel both succeed with isolated children/operations",
    () =>
      Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      yield* Effect.addFinalizer(() => Effect.promise(() => disposeAllInstances()))

      const listener = yield* Effect.acquireRelease(
        Effect.promise(() => Server.listen({ hostname: "127.0.0.1", port: 0 })),
        (l) => Effect.promise(() => l.stop()),
      )

      // create source via real HTTP so listener DB owns it (production route)
      const createUrl = new URL(`/session?directory=${encodeURIComponent(dir)}`, listener.url).toString()
      const createRes = yield* Effect.promise(() =>
        fetch(createUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "concurrency-src" }) }),
      )
      expect(createRes.status).toBe(200)
      const source = yield* Effect.promise(() => createRes.json() as Promise<{ id: string }>)

      const tokenA = "conc-a-" + Math.random().toString(36).slice(2, 8)
      const tokenB = "conc-b-" + Math.random().toString(36).slice(2, 8)
      const opIdA = SessionOperation.forkId(source.id, tokenA)
      const opIdB = SessionOperation.forkId(source.id, tokenB)
      const keyA = `fork:${source.id}:${tokenA}`
      const keyB = `fork:${source.id}:${tokenB}`

      const forkUrl = new URL(`/session/${source.id}/fork?directory=${encodeURIComponent(dir)}`, listener.url).toString()
      const bodyA = {
        idempotencyKey: keyA,
        requestId: `req-conc-a-${tokenA}`,
        opId: opIdA,
        context: { directory: dir, sessionId: source.id, parentSessionId: null },
      }
      const bodyB = {
        idempotencyKey: keyB,
        requestId: `req-conc-b-${tokenB}`,
        opId: opIdB,
        context: { directory: dir, sessionId: source.id, parentSessionId: null },
      }

      // concurrent dispatch through real production HTTP route
      const [resA, resB] = yield* Effect.all(
        [
          Effect.promise(() =>
            fetch(forkUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(bodyA) }),
          ),
          Effect.promise(() =>
            fetch(forkUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(bodyB) }),
          ),
        ],
        { concurrency: "unbounded" },
      )

      expect(resA.status).toBe(200)
      expect(resB.status).toBe(200)

      const dataA = yield* Effect.promise(() => resA.json() as Promise<{ id: string; parentID: string; directory: string }>)
      const dataB = yield* Effect.promise(() => resB.json() as Promise<{ id: string; parentID: string; directory: string }>)

      // child identity different and parent correct
      expect(dataA.id).toBeDefined()
      expect(dataB.id).toBeDefined()
      expect(dataA.id).not.toBe(dataB.id)
      expect(dataA.parentID).toBe(source.id)
      expect(dataB.parentID).toBe(source.id)
      expect(dataA.directory).toBe(dir)
      expect(dataB.directory).toBe(dir)

      // verify children listing via HTTP – exactly two, containing both ids
      const childrenUrl = new URL(`/session/${source.id}/children?directory=${encodeURIComponent(dir)}`, listener.url).toString()
      const childrenRes = yield* Effect.promise(() => fetch(childrenUrl))
      expect(childrenRes.status).toBe(200)
      const children = yield* Effect.promise(() => childrenRes.json() as Promise<Array<{ id: string; parentID: string }>>)
      expect(children.length).toBe(2)
      const childIds = new Set(children.map((c) => c.id))
      expect(childIds.has(dataA.id)).toBe(true)
      expect(childIds.has(dataB.id)).toBe(true)

      // verify total session count via HTTP – source + 2 children, no extra
      const listUrl = new URL(`/session?directory=${encodeURIComponent(dir)}`, listener.url).toString()
      const listRes = yield* Effect.promise(() => fetch(listUrl))
      expect(listRes.status).toBe(200)
      const allSessions = yield* Effect.promise(() => listRes.json() as Promise<Array<{ id: string }>>)
      expect(allSessions.length).toBe(3)

      // verify operation/result attribution via idempotent replay through the same production HTTP route
      // replaying each key must return the same child and not create extra state
      const replayA = yield* Effect.promise(() =>
        fetch(forkUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(bodyA) }),
      )
      expect(replayA.status).toBe(200)
      const replayDataA = yield* Effect.promise(() => replayA.json() as Promise<{ id: string }>)
      expect(replayDataA.id).toBe(dataA.id)

      const replayB = yield* Effect.promise(() =>
        fetch(forkUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(bodyB) }),
      )
      expect(replayB.status).toBe(200)
      const replayDataB = yield* Effect.promise(() => replayB.json() as Promise<{ id: string }>)
      expect(replayDataB.id).toBe(dataB.id)

      // after replay, still exactly 2 children and 3 total sessions – no extra operation/child leaked
      const childrenRes2 = yield* Effect.promise(() => fetch(childrenUrl))
      expect(childrenRes2.status).toBe(200)
      const children2 = yield* Effect.promise(() => childrenRes2.json() as Promise<any[]>)
      expect(children2.length).toBe(2)

      const listRes2 = yield* Effect.promise(() => fetch(listUrl))
      const allSessions2 = yield* Effect.promise(() => listRes2.json() as Promise<any[]>)
      expect(allSessions2.length).toBe(3)
      }),
    10000,
  )
})
