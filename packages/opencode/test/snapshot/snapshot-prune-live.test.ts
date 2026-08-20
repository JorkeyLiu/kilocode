import { expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { AppProcess } from "@opencode-ai/core/process"
import { KiloSnapshotMaterialize } from "../../src/kilocode/snapshot/materialize"
import * as Artifact from "@opencode-ai/core/retention/artifact"
import { tmpdir } from "../fixture/fixture"
import { $ } from "bun"

test("prune retains aged live ref and deletes aged unreferenced ref", async () => {
  await using tmp = await tmpdir()
  const gitdir = path.join(tmp.path, "snap.git")
  await $`git init --bare ${gitdir}`.quiet()
  const liveFile = path.join(tmp.path, "live.txt")
  const deadFile = path.join(tmp.path, "dead.txt")
  await fs.writeFile(liveFile, "live\n")
  await fs.writeFile(deadFile, "dead\n")
  const realLive = (await $`git --git-dir=${gitdir} hash-object -w ${liveFile}`.text()).trim()
  const realDead = (await $`git --git-dir=${gitdir} hash-object -w ${deadFile}`.text()).trim()
  expect(realLive).toBeTruthy()
  expect(realDead).toBeTruthy()
  expect(realLive).not.toBe(realDead)
  const liveOld = `refs/kilo/snapshots/1/${realLive}`
  const deadOld = `refs/kilo/snapshots/1/${realDead}`
  const recentLive = `refs/kilo/snapshots/${Date.now()}/${realLive}`
  await $`git --git-dir=${gitdir} update-ref ${liveOld} ${realLive}`.quiet()
  await $`git --git-dir=${gitdir} update-ref ${deadOld} ${realDead}`.quiet()
  await $`git --git-dir=${gitdir} update-ref ${recentLive} ${realLive}`.quiet()
  const beforeProc = Bun.spawn(["git", "--git-dir", gitdir, "for-each-ref", "--format=%(refname)", "refs/kilo/snapshots"], { stdout: "pipe" })
  await beforeProc.exited
  const before = (await new Response(beforeProc.stdout).text()).trim()
  expect(before).toContain(liveOld)
  expect(before).toContain(deadOld)
  const liveSet = new Set([realLive])
  await Effect.runPromise(
    Effect.gen(function* () {
      const fsUtil = yield* FSUtil.Service
      const proc = yield* AppProcess.Service
      const g = (cmd: string[], opts?: { stdin?: string }) =>
        proc
          .run(ChildProcess.make("git", cmd, { extendEnv: true }), { stdin: opts?.stdin })
          .pipe(
            Effect.map((r) => ({
              code: r.exitCode,
              text: r.stdout.toString("utf8"),
              stderr: r.stderr.toString("utf8"),
            })),
            Effect.catch(() => Effect.succeed({ code: 1 as const, text: "", stderr: "" })),
          )
      const gitFn = (cmd: string[], opts?: { stdin?: string }) => g(cmd, opts)
      const ok = yield* KiloSnapshotMaterialize.prune({ gitdir, git: gitFn, fs: fsUtil }, Date.now() - 7 * 24 * 60 * 60 * 1000, liveSet)
      expect(ok).toBe(true)
    }).pipe(Effect.provide(Layer.mergeAll(FSUtil.defaultLayer, AppProcess.defaultLayer))),
  )
  const liveProc = Bun.spawn(["git", "--git-dir", gitdir, "rev-parse", "--verify", "--quiet", liveOld], { stdout: "pipe" })
  await liveProc.exited
  const liveAfter = (await new Response(liveProc.stdout).text()).trim()
  const deadProc = Bun.spawn(["git", "--git-dir", gitdir, "rev-parse", "--verify", "--quiet", deadOld], { stdout: "pipe" })
  await deadProc.exited
  const deadAfter = (await new Response(deadProc.stdout).text()).trim()
  const recentProc = Bun.spawn(["git", "--git-dir", gitdir, "rev-parse", "--verify", "--quiet", recentLive], { stdout: "pipe" })
  await recentProc.exited
  const recentAfter = (await new Response(recentProc.stdout).text()).trim()
  expect(liveAfter).toBe(realLive)
  expect(deadAfter).toBe("")
  expect(recentAfter).toBe(realLive)
  const catProc = Bun.spawn(["git", "--git-dir", gitdir, "cat-file", "-e", realLive], { stdout: "pipe", stderr: "pipe" })
  await catProc.exited
  expect(catProc.exitCode).toBe(0)
})

test("snapshot remains project-owned outside family artifact enumeration", async () => {
  const family = Artifact.familyArtifactsForFamily(["ses_abc123"])
  expect(family.some((k) => k[0] === "snapshot")).toBe(false)
  expect(Artifact.isFamilyKind("snapshot")).toBe(false)
  const entry = Artifact.get("snapshot")
  expect(entry?.owner).toBe("project")
  expect(entry?.retention).toBe("project")
  expect(Artifact.familyKinds()).not.toContain("snapshot")
})

test("prune without live set deletes all aged refs (baseline)", async () => {
  await using tmp = await tmpdir()
  const gitdir = path.join(tmp.path, "snap2.git")
  await $`git init --bare ${gitdir}`.quiet()
  const file = path.join(tmp.path, "x.txt")
  await fs.writeFile(file, "x\n")
  const hash = (await $`git --git-dir=${gitdir} hash-object -w ${file}`.text()).trim()
  const oldRef = `refs/kilo/snapshots/1/${hash}`
  await $`git --git-dir=${gitdir} update-ref ${oldRef} ${hash}`.quiet()
  const checkProc = Bun.spawn(["git", "--git-dir", gitdir, "rev-parse", "--verify", "--quiet", oldRef], { stdout: "pipe" })
  await checkProc.exited
  expect((await new Response(checkProc.stdout).text()).trim()).toBe(hash)
  await Effect.runPromise(
    Effect.gen(function* () {
      const fsUtil = yield* FSUtil.Service
      const proc = yield* AppProcess.Service
      const g = (cmd: string[], opts?: { stdin?: string }) =>
        proc
          .run(ChildProcess.make("git", cmd, { extendEnv: true }), { stdin: opts?.stdin })
          .pipe(
            Effect.map((r) => ({
              code: r.exitCode,
              text: r.stdout.toString("utf8"),
              stderr: r.stderr.toString("utf8"),
            })),
            Effect.catch(() => Effect.succeed({ code: 1 as const, text: "", stderr: "" })),
          )
      const gitFn = (cmd: string[], opts?: { stdin?: string }) => g(cmd, opts)
      const ok = yield* KiloSnapshotMaterialize.prune({ gitdir, git: gitFn, fs: fsUtil }, Date.now() - 1000)
      expect(ok).toBe(true)
    }).pipe(Effect.provide(Layer.mergeAll(FSUtil.defaultLayer, AppProcess.defaultLayer))),
  )
  const afterProc = Bun.spawn(["git", "--git-dir", gitdir, "rev-parse", "--verify", "--quiet", oldRef], { stdout: "pipe" })
  await afterProc.exited
  expect((await new Response(afterProc.stdout).text()).trim()).toBe("")
})
