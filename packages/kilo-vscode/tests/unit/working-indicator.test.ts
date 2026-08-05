import { describe, expect, it } from "bun:test"
import {
  cumulativeElapsedMs,
  formatElapsedSeconds,
  hasActiveSegment,
  showIdleCumulative,
  showSpinner,
  showWorkingIndicator,
  tracksElapsed,
  tracksElapsedMs,
} from "../../webview-ui/src/components/shared/working-indicator-utils"

describe("tracksElapsed", () => {
  it("tracks pending submissions before backend status arrives", () => {
    expect(tracksElapsed("idle", true, 1)).toBe(true)
  })

  it("tracks active backend statuses", () => {
    expect(tracksElapsed("busy", false, 1)).toBe(true)
    expect(tracksElapsed("retry", false, 1)).toBe(true)
    expect(tracksElapsed("offline", false, 1)).toBe(true)
  })

  it("stops for idle sessions and missing start times", () => {
    expect(tracksElapsed("idle", false, 1)).toBe(false)
    expect(tracksElapsed("busy", false, undefined)).toBe(false)
    expect(tracksElapsed("idle", true, undefined)).toBe(false)
  })
})

describe("cumulativeElapsedMs", () => {
  it("prefers the Agent Manager snapshot over the sidebar since timestamp", () => {
    expect(cumulativeElapsedMs({ elapsedMs: 120_000, activeStart: 1_000_000 }, 500_000, 1_000_030)).toBe(120_030)
  })

  it("bootstraps an active segment from base plus current segment", () => {
    // Page-state bootstrap while the session is still running: base is the
    // settled total, activeStart anchors the still-growing segment.
    expect(cumulativeElapsedMs({ elapsedMs: 90_000, activeStart: 2_000_000 }, undefined, 2_000_025)).toBe(90_025)
  })

  it("renders the settled final cumulative duration while idle", () => {
    expect(cumulativeElapsedMs({ elapsedMs: 300_000 }, undefined, 9_999_999)).toBe(300_000)
  })

  it("falls back to the sidebar since timestamp when no snapshot exists", () => {
    expect(cumulativeElapsedMs(undefined, 5_000, 5_042)).toBe(42)
    expect(cumulativeElapsedMs(undefined, undefined, 5_042)).toBe(0)
  })

  it("never returns negative time for clock skew", () => {
    expect(cumulativeElapsedMs({ elapsedMs: 10, activeStart: 100 }, undefined, 50)).toBe(10)
    expect(cumulativeElapsedMs(undefined, 100, 50)).toBe(0)
  })
})

describe("hasActiveSegment", () => {
  it("detects a running snapshot segment", () => {
    expect(hasActiveSegment({ elapsedMs: 90_000, activeStart: 2_000_000 })).toBe(true)
  })

  it("returns false for settled snapshots, empty snapshots, and no snapshot", () => {
    expect(hasActiveSegment({ elapsedMs: 300_000 })).toBe(false)
    expect(hasActiveSegment(undefined)).toBe(false)
  })
})

describe("tracksElapsedMs", () => {
  it("ticks for an active snapshot even with idle local status and no busySince", () => {
    // Panel reopen: webview-local status is still idle and busySince unseeded,
    // but the persisted active snapshot must drive the counter.
    expect(tracksElapsedMs("idle", false, undefined, { elapsedMs: 90_000, activeStart: 2_000_000 })).toBe(true)
  })

  it("ticks for a settled cumulative total while idle", () => {
    expect(tracksElapsedMs("idle", false, undefined, { elapsedMs: 300_000 })).toBe(true)
  })

  it("ticks for a pending submission and for local activity", () => {
    expect(tracksElapsedMs("idle", true, 1, undefined)).toBe(true)
    expect(tracksElapsedMs("busy", false, 1, undefined)).toBe(true)
  })

  it("stops for an idle session with no snapshot", () => {
    expect(tracksElapsedMs("idle", false, undefined, undefined)).toBe(false)
  })
})

describe("showWorkingIndicator", () => {
  it("renders and ticks an active snapshot after panel reopen with idle local state", () => {
    // Acceptance (3): active snapshot drives the indicator before webview-local
    // status/busySince is reseeded.
    expect(showWorkingIndicator(false, "idle", false, { elapsedMs: 90_000, activeStart: 2_000_000 })).toBe(true)
  })

  it("shows submission feedback on top of an idle cumulative total", () => {
    // Acceptance (2): follow-up submission after settled timing shows feedback
    // immediately, without waiting for a backend status event.
    expect(showWorkingIndicator(true, "idle", false, { elapsedMs: 300_000 })).toBe(true)
  })

  it("keeps a settled cumulative total visible while idle", () => {
    // Acceptance (4): idle settled snapshot still shows the static final duration.
    expect(showWorkingIndicator(false, "idle", false, { elapsedMs: 300_000 })).toBe(true)
  })

  it("hides for an idle session with no snapshot, matching the sidebar fallback", () => {
    // Acceptance (5): non-Agent-Manager behavior unchanged.
    expect(showWorkingIndicator(false, "idle", false, undefined)).toBe(false)
    expect(showWorkingIndicator(false, "idle", true, undefined)).toBe(false)
  })

  it("keeps local active/blocked semantics unchanged", () => {
    expect(showWorkingIndicator(false, "busy", false, undefined)).toBe(true)
    expect(showWorkingIndicator(false, "busy", true, undefined)).toBe(false)
  })
})

describe("showSpinner", () => {
  it("shows the spinner for submission feedback on top of an idle cumulative total", () => {
    // Acceptance (2): session.submitting() always displays spinner/status feedback.
    expect(showSpinner({ elapsedMs: 300_000 }, true)).toBe(true)
  })

  it("shows the spinner for a running snapshot segment", () => {
    expect(showSpinner({ elapsedMs: 90_000, activeStart: 2_000_000 }, false)).toBe(true)
  })

  it("hides the spinner for an idle settled total but keeps the static duration", () => {
    // Acceptance (4): only the elapsed label remains.
    expect(showSpinner({ elapsedMs: 300_000 }, false)).toBe(false)
  })

  it("always shows the spinner without a snapshot, matching the sidebar fallback", () => {
    expect(showSpinner(undefined, false)).toBe(true)
  })
})

describe("showIdleCumulative", () => {
  it("keeps the indicator visible for a settled snapshot with elapsed time", () => {
    expect(showIdleCumulative({ elapsedMs: 45_000 })).toBe(true)
  })

  it("hides the idle indicator when no snapshot, still active, or under one second", () => {
    expect(showIdleCumulative(undefined)).toBe(false)
    expect(showIdleCumulative({ elapsedMs: 45_000, activeStart: 123 })).toBe(false)
    expect(showIdleCumulative({ elapsedMs: 0 })).toBe(false)
    expect(showIdleCumulative({ elapsedMs: 500 })).toBe(false)
  })
})

describe("formatElapsedSeconds", () => {
  it("keeps the existing seconds-only form below one minute", () => {
    expect(formatElapsedSeconds(0)).toBe("0s")
    expect(formatElapsedSeconds(59)).toBe("59s")
  })

  it("keeps the existing minutes form below one hour", () => {
    expect(formatElapsedSeconds(60)).toBe("1m 0s")
    expect(formatElapsedSeconds(3599)).toBe("59m 59s")
  })

  it("switches to hours at exactly one hour", () => {
    expect(formatElapsedSeconds(3600)).toBe("1h 0m 0s")
  })

  it("renders hours, minutes, and seconds for 1h2m3s", () => {
    expect(formatElapsedSeconds(3723)).toBe("1h 2m 3s")
  })

  it("renders multi-hour durations without a total-minute overflow", () => {
    expect(formatElapsedSeconds(7545)).toBe("2h 5m 45s")
    expect(formatElapsedSeconds(90061)).toBe("25h 1m 1s")
  })
})
