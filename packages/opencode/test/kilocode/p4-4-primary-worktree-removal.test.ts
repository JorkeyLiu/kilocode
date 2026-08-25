import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

// P4.4-T2 source-removal evidence — orphaned primary-worktree mirror-read helper
// physically removed (managed worktree infrastructure permanently removed,
// canonical project assets live only under first workspace root .kilo boundary).
// - `packages/opencode/src/kilocode/primary-worktree.ts` deleted (no production
//   consumer; only direct test `primary-worktree.test.ts` existed).
// - Direct test `packages/opencode/test/kilocode/primary-worktree.test.ts` deleted
//   and its glob entry removed from `script/kilocode/test-profile.ts`.
// - No production source may reference `primaryPaths`/`primaryWorktree` or
//   `primary-worktree` import surface after the canonical `canonicalRoot`
//   cutover. `ConfigPaths` and legacy-reader cutover proofs remain untouched.
// - Worktree-removal regression now asserts absence (P4.4 exception closed).
// Spec anchors: runtime §8.1/R5; P4.4 evidence matrix rows 6/8; tracker §7 rows 6/8.
// This file asserts absence of the helper module/import surface; it does not
// claim P4.4 completion or transport narrowing (existing HTTP/SSE bridge remains).

const opencode = join(import.meta.dir, "../../src")
const repo = resolve(join(import.meta.dir, "../../../../"))

function read(rel: string): string {
  return readFileSync(join(opencode, rel), "utf8")
}

function readRepo(rel: string): string {
  return readFileSync(join(repo, rel), "utf8")
}

describe("P4.4 primary-worktree removal — orphaned helper physically absent", () => {
  test("helper module and its direct test are deleted", () => {
    expect(existsSync(join(opencode, "kilocode/primary-worktree.ts"))).toBe(false)
    expect(existsSync(join(repo, "packages/opencode/test/kilocode/primary-worktree.test.ts"))).toBe(false)
  })

  test("no production source references the helper import or symbols", () => {
    const files = [
      "config/config.ts",
      "kilocode/config/config.ts",
      "kilocode/config/overlay.ts",
      "skill/index.ts",
      "config/paths.ts",
    ]
    for (const file of files) {
      const src = read(file)
      expect(src, `${file} must not import primary-worktree`).not.toContain("primary-worktree")
      expect(src, `${file} must not reference primaryPaths`).not.toContain("primaryPaths")
      expect(src, `${file} must not reference primaryWorktree`).not.toContain("primaryWorktree")
    }
  })

  test("CLI source tree contains no helper surface", () => {
    let combined = ""
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          if (entry.name === "node_modules" || entry.name === ".git") continue
          walk(full)
        } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
          combined += readFileSync(full, "utf8") + "\n"
        }
      }
    }
    walk(opencode)
    expect(combined).not.toContain("primaryPaths")
    expect(combined).not.toContain("primaryWorktree")
    expect(combined).not.toContain("primary-worktree")
  })

  test("test-profile no longer lists the deleted direct test", () => {
    const profile = readRepo("packages/opencode/script/kilocode/test-profile.ts")
    expect(profile).not.toContain("kilocode/primary-worktree.test.ts")
    expect(profile).toContain("p4-4-primary-worktree-removal")
  })

  test("canonical-root and ConfigPaths behavior remains", () => {
    // Must preserve canonical-root handling and ConfigPaths legacy surface.
    expect(read("kilocode/config/config.ts")).toContain("canonicalRoot")
    expect(read("kilocode/config/overlay.ts")).toContain("canonicalRoot")
    expect(read("config/paths.ts")).toContain("Flag.KILO_CONFIG_DIR")
    expect(read("config/paths.ts")).toContain('targets: [".kilocode", ".kilo"]')
  })
})
