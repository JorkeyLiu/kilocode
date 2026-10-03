/**
 * Prompt readiness contract: runtime-needed send waits for the worker while
 * provider/model/agent selection stays canonical-file only.
 *
 * Static analysis — reads PromptInput.tsx (+ ChatView wiring) and verifies:
 * - send is gated on the existing connection lifecycle state
 *   (server.isConnected / connectionState), with an explicit waiting
 *   reason shown while the draft stays in the composer;
 * - no queued accepted operation: nothing is persisted, replayed, or
 *   auto-retried — handleSend returns early while disabled;
 * - single operation owner: session.sendMessage/sendCommand are issued only
 *   from handleSend;
 * - selectors are never disabled by worker state (canonical-file selection
 *   stays interactive before worker startup).
 */

import { describe, it, expect } from "bun:test"
import fs from "node:fs"
import path from "node:path"

const ROOT = path.resolve(import.meta.dir, "../..")
const PROMPT_FILE = path.join(ROOT, "webview-ui/src/components/chat/PromptInput.tsx")

function read(): string {
  return fs.readFileSync(PROMPT_FILE, "utf-8")
}

describe("prompt readiness — runtime-needed send waits for the worker", () => {
  it("gates send on the connection lifecycle state", () => {
    const s = read()
    expect(s).toContain("const isDisabled = () => !server.isConnected()")
    expect(s).toContain("!isDisabled()")
    expect(s).toContain('server.connectionState()')
  })

  it("shows an explicit waiting reason while disabled (no silent stall)", () => {
    const s = read()
    expect(s).toContain("prompt-input-waiting")
    expect(s).toContain("waitingReason")
    expect(s).toContain('role="status"')
    // Reuses existing copy — no new i18n churn.
    expect(s).toContain("prompt.placeholder.connecting")
    expect(s).toContain("session.status.offline")
  })

  it("creates no second operation owner and never queues/replays", () => {
    const s = read()
    // Exactly the two pre-existing dispatch sites (extension triggerTask +
    // composer handleSend) — this change adds no new owner.
    expect(s.match(/session\.sendMessage\(/g)?.length).toBe(2)
    expect(s.match(/session\.sendCommand\(/g)?.length).toBe(1)
    // Both send sites are gated on worker readiness.
    expect(s).toMatch(/if \(message\.type === "triggerTask"\) \{\s*if \(isDisabled\(\)\) return/)
    // Early return while disabled — the draft stays put, nothing fires.
    expect(s).toMatch(/if \(\(\!message && imgs\.length === 0\) \|\| isDisabled\(\)/)
    // No queued/replayed accepted operation.
    expect(s).not.toMatch(/pendingSubmit|queuedSend|sendQueue|replaySend|retrySend/i)
    expect(s).not.toContain("setTimeout(handleSend")
    expect(s).not.toContain("queueMicrotask(handleSend")
  })
})

describe("prompt readiness — selectors stay canonical-file only", () => {
  it("model/agent/thinking selectors are rendered without worker-state disable", () => {
    const s = read()
    expect(s).toContain("<ModeSwitcher sessionID={sid} />")
    expect(s).toContain("<ModelSelector sessionID={sid} />")
    expect(s).toContain("<ThinkingSelector sessionID={sid} />")
    // Selectors never receive a worker-derived disabled prop here.
    expect(s).not.toMatch(/<ModeSwitcher[^>]*disabled/)
    expect(s).not.toMatch(/<ModelSelector[^>]*disabled/)
    expect(s).not.toMatch(/<ThinkingSelector[^>]*disabled/)
  })
})
