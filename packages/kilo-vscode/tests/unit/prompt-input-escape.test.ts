import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const promptPath = join(__dirname, "..", "..", "webview-ui", "src", "components", "chat", "PromptInput.tsx")
const chatPath = join(__dirname, "..", "..", "webview-ui", "src", "components", "chat", "ChatView.tsx")
const slashPath = join(__dirname, "..", "..", "webview-ui", "src", "hooks", "useSlashCommand.ts")
const mentionPath = join(__dirname, "..", "..", "webview-ui", "src", "hooks", "useFileMention.ts")
const prompt = readFileSync(promptPath, "utf8")
const chat = readFileSync(chatPath, "utf8")
const slash = readFileSync(slashPath, "utf8")
const mention = readFileSync(mentionPath, "utf8")

describe("Escape must not abort a session", () => {
  it("removes the document-level Escape abort path from ChatView", () => {
    // The deleted path was an onMount document keydown listener whose Escape
    // branch called session.abort(); its registration/cleanup lines are the
    // fingerprint. Unrelated document keydown listeners (any other handler)
    // and explicit abort controls (buttons, no document listener) stay allowed.
    expect(chat).not.toContain('document.addEventListener("keydown", handler)')
    expect(chat).not.toContain('onCleanup(() => document.removeEventListener("keydown", handler))')
  })

  it("removes the busy Escape abort branch from PromptInput keydown", () => {
    const start = prompt.indexOf("const handleKeyDown = (e: KeyboardEvent) => {")
    const end = prompt.indexOf("const canEnhance", start)
    const keydown = prompt.slice(start, end)

    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    expect(keydown).not.toContain("session.abort()")
    expect(keydown).not.toContain('e.key === "Escape" && isBusy()')
  })

  it("keeps the explicit stop button abort control", () => {
    expect(prompt).toContain("onClick={() => session.abort()}")
  })

  it("keeps overlay-local Escape handlers in slash and file-mention hooks", () => {
    expect(slash).toContain('if (e.key === "Escape")')
    expect(mention).toContain('if (e.key === "Escape")')
  })
})
