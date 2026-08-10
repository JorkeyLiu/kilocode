/**
 * Focused contract tests for the backend P0 record parser
 * (test/benchmark/p0-records.ts).
 *
 * The parser is pure; the line format mirrors what the production
 * `@opencode-ai/core/util/log` stream emits for `service=p0-perf` records
 * (verified against src/kilocode/perf/instrument.ts + src/kilocode/server/
 * config-convergence.ts emit sites).
 */

import { describe, expect, it } from "bun:test"
import {
  between,
  countStage,
  extractP0Records,
  firstStage,
  parseP0Line,
  seqs,
  stageDurations,
  stageRecords,
  stageSpans,
} from "./p0-records"

const MARK_LINE =
  "INFO  2026-08-10T10:00:00 +12ms service=p0-perf event=p0.mark stage=config_commit ts=1754822942000 dir=/var/folders/p0/proj meta={\"seq\":3} config_commit"

const START_LINE =
  "INFO  2026-08-10T10:00:01 +1ms service=p0-perf event=p0.start stage=instance_bootstrap ts=1754822942001 dir=/var/folders/p0/proj instance_bootstrap"

const END_LINE =
  "INFO  2026-08-10T10:00:01 +2ms service=p0-perf event=p0.end stage=instance_bootstrap ts=1754822942002 duration=231 dir=/var/folders/p0/proj instance_bootstrap"

const ENTRY_LINE =
  "INFO  2026-08-10T10:00:02 +3ms service=p0-perf event=p0.mark stage=processor_entry ts=1754822942003 id=ses_1 meta={\"messageID\":\"m1\",\"provider\":\"test\"} processor_entry"

describe("p0 record parser", () => {
  it("parses a mark record with stage, ts, dir, and JSON meta", () => {
    const rec = parseP0Line(MARK_LINE)
    expect(rec).toEqual({
      event: "p0.mark",
      stage: "config_commit",
      ts: 1_754_822_942_000,
      dir: "/var/folders/p0/proj",
      meta: { seq: 3 },
    })
  })

  it("parses span start/end records with duration", () => {
    const start = parseP0Line(START_LINE)
    expect(start).toMatchObject({ event: "p0.start", stage: "instance_bootstrap", dir: "/var/folders/p0/proj" })
    expect(start?.duration).toBeUndefined()
    const end = parseP0Line(END_LINE)
    expect(end).toMatchObject({ event: "p0.end", stage: "instance_bootstrap", ts: 1_754_822_942_002 })
    expect(end?.duration).toBe(231)
  })

  it("parses id + nested meta on a processor_entry record", () => {
    const rec = parseP0Line(ENTRY_LINE)
    expect(rec?.id).toBe("ses_1")
    expect(rec?.meta).toEqual({ messageID: "m1", provider: "test" })
  })

  it("returns undefined for non-p0 lines", () => {
    expect(parseP0Line("INFO  something else service=server stage=config_load")).toBeUndefined()
    expect(parseP0Line("hello world")).toBeUndefined()
    expect(parseP0Line("")).toBeUndefined()
  })

  it("extracts multiple records across a log buffer, preserving order", () => {
    const text = `${MARK_LINE}\n${START_LINE}\n${END_LINE}\nINFO  unrelated line\n${ENTRY_LINE}\n`
    const records = extractP0Records(text)
    expect(records).toHaveLength(4)
    expect(records.map((rec) => rec.stage)).toEqual(["config_commit", "instance_bootstrap", "instance_bootstrap", "processor_entry"])
  })

  it("stage helpers filter, count, and collect durations/seqs", () => {
    const records = extractP0Records(`${MARK_LINE}\n${START_LINE}\n${END_LINE}\n${ENTRY_LINE}\n`)
    expect(stageRecords(records, "instance_bootstrap")).toHaveLength(2)
    expect(countStage(records, "processor_entry")).toBe(1)
    expect(countStage(records, "listener")).toBe(0)
    expect(stageDurations(records, "instance_bootstrap")).toEqual([231])
    expect(seqs(records, "config_commit")).toEqual([3])
    expect(seqs(records, "convergence_complete")).toEqual([])
  })

  it("between computes positive ts deltas", () => {
    const start = parseP0Line(START_LINE)
    const end = parseP0Line(END_LINE)
    expect(between(start, end)).toBe(1)
    expect(between(end, start)).toBeUndefined()
    expect(between(undefined, end)).toBeUndefined()
  })

  it("firstStage returns the first record of a stage", () => {
    const records = extractP0Records(`${START_LINE}\n${END_LINE}\n`)
    expect(firstStage(records, "instance_bootstrap")?.event).toBe("p0.start")
    expect(firstStage(records, "listener")).toBeUndefined()
  })

  it("stageSpans counts a completed start/end pair as one span, not two records", () => {
    const records = extractP0Records(`${START_LINE}\n${END_LINE}\n`)
    // countStage sees start+end (2 records); stageSpans sees 1 completed span.
    expect(countStage(records, "instance_bootstrap")).toBe(2)
    expect(stageSpans(records, "instance_bootstrap")).toEqual({ spans: 1, unmatchedStarts: 0 })
  })

  it("stageSpans reports lone starts as unmatched, never as spans", () => {
    const records = extractP0Records(`${START_LINE}\n`)
    expect(stageSpans(records, "instance_bootstrap")).toEqual({ spans: 0, unmatchedStarts: 1 })
  })

  it("stageSpans requires matching dir correlation between start and end", () => {
    const endOther = END_LINE.replace("dir=/var/folders/p0/proj", "dir=/var/folders/p0/other")
    const records = extractP0Records(`${START_LINE}\n${endOther}\n`)
    expect(stageSpans(records, "instance_bootstrap")).toEqual({ spans: 0, unmatchedStarts: 1 })
  })

  it("stageSpans ignores ends without a matching start", () => {
    const records = extractP0Records(`${END_LINE}\n`)
    expect(stageSpans(records, "instance_bootstrap")).toEqual({ spans: 0, unmatchedStarts: 0 })
  })

  it("stageSpans pairs each end with the earliest unmatched matching start", () => {
    const start2 = START_LINE.replace("ts=1754822942001", "ts=1754822942200")
    const records = extractP0Records(`${START_LINE}\n${start2}\n${END_LINE}\n`)
    expect(stageSpans(records, "instance_bootstrap")).toEqual({ spans: 1, unmatchedStarts: 1 })
  })

  it("stageSpans counts zero for mark stages", () => {
    const records = extractP0Records(`${MARK_LINE}\n`)
    expect(stageSpans(records, "config_commit")).toEqual({ spans: 0, unmatchedStarts: 0 })
  })
})
