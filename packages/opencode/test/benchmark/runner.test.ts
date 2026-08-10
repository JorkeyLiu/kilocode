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
 *     failed runs, and early throws (unknown scenario id).
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
import { runCampaign, runStatus } from "./runner"
import { registerBenchmarkEnv, runRoot, systemTmp } from "./environment"

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

      const samples = lines.filter((line) => line.kind === "sample")
      expect(samples).toHaveLength(2)
      expect(samples.map((line) => line.phase as string).sort()).toEqual(["measured", "warmup"])
      expect(samples.every((line) => line.ok)).toBe(true)

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
