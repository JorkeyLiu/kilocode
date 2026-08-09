/**
 * Static contract guard for the pull-back-to-editor wiring.
 *
 * The behavior itself (parts → composer content) is covered at runtime by
 * pull-back.test.ts; this file guards the glue that is not unit-testable in
 * isolation: the queued button semantics in kilo-ui, the TranscriptRow →
 * session.pullBackQueued wiring, the session context rename, the
 * SetChatBoxMessage payload shape, and the PromptInput setChatBoxMessage
 * handler extension (images/review restored only when present, so sent-message
 * revert keeps clearing nothing it did not already).
 */

import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const ROOT = join(__dirname, "..", "..")
const messagePart = readFileSync(join(ROOT, "..", "kilo-ui", "src", "components", "message-part.tsx"), "utf8")
const vscodeUser = readFileSync(join(ROOT, "webview-ui", "src", "components", "chat", "VscodeUserMessage.tsx"), "utf8")
const transcript = readFileSync(join(ROOT, "webview-ui", "src", "components", "chat", "TranscriptRow.tsx"), "utf8")
const session = readFileSync(join(ROOT, "webview-ui", "src", "context", "session.tsx"), "utf8")
const pullBackHelper = readFileSync(join(ROOT, "webview-ui", "src", "context", "session-pull-back.ts"), "utf8")
const messages = readFileSync(
  join(ROOT, "webview-ui", "src", "types", "messages", "extension-messages.ts"),
  "utf8",
)
const prompt = readFileSync(join(ROOT, "webview-ui", "src", "components", "chat", "PromptInput.tsx"), "utf8")

describe("queued button → pull-back affordance (kilo-ui)", () => {
  it("renders the queued action as an arrow-left pull-back button", () => {
    const start = messagePart.indexOf("props.queued === true")
    const end = messagePart.indexOf("props.onFork", start)
    const block = messagePart.slice(start, end)
    expect(block).toContain('icon="arrow-left"')
    expect(block).toContain('i18n.t("ui.message.pullBackQueued")')
    expect(block).toContain("props.onPullBack")
    expect(block).not.toContain('icon="close"')
    expect(block).not.toContain("ui.message.cancelQueued")
    expect(block).not.toContain("onCancel")
  })

  it("declares the onPullBack prop and drops onCancel", () => {
    expect(messagePart).toMatch(/onPullBack\?: \(\) => void/)
    expect(messagePart).not.toMatch(/onCancel\?: \(\) => void/)
  })
})

describe("TranscriptRow → session.pullBackQueued wiring", () => {
  it("passes onPullBack through VscodeUserMessage", () => {
    expect(vscodeUser).toContain("onPullBack?: () => void")
    expect(vscodeUser).toContain("onPullBack={props.onPullBack}")
    expect(vscodeUser).not.toContain("onCancel")
  })

  it("wires queued rows to session.pullBackQueued and not cancelQueued", () => {
    expect(transcript).toContain("session.pullBackQueued(row().message.sessionID, row().message.id)")
    expect(transcript).not.toContain("session.cancelQueued")
    expect(transcript).not.toContain("onCancel")
  })
})

describe("session context pull-back implementation", () => {
  it("replaces the cancelQueued action with pullBackQueued in the context contract", () => {
    expect(session).toContain("pullBackQueued: (sessionID: string, messageID: string) => void")
    expect(session).not.toContain("cancelQueued: (sessionID: string, messageID: string) => void")
    expect(session).not.toMatch(/^\s*cancelQueued,\s*$/m)
  })

  it("defers the restore: pullBackQueued registers pending and posts only cancelQueued", () => {
    const start = session.indexOf("function pullBackQueued")
    const end = session.indexOf("function syncSession", start)
    const block = session.slice(start, end)
    expect(block).toContain("pullBacks.pending.set(messageID, sessionID)")
    expect(block).toContain('vscode.postMessage({ type: "cancelQueued", sessionID, messageID })')
    // No capture or restore at click time — the composer must not be touched
    // until the backend confirms removal via message.removed.
    expect(block).not.toContain("setChatBoxMessage")
    expect(block).not.toContain("capturePullBack")
    expect(block).not.toContain("window.postMessage")
  })

  it("restores on removal confirmation only for non-empty capture and clears pending", () => {
    const start = session.indexOf("function handleMessageRemoved")
    const end = session.indexOf("function handleCloudSessionDataLoaded", start)
    const block = session.slice(start, end)
    expect(block).toContain("pullBacks.pending.get(messageID)")
    expect(block).toContain("pullBacks.pending.delete(messageID)")
    expect(block).toContain("capturePullBack(getParts(messageID))")
    // The restore post is guarded by non-empty content — an empty capture must
    // never wipe the composer (LOCK-002).
    expect(block).toContain("if (text || images.length > 0 || paths.length > 0 || review.length > 0)")
    expect(block).toContain('window.postMessage({ type: "setChatBoxMessage", text, paths, images, review, focus: true }, "*")')
    const guard = block.indexOf("if (text ||")
    const post = block.indexOf('window.postMessage({ type: "setChatBoxMessage"')
    expect(guard).toBeGreaterThan(-1)
    expect(post).toBeGreaterThan(guard)
  })

  it("wires the pending lifecycle through the extracted helper", () => {
    // session.tsx delegates the pending map + cleanup effect to the helper and
    // passes the queued-message derivation inputs through it.
    expect(session).toContain("createPendingPullBacks((sid) => statusMap[sid] ?? idle, (sid) => store.messages[sid], getParts)")
    expect(session).toContain('import { createPendingPullBacks } from "./session-pull-back"')
    expect(session).not.toContain("pendingPullBacksTick")
  })

  it("drops pending entries whose message leaves the queued set without removal", () => {
    // The prune decision uses both derivations and prunes only when the
    // message is neither queued nor the active/pending slot — the active-slot
    // exception closes the over-prune window between the preceding turn's
    // completion and the slot's promotion.
    expect(pullBackHelper).toContain("queuedUserMessageIDs(messages, status, (msg) => getParts(msg.id))")
    expect(pullBackHelper).toContain("activeUserMessageID(messages, status, (msg) => getParts(msg.id))")
    expect(pullBackHelper).toContain("return !queued.has(messageID) && active !== messageID")
    expect(pullBackHelper).toContain("if (shouldPrunePendingPullBack(messageID, msgs, status, getParts)) pending.delete(messageID)")
    expect(pullBackHelper).toContain("createSignal")
    expect(pullBackHelper).toContain("createEffect")
    // The cleanup path never restores — it only forgets the pending request.
    expect(pullBackHelper).not.toContain("setChatBoxMessage")
    expect(pullBackHelper).not.toContain("window.postMessage")
  })
})

describe("SetChatBoxMessage payload shape", () => {
  it("carries optional images, review, paths, and a focus flag for composer restore", () => {
    const start = messages.indexOf("export interface SetChatBoxMessage")
    const end = messages.indexOf("export interface AppendChatBoxMessage", start)
    const block = messages.slice(start, end)
    expect(block).toContain("images?: ImageAttachment[]")
    expect(block).toContain("review?: ReviewComment[]")
    expect(block).toContain("paths?: string[]")
    expect(block).toContain("focus?: boolean")
  })
})

describe("PromptInput setChatBoxMessage handler", () => {
  it("restores images and review only when present, keeping revert semantics", () => {
    const start = prompt.indexOf('if (message.type === "setChatBoxMessage")')
    const end = prompt.indexOf('if (message.type === "appendChatBoxMessage")', start)
    const block = prompt.slice(start, end)
    expect(block).toContain("if (message.images) imageAttach.replace(message.images)")
    expect(block).toContain("if (message.review) replaceReviewComments(message.review)")
    // Exactly one replace call, always behind the guard — revertSession posts
    // text+paths only and must not clear images/review the user is composing.
    const replaces = block.match(/imageAttach\.replace\(message\.images\)/g) ?? []
    expect(replaces).toHaveLength(1)
    expect(block).toContain("if (message.paths?.length) mention.seedFromParts(message.paths, message.text)")
    expect(block).toContain("else mention.seedFromText(message.text)")
    expect(block).toContain("textareaRef.value = message.text")
    // The pull-back restore requests focus so the user can immediately re-edit;
    // the revert path posts without the flag and keeps its non-focus behavior.
    expect(block).toContain("if (message.focus) textareaRef.focus()")
  })
})
