import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { Installation } from "../../../src/installation"
import { InstallationVersion } from "@opencode-ai/core/installation/version"

const opencode = join(import.meta.dir, "../../../src")

function read(rel: string): string {
  return readFileSync(join(opencode, rel), "utf8")
}

describe("standalone self-upgrade removal", () => {
  test("Installation module exposes method only (no latest/upgrade/info)", async () => {
    expect("latest" in Installation).toBe(false)
    expect("upgrade" in Installation).toBe(false)
    expect("info" in Installation).toBe(false)
    expect(typeof Installation.method).toBe("function")
  })

  test("no headless auto-upgrade module remains", async () => {
    expect(await Bun.file(join(opencode, "cli/upgrade.ts")).exists()).toBe(false)
    expect(await Bun.file(join(opencode, "cli/cmd/upgrade.ts")).exists()).toBe(false)
    expect(read("cli/cmd/tui/worker.ts")).not.toContain("cli/upgrade")
    expect(read("cli/cmd/tui/worker.ts")).not.toContain("checkUpgrade")
    expect(read("cli/cmd/tui/thread.ts")).not.toContain("checkUpgrade")
    expect(read("cli/cmd/tui/app.tsx")).not.toContain("installation.update-available")
    expect(read("cli/cmd/tui/app.tsx")).not.toContain("global.upgrade")
  })

  test("version display metadata is preserved", () => {
    expect(typeof InstallationVersion).toBe("string")
    expect(Installation.userAgent()).toContain(InstallationVersion)
  })
})
