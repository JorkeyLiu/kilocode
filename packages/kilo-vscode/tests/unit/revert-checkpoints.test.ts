import { describe, expect, it } from "bun:test"
import fs from "node:fs"
import path from "node:path"

const ROOT = path.resolve(import.meta.dir, "../..")
// P3.2: the turn renderer is TranscriptRowView (VscodeSessionTurn was removed
// with the custom diff surface); the H-12 revert contract is asserted against
// the production component.
const TURN_FILE = path.join(ROOT, "webview-ui/src/components/chat/TranscriptRow.tsx")
const PROVIDER_FILE = path.join(ROOT, "src/KiloProvider.ts")

const src = fs.readFileSync(TURN_FILE, "utf-8")
const provider = fs.readFileSync(PROVIDER_FILE, "utf-8")

function method(name: string, next: string) {
  const start = provider.indexOf(`  private async ${name}`)
  const end = provider.indexOf(`  private async ${next}`, start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return provider.slice(start, end)
}

describe("message revert checkpoints", () => {
  it("keeps revert actions available after a session is already reverted", () => {
    expect(src).toMatch(/onRevert=\{\s*row\(\)\.answered\s*\? \(\) =>/)
    expect(src).not.toMatch(/onRevert=\{[\s\S]*?&& !session\.revert\(\)[\s\S]*?\? \(\) =>/)
  })

  it("only marks revert disabled while the agent is busy", () => {
    expect(src).toMatch(/data-revert-disabled=\{\s*row\(\)\.answered && session\.status\(\) !== "idle"/)
    expect(src).not.toMatch(/data-revert-disabled=\{[\s\S]*?!session\.revert\(\)/)
  })
})

describe("revert session synchronization", () => {
  it("keeps REST responses as the mutation result", () => {
    const revert = method("handleRevertSession", "handleUnrevertSession")
    const unrevert = method("handleUnrevertSession", "handleCancelQueued")

    expect(revert).toContain("await this.client.session.revert")
    expect(unrevert).toContain("await this.client.session.unrevert")
    expect(revert).toContain('type: "sessionUpdated"')
    expect(unrevert).toContain('type: "sessionUpdated"')
  })

  it("uses ordered sync snapshots instead of duplicate bus snapshots", () => {
    expect(provider).toMatch(/source: "sync"/)
    expect(provider).toMatch(
      /if \(event\.type === "session\.updated"\) return "source" in event && event\.source === "sync"/,
    )
    expect(provider).toMatch(/if \(!isLegacySyncEvent\(event\)\) return/)
    const syncBlock = provider.slice(
      provider.indexOf('if (event.type === "session.updated") {'),
      provider.indexOf('if (event.type === "global.disposed")'),
    )
    expect(syncBlock.indexOf("if (!isLegacySyncEvent(event)) return")).toBeGreaterThan(-1)
    expect(syncBlock.indexOf("this.revisions.set(sid, { id: event.id, seq: event.seq })")).toBeGreaterThan(
      syncBlock.indexOf("if (!isLegacySyncEvent(event)) return"),
    )
    expect(syncBlock).toContain("event.seq <= revision.seq")
    expect(provider).toContain("sdkSessionToDetail(event.properties.info")
    const currentBlock = provider.slice(provider.indexOf('if (event.type === "session.updated" && this.currentSession'))
    expect(currentBlock).toContain("sdkSessionToDetail(event.properties.info")
    expect(currentBlock.indexOf("sdkSessionToDetail(event.properties.info")).toBeLessThan(
      currentBlock.indexOf("this.setCurrentSession(detail)"),
    )
  })
})
