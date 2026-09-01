import { describe, expect, it } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"

const root = join(__dirname, "..", "..")

describe("TabPanel removal — ordinary tab strip absent", () => {
  it("deletes the ordinary SessionTabStrip and its local-tabs context", () => {
    expect(existsSync(join(root, "webview-ui", "src", "components", "chat", "SessionTabStrip.tsx"))).toBe(false)
    expect(existsSync(join(root, "webview-ui", "src", "context", "local-tabs.tsx"))).toBe(false)
  })

  it("keeps the shared SessionTab and SessionTabMenu for Agent Manager", () => {
    expect(existsSync(join(root, "webview-ui", "src", "components", "chat", "SessionTab.tsx"))).toBe(true)
    expect(existsSync(join(root, "webview-ui", "src", "components", "chat", "SessionTabMenu.tsx"))).toBe(true)
  })

  it("keeps the Agent Manager session tab registry", () => {
    expect(existsSync(join(root, "webview-ui", "agent-manager", "session-tabs.ts"))).toBe(true)
    expect(existsSync(join(root, "webview-ui", "agent-manager", "session-tab-manager.ts"))).toBe(true)
  })

  it("keeps the shared local-tabs utils for legacy import", () => {
    expect(existsSync(join(root, "webview-ui", "src", "utils", "local-tabs.ts"))).toBe(true)
  })
})
