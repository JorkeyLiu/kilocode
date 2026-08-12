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
  SPAN_STAGES,
  STAGES,
  between,
  countStage,
  extractP0Records,
  firstStage,
  parseP0Line,
  seqs,
  stageDurations,
  stageRecords,
  stageSpans,
  type P0Record,
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

  it("stage lists document the P0 stage/span coverage (tool/permission/question/app-layer)", () => {
    const stages: string[] = [
      "app_layer_define",
      "app_runtime_make",
      "tool_execute",
      "tool_execute_plugin",
      "permission_wait",
      "question_wait",
    ]
    for (const stage of stages) {
      expect(STAGES.includes(stage as (typeof STAGES)[number])).toBe(true)
      expect(SPAN_STAGES.includes(stage as (typeof SPAN_STAGES)[number])).toBe(true)
    }
  })

  it("parses a tool_execute span with id correlation and tool meta", () => {
    const start = parseP0Line(
      "INFO  service=p0-perf event=p0.start stage=tool_execute ts=1754822942001 id=ses_1 meta={\"tool\":\"read\",\"callID\":\"call_1\"} tool_execute",
    )
    expect(start).toMatchObject({ event: "p0.start", stage: "tool_execute", id: "ses_1" })
    expect(start?.meta).toEqual({ tool: "read", callID: "call_1" })
    const end = parseP0Line(
      "INFO  service=p0-perf event=p0.end stage=tool_execute ts=1754822942002 duration=7 id=ses_1 meta={\"tool\":\"read\"} tool_execute",
    )
    expect(end).toMatchObject({ event: "p0.end", stage: "tool_execute", id: "ses_1", duration: 7 })
    expect(stageSpans([start!, end!], "tool_execute")).toEqual({ spans: 1, unmatchedStarts: 0 })
  })

  it("parses the distinct tool_execute_plugin span separately from the outer tool_execute span", () => {
    const outer = [
      parseP0Line(
        "INFO  service=p0-perf event=p0.start stage=tool_execute ts=1754822942001 id=ses_1 meta={\"tool\":\"p0_echo\",\"callID\":\"call_1\"} tool_execute",
      ),
      parseP0Line(
        "INFO  service=p0-perf event=p0.end stage=tool_execute ts=1754822942003 duration=9 id=ses_1 meta={\"tool\":\"p0_echo\"} tool_execute",
      ),
    ]
    const inner = [
      parseP0Line(
        "INFO  service=p0-perf event=p0.start stage=tool_execute_plugin ts=1754822942001 id=ses_1 meta={\"tool\":\"p0_echo\",\"callID\":\"call_1\"} tool_execute_plugin",
      ),
      parseP0Line(
        "INFO  service=p0-perf event=p0.end stage=tool_execute_plugin ts=1754822942002 duration=4 id=ses_1 meta={\"tool\":\"p0_echo\"} tool_execute_plugin",
      ),
    ]
    expect(outer.every((rec) => rec?.stage === "tool_execute")).toBe(true)
    expect(inner.every((rec) => rec?.stage === "tool_execute_plugin")).toBe(true)
    // One completed pair per stage — the duplicate-pair corruption is gone.
    expect(stageSpans([...outer, ...inner] as P0Record[], "tool_execute")).toEqual({ spans: 1, unmatchedStarts: 0 })
    expect(stageSpans([...outer, ...inner] as P0Record[], "tool_execute_plugin")).toEqual({
      spans: 1,
      unmatchedStarts: 0,
    })
    expect(stageDurations([...outer, ...inner] as P0Record[], "tool_execute_plugin")).toEqual([4])
  })

  it("permission_wait spans correlate by request id and leave unmatched starts on rejection", () => {
    const start = parseP0Line(
      "INFO  service=p0-perf event=p0.start stage=permission_wait ts=1754822942001 id=req_9 meta={\"sessionID\":\"ses_1\",\"permission\":\"read\"} permission_wait",
    )
    const end = parseP0Line(
      "INFO  service=p0-perf event=p0.end stage=permission_wait ts=1754822942002 duration=140 id=req_9 meta={\"sessionID\":\"ses_1\"} permission_wait",
    )
    expect(stageSpans([start!, end!], "permission_wait")).toEqual({ spans: 1, unmatchedStarts: 0 })
    // A rejected ask never reaches end(): lone start is the failure signal.
    expect(stageSpans([start!], "permission_wait")).toEqual({ spans: 0, unmatchedStarts: 1 })
    expect(stageDurations([start!, end!], "permission_wait")).toEqual([140])
  })
})
