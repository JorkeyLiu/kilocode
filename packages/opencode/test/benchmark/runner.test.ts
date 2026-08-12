/**
 * Focused runner/JSONL contract tests for the backend P0 benchmark campaign.
 *
 * Covers, through the production seam (`runCampaign` boots the real
 * Server.listen/AppLayer listener + loopback LLM exactly like the CLI):
 *   - warmup samples are excluded from summaries (`n` counts successful
 *     measured samples only),
 *   - summary lines carry truthful per-metric units (ms / bytes/ms / count),
 *   - run status/failure propagation (a failed measured sample → failed run),
 *   - cleanup on failure: the run root is removed after successful runs,
 *     failed runs, and early throws (unknown scenario id),
 *   - git provenance (`gitState`) clean/dirty/commit detection is verified
 *     against a run-owned temp git repo — never the real worktree — and the
 *     emitted JSONL carries gitCommit/gitDirty on both sample and run records.
 *
 * The JSONL artifact is written to the real system temp (outside the run-owned
 * root, which is removed by runCampaign) and cleaned up by this file.
 */

import "./environment"
import { afterAll, describe, expect, it } from "bun:test"
import * as Log from "@opencode-ai/core/util/log"
import fs from "node:fs"
import path from "node:path"
import { run, bootBackend } from "./backend"
import { runCampaign, runStatus, gitState, sampleEnv, envFor } from "./runner"
import { registerBenchmarkEnv, runRoot, systemTmp } from "./environment"
import { tmpdir } from "../fixture/fixture"

await Log.init({ print: true })

const outPath = (tag: string) => path.join(systemTmp, "kilo-p0-results", `runner-test-${tag}-${process.pid}.jsonl`)
const outs: string[] = []

afterAll(async () => {
  await Promise.all(outs.map((file) => fs.promises.rm(file, { force: true }).catch(() => undefined)))
})

// Last hook: once every benchmark file has finished, restore the pre-load env
// and remove the run root so later files in this `bun test` process never
// inherit removed runRoot paths.
afterAll(registerBenchmarkEnv())

const readLines = async (out: string): Promise<Array<Record<string, unknown>>> =>
  (await Bun.file(out).text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>)

describe("runner run status", () => {
  it("maps measured failure counts onto ok/partial/failed", () => {
    expect(runStatus(0, 3)).toBe("ok")
    expect(runStatus(1, 3)).toBe("partial")
    expect(runStatus(3, 3)).toBe("failed")
  })
})

describe("runner git provenance", () => {
  it(
    "gitState reports commit + short head and clean in a fresh git repo",
    async () => {
      await using tmp = await tmpdir({ git: true })
      const state = gitState(tmp.path)
      expect(state.gitHead).toBeTruthy()
      expect(state.gitCommit).toMatch(/^[0-9a-f]{40}$/)
      expect(state.gitHead).toBe(state.gitCommit!.slice(0, state.gitHead!.length))
      expect(state.gitDirty).toBe(false)
    },
    30_000,
  )

  it(
    "gitState reports dirty when the repo has uncommitted/untracked changes",
    async () => {
      await using tmp = await tmpdir({ git: true })
      await Bun.write(path.join(tmp.path, "untracked.txt"), "dirty")
      expect(gitState(tmp.path).gitDirty).toBe(true)
    },
    30_000,
  )

  it("gitState reports null commit/head and dirty for a non-git directory", async () => {
    await using tmp = await tmpdir()
    const state = gitState(tmp.path)
    expect(state.gitHead).toBeNull()
    expect(state.gitCommit).toBeNull()
    expect(state.gitDirty).toBe(true)
  })

  it("sampleEnv carries the explicit commit alias and dirty flag", () => {
    const env = sampleEnv()
    expect(env.gitCommit).toMatch(/^[0-9a-f]{40}$/)
    expect(env.gitHead).toBeTruthy()
    expect(typeof env.gitDirty).toBe("boolean")
    expect(env.os).toBe(process.platform)
  })

  it(
    "envFor freezes clean provenance before self-output creation flips the tree",
    async () => {
      // The evidence dir is NOT gitignored, so a campaign that writes output
      // inside the repo makes the tree technically dirty afterwards. The
      // recorded provenance must be captured BEFORE artifact creation and stay
      // frozen — a clean campaign records gitDirty=false even though the
      // artifact is now visible to git.
      await using repo = await tmpdir({ git: true })
      const frozen = envFor(repo.path)
      expect(frozen.gitDirty).toBe(false)
      expect(frozen.gitCommit).toMatch(/^[0-9a-f]{40}$/)
      await fs.promises.writeFile(path.join(repo.path, "backend.jsonl"), "x\n")
      // The physical tree flipped dirty (self-output is visible to git)...
      expect(gitState(repo.path).gitDirty).toBe(true)
      // ...but the frozen provenance captured before creation stays clean.
      expect(frozen.gitDirty).toBe(false)
    },
    30_000,
  )
})

describe("runner campaign (production seam)", () => {
  it(
    "writes a complete JSONL artifact with warmup exclusion and cleans the run root",
    async () => {
      const out = outPath("ok")
      outs.push(out)
      const result = await runCampaign({ scenarios: ["6"], samples: 1, warmup: 1, out })
      expect(result.status).toBe("ok")
      expect(result.failures).toBe(0)
      expect(result.warmupFailures).toBe(0)
      // runCampaign removes the run-owned root on success.
      expect(fs.existsSync(runRoot)).toBe(false)

      const lines = await readLines(out)
      expect(lines[0]?.kind).toBe("run")
      expect(lines[0]?.event).toBe("start")
      expect(lines.at(-1)?.kind).toBe("run")
      expect(lines.at(-1)?.event).toBe("finish")
      expect(lines.at(-1)?.status).toBe("ok")
      // Both run-envelope records carry campaign provenance (commit/head/dirty).
      const env = (lines[0]?.env ?? {}) as Record<string, unknown>
      expect(lines.at(-1)?.env).toEqual(lines[0]?.env)
      expect(env.gitCommit).toMatch(/^[0-9a-f]{40}$/)
      expect(env.gitHead).toBeTruthy()
      expect(typeof env.gitDirty).toBe("boolean")

      const samples = lines.filter((line) => line.kind === "sample")
      expect(samples).toHaveLength(2)
      expect(samples.map((line) => line.phase as string).sort()).toEqual(["measured", "warmup"])
      expect(samples.every((line) => line.ok)).toBe(true)
      // Every measured sample's provenance is unambiguous.
      for (const sample of samples) {
        const sampleEnv = (sample.env ?? {}) as Record<string, unknown>
        expect(sampleEnv.gitCommit).toMatch(/^[0-9a-f]{40}$/)
        expect(typeof sampleEnv.gitDirty).toBe("boolean")
        expect(sampleEnv.boot).toContain("Server.listen/AppLayer")
        expect(Array.isArray(sample.failures)).toBe(true)
      }

      const summaries = lines.filter((line) => line.kind === "summary")
      expect(summaries.length).toBeGreaterThan(0)
      const totalMs = summaries.find((line) => line.metric === "totalMs")
      expect(totalMs?.unit).toBe("ms")
      expect(totalMs?.n).toBe(1) // warmup excluded: n counts successful measured samples only
      expect(totalMs?.scenario).toBe("6")
      // First-span stage metrics carry explicit occurrence semantics.
      const boot = summaries.find((line) => line.metric === "firstInstanceBootstrapMs")
      expect(boot?.unit).toBe("ms")
      expect(boot?.n).toBe(1)
      for (const line of summaries) {
        expect(["ms", "bytes", "bytes/ms", "count"]).toContain(line.unit as string)
        expect(line.n).toBe(1)
      }
    },
    120_000,
  )

  it(
    "propagates a failed measured sample to run status and cleans the run root",
    async () => {
      const out = outPath("fail")
      outs.push(out)
      // Scenario 6 always queues its own "first answer" reply, so to make the
      // measured sample fail deterministically we inject an earlier queued
      // reply through the shared LLM server seam: the prompt consumes it (FIFO)
      // and scenario 6's content assertion rejects it as not the queued reply.
      const backend = await bootBackend()
      await run(backend.llm.text("interfering reply"))
      const result = await runCampaign({ scenarios: ["6"], samples: 1, warmup: 0, out })
      expect(result.status).toBe("failed")
      expect(result.failures).toBe(1)
      expect(fs.existsSync(runRoot)).toBe(false)

      const lines = await readLines(out)
      const sample = lines.find((line) => line.kind === "sample")
      expect(sample?.ok).toBe(false)
      expect((sample?.failures as string[]).join(" ")).toContain("first answer")
      const finish = lines.at(-1)
      expect(finish?.kind).toBe("run")
      expect(finish?.event).toBe("finish")
      expect(finish?.status).toBe("failed")
      expect(finish?.failures).toBe(1)
    },
    120_000,
  )

  it(
    "rejects unknown scenarios before booting and cleans the run root",
    async () => {
      const out = outPath("bad")
      outs.push(out)
      await expect(runCampaign({ scenarios: ["nope"], samples: 1, warmup: 0, out })).rejects.toThrow(
        "unknown scenario id nope",
      )
      // The run-owned root (created at module load) is removed even though the
      // campaign never reached the sample loop.
      expect(fs.existsSync(runRoot)).toBe(false)
    },
    60_000,
  )
})
