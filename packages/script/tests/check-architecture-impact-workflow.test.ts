// kilocode_change - new file

// Wiring tests for the architecture-impact PR gate.
// These do NOT re-test the parser (see check-architecture-impact.test.ts); they
// statically verify the repo artifacts stay consistent with each other and
// simulate the workflow's trust flow against real temp repos:
//   - the PR template's `## Documentation Impact` section matches what the
//     parser reads, and filled-in template bodies parse cleanly
//   - the CI workflow keeps the gate on the locked event contract, reads the
//     PR body from $GITHUB_EVENT_PATH into a temp file (never shell
//     interpolation), and runs with least privilege
//   - the gate runs the checker revision from the base commit; the introducing
//     PR bootstraps from the head checker only when base lacks one, with an
//     explicit notice; base/head commit objects are verified and
//     fetched by explicit SHA, failing closed
//   - checkout/setup-bun are pinned to repository-approved commit SHAs
//   - the workflow allowlist guard still lists this workflow

import { describe, expect, test } from "bun:test"
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import os from "node:os"
import path from "node:path"
import { parseDeclaration } from "../../../script/check-architecture-impact"

const ROOT = path.resolve(import.meta.dir, "../../..")
const TEMPLATE = readFileSync(path.join(ROOT, ".github", "pull_request_template.md"), "utf8")
const WORKFLOW = readFileSync(path.join(ROOT, ".github", "workflows", "check-architecture-impact.yml"), "utf8")
const WORKFLOW_GUARD = readFileSync(path.join(ROOT, "script", "check-workflows.ts"), "utf8")

const SECTION = "## Documentation Impact"
const STATUS_UPDATED = "Architecture docs updated"
const STATUS_NA = "Not applicable"
const FIELD_DOCS = "Canonical docs:"
const FIELD_RATIONALE = "Rationale:"
const ARCH_DOC = "packages/kilo-docs/pages/contributing/architecture/cli-runtime.md"

// ─── PR template ↔ parser consistency ───────────────────────────────────────

describe("PR template Documentation Impact section", () => {
  test("template exposes exactly one section the parser can see", () => {
    const heads = TEMPLATE.split(/\r?\n/).filter((l) => l.trim() === SECTION)
    expect(heads).toHaveLength(1)
    // The heading must not live inside an HTML comment, or the parser misses it.
    expect(parseDeclaration(TEMPLATE).present).toBe(true)
  })

  test("status labels match the parser exactly", () => {
    for (const label of [STATUS_UPDATED, STATUS_NA]) {
      expect(TEMPLATE).toContain(`- [ ] ${label}`)
    }
  })

  test("field labels match the parser exactly", () => {
    expect(TEMPLATE).toContain(FIELD_DOCS)
    expect(TEMPLATE).toContain(FIELD_RATIONALE)
  })

  test("checking Architecture docs updated in the template parses cleanly", () => {
    const body = TEMPLATE
      .replace(`- [ ] ${STATUS_UPDATED}`, `- [x] ${STATUS_UPDATED}`)
      .replace("<doc>.md", "cli-runtime.md")
    const d = parseDeclaration(body)
    expect(d.present).toBe(true)
    expect(d.status).toBe("updated")
    expect(d.canonicalDocs).toEqual([ARCH_DOC])
    expect(d.errors).toEqual([])
  })

  test("checking Not applicable in the template parses cleanly", () => {
    const body = TEMPLATE
      .replace(`- [ ] ${STATUS_NA}`, `- [x] ${STATUS_NA}`)
      .replace("<why no architecture doc update is needed>", "No runtime lifecycle contract changed.")
    const d = parseDeclaration(body)
    expect(d.present).toBe(true)
    expect(d.status).toBe("not-applicable")
    expect(d.rationale).toBe("No runtime lifecycle contract changed.")
    expect(d.errors).toEqual([])
  })

  test("an unfilled template still fail-closes as expected", () => {
    const d = parseDeclaration(TEMPLATE)
    expect(d.errors.some((e) => e.includes("No status is checked"))).toBe(true)
  })
})

// ─── workflow event/security contract ───────────────────────────────────────

describe("check-architecture-impact.yml contract", () => {
  test("runs on opened/synchronize/reopened/edited so declaration edits rerun", () => {
    expect(WORKFLOW).toContain("pull_request:")
    expect(WORKFLOW).toContain("types: [opened, synchronize, reopened, edited]")
    for (const t of ["opened", "synchronize", "reopened", "edited"]) {
      expect(WORKFLOW).toContain(t)
    }
  })

  test("has no paths filter that could suppress body-edit reruns", () => {
    expect(WORKFLOW).not.toContain("paths:")
  })

  test("never uses pull_request_target", () => {
    expect(WORKFLOW).not.toContain("pull_request_target")
  })

  test("reads the body from $GITHUB_EVENT_PATH into a temp file, not a shell string", () => {
    expect(WORKFLOW).toContain("mktemp")
    expect(WORKFLOW).toContain('jq -r \'.pull_request.body // ""\' "$GITHUB_EVENT_PATH"')
    expect(WORKFLOW).toContain('> "$BODY_FILE"')
    expect(WORKFLOW).toContain("--pr-body-file")
  })

  test("passes base/head SHAs from the event as env, checked into argv only", () => {
    expect(WORKFLOW).toContain("BASE_SHA: ${{ github.event.pull_request.base.sha }}")
    expect(WORKFLOW).toContain("HEAD_SHA: ${{ github.event.pull_request.head.sha || github.sha }}")
    expect(WORKFLOW).toContain('--base "$BASE_SHA"')
    expect(WORKFLOW).toContain('--head "$HEAD_SHA"')
  })

  test("checks out the head SHA with full history for merge-base diffing", () => {
    expect(WORKFLOW).toContain("ref: ${{ github.event.pull_request.head.sha || github.sha }}")
    expect(WORKFLOW).toContain("fetch-depth: 0")
  })

  test("runs with least privilege (contents read, no write scopes)", () => {
    expect(WORKFLOW).toContain("permissions:")
    expect(WORKFLOW).toContain("contents: read")
    for (const scope of ["pull-requests: write", "issues: write", "checks: write", "contents: write"]) {
      expect(WORKFLOW).not.toContain(scope)
    }
  })

  test("per-PR concurrency cancels stale runs", () => {
    expect(WORKFLOW).toContain("concurrency:")
    expect(WORKFLOW).toContain("github.event.pull_request.number")
    expect(WORKFLOW).toContain("cancel-in-progress: true")
  })

  test("keeps the stable job name for branch-protection required checks", () => {
    const jobs = WORKFLOW.slice(WORKFLOW.indexOf("jobs:"))
    expect(jobs).toMatch(/check:\n {4}name: Check architecture impact/)
    expect(WORKFLOW).toMatch(/^name: Check architecture impact$/m)
  })

  test("workflow allowlist guard still lists this workflow", () => {
    expect(WORKFLOW_GUARD).toContain('"check-architecture-impact.yml"')
  })
})

// ─── workflow trust wiring ──────────────────────────────────────────────────

describe("check-architecture-impact.yml trust wiring", () => {
  test("pins checkout and setup-bun to repository-approved commit SHAs", () => {
    expect(WORKFLOW).toContain("actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2")
    expect(WORKFLOW).toContain("oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0")
    // floating tags are gone
    expect(WORKFLOW).not.toContain("actions/checkout@v6")
    expect(WORKFLOW).not.toContain("setup-bun@v2")
  })

  test("verifies both commit objects and fetches missing ones by explicit SHA, failing closed", () => {
    expect(WORKFLOW).toContain('git cat-file -e "$ref^{commit}"')
    expect(WORKFLOW).toContain('git fetch --no-tags origin "$ref"')
    expect(WORKFLOW).toContain('ensure_object "$BASE_SHA" "base"')
    expect(WORKFLOW).toContain('ensure_object "$HEAD_SHA" "head"')
    expect(WORKFLOW).toContain("Cannot obtain $label commit object")
    expect(WORKFLOW).toContain("failing closed")
  })

  test("materializes the trusted checker from the base commit", () => {
    expect(WORKFLOW).toContain('git show "$BASE_SHA:script/check-architecture-impact.ts"')
    expect(WORKFLOW).toContain("Trusted checker materialized from base commit $BASE_SHA.")
    expect(WORKFLOW).toContain("TRUSTED_CHECKER: .git/check-architecture-impact.ts")
  })

  test("bootstraps from the head checker only when base lacks it, with an explicit notice", () => {
    expect(WORKFLOW).toContain("BOOTSTRAP")
    expect(WORKFLOW).toContain('git show "$HEAD_SHA:script/check-architecture-impact.ts"')
    expect(WORKFLOW).toContain("using the checked-out head checker for this run only")
  })

  test("distinguishes checker-absent from a git operational failure", () => {
    // The base object is re-verified before the fallback so an unavailable
    // base object fails closed instead of silently bootstrapping.
    expect(WORKFLOW).toContain('if ! git cat-file -e "$BASE_SHA^{commit}"')
    expect(WORKFLOW).toContain("cannot materialize trusted checker")
  })

  test("provisions only typescript with scripts disabled, never a full install", () => {
    expect(WORKFLOW).toContain("bun add --ignore-scripts typescript@5.8.2")
    expect(WORKFLOW).not.toContain("bun install")
  })

  test("runs the trusted checker from base, never the PR branch script", () => {
    expect(WORKFLOW).toContain("bun run .git/check-architecture-impact.ts")
    expect(WORKFLOW).not.toContain("bun run script/check-architecture-impact.ts")
  })
})

// ─── end-to-end trust simulation ────────────────────────────────────────────
// The workflow's `run:` blocks are extracted verbatim and executed against real
// temp git repos with the same env the runner would set, so the trust flow is
// tested as written, not re-implemented.

const CHECKER_SRC = path.join(ROOT, "script", "check-architecture-impact.ts")
const CHECKER_BLOB = "script/check-architecture-impact.ts"
const HIGH_FILE = "packages/opencode/src/kilocode/server/drain-control.ts"
const highBaseline = "export const base = 1\n"
const highChange = "export const base = 1\nexport const newGate = 2\n"
const VALID_BODY = "## Documentation Impact\n- [x] Not applicable\n  Rationale: no contract changed.\n"
const INVALID_BODY = "## Summary\nno declaration section here\n"
const MALICIOUS = "console.log('MALICIOUS HEAD CHECKER RAN'); console.log('RESULT: PASS'); process.exit(0)\n"

/** Extracts every `run: |` block from the workflow, keyed by step name. */
function runScripts(workflow: string): Map<string, string> {
  const out = new Map<string, string>()
  const lines = workflow.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const m = (lines[i] ?? "").match(/^ {6}- name: (.+)$/)
    if (!m) continue
    const name = m[1] ?? ""
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j] ?? ""
      if (/^ {6}- /.test(line)) break // next step without a run block
      if (/^ {8}run: \|$/.test(line)) {
        const body: string[] = []
        let k = j + 1
        while (k < lines.length) {
          const cur = lines[k] ?? ""
          if (cur !== "" && !cur.startsWith("          ")) break
          body.push(cur.slice(10))
          k++
        }
        out.set(name, body.join("\n").replace(/\n+$/, ""))
        break
      }
    }
  }
  return out
}

function gitOk(repo: string, args: string[]): string {
  const res = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" })
  expect(res.status, `git ${args.join(" ")} failed: ${res.stderr}`).toBe(0)
  return res.stdout?.trim() ?? ""
}

function gitRaw(repo: string, args: string[]) {
  return spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" })
}

interface Fixture {
  root: string
  origin: string
  ws: string
}

function fixture(tag: string): Fixture {
  const root = mkdtempSync(path.join(os.tmpdir(), tag))
  const origin = path.join(root, "origin")
  const ws = path.join(root, "ws")
  mkdirSync(origin)
  gitOk(origin, ["init", "-q"])
  gitOk(origin, ["config", "user.name", "Trust Test"])
  gitOk(origin, ["config", "user.email", "trust@test.invalid"])
  gitOk(origin, ["config", "commit.gpgsign", "false"])
  return { root, origin, ws }
}

function commit(f: Fixture, msg: string): string {
  gitOk(f.origin, ["add", "-A"])
  gitOk(f.origin, ["commit", "-qm", msg])
  return gitOk(f.origin, ["rev-parse", "HEAD"])
}

/** Simulates actions/checkout at the head SHA: full clone + detached checkout. */
function cloneHead(f: Fixture, headSha: string) {
  gitOk(f.root, ["clone", "-q", f.origin, "ws"])
  gitOk(f.ws, ["checkout", "-q", headSha])
  gitOk(f.ws, ["config", "user.name", "Trust Test"])
  gitOk(f.ws, ["config", "user.email", "trust@test.invalid"])
  // CI resolves `typescript` from the repo's node_modules after the trusted
  // install step (asserted statically above); tests symlink the same package.
  mkdirSync(path.join(f.ws, "node_modules"), { recursive: true })
  symlinkSync(path.join(ROOT, "node_modules/typescript"), path.join(f.ws, "node_modules/typescript"), "dir")
  writeFileSync(path.join(f.ws, ".gitignore"), "node_modules/\n")
}

function writeEvent(f: Fixture, body: string): string {
  const eventFile = path.join(f.ws, "event.json")
  writeFileSync(eventFile, JSON.stringify({ pull_request: { body } }))
  return eventFile
}

function stepEnv(f: Fixture, baseSha: string, headSha: string, eventFile: string): Record<string, string> {
  return {
    BASE_SHA: baseSha,
    HEAD_SHA: headSha,
    TRUSTED_CHECKER: ".git/check-architecture-impact.ts",
    GITHUB_WORKSPACE: f.ws,
    GITHUB_EVENT_PATH: eventFile,
  }
}

/** Runs one extracted workflow `run:` block exactly as the runner would. */
function runStep(scripts: Map<string, string>, name: string, cwd: string, env: Record<string, string>) {
  const script = scripts.get(name)
  expect(script, `run block for step "${name}"`).toBeDefined()
  return spawnSync("bash", ["-c", script!], { cwd, env: { ...process.env, ...env }, encoding: "utf8" })
}

describe("check-architecture-impact.yml trust flow (temp repos)", () => {
  test("runs the trusted base checker, not a malicious head checker", () => {
    const f = fixture("kilo-arch-trust-base-")
    const scripts = runScripts(WORKFLOW)
    try {
      // base: the real checker + a baseline high-signal file
      mkdirSync(path.join(f.origin, "script"), { recursive: true })
      mkdirSync(path.dirname(path.join(f.origin, HIGH_FILE)), { recursive: true })
      copyFileSync(CHECKER_SRC, path.join(f.origin, CHECKER_BLOB))
      writeFileSync(path.join(f.origin, HIGH_FILE), highBaseline)
      const baseSha = commit(f, "base with trusted checker")

      // head: a malicious self-passing checker + an executable high change
      writeFileSync(path.join(f.origin, CHECKER_BLOB), MALICIOUS)
      writeFileSync(path.join(f.origin, HIGH_FILE), highChange)
      const headSha = commit(f, "malicious head checker + high change")

      cloneHead(f, headSha)
      const env = stepEnv(f, baseSha, headSha, writeEvent(f, INVALID_BODY))

      const verify = runStep(scripts, "Verify base and head commit objects", f.ws, env)
      expect(verify.status).toBe(0)

      const materialize = runStep(scripts, "Materialize trusted checker from base", f.ws, env)
      expect(materialize.status).toBe(0)
      expect(materialize.stdout).toContain("Trusted checker materialized from base commit")
      const trusted = readFileSync(path.join(f.ws, ".git", "check-architecture-impact.ts"), "utf8")
      expect(trusted).toContain("Deterministic, diff-aware architecture-impact checker")
      expect(trusted).not.toContain("MALICIOUS")

      // invalid declaration on a high change must FAIL under the trusted checker
      const bad = runStep(scripts, "Check Documentation Impact declaration", f.ws, env)
      expect(bad.status).toBe(1)
      expect(bad.stderr).toContain("RESULT: FAIL")
      expect(bad.stderr).not.toContain("MALICIOUS")

      // valid declaration passes
      const good = runStep(scripts, "Check Documentation Impact declaration", f.ws, {
        ...env,
        GITHUB_EVENT_PATH: writeEvent(f, VALID_BODY),
      })
      expect(good.status).toBe(0)
      expect(good.stdout).toContain("RESULT: PASS")
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  }, { timeout: 60000 })

  test("bootstraps from the head checker only when base lacks the checker", () => {
    const f = fixture("kilo-arch-trust-boot-")
    const scripts = runScripts(WORKFLOW)
    try {
      // base: no checker, just a baseline high-signal file
      mkdirSync(path.dirname(path.join(f.origin, HIGH_FILE)), { recursive: true })
      writeFileSync(path.join(f.origin, HIGH_FILE), highBaseline)
      const baseSha = commit(f, "base without checker")

      // head: the introducing PR adds the real checker + a high change
      mkdirSync(path.join(f.origin, "script"), { recursive: true })
      copyFileSync(CHECKER_SRC, path.join(f.origin, CHECKER_BLOB))
      writeFileSync(path.join(f.origin, HIGH_FILE), highChange)
      const headSha = commit(f, "introduce checker + high change")

      cloneHead(f, headSha)
      const env = stepEnv(f, baseSha, headSha, writeEvent(f, INVALID_BODY))

      expect(runStep(scripts, "Verify base and head commit objects", f.ws, env).status).toBe(0)

      const materialize = runStep(scripts, "Materialize trusted checker from base", f.ws, env)
      expect(materialize.status).toBe(0)
      expect(materialize.stdout).toContain("BOOTSTRAP")
      expect(materialize.stdout).toContain("using the checked-out head checker for this run only")
      const trusted = readFileSync(path.join(f.ws, ".git", "check-architecture-impact.ts"), "utf8")
      expect(trusted).toContain("Deterministic, diff-aware architecture-impact checker")

      // The introducing PR still enforces the gate with the bootstrapped checker
      const bad = runStep(scripts, "Check Documentation Impact declaration", f.ws, env)
      expect(bad.status).toBe(1)
      expect(bad.stderr).toContain("RESULT: FAIL")

      const good = runStep(scripts, "Check Documentation Impact declaration", f.ws, {
        ...env,
        GITHUB_EVENT_PATH: writeEvent(f, VALID_BODY),
      })
      expect(good.status).toBe(0)
      expect(good.stdout).toContain("RESULT: PASS")
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  }, { timeout: 60000 })

  test("fails closed when the base commit object cannot be fetched", () => {
    const f = fixture("kilo-arch-trust-miss-")
    const scripts = runScripts(WORKFLOW)
    try {
      // origin holds the PR base/head commits...
      mkdirSync(path.dirname(path.join(f.origin, HIGH_FILE)), { recursive: true })
      writeFileSync(path.join(f.origin, HIGH_FILE), highBaseline)
      const baseSha = commit(f, "base")
      writeFileSync(path.join(f.origin, HIGH_FILE), highChange)
      const headSha = commit(f, "head")

      // ...but the workspace's origin is a bare remote that never saw them:
      // the base object is absent locally and the fetch cannot retrieve it.
      const bare = path.join(f.root, "remote")
      mkdirSync(bare)
      gitOk(bare, ["init", "-q", "--bare"])
      gitOk(f.root, ["clone", "-q", bare, "ws"])
      const env = stepEnv(f, baseSha, headSha, writeEvent(f, INVALID_BODY))

      const verify = runStep(scripts, "Verify base and head commit objects", f.ws, env)
      expect(verify.status).toBe(1)
      expect(verify.stdout + verify.stderr).toContain("Cannot obtain base commit object")
      expect(verify.stdout + verify.stderr).toContain("failing closed")
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  }, { timeout: 60000 })

  test("fetches a missing base commit object by explicit SHA", () => {
    const f = fixture("kilo-arch-trust-fetch-")
    const scripts = runScripts(WORKFLOW)
    try {
      mkdirSync(path.dirname(path.join(f.origin, HIGH_FILE)), { recursive: true })
      writeFileSync(path.join(f.origin, HIGH_FILE), highBaseline)
      const baseSha = commit(f, "base")
      writeFileSync(path.join(f.origin, HIGH_FILE), highChange)
      const headSha = commit(f, "head")

      // file:// shallow clone at head: the base commit object is genuinely absent
      gitOk(f.root, ["clone", "-q", "--depth", "1", `file://${f.origin}`, "ws"])
      gitOk(f.ws, ["checkout", "-q", headSha])
      expect(gitRaw(f.ws, ["cat-file", "-e", `${baseSha}^{commit}`]).status).toBe(128)

      const env = stepEnv(f, baseSha, headSha, writeEvent(f, VALID_BODY))
      const verify = runStep(scripts, "Verify base and head commit objects", f.ws, env)
      expect(verify.status).toBe(0)
      expect(verify.stdout).toContain("base commit object")
      expect(gitRaw(f.ws, ["cat-file", "-e", `${baseSha}^{commit}`]).status).toBe(0)
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  }, { timeout: 60000 })
})
