import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// P3.3: cloud sessions (preview/import/fork) and KiloClaw are permanently
// removed (LOCK-003). These static guards assert structural absence across the
// opencode source, HTTP group/handlers, and CLI/TUI, while preserving the
// retained shared semantics (remote sessions, generic SessionImport,
// EventServiceClient/presence, non-removed gateway endpoints).
const opencode = join(import.meta.dir, "../../src")

function read(path: string): string {
  return readFileSync(path, "utf8")
}

describe("cloud-sessions + KiloClaw structural absence (opencode)", () => {
  test("cloud-session module and claw TUI directory are absent", () => {
    const cloud = join(opencode, "kilocode/cloud-session.ts")
    const clawDir = join(opencode, "kilocode/claw")
    const dialogSetup = join(opencode, "kilocode/components/dialog-claw-setup.tsx")
    const dialogUpgrade = join(opencode, "kilocode/components/dialog-claw-upgrade.tsx")
    expect(() => readFileSync(cloud, "utf8")).toThrow()
    expect(() => readFileSync(clawDir, "utf8")).toThrow()
    expect(() => readFileSync(dialogSetup, "utf8")).toThrow()
    expect(() => readFileSync(dialogUpgrade, "utf8")).toThrow()
  })

  test("no cloud/claw CLI flags, fork helpers, or import helpers remain", () => {
    const run = read(join(opencode, "cli/cmd/run.ts"))
    const thread = read(join(opencode, "cli/cmd/tui/thread.ts"))
    const attach = read(join(opencode, "cli/cmd/tui/attach.ts"))
    const summary = read(join(opencode, "session/summary.ts"))
    for (const src of [run, thread, attach, summary]) {
      expect(src).not.toContain("cloud-fork")
      expect(src).not.toContain("cloudFork")
      expect(src).not.toContain("importCloudSession")
      expect(src).not.toContain("validateCloudFork")
    }
  })

  test("no KiloClaw TUI route, command, or view wiring remains", () => {
    const route = read(join(opencode, "cli/cmd/tui/context/route.tsx"))
    const api = read(join(opencode, "cli/cmd/tui/plugin/api.tsx"))
    const app = read(join(opencode, "cli/cmd/tui/app.tsx"))
    const kiloApp = read(join(opencode, "kilocode/cli/cmd/tui/app.tsx"))
    const commands = read(join(opencode, "kilocode/kilo-commands.tsx"))
    for (const src of [route, api, app, kiloApp, commands]) {
      expect(src).not.toContain("kiloclaw")
      expect(src).not.toContain("KiloClaw")
    }
  })

  test("no cloud or KiloClaw gateway endpoints remain in the kilo group", () => {
    const group = read(join(opencode, "kilocode/server/httpapi/groups/kilo-gateway.ts"))
    const handlers = read(join(opencode, "kilocode/server/httpapi/handlers/kilo-gateway.ts"))
    for (const surface of ["cloudSessions", "cloudSessionImport", "clawStatus", "clawChatCredentials"]) {
      expect(group).not.toContain(surface)
      expect(handlers).not.toContain(surface)
    }
    expect(group).not.toContain("/kilo/cloud")
    expect(group).not.toContain("/kilo/claw")
    // Retained gateway endpoints survive.
    expect(group).toContain("organization")
    expect(group).toContain("notifications")
    expect(group).toContain("profile")
  })

  test("preserved shared semantics remain (remote, SessionImport, presence)", () => {
    const remoteGroup = read(join(opencode, "kilocode/server/httpapi/groups/remote.ts"))
    const sessionImport = read(join(opencode, "kilocode/server/httpapi/groups/session-import.ts"))
    const presence = read(join(opencode, "kilocode/presence/service.ts"))
    expect(sessionImport).toContain("SessionImportApi")
    expect(presence).toContain("KILO_EVENT_SERVICE_URL")
    // Remote session sync and generic SessionImport routes survive.
    expect(remoteGroup).toContain("/remote")
    expect(sessionImport).toContain("kilocode.sessionImport")
  })
})
