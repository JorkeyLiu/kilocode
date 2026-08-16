// kilocode_change - new file
//
// Static guard that the JetBrains product (LOCK-003 permanent removal) leaves no
// active integration in this repository. It scans committed files for JetBrains
// product surfaces that would otherwise be silently re-added or left orphaned:
// the package directory, JetBrains-only workflows, workflow allowlist entries,
// turbo tasks, release scripts/skills, container images, and CI build filters.
//
// Shared dependencies that are NOT the JetBrains product and must survive are
// intentionally not asserted here: the generic Kotlin LSP download URL and
// extractor exclusion, the JetBrains Mono font asset and i18n name, historical
// CHANGELOG entries, the generic KILO_CLIENT/KILO_PLATFORM protocol, shared
// provider icons, retained CLI distributions, and legacy archive redirects.

import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import path from "node:path"

const ROOT = path.resolve(import.meta.dir, "../../..")

const JETBRAINS_WORKFLOWS = [
  "test-jetbrains.yml",
  "publish-jetbrains.yml",
  "prepare-jetbrains-release.yml",
  "codeql-kotlin.yml",
]

function read(rel: string): string {
  return readFileSync(path.join(ROOT, rel), "utf8")
}

describe("JetBrains product absence", () => {
  test("the kilo-jetbrains package directory is removed", () => {
    expect(existsSync(path.join(ROOT, "packages/kilo-jetbrains"))).toBe(false)
  })

  test("JetBrains-only workflows are deleted and absent from the allowlist", () => {
    const workflows = readdirSync(path.join(ROOT, ".github/workflows"))
    for (const name of JETBRAINS_WORKFLOWS) {
      expect(workflows, `workflow still present: ${name}`).not.toContain(name)
    }
    const allowlist = read("script/check-workflows.ts")
    for (const name of JETBRAINS_WORKFLOWS) {
      expect(allowlist, `workflow still allowlisted: ${name}`).not.toContain(name)
    }
  })

  test("no turbo task references the kilo-jetbrains package", () => {
    const turbo = read("turbo.json")
    expect(turbo).not.toContain("kilo-jetbrains")
    expect(turbo).not.toMatch(/kilo-jetbrains#/)
  })

  test("JetBrains release scripts and skill are removed", () => {
    expect(existsSync(path.join(ROOT, "script/jetbrains-release-pr.ts"))).toBe(false)
    expect(existsSync(path.join(ROOT, "script/jetbrains-release-validate.ts"))).toBe(false)
    expect(existsSync(path.join(ROOT, ".kilo/skills/release-jetbrains"))).toBe(false)
  })

  test("shared workflows carry no JetBrains build/test filters or jobs", () => {
    for (const rel of [".github/workflows/test.yml", ".github/workflows/typecheck.yml", "script/publish.ts"]) {
      const content = read(rel)
      expect(content, `${rel} still filters/job @kilocode/kilo-jetbrains`).not.toContain("kilo-jetbrains")
      expect(content, `${rel} still references test-jetbrains.yml`).not.toContain("test-jetbrains.yml")
    }
  })

  test("container build list and docs contain no JetBrains image", () => {
    expect(read("packages/containers/script/build.ts")).not.toContain("jetbrains")
    expect(read("packages/containers/README.md")).not.toMatch(/\bjetbrains\b/)
  })

  test("architecture checker maps no JetBrains source paths", () => {
    expect(read("script/check-architecture-impact.ts")).not.toContain("kilo-jetbrains")
  })
})
