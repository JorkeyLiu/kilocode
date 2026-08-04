/**
 * Extension remote-notification subsystem removal contract (LOCK-003/004).
 *
 * Static analysis — proves the VS Code extension no longer references the
 * removed homepage remote notification promotion subsystem (fetch, render,
 * dismiss, reset, story, i18n, styles) while the shared operational system
 * notification settings path is preserved.
 *
 * The banned-identifier scan is recursive: every TypeScript/TSX/CSS source
 * file under the extension (`src/`) and webview (`webview-ui/`) trees is
 * checked, so reintroduction of the subsystem in a new file path is caught
 * instead of escaping a fixed file list.
 */

import { describe, expect, it } from "bun:test"
import { Glob } from "bun"
import fs from "node:fs"
import path from "node:path"

const ROOT = path.resolve(import.meta.dir, "../..")

/** Identifiers exclusive to the removed remote promotion subsystem. */
const BANNED = [
  "KiloNotifications",
  "NotificationsProvider",
  "NotificationsContext",
  "useNotifications",
  "requestNotifications",
  "dismissNotification",
  "fetchAndSendNotifications",
  "notifyNotificationDismissed",
  "onNotificationDismissed",
  "notificationsLoaded",
  "resetReadNotifications",
  "KilocodeNotification",
  "NOTIFICATION_CLICKED",
  "kilo-notifications",
  "notifications.action",
  "resetSettings.notificationsButton",
]

const SOURCE_ROOTS = ["src", "webview-ui"]

/**
 * Recursively enumerate every source file under the extension and webview
 * trees. `node_modules`/`dist`/`out` and the guard test itself are excluded
 * by natural root choice. Sorted for deterministic output.
 */
function listSourceFiles(): string[] {
  const glob = new Glob("**/*.{ts,tsx,css}")
  const files: string[] = []
  for (const root of SOURCE_ROOTS) {
    const dir = path.join(ROOT, root)
    for (const rel of glob.scanSync({ cwd: dir })) {
      files.push(path.join(root, rel))
    }
  }
  return files.sort()
}

const SOURCE_FILES = listSourceFiles()

const DELETED_FILES = [
  "src/kilo-provider/notifications.ts",
  "webview-ui/src/components/chat/KiloNotifications.tsx",
  "webview-ui/src/context/notifications.tsx",
  "webview-ui/src/styles/notifications.css",
]

/** i18n keys exclusive to the removed subsystem, flat-key format. */
const BANNED_I18N_KEYS = [
  '"settings.aboutKiloCode.resetSettings.notificationsButton"',
  '"notifications.action.next"',
  '"notifications.action.close"',
  '"notifications.action.tryModel"',
  '"notifications.action.tryModelGeneric"',
]

function readFile(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), "utf-8")
}

function exists(rel: string): boolean {
  return fs.existsSync(path.join(ROOT, rel))
}

describe("Extension remote notification subsystem removal", () => {
  it("removed subsystem source files stay deleted", () => {
    for (const file of DELETED_FILES) {
      expect(exists(file), `${file} should remain deleted`).toBe(false)
    }
  })

  it("extension and webview sources no longer reference exclusive identifiers", () => {
    expect(SOURCE_FILES.length).toBeGreaterThan(0)
    for (const file of SOURCE_FILES) {
      const source = readFile(file)
      for (const id of BANNED) {
        expect(source, `${file} must not contain "${id}"`).not.toContain(id)
      }
    }
  })

  it("agent-manager provider chains no longer wrap NotificationsProvider", () => {
    const app = readFile("webview-ui/src/App.tsx")
    const agent = readFile("webview-ui/agent-manager/AgentManagerApp.tsx")
    expect(app).not.toContain("NotificationsProvider")
    expect(agent).not.toContain("NotificationsProvider")
  })

  it("message type unions no longer include notification load/dismiss messages", () => {
    const extension = readFile("webview-ui/src/types/messages/extension-messages.ts")
    const webview = readFile("webview-ui/src/types/messages/webview-messages.ts")
    expect(extension).not.toContain("NotificationsLoadedMessage")
    expect(webview).not.toContain("RequestNotificationsMessage")
    expect(webview).not.toContain("DismissNotificationMessage")
    expect(webview).not.toContain("ResetReadNotificationsRequest")
  })

  it("i18n files no longer contain the exclusive notification keys", () => {
    const dir = path.join(ROOT, "webview-ui/src/i18n")
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".ts"))
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const source = fs.readFileSync(path.join(dir, file), "utf-8")
      for (const key of BANNED_I18N_KEYS) {
        expect(source, `${file} must not contain ${key}`).not.toContain(key)
      }
    }
  })

  it("preserves the operational system notification settings path", () => {
    const provider = readFile("src/KiloProvider.ts")
    expect(provider).toContain('case "requestNotificationSettings"')
    expect(provider).toContain("sendNotificationSettings")
    expect(provider).toContain('type: "notificationSettingsLoaded"')

    const extension = readFile("webview-ui/src/types/messages/extension-messages.ts")
    expect(extension).toContain('type: "notificationSettingsLoaded"')

    const webview = readFile("webview-ui/src/types/messages/webview-messages.ts")
    expect(webview).toContain('type: "requestNotificationSettings"')

    const settings = readFile("webview-ui/src/components/settings/Settings.tsx")
    expect(settings).toContain("NotificationsTab")
  })
})
