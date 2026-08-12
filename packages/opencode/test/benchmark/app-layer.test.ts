/**
 * Focused P0 test for the module-load AppLayer construction spans
 * (`app_layer_define` / `app_runtime_make` in src/effect/app-runtime.ts).
 *
 * The spans fire once when `effect/app-runtime.ts` first evaluates. This file
 * imports it DIRECTLY (no server graph) so Bun cannot race its evaluation
 * ahead of `./environment` / `Log.init` — the module-load ordering hazard that
 * affects any benchmark file statically importing the heavy server graph (see
 * backend.test.ts for the harness that boots that graph at test time).
 *
 * Order robustness: ES module evaluation is once-per-process, so whether the
 * spans land in this test's slice depends on whether a prior benchmark file
 * already evaluated the module. The assertion is truthful in both cases —
 * exactly one completed span per stage across the whole process capture, zero
 * unmatched starts, and a re-import never re-emits.
 */

import "./capture"
import "./environment"
import { afterAll, describe, expect, it } from "bun:test"
import * as Log from "@opencode-ai/core/util/log"
import { captured, installCapture } from "./capture"
import { registerBenchmarkEnv } from "./environment"
import * as P0 from "./p0-records"

await Log.init({ print: true })
installCapture()

afterAll(registerBenchmarkEnv())

const parseSlice = (from: number): P0.P0Record[] =>
  captured()
    .slice(from)
    .map((line) => P0.parseP0Line(line))
    .filter((rec): rec is P0.P0Record => rec !== undefined)

describe("backend AppLayer construction P0 spans", () => {
  it("captures app_layer_define and app_runtime_make start/end pairs at module load (once per process)", async () => {
    const from = captured().length
    // Load the production AppLayer graph in this process (a re-import is a
    // no-op if an earlier benchmark file already evaluated it — the module
    // cache never re-runs module-load code, so the spans never re-emit).
    await import("../../src/effect/app-runtime")
    await Bun.sleep(50)

    const slice = parseSlice(from)
    const whole = parseSlice(0)
    for (const stage of ["app_layer_define", "app_runtime_make"]) {
      const fresh = P0.stageSpans(slice, stage)
      if (fresh.spans === 1) {
        // This file was the first evaluator in the process: the fresh import
        // emitted exactly one completed pair and a re-import cannot re-emit.
        expect(fresh).toEqual({ spans: 1, unmatchedStarts: 0 })
      } else {
        // A prior benchmark file already evaluated the module in this process
        // (the spans landed before `from`); the re-import emitted nothing. The
        // module-load proof is on the whole-process capture.
        expect(fresh).toEqual({ spans: 0, unmatchedStarts: 0 })
      }
      // Either way: exactly one completed module-load span per stage in this
      // process, never an unmatched start.
      expect(P0.stageSpans(whole, stage)).toEqual({ spans: 1, unmatchedStarts: 0 })
      expect(P0.stageDurations(slice, stage)).toHaveLength(fresh.spans)
    }
  })
})
