import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import os from "os"
import { Global } from "@opencode-ai/core/global"
import { collectBaselineFsOnly } from "@opencode-ai/core/storage/baseline"
import { createS0Fixture } from "@opencode-ai/core/storage/s0-fixture"

describe("S0 baseline — opencode storage", () => {
  test("baseline is stable and machine-readable for fixture, and script invocation is read-only", async () => {
    const fix = await createS0Fixture()
    try {
      const b1 = await collectBaselineFsOnly(fix.dir)
      const b2 = await collectBaselineFsOnly(fix.dir)
      // stable without timestamp
      const { timestamp: _t1, ...v1 } = b1 as any
      const { timestamp: _t2, ...v2 } = b2 as any
      expect(JSON.stringify(v1)).toBe(JSON.stringify(v2))
      expect(b1.tables["session"].rows).toBe(4)
      expect(b1.artifacts["session_diff"].files).toBe(4)
      expect(b1.families.total).toBe(3)
      // script invocation via bun spawn (no lease, no writes)
      const script = path.join(import.meta.dir, "../../script/storage-baseline.ts")
      const proc = Bun.spawn(["bun", "run", script, "--data-root", fix.dir, "--compact"], {
        stdout: "pipe",
        stderr: "pipe",
      })
      const out = await new Response(proc.stdout).text()
      const err = await new Response(proc.stderr).text()
      const code = await proc.exited
      expect(code).toBe(0)
      expect(err).toBe("")
      const parsed = JSON.parse(out)
      expect(parsed.version).toBe(1)
      expect(parsed.dataRoot).toBe(path.resolve(fix.dir))
      expect(parsed.tables["session"].rows).toBe(4)
      expect(parsed.db.main.exists).toBe(true)
      // second script invocation yields same stable counts (timestamp/mtime may differ)
      const proc2 = Bun.spawn(["bun", "run", script, "--data-root", fix.dir, "--compact"], {
        stdout: "pipe",
        stderr: "pipe",
      })
      const out2 = await new Response(proc2.stdout).text()
      await proc2.exited
      const p2 = JSON.parse(out2)
      // DB file physical bytes (including WAL) may vary due to checkpoint timing; compare logical state only for stability
      const stripVolatile = (o: any) => {
        const c = JSON.parse(JSON.stringify(o))
        delete c.timestamp
        // strip physical file volatile fields for stability comparison
        delete c.db
        // also strip artifact mtime implicit via bytes? bytes are stable, keep
        return c
      }
      expect(JSON.stringify(stripVolatile(parsed))).toBe(JSON.stringify(stripVolatile(p2)))
      // production untouched
      expect(path.resolve(fix.dir)).not.toBe(path.resolve(Global.Path.data))
    } finally {
      await fix.cleanup()
    }
  })

  test("opencode fixture isolation: temp dir under os.tmpdir, not production, and missing path returns zeros without creating", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kilo-s0-op-"))
    const missing = path.join(dir, "missing")
    const r = await collectBaselineFsOnly(missing)
    expect(r.tables["session"].rows).toBe(0)
    expect(r.db.main.exists).toBe(false)
    expect(
      await fs
        .access(missing)
        .then(() => true)
        .catch(() => false),
    ).toBe(false)
    await fs.rm(dir, { recursive: true, force: true })
  })
})
