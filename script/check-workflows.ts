#!/usr/bin/env bun

/**
 * Keeps an explicit inventory of the workflows allowed to run in CI.
 *
 * GitHub runs every `.yml` / `.yaml` file under `.github/workflows/`, so a
 * workflow that appears there runs with repository privileges whether it was
 * added deliberately or arrived as an unvetted change. This check makes that
 * decision explicit: the list of allowed workflows is hardcoded below, and any
 * drift (added or removed file in `.github/workflows/`) fails CI until the
 * list is updated deliberately.
 *
 * Only runnable workflows are checked (`.yml` / `.yaml`). Files under
 * `.github/workflows/disabled/` can't run, so they're not tracked here.
 *
 * To accept a new workflow: add its filename to `active`.
 * To drop one: remove its filename from the list.
 */

import { readdirSync } from "node:fs"
import path from "node:path"

const ROOT = path.resolve(import.meta.dir, "..")
const DIR = path.join(ROOT, ".github", "workflows")

// Workflows we have deliberately accepted into CI. Sort alphabetically.
const active = new Set([
  "auto-docs.yml",
  "beta.yml",
  "check-architecture-impact.yml",
  "check-forbidden-strings.yml",
  "check-kilo-generated-artifacts.yml",
  "check-md-table-padding.yml",
  "check-org-member.yml",
  "check-repository-guards.yml",
  "codeql.yml",
  "containers.yml",
  "docs-build.yml",
  "docs-check-links.yml",
  "generate.yml",
  "kilo-auto-close.yml",
  "nix-eval.yml",
  "nix-hashes.yml",
  "publish.yml",
  "smoke-test.yml",
  "source-check-links.yml",
  "test-vscode.yml",
  "test.yml",
  "typecheck.yml",
  "visual-regression.yml",
  "vscode-e2e.yml",
])

// GitHub picks up both .yml and .yaml in .github/workflows/. We accept both so
// a `.yaml` addition also shows up as unexpected drift.
const isWorkflow = (f: string) => f.endsWith(".yml") || f.endsWith(".yaml")
const actualActive = new Set(readdirSync(DIR).filter(isWorkflow))

const missing = [...active].filter((f) => !actualActive.has(f)).sort()
const extra = [...actualActive].filter((f) => !active.has(f)).sort()
const errs: string[] = []
for (const f of extra) {
  errs.push(`unexpected workflow: ${f} — if this was added intentionally, add it to script/check-workflows.ts`)
}
for (const f of missing) {
  errs.push(
    `expected workflow not found: ${f} — if this was removed intentionally, remove it from script/check-workflows.ts`,
  )
}

if (errs.length === 0) {
  console.log(`check-workflows: ok (${actualActive.size} workflows).`)
  process.exit(0)
}

for (const e of errs) console.error(e)
console.error("")
console.error(`Found ${errs.length} workflow inventory issue(s).`)
console.error("The workflow inventory must be updated deliberately when workflows are added or removed.")
process.exit(1)
