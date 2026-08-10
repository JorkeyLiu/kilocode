import { describe, expect, it } from "bun:test"
import { lifecycleTeardownSteps, runCleanupSteps } from "../../script/p0-bench/parse"

describe("p0 ordered teardown (runCleanupSteps)", () => {
  it("runs every cleanup step even when earlier steps throw", async () => {
    const order: string[] = []
    const notes = await runCleanupSteps([
      {
        label: "done marker",
        run: () => {
          order.push("done marker")
          throw new Error("done write failed")
        },
      },
      {
        label: "browser close",
        run: () => {
          order.push("browser close")
          throw new Error("cdp socket error")
        },
      },
      {
        label: "capture stop",
        run: () => {
          order.push("capture stop")
        },
      },
      {
        label: "cleanup",
        run: () => {
          order.push("cleanup")
        },
      },
    ])
    expect(order).toEqual(["done marker", "browser close", "capture stop", "cleanup"])
    expect(notes).toEqual(["done marker: done write failed", "browser close: cdp socket error"])
  })

  it("collects both sync and async step failures as labeled notes", async () => {
    const notes = await runCleanupSteps([
      { label: "ok", run: () => undefined },
      {
        label: "async fail",
        run: async () => {
          throw new Error("nope")
        },
      },
    ])
    expect(notes).toEqual(["async fail: nope"])
  })

  it("returns no notes when every step succeeds", async () => {
    const notes = await runCleanupSteps([
      { label: "a", run: () => undefined },
      { label: "b", run: async () => undefined },
    ])
    expect(notes).toEqual([])
  })

  it("composes the real lifecycle teardown in the exact order and runs every step", async () => {
    const order: string[] = []
    const steps = lifecycleTeardownSteps({
      writeDone: () => {
        order.push("done marker")
        throw new Error("done write failed")
      },
      closeBrowser: () => {
        order.push("browser close")
        throw new Error("cdp socket error")
      },
      stopCapture: () => {
        order.push("capture stop")
        return {
          text: "raw-tail",
          totalBytes: 8,
          retainedBytes: 8,
          truncated: true,
          records: { stages: [], cliPath: null, spawnedPid: null },
        }
      },
      markTruncated: (truncated) => {
        order.push(`mark truncated=${truncated}`)
      },
      writeRawLog: (text) => {
        order.push(`raw log write ${text}`)
        throw new Error("raw log write failed: disk full")
      },
      waitExit: async () => {
        order.push("VS Code exit")
        return false
      },
      onExitResult: (exited) => {
        order.push(`exit ok=${exited}`)
      },
      cleanup: () => {
        order.push("cleanup")
      },
    })
    // Structural check: the exact-ordered lifecycle teardown plan.
    expect(steps.map((s) => s.label)).toEqual([
      "done marker",
      "browser close",
      "capture stop",
      "raw log write",
      "VS Code exit",
      "cleanup",
    ])
    // A raw-log write failure surfaces as a labeled teardown note (evidence
    // loss is visible) while every later step still runs.
    const notes = await runCleanupSteps(steps)
    expect(order).toEqual([
      "done marker",
      "browser close",
      "capture stop",
      "mark truncated=true",
      "raw log write raw-tail",
      "VS Code exit",
      "exit ok=false",
      "cleanup",
    ])
    expect(notes).toEqual([
      "done marker: done write failed",
      "browser close: cdp socket error",
      "raw log write: raw log write failed: disk full",
    ])
  })
})
