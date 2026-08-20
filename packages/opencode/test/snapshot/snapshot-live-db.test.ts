import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { sql } from "drizzle-orm"
import { ChildProcess } from "effect/unstable/process"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { AppProcess } from "@opencode-ai/core/process"
import { Database } from "@opencode-ai/core/database/database"
import { PartTable, SessionTable, MessageTable } from "@opencode-ai/core/session/sql"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ProjectV2 } from "@opencode-ai/core/project"
import { extractLiveHashes, fetchLiveHashes } from "../../src/snapshot/live-collector"
import { KiloSnapshotMaterialize } from "../../src/kilocode/snapshot/materialize"
import { tmpdir } from "../fixture/fixture"
import { $ } from "bun"

async function gitHash(gitdir: string, content: string): Promise<string> {
  const file = path.join(gitdir + "-tmp", content.slice(0, 8) + ".txt")
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, content)
  const h = (await $`git --git-dir=${gitdir} hash-object -w ${file}`.text()).trim()
  await fs.rm(file, { force: true })
  return h
}

describe("snapshot live collector realistic DB", () => {
  test("project-scoped live hashes exclude cross-project refs and feed prune", async () => {
    await using tmp = await tmpdir()
    const gitdir = path.join(tmp.path, "snap-live.git")
    await $`git init --bare ${gitdir}`.quiet()

    // create real blob hashes for live/dead/cross
    const liveA = await gitHash(gitdir, "liveA-" + crypto.randomUUID())
    const snapPartA = await gitHash(gitdir, "snapPartA-" + crypto.randomUUID())
    const patchA = await gitHash(gitdir, "patchA-" + crypto.randomUUID())
    const stepA = await gitHash(gitdir, "stepA-" + crypto.randomUUID())
    const liveB = await gitHash(gitdir, "liveB-" + crypto.randomUUID())
    const dead = await gitHash(gitdir, "dead-" + crypto.randomUUID())
    const crossDead = await gitHash(gitdir, "crossDead-" + crypto.randomUUID())

    const projectA = `proj-${crypto.randomUUID().slice(0, 8)}`
    const projectB = `proj-${crypto.randomUUID().slice(0, 8)}`
    const sesA1 = `ses_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`
    const sesA2 = `ses_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`
    const sesB1 = `ses_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`
    const msgA1 = `msg_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`
    const msgA2 = `msg_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`
    const msgB1 = `msg_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`

    const dbPath = path.join(tmp.path, "live.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        // disable FK for minimal inserts
        yield* db.run(sql`PRAGMA foreign_keys=OFF`).pipe(Effect.orDie)
        // insert projects to satisfy FK if enabled later
        yield* db
          .insert(ProjectTable)
          .values([
            { id: ProjectV2.ID.make(projectA), worktree: `/tmp/${projectA}` as never, sandboxes: [] as never, vcs: "git" as never },
            { id: ProjectV2.ID.make(projectB), worktree: `/tmp/${projectB}` as never, sandboxes: [] as never, vcs: "git" as never },
          ])
          .run()
          .pipe(Effect.orDie)
        // sessions
        yield* db
          .insert(SessionTable)
          .values([
            {
              id: sesA1 as never,
              project_id: ProjectV2.ID.make(projectA),
              slug: "a1",
              directory: "/tmp/a" as never,
              version: "1",
              title: "A1",
              revert: { messageID: msgA1 as never, snapshot: liveA } as never,
            },
            {
              id: sesA2 as never,
              project_id: ProjectV2.ID.make(projectA),
              slug: "a2",
              directory: "/tmp/a" as never,
              version: "1",
              title: "A2",
            },
            {
              id: sesB1 as never,
              project_id: ProjectV2.ID.make(projectB),
              slug: "b1",
              directory: "/tmp/b" as never,
              version: "1",
              title: "B1",
              revert: { messageID: msgB1 as never, snapshot: liveB } as never,
            },
          ])
          .run()
          .pipe(Effect.orDie)
        // messages to satisfy Part FK
        yield* db
          .insert(MessageTable)
          .values([
            { id: msgA1 as never, session_id: sesA1 as never, data: { role: "user" } as never },
            { id: msgA2 as never, session_id: sesA2 as never, data: { role: "user" } as never },
            { id: msgB1 as never, session_id: sesB1 as never, data: { role: "user" } as never },
          ])
          .run()
          .pipe(Effect.orDie)
        // parts: projA live via parts, projB isolated
        yield* db
          .insert(PartTable)
          .values([
            {
              id: `prt_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}` as never,
              message_id: msgA1 as never,
              session_id: sesA1 as never,
              data: { type: "snapshot", snapshot: snapPartA, id: "x", sessionID: sesA1, messageID: msgA1 } as never,
            },
            {
              id: `prt_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}` as never,
              message_id: msgA1 as never,
              session_id: sesA1 as never,
              data: { type: "patch", hash: patchA, files: [], id: "x", sessionID: sesA1, messageID: msgA1 } as never,
            },
            {
              id: `prt_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}` as never,
              message_id: msgA2 as never,
              session_id: sesA2 as never,
              data: { type: "step-start", snapshot: stepA, id: "x", sessionID: sesA2, messageID: msgA2 } as never,
            },
            {
              id: `prt_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}` as never,
              message_id: msgB1 as never,
              session_id: sesB1 as never,
              data: { type: "snapshot", snapshot: crossDead, id: "x", sessionID: sesB1, messageID: msgB1 } as never,
            },
            // ignored types should not leak
            {
              id: `prt_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}` as never,
              message_id: msgA1 as never,
              session_id: sesA1 as never,
              data: { type: "text", text: "hello", id: "x", sessionID: sesA1, messageID: msgA1 } as never,
            },
          ])
          .run()
          .pipe(Effect.orDie)
        yield* db.run(sql`PRAGMA foreign_keys=ON`).pipe(Effect.orDie)
      }).pipe(Effect.provide(dbLayer)),
    )

    // verify typed collector
    const liveSetA = await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        return yield* fetchLiveHashes(db, ProjectV2.ID.make(projectA))
      }).pipe(Effect.provide(dbLayer)),
    )
    expect(liveSetA.has(liveA)).toBe(true)
    expect(liveSetA.has(snapPartA)).toBe(true)
    expect(liveSetA.has(patchA)).toBe(true)
    expect(liveSetA.has(stepA)).toBe(true)
    expect(liveSetA.has(liveB)).toBe(false)
    expect(liveSetA.has(crossDead)).toBe(false)
    expect(liveSetA.has(dead)).toBe(false)

    const liveSetB = await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        return yield* fetchLiveHashes(db, ProjectV2.ID.make(projectB))
      }).pipe(Effect.provide(dbLayer)),
    )
    expect(liveSetB.has(liveB)).toBe(true)
    expect(liveSetB.has(crossDead)).toBe(true)
    expect(liveSetB.has(liveA)).toBe(false)

    // pure extractor edge: empty revert and ignored parts
    const pure = extractLiveHashes([{ revert: null }, { revert: { snapshot: "" } }], [{ data: { type: "text", text: "x" } }])
    expect(pure.size).toBe(0)

    // git prune with DB-derived live set
    const oldLive = `refs/kilo/snapshots/1/${liveA}`
    const oldSnapPart = `refs/kilo/snapshots/1/${snapPartA}`
    const oldPatch = `refs/kilo/snapshots/1/${patchA}`
    const oldStep = `refs/kilo/snapshots/1/${stepA}`
    const oldDead = `refs/kilo/snapshots/1/${dead}`
    const oldCrossDead = `refs/kilo/snapshots/1/${crossDead}`
    const oldLiveB = `refs/kilo/snapshots/1/${liveB}`
    const recent = `refs/kilo/snapshots/${Date.now()}/${liveA}`

    await $`git --git-dir=${gitdir} update-ref ${oldLive} ${liveA}`.quiet()
    await $`git --git-dir=${gitdir} update-ref ${oldSnapPart} ${snapPartA}`.quiet()
    await $`git --git-dir=${gitdir} update-ref ${oldPatch} ${patchA}`.quiet()
    await $`git --git-dir=${gitdir} update-ref ${oldStep} ${stepA}`.quiet()
    await $`git --git-dir=${gitdir} update-ref ${oldDead} ${dead}`.quiet()
    await $`git --git-dir=${gitdir} update-ref ${oldCrossDead} ${crossDead}`.quiet()
    await $`git --git-dir=${gitdir} update-ref ${oldLiveB} ${liveB}`.quiet()
    await $`git --git-dir=${gitdir} update-ref ${recent} ${liveA}`.quiet()

    await Effect.runPromise(
      Effect.gen(function* () {
        const fsUtil = yield* FSUtil.Service
        const proc = yield* AppProcess.Service
        const g = (cmd: string[], opts?: { stdin?: string }) =>
          proc
            .run(ChildProcess.make("git", cmd, { extendEnv: true }), { stdin: opts?.stdin })
            .pipe(
              Effect.map((r) => ({ code: r.exitCode, text: r.stdout.toString("utf8"), stderr: r.stderr.toString("utf8") })),
              Effect.catch(() => Effect.succeed({ code: 1 as const, text: "", stderr: "" })),
            )
        const ok = yield* KiloSnapshotMaterialize.prune({ gitdir, git: (c, o) => g(c, o), fs: fsUtil }, Date.now() - 7 * 24 * 60 * 60 * 1000, liveSetA)
        expect(ok).toBe(true)
      }).pipe(Effect.provide(Layer.mergeAll(FSUtil.defaultLayer, AppProcess.defaultLayer))),
    )

    async function existsRef(ref: string): Promise<boolean> {
      const p = Bun.spawn(["git", "--git-dir", gitdir, "rev-parse", "--verify", "--quiet", ref], { stdout: "pipe" })
      await p.exited
      const t = (await new Response(p.stdout).text()).trim()
      return t !== ""
    }

    expect(await existsRef(oldLive)).toBe(true)
    expect(await existsRef(oldSnapPart)).toBe(true)
    expect(await existsRef(oldPatch)).toBe(true)
    expect(await existsRef(oldStep)).toBe(true)
    expect(await existsRef(recent)).toBe(true)
    expect(await existsRef(oldDead)).toBe(false)
    expect(await existsRef(oldCrossDead)).toBe(false)
    expect(await existsRef(oldLiveB)).toBe(false)
  }, 10_000)

  test("extractLiveHashes handles snapshot/patch/step types and ignores others", () => {
    const s = extractLiveHashes(
      [{ revert: { snapshot: "r1" } }, { revert: { snapshot: "" } }, { revert: null as never }],
      [
        { data: { type: "snapshot", snapshot: "s1" } },
        { data: { type: "patch", hash: "p1", files: [] } },
        { data: { type: "step-start", snapshot: "ss1" } },
        { data: { type: "step-finish", snapshot: "sf1" } },
        { data: { type: "text", text: "hi" } },
        { data: null as never },
        { data: { type: "snapshot", snapshot: "" } },
        { data: { type: "patch", hash: "" } },
      ],
    )
    expect(s.has("r1")).toBe(true)
    expect(s.has("s1")).toBe(true)
    expect(s.has("p1")).toBe(true)
    expect(s.has("ss1")).toBe(true)
    expect(s.has("sf1")).toBe(true)
    expect(s.size).toBe(5)
  })
})
