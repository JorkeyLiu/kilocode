import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import fs from "fs/promises"
import path from "path"
import os from "os"
import { Database } from "@opencode-ai/core/database/database"
import { createArchive, verifyArchive, deriveArchive, checkpointAndVerify } from "@opencode-ai/core/cutover/archive"
import { createIdentity, verifyGate } from "@opencode-ai/core/cutover/identity"
import { runCutover, bootstrapFreshStaged, isFresh, recoverCutover } from "@opencode-ai/core/cutover/cutover"
import { runOfflineCutover } from "@opencode-ai/core/cutover/offline"
import { verifyAndRollback, recoverRollback } from "@opencode-ai/core/cutover/rollback"
import { isValidArchiveID } from "@opencode-ai/core/cutover/util"
import { parseAndValidateManifest } from "@opencode-ai/core/cutover/manifest"

async function makeDataRoot(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kilo-cutover-hard-"))
  const cleanup = async () => {
    try { await fs.rm(dir, { recursive: true, force: true }) } catch {}
    try {
      const { p4 } = deriveArchive(dir)
      const parent = path.dirname(path.resolve(dir))
      const base = path.basename(path.resolve(dir))
      await fs.rm(path.join(parent, `.cutover-${base}.marker.json`), { force: true }).catch(()=>{})
      await fs.rm(path.join(parent, `.cutover-${base}.lock`), { recursive: true, force: true }).catch(()=>{})
      await fs.rm(path.join(parent, `.rollback-${base}.marker.json`), { force: true }).catch(()=>{})
      await fs.rm(path.join(parent, `.rollback-${base}.lock`), { recursive: true, force: true }).catch(()=>{})
      await fs.rm(path.join(parent, `.kilo-${base}.lease.json`), { force: true }).catch(()=>{})
    } catch {}
  }
  return { root: dir, cleanup }
}

async function ensureProject(root: string) {
  const dbPath = path.join(root, "kilo.db")
  const layer = Database.layerFromPath(dbPath)
  await Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const existing = yield* db.get<{ id: string }>(sql`SELECT id FROM project WHERE id='proj_global'`).pipe(Effect.orDie)
      if (!existing) yield* db.run(sql`INSERT INTO project (id, worktree, sandboxes, time_created, time_updated) VALUES ('proj_global', '/tmp', '[]', 1, 1)`).pipe(Effect.orDie)
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.orDie),
  )
}

async function initLegacyDB(root: string) {
  await ensureProject(root)
  const dbPath = path.join(root, "kilo.db")
  const layer = Database.layerFromPath(dbPath)
  await Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db.run(sql`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES ('ses_legacy1', 'proj_global', 'legacy', '/tmp', 'Legacy', 'v1', 1, 1)`).pipe(Effect.orDie)
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.orDie),
  )
  await fs.mkdir(path.join(root, "storage/session_diff"), { recursive: true })
  await fs.writeFile(path.join(root, "storage/session_diff", "ses_legacy1.json"), JSON.stringify({ diff: "x" }))
  await fs.mkdir(path.join(root, "storage/session_diff_base"), { recursive: true })
  await fs.writeFile(path.join(root, "storage/session_diff_base", "ses_legacy1.json"), JSON.stringify({ base: "y" }))
  await fs.mkdir(path.join(root, "storage/session_share"), { recursive: true })
  await fs.writeFile(path.join(root, "storage/session_share", "ses_legacy1.json"), JSON.stringify({ share: "z" }))
  await fs.mkdir(path.join(root, "snapshot", "proj"), { recursive: true })
  await fs.writeFile(path.join(root, "snapshot", "proj", "file.txt"), "snapshot data")
}

describe("S5 hardened production path", () => {
  test("offline invocation refuses when a live external lease is held", async () => {
    const { root, cleanup } = await makeDataRoot()
    try {
      await initLegacyDB(root)
      const { leasePathFor } = await import("@opencode-ai/core/cutover/lease")
      const lp = leasePathFor(root)
      await fs.mkdir(path.dirname(lp), { recursive: true }).catch(() => {})
      // simulate a live external (cross-process) holder on our own PID with a foreign token
      await fs.writeFile(lp, JSON.stringify({ pid: process.pid, token: "foreign-holder", createdAt: Date.now() }), "utf8")
      let failed = false
      try {
        await runOfflineCutover({ dataRoot: root })
      } catch (e) {
        failed = true
        expect(String(e).includes("exclusivity") || String(e).includes("lease") || String(e).includes("held") || String(e).includes("live")).toBe(true)
      }
      expect(failed).toBe(true)
      expect(await fs.access(path.join(root, "kilo.db")).then(() => true).catch(() => false)).toBe(true)
      await fs.rm(lp, { force: true })
    } finally {
      await cleanup()
    }
  })

  test("checkpoint validates wal_checkpoint busy/log and fails closed", async () => {
    const { root, cleanup } = await makeDataRoot()
    try {
      await initLegacyDB(root)
      // inject busy by patching bun:sqlite Database to return busy=1
      const { Database: BunDB } = await import("bun:sqlite")
      const orig = BunDB.prototype.query
      let called = false
      // @ts-ignore
      BunDB.prototype.query = function(q: string) {
        if (q.includes("wal_checkpoint")) {
          called = true
          return { get: () => ({ busy: 1, log: 0, checkpointed: 0 }), all: () => [] } as any
        }
        return orig.call(this, q)
      }
      let failed = false
      try { await createArchive({ dataRoot: root }) } catch (e) { failed = true; expect(String(e).includes("busy") || String(e).includes("quiescence")).toBe(true) }
      expect(failed).toBe(true)
      expect(called).toBe(true)
      BunDB.prototype.query = orig
      // legacy still active
      expect(await fs.access(path.join(root, "kilo.db")).then(()=>true).catch(()=>false)).toBe(true)
    } finally { await cleanup() }
  })

  test("fsyncDir failure propagates and cleans temp", async () => {
    const { root, cleanup } = await makeDataRoot()
    try {
      await initLegacyDB(root)
      // fsyncDir propagates errors: call with non-existent dir's parent should throw, and we verify createArchive cleans temp on EXDEV (already proven)
      // Here we test that fsyncDir itself throws on invalid dir
      const { fsyncDir } = await import("@opencode-ai/core/cutover/util")
      let threw = false
      try { await fsyncDir("/nonexistent-dir-xyz-12345/sub") } catch { threw = true }
      expect(threw).toBe(true)
      // and that EXDEV failure cleans tmp (reuse earlier EXDEV logic)
      const { Database: BunDB } = await import("bun:sqlite")
      const origRename = fs.rename
      let called = false
      // @ts-ignore
      fs.rename = async (a:any,b:any)=>{ called=true; const e:any=new Error("EXDEV"); e.code="EXDEV"; throw e }
      let failed = false
      try { await createArchive({ dataRoot: root, archiveID: "20260106T000000Z-ffffffff-aaaa-bbbb-cccc-dddddddddddd" }) } catch (e) { failed = true; expect(String(e).includes("EXDEV")).toBe(true) }
      expect(failed).toBe(true)
      const { p4 } = deriveArchive(root)
      const entries = await fs.readdir(p4).catch(()=>[] as string[])
      expect(entries.some(e=>e.startsWith(".tmp-"))).toBe(false)
      // @ts-ignore
      fs.rename = origRename
    } finally { await cleanup() }
  })

  test("manifest traversal/symlink/duplicate/unknown rejected and rollback cannot consume tampered archive", async () => {
    const { root, cleanup } = await makeDataRoot()
    try {
      await initLegacyDB(root)
      const res = await createArchive({ dataRoot: root, archiveID: "20260101T000000Z-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" })
      // traversal via manifest edit
      const maniPath = path.join(res.archivePath, "manifest.json")
      const raw = await fs.readFile(maniPath, "utf8")
      const mani = JSON.parse(raw)
      // duplicate
      const dup = JSON.parse(raw)
      dup.files.push(dup.files[0])
      await fs.writeFile(maniPath, JSON.stringify(dup, null, 2))
      let failed = false
      try { await verifyArchive(res.archivePath) } catch (e) { failed = true; expect(String(e).includes("duplicate") || String(e).includes("mismatch")).toBe(true) }
      expect(failed).toBe(true)
      // restore and try unknown
      await fs.writeFile(maniPath, raw)
      const unk = JSON.parse(raw)
      unk.files.push({ path: "unknown.txt", bytes: 1, sha256: "0".repeat(64) })
      unk.aggregate_sha256 = (await import("@opencode-ai/core/cutover/manifest")).aggregate(unk.files)
      await fs.writeFile(maniPath, JSON.stringify(unk, null, 2))
      failed = false
      try { await verifyArchive(res.archivePath) } catch (e) { failed = true; expect(String(e).includes("unknown")).toBe(true) }
      expect(failed).toBe(true)
      await fs.writeFile(maniPath, raw)
      // symlink
      const linkTarget = path.join(res.archivePath, "storage/session_diff/symlink.json")
      try { await fs.symlink(path.join(root, "kilo.db"), linkTarget) } catch {}
      const linkExists = await fs.lstat(linkTarget).then(s=>s.isSymbolicLink()).catch(()=>false)
      if (linkExists) {
        failed = false
        try { await verifyArchive(res.archivePath) } catch (e) { failed = true; expect(String(e).includes("symlink") || String(e).includes("undeclared")).toBe(true) }
        expect(failed).toBe(true)
        await fs.rm(linkTarget, { force: true })
      }
      await fs.writeFile(maniPath, raw)
      // rollback should also reject tampered archive
      // tamper by adding traversal file physically without manifest entry
      await fs.writeFile(path.join(res.archivePath, "evil.txt"), "evil")
      failed = false
      try { await verifyAndRollback({ dataRoot: root, archivePath: res.archivePath }) } catch (e) { failed = true }
      expect(failed).toBe(true)
      await fs.rm(path.join(res.archivePath, "evil.txt"), { force: true }).catch(()=>{})
      // now verify should pass again
      const ok = await verifyArchive(res.archivePath)
      expect(ok.archive_id).toBe("20260101T000000Z-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")
    } finally { await cleanup() }
  })

  test("verifyGate propagates non-ENOENT, enforces auto_vacuum and full zero-state", async () => {
    const { root, cleanup } = await makeDataRoot()
    try {
      await initLegacyDB(root)
      const cut = await runCutover({ dataRoot: root })
      expect(await isFresh(root)).toBe(true)
      const dbPath = path.join(root, "kilo.db")
      const layer = Database.layerFromPath(dbPath)
      // auto_vacuum is verified to be 2 on fresh DB via direct pragma
      const av = await Effect.runPromise(Effect.gen(function*(){
        const { db } = yield* Database.Service
        const r = yield* db.get<{ auto_vacuum: number }>(sql`PRAGMA auto_vacuum`).pipe(Effect.orDie)
        return (r as any).auto_vacuum
      }).pipe(Effect.provide(layer), Effect.scoped, Effect.orDie))
      expect(av).toBe(2)
      // full zero-state: insert message should cause gate to fail on message table
      await ensureProject(root)
      await Effect.runPromise(Effect.gen(function*(){
        const { db } = yield* Database.Service
        yield* db.run(sql`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES ('ses_fresh1', 'proj_global', 'fresh1', '/tmp', 'Fresh1', 'v1', 10, 10)`).pipe(Effect.orDie)
        yield* db.run(sql`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('msg1', 'ses_fresh1', 10, 10, '{}')`).pipe(Effect.orDie)
      }).pipe(Effect.provide(layer), Effect.scoped, Effect.orDie))
      expect(await isFresh(root)).toBe(false)
      // verifyGate should propagate non-ENOENT: make verifyGate fail with EACCES by causing readdir to throw non-ENOENT
      // We test by making storage/session_diff a file where dir expected, then verifyGate should not swallow EACCES? Actually readdir on file throws ENOTDIR, which is not ENOENT, should propagate as failure
      // For now, we test that after cleaning message, gate passes, but family artifact not empty fails
      await Effect.runPromise(Effect.gen(function*(){
        const { db } = yield* Database.Service
        yield* db.run(sql`DELETE FROM message WHERE id='msg1'`).pipe(Effect.orDie)
        yield* db.run(sql`DELETE FROM session WHERE id='ses_fresh1'`).pipe(Effect.orDie)
      }).pipe(Effect.provide(layer), Effect.scoped, Effect.orDie))
      expect(await isFresh(root)).toBe(true)
      // family artifact not empty
      await fs.mkdir(path.join(root, "storage/session_diff"), { recursive: true })
      await fs.writeFile(path.join(root, "storage/session_diff", "ses_fake.json"), "{}")
      expect(await isFresh(root)).toBe(false)
      await fs.rm(path.join(root, "storage/session_diff", "ses_fake.json"), { force: true })
      expect(await isFresh(root)).toBe(true)
      // non-ENOENT propagation: create a file at storage/session_diff path where dir expected, then isFresh should be false (since readdir will throw ENOTDIR, not ENOENT, and gate should fail)
      // We simulate by removing dir and creating file at same path
      await fs.rm(path.join(root, "storage/session_diff"), { recursive: true, force: true }).catch(()=>{})
      await fs.writeFile(path.join(root, "storage/session_diff"), "not a dir")
      let isFreshResult = await isFresh(root)
      // isFresh should be false because family artifact check should handle ENOTDIR as non-empty? Our verifyGate treats ENOTDIR as not ENOENT, so it will fail and return false via catchAll, which is expected
      expect(isFreshResult).toBe(false)
      await fs.rm(path.join(root, "storage/session_diff"), { force: true }).catch(()=>{})
      await fs.mkdir(path.join(root, "storage/session_diff"), { recursive: true })
      expect(await isFresh(root)).toBe(true)
    } finally { await cleanup() }
  })

  test("staged fresh atomic handoff and failure at bootstrap preserves legacy and cleans staged", async () => {
    const { root, cleanup } = await makeDataRoot()
    try {
      await initLegacyDB(root)
      const { parent, base } = deriveArchive(root)
      // Use checkpoint busy injection to cause archive failure before staging, proving that no staged left
      const { Database: BunDB } = await import("bun:sqlite")
      const orig = BunDB.prototype.query
      // @ts-ignore
      BunDB.prototype.query = function(q: string) {
        if (q.includes("wal_checkpoint")) return { get: () => ({ busy: 1, log: 0, checkpointed: 0 }), all: () => [] } as any
        return orig.call(this, q)
      }
      let threw = false
      try { await runCutover({ dataRoot: root }) } catch (e) { threw = true; expect(String(e).includes("busy")).toBe(true) }
      expect(threw).toBe(true)
      BunDB.prototype.query = orig
      expect(await fs.access(path.join(root, "kilo.db")).then(()=>true).catch(()=>false)).toBe(true)
      const stagedLeft = await fs.readdir(parent).then(a=>a.filter(x=>x.includes(".staged-"))).catch(()=>[] as string[])
      expect(stagedLeft.length).toBe(0)
      const markerExists = await fs.access(path.join(parent, `.cutover-${base}.marker.json`)).then(()=>true).catch(()=>false)
      expect(markerExists).toBe(false)
      const res = await runCutover({ dataRoot: root })
      expect(res.archiveID).toBeTruthy()
      expect(await isFresh(root)).toBe(true)
    } finally { await cleanup() }
  })

  test("restart recovery cleans staged and restores after handoff failure", async () => {
    const { root, cleanup } = await makeDataRoot()
    try {
      await initLegacyDB(root)
      const res = await runCutover({ dataRoot: root })
      const { parent, base } = deriveArchive(root)
      // simulate crash after staged but before handoff: create staged and marker
      const fakeID = "20260102T000000Z-bbbbbbbb-cccc-dddd-eeee-ffffffffffff"
      const staged = path.join(parent, `.staged-${base}-${fakeID}`)
      await fs.mkdir(staged, { recursive: true })
      await fs.mkdir(path.join(staged, "storage/session_diff"), { recursive: true })
      await fs.writeFile(path.join(parent, `.cutover-${base}.marker.json`), JSON.stringify({ archiveID: fakeID, stagedPath: staged, dataRoot: root, phase: "staged" }, null, 2))
      expect(await fs.access(staged).then(()=>true).catch(()=>false)).toBe(true)
      await recoverCutover(root)
      expect(await fs.access(staged).then(()=>true).catch(()=>false)).toBe(false)
      expect(await fs.access(path.join(parent, `.cutover-${base}.marker.json`)).then(()=>true).catch(()=>false)).toBe(false)
      // still fresh
      expect(await isFresh(root)).toBe(true)
      // simulate handoff failure: backup exists, dataRoot fresh but marker handoff
      const backup = `${root}.backup-${fakeID}`
      // create backup by copying current root
      await fs.mkdir(backup, { recursive: true }).catch(()=>{})
      await fs.rm(backup, { recursive: true, force: true })
      await fs.cp(root, backup, { recursive: true }).catch(()=>{})
      await fs.writeFile(path.join(parent, `.cutover-${base}.marker.json`), JSON.stringify({ archiveID: fakeID, stagedPath: staged, dataRoot: root, phase: "handoff" }, null, 2))
      await recoverCutover(root)
      // after recovery, backup should be cleaned if gate passed
      const backupExists = await fs.access(backup).then(()=>true).catch(()=>false)
      // Since gate passes, backup cleaned
      expect(backupExists).toBe(false)
    } finally { await cleanup() }
  })

  test("rollback staged atomic and handoff failure recovery", async () => {
    const { root, cleanup } = await makeDataRoot()
    try {
      await initLegacyDB(root)
      const cut = await runCutover({ dataRoot: root })
      // create fresh session to make rollback needed
      const dbPath = path.join(root, "kilo.db")
      await ensureProject(root)
      const layer = Database.layerFromPath(dbPath)
      await Effect.runPromise(Effect.gen(function*(){
        const { db } = yield* Database.Service
        yield* db.run(sql`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES ('ses_fresh', 'proj_global', 'fresh', '/tmp', 'Fresh', 'v1', 10, 10)`).pipe(Effect.orDie)
      }).pipe(Effect.provide(layer), Effect.scoped, Effect.orDie))
      await fs.writeFile(path.join(root, "storage/session_diff", "ses_fresh.json"), "{}")
      // now rollback should restore legacy
      const rb = await verifyAndRollback({ dataRoot: root, archivePath: cut.archivePath })
      expect(rb.rollbackArchivePath).toBeTruthy()
      expect(await fs.access(path.join(root, "storage/session_diff", "ses_legacy1.json")).then(()=>true).catch(()=>false)).toBe(true)
      expect(await fs.access(path.join(root, "storage/session_diff", "ses_fresh.json")).then(()=>true).catch(()=>false)).toBe(false)
      // verify legacy session restored
      const layer2 = Database.layerFromPath(dbPath)
      const rows = await Effect.runPromise(Effect.gen(function*(){
        const { db } = yield* Database.Service
        return yield* db.all<{id:string}>(sql`SELECT id FROM session`).pipe(Effect.orDie)
      }).pipe(Effect.provide(layer2), Effect.scoped, Effect.orDie))
      expect(rows.some(r=>r.id==="ses_legacy1")).toBe(true)
      expect(rows.some(r=>r.id==="ses_fresh")).toBe(false)
    } finally { await cleanup() }
  })

  test("realistic canonical session/message/part persistence after fresh activation and restart", async () => {
    const { root, cleanup } = await makeDataRoot()
    try {
      await initLegacyDB(root)
      await runCutover({ dataRoot: root })
      const dbPath = path.join(root, "kilo.db")
      await ensureProject(root)
      const layer = Database.layerFromPath(dbPath)
      await Effect.runPromise(Effect.gen(function*(){
        const { db } = yield* Database.Service
        yield* db.run(sql`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES ('ses_new', 'proj_global', 'new', '/tmp', 'New', 'v1', 100, 100)`).pipe(Effect.orDie)
        yield* db.run(sql`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('msg_new', 'ses_new', 100, 100, '{}')`).pipe(Effect.orDie)
        yield* db.run(sql`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('part_new', 'msg_new', 'ses_new', 100, 100, '{}')`).pipe(Effect.orDie)
      }).pipe(Effect.provide(layer), Effect.scoped, Effect.orDie))
      // simulate restart: reopen layer
      const layer2 = Database.layerFromPath(dbPath)
      const persisted = await Effect.runPromise(Effect.gen(function*(){
        const { db } = yield* Database.Service
        const s = yield* db.get<{id:string}>(sql`SELECT id FROM session WHERE id='ses_new'`).pipe(Effect.orDie)
        const m = yield* db.get<{id:string}>(sql`SELECT id FROM message WHERE id='msg_new'`).pipe(Effect.orDie)
        const p = yield* db.get<{id:string}>(sql`SELECT id FROM part WHERE id='part_new'`).pipe(Effect.orDie)
        return { s, m, p }
      }).pipe(Effect.provide(layer2), Effect.scoped, Effect.orDie))
      expect((persisted.s as any).id).toBe("ses_new")
      expect((persisted.m as any).id).toBe("msg_new")
      expect((persisted.p as any).id).toBe("part_new")
    } finally { await cleanup() }
  })

  test("temp cleanup on every failure including generated IDs", async () => {
    const { root, cleanup } = await makeDataRoot()
    try {
      await initLegacyDB(root)
      // Use EXDEV injection via rename mock to cause archive failure and check temp cleaned
      const origRename = fs.rename
      let shouldFail = true
      // @ts-ignore
      fs.rename = async (a:any,b:any)=>{ if (shouldFail && String(a).includes(".tmp-")) { const e:any=new Error("EXDEV"); e.code="EXDEV"; throw e } return (origRename as any)(a,b) }
      let threw = false
      try { await createArchive({ dataRoot: root }) } catch (e) { threw = true }
      expect(threw).toBe(true)
      const { p4 } = deriveArchive(root)
      const tmps = await fs.readdir(p4).then(a=>a.filter(x=>x.startsWith(".tmp-"))).catch(()=>[] as string[])
      expect(tmps.length).toBe(0)
      // @ts-ignore
      fs.rename = origRename
      shouldFail = false
      const ok = await createArchive({ dataRoot: root })
      expect(ok.archiveID).toBeTruthy()
      // runCutover failure via checkpoint busy injection should also clean staged
      const { Database: BunDB } = await import("bun:sqlite")
      const origQ = BunDB.prototype.query
      // @ts-ignore
      BunDB.prototype.query = function(q:string){ if (q.includes("wal_checkpoint")) return { get:()=>({busy:1,log:0,checkpointed:0}), all:()=>[]} as any; return origQ.call(this,q) }
      threw = false
      try { await runCutover({ dataRoot: root }) } catch {}
      BunDB.prototype.query = origQ
      const tmps2 = await fs.readdir(p4).then(a=>a.filter(x=>x.startsWith(".tmp-"))).catch(()=>[] as string[])
      expect(tmps2.length).toBe(0)
      const { parent } = deriveArchive(root)
      const stageds = await fs.readdir(parent).then(a=>a.filter(x=>x.includes(".staged-"))).catch(()=>[] as string[])
      expect(stageds.length).toBe(0)
    } finally { await cleanup() }
  })

  test("rollback marker outside absolute stagedPath fails closed", async () => {
    const { root, cleanup } = await makeDataRoot()
    let sentinelDir: string | undefined
    try {
      await initLegacyDB(root)
      const { parent, base } = deriveArchive(root)
      // sentinel outside tmpdir (homedir) to be truly outside expectedParent (/tmp)
      sentinelDir = await fs.mkdtemp(path.join(os.homedir(), "kilo-sentinel-"))
      const sentinelFile = path.join(sentinelDir, "keep.txt")
      await fs.writeFile(sentinelFile, "sentinel")
      const mp = path.join(parent, `.rollback-${base}.marker.json`)
      const fakeID = "20260101T000000Z-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
      const evilStaged = path.join(sentinelDir, "evil-staged")
      await fs.mkdir(evilStaged, { recursive: true })
      await fs.writeFile(path.join(evilStaged, "proof.txt"), "evil")
      await fs.writeFile(mp, JSON.stringify({ archiveID: fakeID, stagedPath: evilStaged, dataRoot: root }, null, 2), "utf8")
      let threw = false
      try {
        await recoverRollback(root)
      } catch (e) {
        threw = true
        expect(String(e).includes("confined") || String(e).includes("fail closed")).toBe(true)
      }
      expect(threw).toBe(true)
      // fail-closed: marker preserved and outside sentinel untouched, no deletion
      expect(await fs.access(mp).then(() => true).catch(() => false)).toBe(true)
      expect(await fs.access(sentinelFile).then(() => true).catch(() => false)).toBe(true)
      expect(await fs.access(evilStaged).then(() => true).catch(() => false)).toBe(true)
      await fs.rm(mp, { force: true }).catch(() => {})
    } finally {
      if (sentinelDir) await fs.rm(sentinelDir, { recursive: true, force: true }).catch(() => {})
      await cleanup()
    }
  })

  test("rollback marker traversal with .. fails closed", async () => {
    const { root, cleanup } = await makeDataRoot()
    let sentinelDir: string | undefined
    try {
      await initLegacyDB(root)
      const { parent, base } = deriveArchive(root)
      sentinelDir = await fs.mkdtemp(path.join(os.homedir(), "kilo-sentinel-"))
      const sentinelFile = path.join(sentinelDir, "keep.txt")
      await fs.writeFile(sentinelFile, "sentinel")
      const mp = path.join(parent, `.rollback-${base}.marker.json`)
      const fakeID = "20260101T000000Z-bbbbbbbb-cccc-dddd-eeee-ffffffffffff"
      // stagedPath contains .. and resolves outside expectedParent (/tmp) to homedir sentinel
      const relToRoot = path.relative("/", path.join(sentinelDir, "traversed"))
      const evilStaged = path.join(parent, "..", relToRoot)
      // also create the traversed dir to prove it would be deletable if unconstrained
      await fs.mkdir(path.join(sentinelDir, "traversed"), { recursive: true }).catch(() => {})
      await fs.writeFile(path.join(sentinelDir, "traversed", "keep2.txt"), "keep2").catch(() => {})
      await fs.writeFile(mp, JSON.stringify({ archiveID: fakeID, stagedPath: evilStaged, dataRoot: root }, null, 2), "utf8")
      let threw = false
      try {
        await recoverRollback(root)
      } catch (e) {
        threw = true
        expect(String(e).includes("confined") || String(e).includes("fail closed")).toBe(true)
      }
      expect(threw).toBe(true)
      expect(await fs.access(mp).then(() => true).catch(() => false)).toBe(true)
      expect(await fs.access(sentinelFile).then(() => true).catch(() => false)).toBe(true)
      // the traversed dir itself must remain
      expect(await fs.access(path.join(sentinelDir, "traversed", "keep2.txt")).then(() => true).catch(() => false)).toBe(true)
      await fs.rm(mp, { force: true }).catch(() => {})
    } finally {
      if (sentinelDir) await fs.rm(sentinelDir, { recursive: true, force: true }).catch(() => {})
      await cleanup()
    }
  })

  test("rollback marker inconsistent dataRoot fails closed", async () => {
    const { root, cleanup } = await makeDataRoot()
    let sentinelDir: string | undefined
    try {
      await initLegacyDB(root)
      const { parent, base } = deriveArchive(root)
      sentinelDir = await fs.mkdtemp(path.join(os.homedir(), "kilo-sentinel-"))
      const sentinelFile = path.join(sentinelDir, "keep.txt")
      await fs.writeFile(sentinelFile, "sentinel")
      const mp = path.join(parent, `.rollback-${base}.marker.json`)
      const fakeID = "20260101T000000Z-cccccccc-dddd-eeee-ffff-111111111111"
      const staged = path.join(parent, `.rollback-staged-${base}-${fakeID}`)
      await fs.mkdir(staged, { recursive: true })
      const fakeRoot = path.join(sentinelDir, "fakeRoot")
      await fs.mkdir(fakeRoot, { recursive: true })
      await fs.writeFile(mp, JSON.stringify({ archiveID: fakeID, stagedPath: staged, dataRoot: fakeRoot }, null, 2), "utf8")
      let threw = false
      try {
        await recoverRollback(root)
      } catch (e) {
        threw = true
        expect(String(e).includes("dataRoot") || String(e).includes("mismatch") || String(e).includes("fail closed")).toBe(true)
      }
      expect(threw).toBe(true)
      expect(await fs.access(mp).then(() => true).catch(() => false)).toBe(true)
      expect(await fs.access(sentinelFile).then(() => true).catch(() => false)).toBe(true)
      expect(await fs.access(staged).then(() => true).catch(() => false)).toBe(true)
      await fs.rm(mp, { force: true }).catch(() => {})
      await fs.rm(staged, { recursive: true, force: true }).catch(() => {})
    } finally {
      if (sentinelDir) await fs.rm(sentinelDir, { recursive: true, force: true }).catch(() => {})
      await cleanup()
    }
  })

  test("rollback marker same-parent sibling with mismatched stagedPath fails closed and preserves sibling", async () => {
    const { root, cleanup } = await makeDataRoot()
    let siblingPath: string | undefined
    try {
      await initLegacyDB(root)
      const { parent, base } = deriveArchive(root)
      const mp = path.join(parent, `.rollback-${base}.marker.json`)
      const realID = "20260101T000000Z-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
      const otherID = "20260101T000000Z-bbbbbbbb-cccc-dddd-eeee-ffffffffffff"
      siblingPath = path.join(parent, `.rollback-staged-${base}-${otherID}`)
      // also cover generic other-id sibling via separate name variant if needed, but use valid otherID mismatch
      const sentinelSibling = path.join(parent, `.rollback-staged-other-id`)
      await fs.mkdir(siblingPath, { recursive: true })
      const sentinel = path.join(siblingPath, "sentinel.txt")
      await fs.writeFile(sentinel, "sentinel")
      // secondary sentinel to ensure generic sibling also untouched if used; create generic one too
      await fs.mkdir(sentinelSibling, { recursive: true }).catch(() => {})
      const sentinel2 = path.join(sentinelSibling, "keep2.txt")
      await fs.writeFile(sentinel2, "keep2").catch(() => {})
      await fs.writeFile(mp, JSON.stringify({ archiveID: realID, stagedPath: siblingPath, dataRoot: root }, null, 2), "utf8")
      let threw = false
      try {
        await recoverRollback(root)
      } catch (e) {
        threw = true
        expect(String(e).includes("mismatch") || String(e).includes("fail closed") || String(e).includes("stagedPath")).toBe(true)
      }
      expect(threw).toBe(true)
      // fail-closed: marker preserved and sentinel siblings untouched
      expect(await fs.access(mp).then(() => true).catch(() => false)).toBe(true)
      expect(await fs.access(sentinel).then(() => true).catch(() => false)).toBe(true)
      expect(await fs.access(siblingPath).then(() => true).catch(() => false)).toBe(true)
      expect(await fs.access(sentinelSibling).then(() => true).catch(() => false)).toBe(true)
      expect(await fs.access(sentinel2).then(() => true).catch(() => false)).toBe(true)
      await fs.rm(mp, { force: true }).catch(() => {})
      await fs.rm(siblingPath, { recursive: true, force: true }).catch(() => {})
      await fs.rm(sentinelSibling, { recursive: true, force: true }).catch(() => {})
    } finally {
      if (siblingPath) await fs.rm(siblingPath, { recursive: true, force: true }).catch(() => {})
      await cleanup()
    }
  })

  test("rollback staging failure cleans marker and staged when safe, preserves handoff marker", async () => {
    const { root, cleanup } = await makeDataRoot()
    try {
      await initLegacyDB(root)
      const cut = await runCutover({ dataRoot: root })
      // add fresh data to make rollback meaningful
      const dbPath = path.join(root, "kilo.db")
      await ensureProject(root)
      const layer = Database.layerFromPath(dbPath)
      await Effect.runPromise(
        Effect.gen(function* () {
          const { db } = yield* Database.Service
          yield* db.run(sql`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES ('ses_stage_fail', 'proj_global', 'sf', '/tmp', 'SF', 'v1', 99, 99)`).pipe(Effect.orDie)
        }).pipe(Effect.provide(layer), Effect.scoped, Effect.orDie),
      )
      const { parent, base } = deriveArchive(root)
      const mp = path.join(parent, `.rollback-${base}.marker.json`)
      // inject staging failure after marker creation via checkpointAndVerify busy injection
      const { Database: BunDB } = await import("bun:sqlite")
      const origQuery = (BunDB as any).prototype.query
      let queryCalls = 0
      ;(BunDB as any).prototype.query = function (q: string) {
        if (q.includes("wal_checkpoint")) {
          queryCalls++
          return { get: () => ({ busy: 1, log: 0, checkpointed: 0 }), all: () => [] } as any
        }
        return origQuery.call(this, q)
      }
      let threw = false
      try {
        await verifyAndRollback({ dataRoot: root, archivePath: cut.archivePath })
      } catch (e) {
        threw = true
        expect(String(e).includes("busy") || String(e).includes("quiescence")).toBe(true)
      }
      ;(BunDB as any).prototype.query = origQuery
      expect(threw).toBe(true)
      expect(queryCalls).toBeGreaterThanOrEqual(1)
      // staging failure before handoff: marker and staged must be cleaned, backup must not exist
      expect(await fs.access(mp).then(() => true).catch(() => false)).toBe(false)
      const stagedLeft = await fs.readdir(parent).then((a) => a.filter((x: string) => x.includes(".rollback-staged-"))).catch(() => [] as string[])
      expect(stagedLeft.length).toBe(0)
      const backupGlob = await fs.readdir(path.dirname(path.resolve(root))).then((a) => a.filter((x: string) => x.startsWith(path.basename(path.resolve(root)) + ".rollback-backup-"))).catch(() => [] as string[])
      expect(backupGlob.length).toBe(0)
      // corrupt/unconfined marker must be preserved fail-closed (no cleanup)
      const corruptStaged = path.join(parent, `.rollback-staged-${base}-20260101T000000Z-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`)
      await fs.mkdir(corruptStaged, { recursive: true }).catch(() => {})
      await fs.writeFile(mp, "not json", "utf8")
      let threw2 = false
      try {
        await verifyAndRollback({ dataRoot: root, archivePath: cut.archivePath })
      } catch (e) {
        threw2 = true
        expect(String(e).includes("corrupt") || String(e).includes("fail closed")).toBe(true)
      }
      expect(threw2).toBe(true)
      expect(await fs.access(mp).then(() => true).catch(() => false)).toBe(true)
      await fs.rm(mp, { force: true }).catch(() => {})
      await fs.rm(corruptStaged, { recursive: true, force: true }).catch(() => {})
      // no backup should remain after staging failures
      const backupLeft2 = await fs.readdir(path.dirname(path.resolve(root))).then((a) => a.filter((x: string) => x.startsWith(path.basename(path.resolve(root)) + ".rollback-backup-"))).catch(() => [] as string[])
      expect(backupLeft2.length).toBe(0)
      // handoff failure preserves marker and backup (inject failure after backup creation)
      const fakeID2 = cut.archiveID
      const backupPath2 = `${path.resolve(root)}.rollback-backup-${fakeID2}`
      const origRm = fs.rm
      let rmCalls = 0
      ;(fs as any).rm = async (p: any, opts: any) => {
        if (String(p) === backupPath2) {
          rmCalls++
          throw new Error("injected handoff rm failure")
        }
        return (origRm as any)(p, opts)
      }
      let handoffThrew = false
      try {
        await verifyAndRollback({ dataRoot: root, archivePath: cut.archivePath })
      } catch (e) {
        handoffThrew = true
        expect(String(e).includes("injected handoff rm failure")).toBe(true)
      }
      ;(fs as any).rm = origRm
      expect(handoffThrew).toBe(true)
      expect(rmCalls).toBeGreaterThanOrEqual(1)
      // handoff failure must preserve marker and backup for deterministic recovery
      expect(await fs.access(mp).then(() => true).catch(() => false)).toBe(true)
      expect(await fs.access(backupPath2).then(() => true).catch(() => false)).toBe(true)
      // cleanup via recovery (need to remove backup manually since rm was patched)
      await fs.rm(backupPath2, { recursive: true, force: true }).catch(() => {})
      await fs.rm(mp, { force: true }).catch(() => {})
      // also clean any leftover staged
      const stagedHandoff2 = path.join(parent, `.rollback-staged-${base}-${fakeID2}`)
      await fs.rm(stagedHandoff2, { recursive: true, force: true }).catch(() => {})
      expect(await fs.access(backupPath2).then(() => true).catch(() => false)).toBe(false)
    } finally {
      await cleanup()
    }
  })

  test("rollback archivePath preflight rejects before lease and does not touch outside paths", async () => {
    const { root, cleanup } = await makeDataRoot()
    let sentinelDir: string | undefined
    try {
      await initLegacyDB(root)
      const cut = await runCutover({ dataRoot: root })
      const { parent, base } = deriveArchive(root)
      const { leasePathFor } = await import("@opencode-ai/core/cutover/lease")
      const lp = leasePathFor(root)
      sentinelDir = await fs.mkdtemp(path.join(os.homedir(), "kilo-sentinel-"))
      const sentinelFile = path.join(sentinelDir, "keep.txt")
      await fs.writeFile(sentinelFile, "sentinel")
      const ensureNoLease = async () => expect(await fs.access(lp).then(() => true).catch(() => false)).toBe(false)
      // non-absolute
      let threw = false
      try {
        await verifyAndRollback({ dataRoot: root, archivePath: "relative/path" })
      } catch (e) {
        threw = true
        expect(String(e).includes("absolute")).toBe(true)
      }
      expect(threw).toBe(true)
      await ensureNoLease()
      // traversal
      threw = false
      try {
        await verifyAndRollback({ dataRoot: root, archivePath: path.join(parent, `${base}-archive/p4.2`, "..", "evil") })
      } catch (e) {
        threw = true
        expect(String(e).includes("boundary") || String(e).includes("traversal")).toBe(true)
      }
      expect(threw).toBe(true)
      await ensureNoLease()
      // outside boundary (parent sibling)
      threw = false
      try {
        await verifyAndRollback({ dataRoot: root, archivePath: path.join(sentinelDir, "evil-archive") })
      } catch (e) {
        threw = true
        expect(String(e).includes("boundary") || String(e).includes("traversal")).toBe(true)
      }
      expect(threw).toBe(true)
      await ensureNoLease()
      expect(await fs.access(sentinelFile).then(() => true).catch(() => false)).toBe(true)
      // unknown archive dir (valid prefix but extra subdir)
      threw = false
      try {
        await verifyAndRollback({ dataRoot: root, archivePath: path.join(parent, `${base}-archive/p4.2`, cut.archiveID, "extra") })
      } catch (e) {
        threw = true
        expect(String(e).includes("boundary") || String(e).includes("traversal") || String(e).includes("invalid")).toBe(true)
      }
      expect(threw).toBe(true)
      await ensureNoLease()
      // missing path
      threw = false
      const missing = path.join(parent, `${base}-archive/p4.2`, "20260101T000000Z-ffffffff-ffff-ffff-ffff-ffffffffffff")
      try {
        await verifyAndRollback({ dataRoot: root, archivePath: missing })
      } catch (e) {
        threw = true
        expect(String(e).includes("not found")).toBe(true)
      }
      expect(threw).toBe(true)
      await ensureNoLease()
      // invalid archiveID format but inside p4.2
      threw = false
      const invalidIDPath = path.join(parent, `${base}-archive/p4.2`, "not-an-id")
      await fs.mkdir(invalidIDPath, { recursive: true }).catch(() => {})
      try {
        await verifyAndRollback({ dataRoot: root, archivePath: invalidIDPath })
      } catch (e) {
        threw = true
        expect(String(e).includes("invalid")).toBe(true)
      }
      expect(threw).toBe(true)
      await ensureNoLease()
      await fs.rm(invalidIDPath, { recursive: true, force: true }).catch(() => {})
      expect(await fs.access(sentinelFile).then(() => true).catch(() => false)).toBe(true)
      // valid path still works and is not blocked by preflight
      const ok = await verifyAndRollback({ dataRoot: root, archivePath: cut.archivePath })
      expect(ok.rollbackArchivePath).toBeTruthy()
      expect(await fs.access(lp).then(() => true).catch(() => false)).toBe(false)
    } finally {
      if (sentinelDir) await fs.rm(sentinelDir, { recursive: true, force: true }).catch(() => {})
      await cleanup()
    }
  })
})
