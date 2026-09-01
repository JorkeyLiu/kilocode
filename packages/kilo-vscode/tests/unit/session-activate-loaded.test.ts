import { describe, it, expect } from "bun:test"
import fs from "node:fs"
import path from "node:path"

const ROOT = path.resolve(import.meta.dir, "../..")
const SESSION_FILE = path.join(ROOT, "webview-ui/src/context/session.tsx")
const EXT_MSG_FILE = path.join(ROOT, "webview-ui/src/types/messages/extension-messages.ts")
const PROVIDER_FILE = path.join(ROOT, "src/KiloProvider.ts")

const sessionSrc = fs.readFileSync(SESSION_FILE, "utf-8")
const extMsgSrc = fs.readFileSync(EXT_MSG_FILE, "utf-8")
const providerSrc = fs.readFileSync(PROVIDER_FILE, "utf-8")

describe("activateLoadedSession product transition", () => {
  it("extension message union includes activateSession", () => {
    expect(extMsgSrc).toContain("ActivateSessionMessage")
    expect(extMsgSrc).toContain('type: "activateSession"')
    expect(extMsgSrc).toContain("ActivateSessionMessage")
    expect(extMsgSrc).toMatch(/ExtensionMessage[\s\S]*ActivateSessionMessage/)
  })

  it("SessionProvider defines activateLoadedSession sharing state with selectSession but omitting fetch", () => {
    const activateIdx = sessionSrc.indexOf("function activateLoadedSession(")
    expect(activateIdx).toBeGreaterThan(-1)
    const nextFnIdx = sessionSrc.indexOf("function loadFocusedMessages(", activateIdx)
    const activateBody = sessionSrc.slice(activateIdx, nextFnIdx > -1 ? nextFnIdx : activateIdx + 800)
    expect(activateBody).toContain("setCurrentSessionID")
    expect(activateBody).toContain("setDraftSessionID")
    expect(activateBody).toContain("setUserClearedSession(false)")
    expect(activateBody).not.toContain("loadFocusedMessages")
    expect(activateBody).not.toContain('type: "loadMessages"')
    // must handle deferredFetch and loading
    expect(activateBody).toContain("deferredFetch = undefined")
    expect(activateBody).toContain("setLoading(false)")
  })

  it("selectSession and activateLoadedSession share applySessionSelectionState helper or equivalent", () => {
    // shared helper ensures same UI convergence
    expect(sessionSrc).toContain("function applySessionSelectionState")
    const selectIdx = sessionSrc.indexOf("function selectSession(")
    const activateIdx = sessionSrc.indexOf("function activateLoadedSession(")
    expect(selectIdx).toBeGreaterThan(-1)
    expect(activateIdx).toBeGreaterThan(-1)
    // selectSession uses helper
    const selectBody = sessionSrc.slice(selectIdx, selectIdx + 600)
    expect(selectBody).toContain("applySessionSelectionState")
    // activateLoadedSession mirrors select's local state but omits fetch
    const nextFnIdx = sessionSrc.indexOf("function loadFocusedMessages(", activateIdx)
    const activateBody = sessionSrc.slice(activateIdx, nextFnIdx > -1 ? nextFnIdx : activateIdx + 800)
    expect(activateBody).toContain("setCurrentSessionID")
    expect(activateBody).not.toContain("loadFocusedMessages")
  })

  it("handleExtensionMessage routes activateSession to activateLoadedSession", () => {
    expect(sessionSrc).toContain('case "activateSession":')
    const handlerIdx = sessionSrc.indexOf('case "activateSession":')
    const slice = sessionSrc.slice(handlerIdx, handlerIdx + 200)
    expect(slice).toContain("activateLoadedSession")
  })

  it("KiloProvider strict path posts activateSession after messagesLoaded without second fetch", () => {
    const strictIdx = providerSrc.indexOf("loadMessagesStrict")
    expect(strictIdx).toBeGreaterThan(-1)
    const doLoadIdx = providerSrc.indexOf("private async doLoadMessages")
    const doLoadBody = providerSrc.slice(doLoadIdx, doLoadIdx + 12000)
    // strict posts activateSession after messagesLoaded
    expect(doLoadBody).toContain("this.postMessage({")
    expect(doLoadBody).toContain("messagesLoaded")
    expect(doLoadBody).toContain("activateSession")
    const msgIdx = doLoadBody.indexOf("messagesLoaded")
    const actIdx = doLoadBody.indexOf("activateSession")
    expect(actIdx).toBeGreaterThan(msgIdx)
    // ensure strict guard: only when strict
    expect(doLoadBody).toContain("if (strict) this.activateSession")
  })

  it("KiloProvider exposes activateSession helper", () => {
    expect(providerSrc).toContain("public activateSession(")
    expect(providerSrc).toContain('type: "activateSession"')
  })

  it("generic welcome remains unchanged — zero-arg path does not require activation", () => {
    // extension.ts generic path check
    const extFile = fs.readFileSync(path.join(ROOT, "src/extension.ts"), "utf-8")
    expect(extFile).toContain('if (typeof targetSessionId === "string" && targetSessionId.length > 0)')
    // session.tsx clearCurrentSession keeps welcome
    expect(sessionSrc).toContain("function clearCurrentSession()")
    const clearBody = sessionSrc.slice(
      sessionSrc.indexOf("function clearCurrentSession()"),
      sessionSrc.indexOf("function clearCurrentSession()") + 400,
    )
    expect(clearBody).toContain("setCurrentSessionID(undefined)")
  })

  it("no synthetic sessionsLoaded injection remains in strict path", () => {
    const start = providerSrc.indexOf("private async doLoadMessages")
    const end = providerSrc.indexOf("private async handleSyncSession", start)
    const doLoadBody = providerSrc.slice(start, end > -1 ? end : start + 12000)
    expect(doLoadBody).not.toContain("sessionsLoaded")
    // strict legitimately posts sessionCreated/sessionUpdated for metadata + messagesLoaded + activateSession
    expect(doLoadBody).toContain("messagesLoaded")
    expect(doLoadBody).toContain("activateSession")
  })
})
