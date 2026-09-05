import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  classifyQueuedObservation,
  countQueuedUserMessages,
  queuedHasAssistant,
  queuedSecondMarkerPresent,
  queuedStatusForSession,
  summarizeQueuedObservation,
  validateQueuedObservation,
  type BackendSnapshot,
  type QueuedObservation,
} from "../../src/agent-manager/fixture-backend"

const MARKER = "E2E queued follow-up"

function snapFor(sessionID: string, userTexts: string[], assistants: number, status?: string): BackendSnapshot {
  const messages = [
    ...userTexts.map((text, i) => ({ id: `u-${i}`, role: "user" as const, text })),
    ...Array.from({ length: assistants }, (_, i) => ({ id: `a-${i}`, role: "assistant" as const, text: "done" })),
  ]
  return {
    requestedAt: new Date().toISOString(),
    sessions: [
      {
        id: sessionID,
        title: "T",
        agent: "e2e-agent",
        model: null,
        parentID: null,
        createdAt: 1,
        updatedAt: 2,
      },
    ],
    messages: { [sessionID]: messages },
    statuses: status === undefined ? {} : { [sessionID]: status },
    agents: [],
    connectedProviders: [],
  }
}

function goodArtifact(over: Partial<QueuedObservation> = {}): QueuedObservation {
  return {
    scenario: "real-session",
    observedAt: new Date().toISOString(),
    sessionID: "ses_test123",
    baselineStatus: "busy",
    status: "busy",
    baselineUserCount: 1,
    currentUserCount: 2,
    secondTextPresent: true,
    hasAssistant: false,
    backendHintAvailable: false,
    sendClickAccepted: true,
    classification: "marker-visible-busy-no-assistant",
    ...over,
  }
}

describe("queued observation helpers (SDK-visible shape only)", () => {
  it("counts user messages and returns undefined when the session is unobservable", () => {
    const s = snapFor("ses_a", ["first"], 0, "busy")
    expect(countQueuedUserMessages(s, "ses_a")).toBe(1)
    expect(countQueuedUserMessages(s, "ses_missing")).toBeUndefined()
    const noMessages: BackendSnapshot = { ...s, messages: {} }
    expect(countQueuedUserMessages(noMessages, "ses_a")).toBeUndefined()
  })

  it("keys follow-up on marker text, not on messages length alone", () => {
    const sameLengthNoMarker = snapFor("ses_a", ["first", "unrelated second"], 0, "busy")
    const sameLengthWithMarker = snapFor("ses_a", ["first", `${MARKER}: second`], 0, "busy")
    expect(queuedSecondMarkerPresent(sameLengthNoMarker, "ses_a", MARKER)).toBe(false)
    expect(queuedSecondMarkerPresent(sameLengthWithMarker, "ses_a", MARKER)).toBe(true)
    expect(classifyQueuedObservation(sameLengthNoMarker, "ses_a", MARKER)).toBe("marker-absent")
    expect(classifyQueuedObservation(sameLengthWithMarker, "ses_a", MARKER)).toBe("marker-visible-busy-no-assistant")
  })

  it("classifies marker-visible-busy-no-assistant only while SDK status is busy with marker and no assistant", () => {
    const s = snapFor("ses_a", ["first", `${MARKER}: second`], 0, "busy")
    expect(queuedHasAssistant(s, "ses_a")).toBe(false)
    expect(queuedStatusForSession(s, "ses_a")).toBe("busy")
    expect(classifyQueuedObservation(s, "ses_a", MARKER)).toBe("marker-visible-busy-no-assistant")
  })

  it("classifies marker-visible-nonbusy-or-assistant when idle or answered (SDK shape, not abort outcome)", () => {
    const idle = snapFor("ses_a", ["first", `${MARKER}: second`], 0, "idle")
    expect(classifyQueuedObservation(idle, "ses_a", MARKER)).toBe("marker-visible-nonbusy-or-assistant")
    const answered = snapFor("ses_a", ["first", `${MARKER}: second`], 1, "busy")
    expect(classifyQueuedObservation(answered, "ses_a", MARKER)).toBe("marker-visible-nonbusy-or-assistant")
  })

  it("retains explicit retry/offline/unknown SDK statuses instead of folding to idle", () => {
    expect(queuedStatusForSession(snapFor("ses_a", ["first"], 0, "retry"), "ses_a")).toBe("retry")
    expect(queuedStatusForSession(snapFor("ses_a", ["first"], 0, "offline"), "ses_a")).toBe("offline")
    expect(queuedStatusForSession(snapFor("ses_a", ["first"], 0, "unknown"), "ses_a")).toBe("unknown")
    expect(queuedStatusForSession(snapFor("ses_a", ["first", `${MARKER}: x`], 0, "retry"), "ses_a")).toBe("retry")
    expect(classifyQueuedObservation(snapFor("ses_a", ["first", `${MARKER}: x`], 0, "retry"), "ses_a", MARKER)).toBe(
      "marker-visible-nonbusy-or-assistant",
    )
    expect(classifyQueuedObservation(snapFor("ses_a", ["first", `${MARKER}: x`], 0, "offline"), "ses_a", MARKER)).toBe(
      "marker-visible-nonbusy-or-assistant",
    )
  })

  it("reads only a missing status entry as idle (backend idle rows are deleted from the map)", () => {
    expect(queuedStatusForSession(snapFor("ses_a", ["first"], 0), "ses_a")).toBe("idle")
    expect(classifyQueuedObservation(snapFor("ses_a", ["first", `${MARKER}: x`], 0), "ses_a", MARKER)).toBe(
      "marker-visible-nonbusy-or-assistant",
    )
  })

  it("maps unexpected raw status values to unknown (fail-closed, never backend queue truth)", () => {
    expect(queuedStatusForSession(snapFor("ses_a", ["first"], 0, "weird"), "ses_a")).toBe("unknown")
  })

  it("classifies snapshot-unobservable when the snapshot cannot show the session", () => {
    const s = snapFor("ses_a", ["first"], 0, "busy")
    expect(classifyQueuedObservation(s, "ses_missing", MARKER)).toBe("snapshot-unobservable")
    const noMessages: BackendSnapshot = { ...s, messages: {} }
    expect(classifyQueuedObservation(noMessages, "ses_a", MARKER)).toBe("snapshot-unobservable")
    expect(queuedStatusForSession(noMessages, "ses_a")).toBe("unknown")
  })

  it("summarizes the bounded artifact with baseline status and DOM-click fact (never prompt text)", () => {
    const s = snapFor("ses_a", ["first", `${MARKER}: second`], 0, "busy")
    const out = summarizeQueuedObservation({
      scenario: "real-session",
      observedAt: new Date().toISOString(),
      sessionID: "ses_a",
      baselineUserCount: 1,
      baselineStatus: "busy",
      snap: s,
      marker: MARKER,
      sendClickAccepted: true,
    })
    expect(out).toMatchObject({
      scenario: "real-session",
      sessionID: "ses_a",
      baselineStatus: "busy",
      status: "busy",
      baselineUserCount: 1,
      currentUserCount: 2,
      secondTextPresent: true,
      hasAssistant: false,
      backendHintAvailable: false,
      sendClickAccepted: true,
      classification: "marker-visible-busy-no-assistant",
    })
    expect(JSON.stringify(out)).not.toContain(MARKER)
    expect(validateQueuedObservation(out)).toBeNull()
  })

  it("summarizes an unconverged DOM click as SDK-visible shape without claiming queue success", () => {
    const s = snapFor("ses_a", ["first"], 0, "busy")
    const out = summarizeQueuedObservation({
      scenario: "real-session",
      observedAt: new Date().toISOString(),
      sessionID: "ses_a",
      baselineUserCount: 1,
      baselineStatus: "busy",
      snap: s,
      marker: MARKER,
      sendClickAccepted: false,
    })
    expect(out.classification).toBe("marker-absent")
    expect(validateQueuedObservation(out)).toBeNull()
  })

  it("rejects out-of-bound summarize inputs fail-fast", () => {
    const s = snapFor("ses_a", ["first"], 0, "busy")
    const base = {
      scenario: "real-session",
      observedAt: new Date().toISOString(),
      sessionID: "ses_a",
      baselineUserCount: 1,
      baselineStatus: "busy" as const,
      snap: s,
      marker: MARKER,
      sendClickAccepted: true,
    }
    expect(() => summarizeQueuedObservation({ ...base, marker: "" })).toThrow()
    expect(() => summarizeQueuedObservation({ ...base, baselineUserCount: -1 })).toThrow()
    expect(() => summarizeQueuedObservation({ ...base, observedAt: "not-iso" })).toThrow()
    expect(() => summarizeQueuedObservation({ ...base, scenario: "other" })).toThrow()
    expect(() => summarizeQueuedObservation({ ...base, baselineStatus: "weird" as never })).toThrow()
  })

  it("validates exact keys, enums, bounds, and redaction", () => {
    expect(validateQueuedObservation(goodArtifact())).toBeNull()
    const extra = { ...goodArtifact(), extra: 1 } as unknown
    expect(validateQueuedObservation(extra)).toContain("keys mismatch")
    const missing = { ...goodArtifact() } as Record<string, unknown>
    delete missing.status
    expect(validateQueuedObservation(missing)).toContain("keys mismatch")
    expect(validateQueuedObservation(goodArtifact({ classification: "bogus" as never }))).toContain(
      "classification invalid",
    )
    expect(validateQueuedObservation(goodArtifact({ status: "weird" as never }))).toContain("status invalid")
    expect(validateQueuedObservation(goodArtifact({ baselineStatus: "weird" as never }))).toContain(
      "baselineStatus invalid",
    )
    expect(validateQueuedObservation(goodArtifact({ observedAt: "2026-09-05 09:00:00" }))).toContain("observedAt")
    expect(validateQueuedObservation(goodArtifact({ sessionID: "x".repeat(257) }))).toContain("sessionID invalid")
    expect(validateQueuedObservation(goodArtifact({ baselineUserCount: -1 }))).toContain("baselineUserCount invalid")
    expect(validateQueuedObservation(goodArtifact({ backendHintAvailable: true }))).toContain(
      "backendHintAvailable must be false",
    )
    expect(validateQueuedObservation(goodArtifact({ sessionID: "ses_e2e-fixture-key" }))).toContain("leaked secret")
  })

  it("rejects the old overclaim enum and field names (backward-incompatible narrowing)", () => {
    for (const c of ["pending", "adopted-or-hidden", "not-enqueued", "unobservable"] as const) {
      expect(validateQueuedObservation(goodArtifact({ classification: c as never }))).toContain("classification invalid")
    }
    const oldPrompt = { ...goodArtifact(), promptAsyncAccepted: true } as Record<string, unknown>
    expect(validateQueuedObservation(oldPrompt)).toContain("keys mismatch")
    const oldCount = { ...goodArtifact(), clientQueuedCount: 1 } as Record<string, unknown>
    expect(validateQueuedObservation(oldCount)).toContain("keys mismatch")
  })

  it("restricts scenario to real-session", () => {
    expect(validateQueuedObservation(goodArtifact({ scenario: "other" }))).toContain("real-session")
    expect(validateQueuedObservation(goodArtifact({ scenario: "" }))).toContain("real-session")
  })

  it("enforces classification/status/marker/assistant cross-field invariants fail-closed", () => {
    expect(
      validateQueuedObservation(goodArtifact({ classification: "marker-visible-busy-no-assistant", status: "idle" })),
    ).toContain("shape mismatch")
    expect(
      validateQueuedObservation(
        goodArtifact({ classification: "marker-visible-busy-no-assistant", hasAssistant: true }),
      ),
    ).toContain("shape mismatch")
    expect(
      validateQueuedObservation(
        goodArtifact({ classification: "marker-visible-busy-no-assistant", secondTextPresent: false }),
      ),
    ).toContain("shape mismatch")
    expect(
      validateQueuedObservation(
        goodArtifact({ classification: "marker-visible-nonbusy-or-assistant", secondTextPresent: false }),
      ),
    ).toContain("marker mismatch")
    expect(
      validateQueuedObservation(goodArtifact({ classification: "marker-absent", secondTextPresent: true })),
    ).toContain("marker mismatch")
    expect(
      validateQueuedObservation(goodArtifact({ classification: "snapshot-unobservable", status: "busy" })),
    ).toContain("snapshot-unobservable requires status unknown")
    expect(
      validateQueuedObservation(
        goodArtifact({
          classification: "marker-visible-nonbusy-or-assistant",
          status: "busy",
          hasAssistant: false,
          secondTextPresent: true,
        }),
      ),
    ).toContain("must be marker-visible-busy-no-assistant")
  })

  it("requires reasonable count growth when observable, without binding the DOM click to queue success", () => {
    expect(
      validateQueuedObservation(goodArtifact({ baselineUserCount: 2, currentUserCount: 1 })),
    ).toContain("currentUserCount must be")
    const shrunk = goodArtifact({
      classification: "snapshot-unobservable",
      status: "unknown",
      baselineUserCount: 2,
      currentUserCount: 0,
      secondTextPresent: false,
    })
    expect(validateQueuedObservation(shrunk)).toBeNull()
    const clickFalse = goodArtifact({ sendClickAccepted: false })
    expect(validateQueuedObservation(clickFalse)).toBeNull()
    const clickFalseBusy = goodArtifact({ sendClickAccepted: false, baselineStatus: "busy" })
    expect(validateQueuedObservation(clickFalseBusy)).toBeNull()
  })

  it("F-1: tab selection lives inside the non-fatal observer boundary (source-level, no live run)", () => {
    const src = readFileSync(join(import.meta.dir, "../../script/e2e-probe-dom.ts"), "utf8")
    const start = src.indexOf("export async function observeQueuedFollowup")
    expect(start).toBeGreaterThan(-1)
    const nextExport = src.indexOf("export async function sendWithRetry", start)
    const body = nextExport > start ? src.slice(start, nextExport) : src.slice(start)
    const clickAt = body.indexOf("await clickTab(frame, sessionID, timeoutMs)")
    expect(clickAt).toBeGreaterThan(-1)
    const tryAt = body.lastIndexOf("try {", clickAt)
    const catchAt = body.indexOf("catch", clickAt)
    expect(tryAt).toBeGreaterThan(-1)
    expect(catchAt).toBeGreaterThan(tryAt)
    expect(clickAt).toBeGreaterThan(tryAt)
    expect(clickAt).toBeLessThan(catchAt)
    expect(body).toContain("sendClickAccepted = false")
    expect(body).toContain("snap.request().catch(() => baseline)")
  })

  it("F-1b: baseline snapshot failure skips the artifact and returns (source-level, no live run)", () => {
    const src = readFileSync(join(import.meta.dir, "../../script/e2e-probe-dom.ts"), "utf8")
    const start = src.indexOf("export async function observeQueuedFollowup")
    expect(start).toBeGreaterThan(-1)
    const nextExport = src.indexOf("export async function sendWithRetry", start)
    const body = nextExport > start ? src.slice(start, nextExport) : src.slice(start)
    const requestAt = body.indexOf("await snap.request()")
    const clickAt = body.indexOf("await clickTab(frame, sessionID, timeoutMs)")
    expect(requestAt).toBeGreaterThan(-1)
    expect(clickAt).toBeGreaterThan(requestAt)
    const headTry = body.lastIndexOf("try {", requestAt)
    expect(headTry).toBeGreaterThan(-1)
    expect(headTry).toBeLessThan(requestAt)
    const headCatch = body.indexOf("catch", requestAt)
    expect(headCatch).toBeGreaterThan(requestAt)
    expect(headCatch).toBeLessThan(clickAt)
    const headReturn = body.indexOf("return", headCatch)
    expect(headReturn).toBeGreaterThan(headCatch)
    expect(headReturn).toBeLessThan(clickAt)
    const skipBranch = body.slice(headCatch, clickAt)
    expect(skipBranch).toContain("return")
    expect(skipBranch).not.toContain("queued-observation.json")
    expect(skipBranch).not.toContain("summarizeQueuedObservation")
    expect(skipBranch).not.toContain("marker-absent")
    expect(skipBranch).not.toContain("marker-visible")
    expect(skipBranch).not.toContain("idle")
  })

  it("F-2: snapshot-unobservable forces the full zeroed shape (status/marker/assistant/count)", () => {
    const base = goodArtifact({
      classification: "snapshot-unobservable",
      status: "unknown",
      secondTextPresent: false,
      hasAssistant: false,
      currentUserCount: 0,
    })
    expect(validateQueuedObservation(base)).toBeNull()
    expect(validateQueuedObservation({ ...base, secondTextPresent: true })).toContain("secondTextPresent false")
    expect(validateQueuedObservation({ ...base, hasAssistant: true })).toContain("hasAssistant false")
    expect(validateQueuedObservation({ ...base, currentUserCount: 1 })).toContain("currentUserCount 0")
    expect(validateQueuedObservation({ ...base, status: "idle" })).toContain("status unknown")
    const partialZero = { ...base, secondTextPresent: false, hasAssistant: false, currentUserCount: 0 }
    expect(validateQueuedObservation(partialZero)).toBeNull()
  })

  it("F-2: unobservable keeps the real baseline count even when it exceeds the zeroed current count", () => {
    const shrunk = goodArtifact({
      classification: "snapshot-unobservable",
      status: "unknown",
      baselineUserCount: 3,
      currentUserCount: 0,
      secondTextPresent: false,
      hasAssistant: false,
    })
    expect(validateQueuedObservation(shrunk)).toBeNull()
    const summarized = summarizeQueuedObservation({
      scenario: "real-session",
      observedAt: new Date().toISOString(),
      sessionID: "ses_missing",
      baselineUserCount: 3,
      baselineStatus: "busy",
      snap: snapFor("ses_a", ["first"], 0, "busy"),
      marker: MARKER,
      sendClickAccepted: false,
    })
    expect(summarized.classification).toBe("snapshot-unobservable")
    expect(summarized).toMatchObject({
      status: "unknown",
      secondTextPresent: false,
      hasAssistant: false,
      currentUserCount: 0,
      baselineUserCount: 3,
    })
    expect(validateQueuedObservation(summarized)).toBeNull()
  })

  it("F-3: failed status/messages reads become explicit unobservable evidence, never idle/marker-absent", () => {
    const readable = snapFor("ses_a", ["first", `${MARKER}: second`], 0, "busy")
    expect(classifyQueuedObservation(readable, "ses_a", MARKER)).toBe("marker-visible-busy-no-assistant")
    const statusFailed: BackendSnapshot = { ...readable, statusReadable: false }
    expect(queuedStatusForSession(statusFailed, "ses_a")).toBe("unknown")
    expect(classifyQueuedObservation(statusFailed, "ses_a", MARKER)).toBe("snapshot-unobservable")
    expect(countQueuedUserMessages(statusFailed, "ses_a")).toBe(2)
    const messagesFailed: BackendSnapshot = { ...readable, messagesReadable: { ses_a: false } }
    expect(countQueuedUserMessages(messagesFailed, "ses_a")).toBeUndefined()
    expect(queuedSecondMarkerPresent(messagesFailed, "ses_a", MARKER)).toBe(false)
    expect(queuedHasAssistant(messagesFailed, "ses_a")).toBe(false)
    expect(queuedStatusForSession(messagesFailed, "ses_a")).toBe("unknown")
    expect(classifyQueuedObservation(messagesFailed, "ses_a", MARKER)).toBe("snapshot-unobservable")
    const otherFailed: BackendSnapshot = { ...readable, messagesReadable: { ses_other: false } }
    expect(classifyQueuedObservation(otherFailed, "ses_a", MARKER)).toBe("marker-visible-busy-no-assistant")
    for (const failed of [statusFailed, messagesFailed]) {
      const out = summarizeQueuedObservation({
        scenario: "real-session",
        observedAt: new Date().toISOString(),
        sessionID: "ses_a",
        baselineUserCount: 1,
        baselineStatus: "busy",
        snap: failed,
        marker: MARKER,
        sendClickAccepted: false,
      })
      expect(out.classification).toBe("snapshot-unobservable")
      expect(out).toMatchObject({
        status: "unknown",
        secondTextPresent: false,
        hasAssistant: false,
        currentUserCount: 0,
      })
      expect(validateQueuedObservation(out)).toBeNull()
    }
  })

  it("F-4: artifact build/validate/write failures stay inside the non-fatal boundary (source-level, no live run)", () => {
    const src = readFileSync(join(import.meta.dir, "../../script/e2e-probe-dom.ts"), "utf8")
    const start = src.indexOf("export async function observeQueuedFollowup")
    expect(start).toBeGreaterThan(-1)
    const nextExport = src.indexOf("export async function sendWithRetry", start)
    const body = nextExport > start ? src.slice(start, nextExport) : src.slice(start)
    const summarizeAt = body.indexOf("summarizeQueuedObservation({")
    const validateAt = body.indexOf("validateQueuedObservation(artifact)")
    const writeAt = body.indexOf('queued-observation.json')
    expect(summarizeAt).toBeGreaterThan(-1)
    expect(validateAt).toBeGreaterThan(summarizeAt)
    expect(writeAt).toBeGreaterThan(validateAt)
    const tryAt = body.lastIndexOf("try {", summarizeAt)
    expect(tryAt).toBeGreaterThan(-1)
    expect(tryAt).toBeLessThan(summarizeAt)
    const catchAt = body.indexOf("catch", writeAt)
    expect(catchAt).toBeGreaterThan(writeAt)
    const returnAt = body.indexOf("return", catchAt)
    expect(returnAt).toBeGreaterThan(catchAt)
    const tail = body.slice(catchAt, returnAt + "return".length)
    expect(tail).toContain("artifact unavailable")
    expect(tail).toContain("Stop continues")
    const catchBranch = body.slice(catchAt, returnAt + 200)
    expect(catchBranch).not.toContain("queued-observation.json")
    expect(catchBranch).not.toContain("QUEUED OBSERVATION")
    expect(catchBranch).not.toContain("summarizeQueuedObservation")
    expect(body.slice(catchAt)).toContain("slice(0,")
    expect(body.slice(catchAt, returnAt + 400)).not.toContain("JSON.stringify(artifact)")
  })

  it("F-4b: artifact failure path skips the write without emitting fake success (helper contract, no live run)", () => {
    const s = snapFor("ses_a", ["first"], 0, "busy")
    expect(() =>
      summarizeQueuedObservation({
        scenario: "real-session",
        observedAt: new Date().toISOString(),
        sessionID: "ses_a",
        baselineUserCount: 1,
        baselineStatus: "busy",
        snap: s,
        marker: "",
        sendClickAccepted: true,
      }),
    ).toThrow()
    expect(validateQueuedObservation(goodArtifact({ baselineUserCount: -1 }))).toContain("baselineUserCount invalid")
    expect(validateQueuedObservation(goodArtifact({ classification: "bogus" as never }))).toContain(
      "classification invalid",
    )
  })

  it("F-4c: caller Phase 4 Stop stays reachable after the observer (source-level, no live run)", () => {
    const src = readFileSync(join(import.meta.dir, "../../script/e2e-probe.ts"), "utf8")
    const observeAt = src.indexOf("await observeQueuedFollowup(")
    const stopAt = src.indexOf("await abortRealSessionsWithTimeline(")
    expect(observeAt).toBeGreaterThan(-1)
    expect(stopAt).toBeGreaterThan(observeAt)
  })

  it("accepts retained retry/offline baseline and current statuses", () => {
    expect(
      validateQueuedObservation(
        goodArtifact({
          baselineStatus: "retry",
          status: "retry",
          classification: "marker-visible-nonbusy-or-assistant",
        }),
      ),
    ).toBeNull()
    expect(
      validateQueuedObservation(
        goodArtifact({
          baselineStatus: "offline",
          status: "offline",
          classification: "marker-visible-nonbusy-or-assistant",
        }),
      ),
    ).toBeNull()
  })
})
