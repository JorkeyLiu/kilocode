// kilocode_change - new file

import { describe, expect, test } from "bun:test"
import { readFileSync, statSync } from "node:fs"
import path from "node:path"

const HOOK = path.resolve(import.meta.dir, "../../../.husky/pre-commit")
const hook = readFileSync(HOOK, "utf8")

describe(".husky/pre-commit", () => {
  test("is an executable sh script with a Kilo-owned new-file marker", () => {
    expect(hook.startsWith("#!/bin/sh\n")).toBe(true)
    // The shared-path hook is marked Kilo-owned right after the shebang so
    // upstream merges recognize it as a Kilo addition.
    const off = hook.indexOf("\n") + 1
    expect(hook.startsWith("# kilocode_change - new file\n", off)).toBe(true)
    expect(hook.startsWith("set -e\n", off + "# kilocode_change - new file\n".length)).toBe(true)
    const mode = statSync(HOOK).mode
    expect(mode & 0o111).not.toBe(0)
  })

  test("runs the architecture-impact checker in advisory worktree mode", () => {
    expect(hook).toContain("check-architecture-impact.ts --worktree")
  })

  test("never blocks when the advisory checker fails", () => {
    // The checker call sits in an `if !` guard, so a non-zero exit only prints
    // a warning and `set -e` cannot turn it into a commit block.
    expect(hook).toMatch(/if ! bun run script\/check-architecture-impact\.ts --worktree; then/)
    expect(hook).toMatch(/warning:/)
  })

  test("skips clean worktrees naturally", () => {
    expect(hook).toMatch(/git diff --quiet HEAD/)
    expect(hook).toMatch(/git ls-files --others --exclude-standard/)
  })
})
