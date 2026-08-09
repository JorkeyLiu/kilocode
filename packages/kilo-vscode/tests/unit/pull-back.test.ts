/**
 * Unit tests for capturePullBack — the pure content-capture step of the
 * pull-back-to-editor flow. Verifies that a queued user message's parts are
 * split into exactly what the composer needs: the draft text (review prefix
 * stripped), ImageAttachments for data-URL image parts, mention paths for
 * non-image file parts, and review comments from TextPart metadata.
 *
 * The second describe block exercises shouldPrunePendingPullBack — the prune
 * decision of the pending pull-back lifecycle. The decision is covered
 * behaviorally (real session-queue derivations, no mocks) rather than by
 * source-text contract, because Solid's server build does not execute effects
 * in the unit harness.
 */

import { describe, expect, it } from "bun:test"
import { capturePullBack } from "../../webview-ui/src/utils/pull-back"
import { shouldPrunePendingPullBack } from "../../webview-ui/src/context/session-pull-back"
import { activeUserMessageID, queuedUserMessageIDs } from "../../webview-ui/src/context/session-queue"
import { formatReviewCommentsMarkdown, reviewMetadata, type ReviewCommentData } from "../../src/shared/review-comments"
import type { Message, Part, SessionStatusInfo } from "../../webview-ui/src/types/messages"

function text(id: string, value: string, metadata?: Record<string, unknown>, synthetic?: boolean): Part {
  return { type: "text", id, text: value, metadata, synthetic } as Part
}

function file(id: string, mime: string, url: string, extra: Partial<Extract<Part, { type: "file" }>> = {}): Part {
  return { type: "file", id, mime, url, ...extra } as Part
}

function userMsg(id: string): Message {
  return { id, sessionID: "sess", role: "user", createdAt: new Date(0).toISOString() } as Message
}

function assistantDone(id: string, parentID: string): Message {
  return {
    id,
    sessionID: "sess",
    role: "assistant",
    createdAt: new Date(0).toISOString(),
    parentID,
    finish: "completed",
    time: { created: 1, completed: 2 },
  } as Message
}

describe("capturePullBack", () => {
  it("captures plain text with no review or attachments", () => {
    const parts = [text("p1", "hello world")]
    const result = capturePullBack(parts)
    expect(result.text).toBe("hello world")
    expect(result.images).toEqual([])
    expect(result.paths).toEqual([])
    expect(result.review).toEqual([])
  })

  it("strips the review prefix and returns the comments", () => {
    const comments: ReviewCommentData[] = [
      { id: "c1", file: "src/app.ts", side: "additions", line: 10, comment: "fix this", selectedText: "const x" },
    ]
    const body = "the actual draft"
    const part = text("p1", `${formatReviewCommentsMarkdown(comments)}\n\n${body}`, reviewMetadata({ version: 1, comments }))
    const result = capturePullBack([part])
    expect(result.text).toBe(body)
    expect(result.review).toEqual(comments)
    expect(result.images).toEqual([])
    expect(result.paths).toEqual([])
  })

  it("captures a review whose body is empty", () => {
    const comments: ReviewCommentData[] = [
      { id: "c1", file: "a.ts", side: "deletions", line: 3, comment: "remove", selectedText: "old" },
    ]
    const part = text("p1", formatReviewCommentsMarkdown(comments), reviewMetadata({ version: 1, comments }))
    const result = capturePullBack([part])
    expect(result.text).toBe("")
    expect(result.review).toEqual(comments)
  })

  it("converts data-URL image parts to ImageAttachments", () => {
    const img = file("p1", "image/png", "data:image/png;base64,AAAA", { filename: "shot.png" })
    const result = capturePullBack([img])
    expect(result.images).toHaveLength(1)
    expect(result.images[0]).toMatchObject({ filename: "shot.png", mime: "image/png", dataUrl: "data:image/png;base64,AAAA" })
    expect(result.images[0].id).toBeTypeOf("string")
    expect(result.paths).toEqual([])
  })

  it("defaults the image filename when the part has none", () => {
    const img = file("p1", "image/jpeg", "data:image/jpeg;base64,BBBB")
    const result = capturePullBack([img])
    expect(result.images[0].filename).toBe("image")
  })

  it("puts non-image file parts into paths", () => {
    const part = file("p1", "text/plain", "file:///x/y.ts", { filename: "y.ts", source: { type: "file", path: "src/y.ts", text: { value: "…", start: 0, end: 1 } } })
    const result = capturePullBack([part])
    expect(result.paths).toEqual(["src/y.ts"])
    expect(result.images).toEqual([])
  })

  it("puts image parts without data URLs into paths, not images", () => {
    const part = file("p1", "image/png", "file:///x/y.png", { filename: "y.png", source: { type: "file", path: "src/y.png", text: { value: "…", start: 0, end: 1 } } })
    const result = capturePullBack([part])
    expect(result.paths).toEqual(["src/y.png"])
    expect(result.images).toEqual([])
  })

  it("ignores file parts without a source path", () => {
    const part = file("p1", "text/plain", "file:///x/y.ts")
    const result = capturePullBack([part])
    expect(result.paths).toEqual([])
    expect(result.images).toEqual([])
  })

  it("ignores synthetic text parts", () => {
    const result = capturePullBack([text("p1", "synthetic", undefined, true)])
    expect(result.text).toBe("")
  })

  it("concatenates multiple non-synthetic text parts", () => {
    const result = capturePullBack([text("p1", "first "), text("p2", "second")])
    expect(result.text).toBe("first second")
  })

  it("combines text, images, paths, and review from a mixed part list", () => {
    const comments: ReviewCommentData[] = [
      { id: "c1", file: "b.ts", side: "additions", line: 1, comment: "ok", selectedText: "x" },
    ]
    const parts = [
      text("p1", `${formatReviewCommentsMarkdown(comments)}\n\nreviewed draft`, reviewMetadata({ version: 1, comments })),
      file("p2", "image/png", "data:image/png;base64,CCCC", { filename: "diagram.png" }),
      file("p3", "text/plain", "file:///x/z.ts", { source: { type: "file", path: "src/z.ts", text: { value: "…", start: 0, end: 1 } } }),
    ]
    const result = capturePullBack(parts)
    expect(result.text).toBe("reviewed draft")
    expect(result.review).toEqual(comments)
    expect(result.images).toMatchObject([{ filename: "diagram.png", mime: "image/png", dataUrl: "data:image/png;base64,CCCC" }])
    expect(result.paths).toEqual(["src/z.ts"])
  })

  it("merges review comments across multiple review text parts", () => {
    const first: ReviewCommentData[] = [
      { id: "c1", file: "a.ts", side: "additions", line: 1, comment: "first", selectedText: "x" },
    ]
    const second: ReviewCommentData[] = [
      { id: "c2", file: "b.ts", side: "deletions", line: 2, comment: "second", selectedText: "y" },
    ]
    const parts = [
      text("p1", `${formatReviewCommentsMarkdown(first)}\n\nfirst draft`, reviewMetadata({ version: 1, comments: first })),
      text("p2", `${formatReviewCommentsMarkdown(second)}\n\nsecond draft`, reviewMetadata({ version: 1, comments: second })),
    ]
    const result = capturePullBack(parts)
    expect(result.review).toEqual([...first, ...second])
    expect(result.text).toBe("first draftsecond draft")
  })

  it("returns empty content for an empty part list", () => {
    const result = capturePullBack([])
    expect(result).toEqual({ text: "", images: [], paths: [], review: [] })
  })

  it("returns empty content for parts carrying nothing restorable", () => {
    // A file part without a source path and without a data URL contributes no
    // text, images, paths, or review — this capture must NOT be posted, since
    // posting it would wipe the composer (LOCK-002).
    const part = file("p1", "text/plain", "file:///x/y.ts")
    const result = capturePullBack([part])
    expect(result).toEqual({ text: "", images: [], paths: [], review: [] })
  })

  it("returns non-empty content for a review-only message", () => {
    const comments: ReviewCommentData[] = [
      { id: "c1", file: "a.ts", side: "additions", line: 1, comment: "fix", selectedText: "x" },
    ]
    const result = capturePullBack([text("p1", formatReviewCommentsMarkdown(comments), reviewMetadata({ version: 1, comments }))])
    expect(result.text).toBe("")
    expect(result.review.length).toBeGreaterThan(0)
    expect(result.images).toEqual([])
    expect(result.paths).toEqual([])
  })

  it("returns non-empty content for an image-only message", () => {
    const img = file("p1", "image/png", "data:image/png;base64,DDDD", { filename: "shot.png" })
    const result = capturePullBack([img])
    expect(result.text).toBe("")
    expect(result.images.length).toBeGreaterThan(0)
    expect(result.paths).toEqual([])
    expect(result.review).toEqual([])
  })

  it("returns non-empty content for a path-only message", () => {
    const part = file("p1", "text/plain", "file:///x/y.ts", {
      source: { type: "file", path: "src/y.ts", text: { value: "…", start: 0, end: 1 } },
    })
    const result = capturePullBack([part])
    expect(result.text).toBe("")
    expect(result.paths.length).toBeGreaterThan(0)
    expect(result.images).toEqual([])
    expect(result.review).toEqual([])
  })
})

// Turn A finished (assistant has time.completed and a non-resumable finish)
// while the session is still working: B is the next pending slot.
const turnADone = [userMsg("A"), assistantDone("assistant-A", "A"), userMsg("B")]

const noParts = () => []

describe("pull-back prune decision (shouldPrunePendingPullBack)", () => {
  it("keeps a pending entry while its message is still queued", () => {
    // A is the running turn (its assistant is streaming toward completion), so
    // B is genuinely queued and must not be pruned.
    const runningA = [userMsg("A"), userMsg("B")]
    expect(shouldPrunePendingPullBack("B", runningA, { type: "working" }, noParts)).toBe(false)
  })

  it("survives the window between the preceding turn's completion and the slot's promotion", () => {
    // This is the over-prune window the audit flagged: queuedUserMessageIDs
    // excludes B (B IS the next pending slot) but activeUserMessageID returns
    // B, so the naive !queued prune would drop the restore for a cancel that
    // still succeeds (message.removed arrives right after).
    expect(queuedUserMessageIDs(turnADone, { type: "working" }, noParts)).not.toContain("B")
    expect(activeUserMessageID(turnADone, { type: "working" }, noParts)).toBe("B")
    expect(shouldPrunePendingPullBack("B", turnADone, { type: "working" }, noParts)).toBe(false)
  })

  it("prunes a no-op entry once the session idles", () => {
    // Slot was promoted but no message.removed ever arrived (cancel no-op):
    // once the session idles the entry is dropped so a later removal cannot
    // restore content for a message that actually ran.
    expect(shouldPrunePendingPullBack("B", turnADone, { type: "idle" }, noParts)).toBe(true)
  })

  it("prunes a no-op entry once the active slot moves past the message", () => {
    // B ran and completed; C is now the pending slot. The lingering entry for
    // B is dropped even while the session stays working.
    const pastB = [
      userMsg("A"),
      assistantDone("assistant-A", "A"),
      userMsg("B"),
      assistantDone("assistant-B", "B"),
      userMsg("C"),
    ]
    expect(activeUserMessageID(pastB, { type: "working" }, noParts)).toBe("C")
    expect(shouldPrunePendingPullBack("B", pastB, { type: "working" }, noParts)).toBe(true)
  })

  it("drops an entry for a message absent from the session entirely", () => {
    expect(shouldPrunePendingPullBack("ghost", [userMsg("A")], { type: "working" }, noParts)).toBe(true)
  })
})
