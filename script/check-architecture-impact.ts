#!/usr/bin/env bun
// kilocode_change - new file

/**
 * Deterministic, diff-aware architecture-impact checker.
 *
 * Classifies changed files/diffs into architecture signals and validates the
 * auditable `## Documentation Impact` declaration in a PR body. Local semantic
 * assessment against the canonical architecture docs is the primary standard;
 * the PR declaration is the durable declaration/CI surface when a PR is opened
 * (the section lives in the PR body, not in repo docs).
 *
 * Tiers:
 *   - high    Tier 1 — runtime lifecycle/ownership/concurrency, provider
 *             lifecycle, hot/cold config classification, executable config
 *             schema, HTTP API group/route contract (shared and Kilo), event
 *             schema, Effect runtime boundary, cross-client contracts shared
 *             by editor clients, workflow definitions and guard scripts. CI
 *             blocks when the declaration is invalid or missing.
 *   - medium  Tier 2 — broader middleware, shared event/SSE/session contract,
 *             package AGENTS, broader product directories, architecture
 *             source-map adjacent paths. CI warns only; never blocks by itself.
 *
 * Source handling: TypeScript/JavaScript and Kotlin (`.kt`) use the installed
 * TypeScript scanner; Kotlin comment/string syntax overlaps, so uncertainty
 * signals rather than hides. Active workflow YAML (`.github/workflows/*.yml|yaml`)
 * is architecture code classified with a minimal `#` comment detector; disabled
 * `.yml.disabled` files and nested workflow files never trigger. Auto-generated
 * SDK output (the `gen/` dirs under `packages/sdk/js/src/`) and build/test
 * output directories are exempt at every tier.
 *
 * The declaration is never skipped: it is parsed and validated on every CI run
 * (fail-closed). Only high + invalid/missing declaration fails.
 * Local `--worktree` mode reports detected signals as local assessment guidance
 * and never requires a PR declaration.
 *
 * Executable-vs-comment detection: a high-signal path only fires
 * when the diff contains an executable added or removed line. Detection uses the
 * installed TypeScript scanner over the joined added/removed snippets, which
 * recognizes `#private` fields, generator methods, decorators, templates, JSX,
 * and whole block comments/JSDoc examples. Diff parsing keeps added `++...` and
 * removed `--...` content lines (e.g. `++count;` / `--count;`) instead of
 * mistaking them for pre-hunk `+++ b/...` / `--- a/...` headers. Line-start
 * JSDoc continuation recognition covers identifiers, `@`, bare `*` separator
 * lines, and TypeScript keyword starters (` * this ...`, ` * type: ...`), so
 * keyword-leading prose no longer reads as code. When a joined snippet is
 * ambiguous (e.g. a bare line that might be a JSDoc example), the classifier
 * signals code rather than hiding a real change. Blank, comment, docblock, and
 * test-name-only changes do not trigger; `.test/.spec/.stories` and
 * `test/tests/__tests__` files never signal, at any tier. Canonical
 * architecture docs are evidence for `Updated`, never an architecture trigger.
 *
 * Renames/copies: git name-status is read with
 * `-M -C --find-copies-harder`, so `R`/`C` entries expose the old path. Both
 * sides of a rename/copy are classified (old path against the removed-lines
 * diff, new path against the added-lines diff), and a pair emits at most one
 * signal to avoid duplicates. This prevents renaming a lifecycle file off a
 * high-signal path from silently losing the signal.
 *
 * Usage:
 *   bun run script/check-architecture-impact.ts --base <ref> --head <ref> --pr-body-file <path>
 *   bun run script/check-architecture-impact.ts --worktree
 *   bun run script/check-architecture-impact.ts --help
 *
 * CI inputs are explicit base/head refs plus the PR body supplied via a file
 * path; refs are validated and never interpolated into a shell.
 */

import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import * as ts from "typescript"

const ROOT = path.resolve(import.meta.dir, "..")

export const ARCH_DOC_DIR = "packages/kilo-docs/pages/contributing/architecture"

// ─── Public types ──────────────────────────────────────────────────────────

export type Tier = "high" | "medium"

export type Kind =
  | "runtime-lifecycle"
  | "provider-lifecycle"
  | "hot-config"
  | "config-schema"
  | "http-api"
  | "effect-boundary"
  | "workflow-inventory"
  | "cross-client-contract"
  | "middleware"
  | "event-sse"
  | "session-contract"
  | "agent-conventions"
  | "arch-adjacent"

export interface Signal {
  tier: Tier
  kind: Kind
  file: string
}

export interface FileChange {
  path: string
  /** Unified=0 diff text for the path (empty for evidence-only files). */
  diff: string
  /**
   * Shared by both sides of one git rename/copy. When set, the two sides
   * classify as a single change and emit at most one signal (no duplicates).
   */
  pair?: string
  /** Side of a rename/copy pair: "old" (source/deleted) or "new" (target/added). */
  pairSide?: "old" | "new"
}

export interface Declaration {
  present: boolean
  status: "updated" | "not-applicable" | undefined
  canonicalDocs: string[]
  rationale: string
  errors: string[]
  warnings: string[]
}

export interface CheckResult {
  signals: Signal[]
  declaration: Declaration
  errors: string[]
  warnings: string[]
  pass: boolean
}

export interface Options {
  changes: FileChange[]
  body?: string
  worktree: boolean
}

export interface DiffLines {
  added: string[]
  removed: string[]
}

// ─── Signal taxonomy ───────────────────────────────────────────────────────

// High (Tier 1) — blocking in CI when the declaration is invalid or missing.
const HIGH: Array<[Kind, string]> = [
  // Runtime lifecycle, ownership, and concurrency contract
  ["runtime-lifecycle", "packages/opencode/src/kilocode/server/generation-gate.ts"],
  ["runtime-lifecycle", "packages/opencode/src/kilocode/server/control-lease.ts"],
  ["runtime-lifecycle", "packages/opencode/src/kilocode/server/drain-control.ts"],
  ["runtime-lifecycle", "packages/opencode/src/kilocode/server/config-convergence.ts"],
  ["runtime-lifecycle", "packages/opencode/src/kilocode/server/config-transaction.ts"],
  ["runtime-lifecycle", "packages/opencode/src/kilocode/server/config-write-intent.ts"],
  ["runtime-lifecycle", "packages/opencode/src/kilocode/server/config-ticket.ts"],
  ["runtime-lifecycle", "packages/opencode/src/kilocode/server/config-rebuild.ts"],
  ["runtime-lifecycle", "packages/opencode/src/kilocode/instance.ts"],
  ["runtime-lifecycle", "packages/opencode/src/kilocode/session/generation-admission.ts"],
  ["runtime-lifecycle", "packages/opencode/src/kilocode/session/config-snapshot.ts"],
  ["runtime-lifecycle", "packages/opencode/src/kilocode/config/config.ts"],
  // Provider lifecycle
  ["provider-lifecycle", "packages/opencode/src/kilocode/provider/"],
  ["provider-lifecycle", "packages/opencode/src/kilocode/server/provider-auth-lifecycle.ts"],
  ["provider-lifecycle", "packages/opencode/src/kilocode/server/custom-provider-save.ts"],
  ["provider-lifecycle", "packages/opencode/src/kilocode/server/custom-provider-delete.ts"],
  // Runtime hot/cold config classification
  ["hot-config", "packages/opencode/src/kilocode/config/hot-keys.ts"],
  // Executable config schema contract
  ["config-schema", "packages/opencode/src/config/config.ts"],
  // HTTP API group/route contract (Kilo and shared route seams)
  ["http-api", "packages/opencode/src/kilocode/server/httpapi/"],
  ["http-api", "packages/opencode/src/server/routes/instance/httpapi/"],
  // Shared event schema
  ["event-sse", "packages/opencode/src/server/event.ts"],
  // Effect runtime boundary and guard scripts
  ["effect-boundary", "packages/opencode/src/effect/"],
  ["effect-boundary", "script/check-opencode-promise-facades.ts"],
  // CI workflow inventory guard
  ["workflow-inventory", "script/check-workflows.ts"],
  // Cross-client contracts shared by editor clients, TUI, and hosted services
  ["cross-client-contract", "packages/kilo-vscode/src/services/cli-backend/server-manager.ts"],
  ["cross-client-contract", "packages/kilo-vscode/src/services/cli-backend/connection-service.ts"],
  ["cross-client-contract", "packages/kilo-vscode/src/services/cli-backend/sdk-sse-adapter.ts"],
  ["cross-client-contract", "packages/kilo-jetbrains/backend/src/main/kotlin/ai/kilocode/backend/cli/KiloBackendCliManager.kt"],
  ["cross-client-contract", "packages/kilo-jetbrains/backend/src/main/kotlin/ai/kilocode/backend/app/KiloBackendConnectionService.kt"],
  ["cross-client-contract", "packages/kilo-jetbrains/backend/src/main/kotlin/ai/kilocode/backend/workspace/KiloBackendWorkspaceManager.kt"],
  ["cross-client-contract", "packages/kilo-jetbrains/shared/src/main/kotlin/ai/kilocode/rpc/"],
  ["cross-client-contract", "packages/sdk/js/src/v2/client.ts"],
  // Governance checker itself and the guard/workflow model (globs after the
  // exact effect-boundary/workflow-inventory entries so specific kinds win)
  ["workflow-inventory", "script/check-architecture-impact.ts"],
  ["workflow-inventory", "script/check-*.ts"],
  ["workflow-inventory", ".github/workflows/*.yml"],
  ["workflow-inventory", ".github/workflows/*.yaml"],
]

/**
 * Filename-regex HIGH rules: a source file directly under `dir` whose basename
 * matches `re`. Future Kilo lifecycle modules under the runtime server dir keep
 * the runtime-lifecycle signal without an exact source-map entry; bounded to
 * direct children of the dir (high-signal source paths).
 */
const NAME_RULES: Array<{ kind: Kind; dir: string; re: RegExp }> = [
  {
    kind: "runtime-lifecycle",
    dir: "packages/opencode/src/kilocode/server/",
    re: /(?:convergence|gate|lease|drain|transaction|fence)/,
  },
]

// Medium (Tier 2) — warnings only, never blocking by themselves.
const MEDIUM: Array<[Kind, string]> = [
  ["middleware", "packages/opencode/src/server/"],
  ["event-sse", "packages/opencode/src/bus/"],
  ["event-sse", "packages/opencode/src/kilocode/server/sse.ts"],
  ["event-sse", "packages/opencode/src/event-v2-bridge.ts"],
  ["session-contract", "packages/opencode/src/session/"],
  ["agent-conventions", "AGENTS.md"],
  ["cross-client-contract", "packages/kilo-vscode/src/services/cli-backend/types.ts"],
  // cli-backend sibling modules are arch-adjacent (after the exact types.ts
  // entry so it keeps the cross-client-contract kind); exact HIGH owners in the
  // dir still beat this rule.
  ["arch-adjacent", "packages/kilo-vscode/src/services/cli-backend/"],
  ["arch-adjacent", "packages/kilo-vscode/src/agent-manager/"],
  ["arch-adjacent", "packages/kilo-jetbrains/backend/src/main/kotlin/ai/kilocode/backend/cli/"],
  ["arch-adjacent", "packages/kilo-jetbrains/backend/src/main/kotlin/ai/kilocode/backend/app/"],
  ["arch-adjacent", "packages/kilo-jetbrains/backend/src/main/kotlin/ai/kilocode/backend/workspace/"],
  ["arch-adjacent", "packages/opencode/src/kilocode/server/"],
  ["arch-adjacent", "packages/opencode/src/kilocode/session/"],
  ["arch-adjacent", "packages/opencode/src/kilocode/config/"],
]

const ADVICE: Record<Kind, string> = {
  "runtime-lifecycle": "runtime lifecycle, ownership, and concurrency contract",
  "provider-lifecycle": "provider lifecycle contract",
  "hot-config": "hot/cold config classification contract",
  "config-schema": "executable config schema contract",
  "http-api": "HTTP API group/route contract",
  "effect-boundary": "Effect runtime boundary or guard script",
  "workflow-inventory": "CI workflow definition or guard script",
  "cross-client-contract": "cross-client contract shared by editor clients, TUI, and hosted services",
  middleware: "shared server middleware",
  "event-sse": "shared event/SSE contract",
  "session-contract": "shared session contract",
  "agent-conventions": "repository/package conventions",
  "arch-adjacent": "architecture source-map adjacent path",
}

/**
 * Worktree-mode advice block. Local semantic assessment against the canonical
 * architecture docs is the primary standard; the PR `## Documentation Impact`
 * section is the durable declaration/CI surface when a PR is opened. The first
 * two lines instruct local agents on that local obligation; lines 2-5 match the
 * PR template text exactly: both statuses unchecked, the
 * template field placeholders, and an explicit select-one instruction. Both
 * unchecked means a verbatim copy into a PR body fails closed with a clear
 * "No status is checked" error instead of silently producing an invalid
 * two-checked declaration.
 */
export const WORKTREE_ADVICE = [
  "Local worktree mode — local semantic assessment is the primary standard; no PR declaration is required here.",
  "For each signal, inspect the full diff and read the mapped canonical docs. High signals: update the relevant canonical docs and record the changed paths, or record a concrete rationale for no update, in the completion or commit-preparation result. Medium/no-signal outcomes can be reported concisely. The pre-commit hook is advisory only.",
  "- [ ] Architecture docs updated",
  "      Canonical docs: packages/kilo-docs/pages/contributing/architecture/<doc>.md",
  "- [ ] Not applicable",
  "      Rationale: <why no architecture doc update is needed>",
  "When opening a PR, add the `## Documentation Impact` section to the PR body. Select exactly one status and fill its field; high impact requires a valid declaration in CI.",
].join("\n")

// ─── Diff parsing and executable detection ────────────────────────────────

/**
 * Parses a unified=0 diff into added and removed line contents (no context).
 * Rename and binary headers reset hunk state; `\ No newline` markers are
 * skipped because they carry no diff prefix.
 *
 * Pre-hunk `+++ b/...` / `--- a/...` headers only appear before the first `@@`
 * hunk header, so `+++`/`---` is only skipped outside a hunk. Inside a hunk
 * every line carries exactly one diff prefix, so a line starting `+++`/`---` is
 * an added/removed content line whose text begins `++`/`--` — e.g.
 * `++count;` / `--count;` — and must be kept. Treating those as fake headers
 * dropped executable lines and bypassed executable detection.
 */
export function parseDiff(diff: string): DiffLines {
  const added: string[] = []
  const removed: string[] = []
  let hunk = false
  for (const raw of diff.split(/\r?\n/)) {
    if (raw.startsWith("@@")) {
      hunk = true
      continue
    }
    if (raw.startsWith("diff --git") || raw.startsWith("index ") || raw.startsWith("Binary files")) {
      hunk = false
      continue
    }
    if (raw.startsWith("+++") || raw.startsWith("---")) {
      if (!hunk) continue // pre-hunk header
    }
    if (!hunk) continue
    if (raw.startsWith("+")) added.push(raw.slice(1))
    else if (raw.startsWith("-")) removed.push(raw.slice(1))
  }
  return { added, removed }
}

// Executable detection uses the installed TypeScript scanner.
// The scanner is a tokenizer, so partial or malformed snippets never throw.
// Added and removed lines are classified as two joined snippets; block comments
// spanning added/removed lines are handled by the scanner's comment trivia, and
// one-line JSDoc continuations (` * prose`), closers (`*/`), and JSX comments
// (`{/* ... */}`) are recognized. Anything that is not provably comment/closer
// counts as code: uncertainty signals rather than hides a change.

const CLOSERS = new Set([
  ts.SyntaxKind.CloseBraceToken,
  ts.SyntaxKind.CloseParenToken,
  ts.SyntaxKind.CloseBracketToken,
  ts.SyntaxKind.SemicolonToken,
  ts.SyntaxKind.CommaToken,
])

const TRIVIA = new Set([
  ts.SyntaxKind.WhitespaceTrivia,
  ts.SyntaxKind.NewLineTrivia,
  ts.SyntaxKind.SingleLineCommentTrivia,
  ts.SyntaxKind.MultiLineCommentTrivia,
  ts.SyntaxKind.ShebangTrivia,
  ts.SyntaxKind.ConflictMarkerTrivia,
])

// TypeScript keyword tokens, derived from the installed scanner's enum. The
// `First*/Last*` members are range markers, not token kinds. Keyword tokens
// start line-level JSDoc prose (` * this ...`, ` * type: ...`,
// ` *   const example = true`) and cannot start a generator method (that needs
// an identifier immediately after `*`), so recognizing them as continuation
// lines does not hide generator, multiplication, or yield-star code. A
// line-start ` * <value>` multiplication continuation (e.g. ` * this.b`) is an
// inherent zero-context ambiguity and is treated as prose.
const KEYWORDS = new Set<ts.SyntaxKind>()
for (const [name, value] of Object.entries(ts.SyntaxKind)) {
  if (
    typeof value === "number" &&
    name.endsWith("Keyword") &&
    !name.startsWith("First") &&
    !name.startsWith("Last")
  ) {
    KEYWORDS.add(value as ts.SyntaxKind)
  }
}

interface TokenInfo {
  kind: ts.SyntaxKind
  /** First non-trivia token of a line (only whitespace precedes it). */
  lineStart: boolean
}

function scanTokens(src: string): TokenInfo[] {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, src)
  const toks: TokenInfo[] = []
  let lineStart = true
  let k = scanner.scan()
  while (k !== ts.SyntaxKind.EndOfFileToken) {
    toks.push({ kind: k, lineStart })
    if (k === ts.SyntaxKind.NewLineTrivia) lineStart = true
    else if (!TRIVIA.has(k)) lineStart = false
    k = scanner.scan()
  }
  return toks
}

/** Whitespace and line breaks only — comments are NOT skipped (JSX detection needs them). */
const WS = new Set([ts.SyntaxKind.WhitespaceTrivia, ts.SyntaxKind.NewLineTrivia])

/** Index of the first non-whitespace token at or after `i`, or `toks.length`. */
function nextCodeToken(toks: TokenInfo[], i: number): number {
  let j = i
  while (j < toks.length && WS.has(toks[j]!.kind)) j++
  return j
}

/** Index just past the newline ending the line that contains token `i`. */
function afterLine(toks: TokenInfo[], i: number): number {
  let j = i
  while (j < toks.length && toks[j]!.kind !== ts.SyntaxKind.NewLineTrivia) j++
  return j + 1
}

/** True when a line break occurs in `toks[from .. to)`. */
function hasNewline(toks: TokenInfo[], from: number, to: number): boolean {
  for (let k = from; k < to; k++) {
    if (toks[k]!.kind === ts.SyntaxKind.NewLineTrivia) return true
  }
  return false
}

/** True when the joined source snippet contains executable code. */
function sourceHasCode(src: string): boolean {
  if (!src) return false
  const toks = scanTokens(src)
  let i = 0
  while (i < toks.length) {
    const t = toks[i]!
    const k = t.kind
    if (TRIVIA.has(k)) {
      i++
      continue
    }
    if (CLOSERS.has(k)) {
      i++
      continue
    }
    if (k === ts.SyntaxKind.OpenBraceToken) {
      // JSX/TSX comment container: { /* ... */ }
      const j = nextCodeToken(toks, i + 1)
      if (j < toks.length && toks[j]!.kind === ts.SyntaxKind.MultiLineCommentTrivia) {
        i = j + 1
        continue
      }
      return true
    }
    if (k === ts.SyntaxKind.AsteriskToken) {
      const j = nextCodeToken(toks, i + 1)
      if (j >= toks.length) {
        i++ // trailing lone `*`
        continue
      }
      if (toks[j]!.kind === ts.SyntaxKind.SlashToken) {
        i = j + 1 // `*/` block-comment closer
        continue
      }
      if (t.lineStart && j > i + 1 && hasNewline(toks, i + 1, j)) {
        // Bare ` *` separator line: nothing after the star on its own line, so
        // skip only this line and keep scanning the next one as-is.
        i = afterLine(toks, i)
        continue
      }
      if (
        t.lineStart &&
        j > i + 1 &&
        (toks[j]!.kind === ts.SyntaxKind.Identifier ||
          toks[j]!.kind === ts.SyntaxKind.AtToken ||
          KEYWORDS.has(toks[j]!.kind))
      ) {
        i = afterLine(toks, j) // ` * prose`, ` * @param`, ` * this` JSDoc continuation
        continue
      }
      return true // generator method, multiplication, yield*, spread
    }
    if (k === ts.SyntaxKind.PrivateIdentifier) {
      const j = nextCodeToken(toks, i + 1)
      if (j < toks.length && j > i + 1 && toks[j]!.kind === ts.SyntaxKind.Identifier) {
        i = afterLine(toks, j) // `# heading` prose, not a `#private` field
        continue
      }
      return true // `#private = ...`
    }
    return true
  }
  return false
}

/** True when any line in the sequence is executable code (scanner-based). */
export function hasCode(lines: string[]): boolean {
  return sourceHasCode(lines.join("\n"))
}

/** True when the diff contains an executable added or removed line. */
export function diffHasCode(diff: string): boolean {
  const { added, removed } = parseDiff(diff)
  return hasCode(added) || hasCode(removed)
}

// ─── YAML handling ─────────────────────────────────────────────────────────

/**
 * Active workflow YAML (`.github/workflows/*.yml|yaml`) is architecture code:
 * the file itself defines the CI guard model. `.yml.disabled` files and
 * workflow files under a nested directory (e.g. `.github/workflows/disabled/`)
 * are not active workflow definitions and never match the HIGH globs.
 */
const isWorkflowYaml = (f: string) => /^\.github\/workflows\/[^/]*\.(yml|yaml)$/.test(f)
const isYamlFile = (f: string) => /\.(yml|yaml)$/.test(f)

/**
 * Minimal YAML comment/code detector: a blank line or a line
 * whose first non-whitespace character is `#` is a comment; any other
 * non-blank changed line is code. The TypeScript scanner would read
 * `# if: ...`-style YAML comment lines as code-like tokens, so YAML files use
 * this file-kind-aware detector instead of the scanner.
 */
export function yamlHasCode(lines: string[]): boolean {
  for (const line of lines) {
    const t = line.trim()
    if (!t || t.startsWith("#")) continue
    return true
  }
  return false
}

/** Diff-code check that accounts for the changed file's kind. */
export function diffHasCodeFor(file: string, diff: string): boolean {
  const { added, removed } = parseDiff(diff)
  if (isYamlFile(file)) return yamlHasCode(added) || yamlHasCode(removed)
  return hasCode(added) || hasCode(removed)
}

// ─── Path classification ───────────────────────────────────────────────────

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function hit(pattern: string, file: string): boolean {
  if (pattern === "AGENTS.md") return file === "AGENTS.md" || file.endsWith("/AGENTS.md")
  if (pattern.endsWith("/")) return file.startsWith(pattern)
  if (pattern.includes("*")) {
    // `*` matches within a single path segment, so workflow globs like
    // `.github/workflows/*.yml` never match nested or `.yml.disabled` files.
    const re = new RegExp(`^${pattern.split("*").map(escapeRe).join("[^/]*")}$`)
    return re.test(file)
  }
  return file === pattern
}

function hitNameRule(rule: { dir: string; re: RegExp }, file: string): boolean {
  if (!file.startsWith(rule.dir)) return false
  const base = file.slice(rule.dir.length)
  return base.length > 0 && !base.includes("/") && rule.re.test(base)
}

// `.test/.spec/.stories` name infixes, Kotlin `*Test.kt` / `*Tests.kt` files,
// and `test/tests/__tests__` path segments mark a file as test-only. Test
// files never signal at any tier.
const isTestFile = (f: string) => {
  const n = f.replaceAll("\\", "/")
  if (/\.(test|spec|stories)\./.test(n)) return true
  if (/(Test|Tests)\.kt$/.test(n)) return true
  return n.split("/").some((s) => s === "test" || s === "tests" || s === "__tests__")
}

const SOURCE_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".kt"])
const isSourceFile = (f: string) => {
  const i = f.lastIndexOf(".")
  return i === -1 ? false : SOURCE_EXTS.has(f.slice(i))
}

// Auto-generated SDK output and build/test output directories never signal at
// any tier: they are generated copies, not architecture sources.
const GENERATED_PREFIXES = ["packages/sdk/js/src/gen/", "packages/sdk/js/src/v2/gen/"]
const BUILD_SEGMENTS = new Set(["dist", "out", "build", "coverage", ".turbo", "node_modules"])
const isExemptPath = (f: string): boolean => {
  if (GENERATED_PREFIXES.some((p) => f.startsWith(p))) return true
  return f.split("/").some((s) => BUILD_SEGMENTS.has(s))
}

/**
 * Classifies one changed file into at most one signal: high wins over medium,
 * and a file can only carry its highest tier. Comment/test-only diffs, test
 * files, generated/build output, canonical docs, and non-source files produce
 * no high signal even on high-signal paths. Active workflow
 * YAML carries the workflow-inventory high signal; other YAML files never do.
 */
export function classifyFile(file: string, diff: string): Signal[] {
  const norm = file.replaceAll("\\", "/")
  if (isTestFile(norm) || isExemptPath(norm) || isCanonicalDoc(norm)) return []
  if (!diffHasCodeFor(norm, diff)) return []
  const carryHigh = isSourceFile(norm) || isWorkflowYaml(norm)
  if (carryHigh) {
    for (const [kind, pattern] of HIGH) {
      if (hit(pattern, norm)) return [{ tier: "high", kind, file: norm }]
    }
    if (isSourceFile(norm)) {
      for (const rule of NAME_RULES) {
        if (hitNameRule(rule, norm)) return [{ tier: "high", kind: rule.kind, file: norm }]
      }
    }
  }
  for (const [kind, pattern] of MEDIUM) {
    if (hit(pattern, norm)) return [{ tier: "medium", kind, file: norm }]
  }
  return []
}

export function classifyChanges(changes: FileChange[]): Signal[] {
  const signals: Signal[] = []
  const winner = new Map<string, number>()
  for (const change of changes) {
    for (const sig of classifyFile(change.path, change.diff)) {
      const pid = change.pair
      if (!pid) {
        signals.push(sig)
        continue
      }
      const at = winner.get(pid)
      if (at === undefined) {
        winner.set(pid, signals.length)
        signals.push(sig)
        continue
      }
      const prev = signals[at]
      if (!prev) continue
      // One rename/copy emits at most one signal: high beats medium, and on an
      // equal tier the new (target) side wins over the old (source) side.
      const higher = sig.tier === "high" && prev.tier === "medium"
      const sameTierNewSide = sig.tier === prev.tier && change.pairSide === "new"
      if (higher || sameTierNewSide) signals[at] = sig
    }
  }
  return signals
}

export function isCanonicalDoc(file: string): boolean {
  const norm = file.replaceAll("\\", "/")
  return norm === ARCH_DOC_DIR || norm.startsWith(`${ARCH_DOC_DIR}/`)
}

function isCandidate(f: string): boolean {
  if (HIGH.some(([, p]) => hit(p, f))) return true
  if (NAME_RULES.some((r) => hitNameRule(r, f))) return true
  return MEDIUM.some(([, p]) => hit(p, f))
}

// ─── Documentation Impact declaration parsing ─────────────────────────────

const SECTION_RE = /^##\s+Documentation Impact\s*$/
const HEADING_RE = /^#{1,6}\s/
const CHECKBOX_RE = /^[-*]\s*\[([ xX])\]\s*(.*)$/
const INDENT_CHECKBOX_RE = /^\s*[-*]\s*\[[ xX]\]/
const FIELD_RE = /^\s*(Canonical docs|Rationale)\s*:\s*(.*)$/i
const STATUS_NAMES = new Set(["Architecture docs updated", "Not applicable"])

/**
 * Body lines outside code fences and HTML comments. Fenced and commented
 * headings, statuses, and fields are ignored by every later step (exact
 * fail-closed parsing).
 *
 * Fence state is evaluated before comment stripping: a line inside a code fence
 * is dropped before any `<!--`/`-->` scanning, so an unterminated HTML comment
 * in a fenced example cannot open a comment that hides a later real section,
 * and a `-->` inside a fence cannot close a comment opened outside one — fence
 * content never alters HTML comment state. A fence opener line is recognized
 * before comment scanning, so a fenced example is skipped wholesale. Outside
 * fences, HTML comments still hide their content across lines.
 */
function effectiveLines(body: string): string[] {
  const out: string[] = []
  let fence: string | null = null
  let inComment = false
  for (const line of body.split(/\r?\n/)) {
    const t = line.trim()
    if (fence) {
      if (t.startsWith(fence)) fence = null
      continue
    }
    if (t.startsWith("```") || t.startsWith("~~~")) {
      fence = t.slice(0, 3)
      continue
    }
    // Outside a fence: strip HTML comment spans, carrying state across lines so
    // a multi-line comment hides everything until its `-->`. Visible text
    // before/after a span on the same line survives, so a heading outside a
    // comment still counts.
    let rest = line
    let visible = ""
    let open: boolean = inComment
    for (;;) {
      if (open) {
        const end = rest.indexOf("-->")
        if (end === -1) break
        open = false
        rest = rest.slice(end + 3)
        continue
      }
      const start = rest.indexOf("<!--")
      if (start === -1) {
        visible += rest
        break
      }
      visible += rest.slice(0, start)
      rest = rest.slice(start)
      open = true
    }
    inComment = open
    out.push(visible)
  }
  return out
}

function readFields(section: string[], errors: string[]): { canonicalDocs: string[]; rationale: string } {
  let canonicalDocs: string[] = []
  let rationale = ""
  const seen = new Set<string>()
  for (let i = 0; i < section.length; i++) {
    const m = (section[i] ?? "").match(FIELD_RE)
    if (!m) continue
    const key = (m[1] ?? "").toLowerCase()
    if (seen.has(key)) {
      errors.push(`Duplicate "${m[1]}:" field in the Documentation Impact section — each field may appear at most once.`)
      continue
    }
    seen.add(key)
    const parts = [(m[2] ?? "").trim()]
    let j = i + 1
    while (j < section.length) {
      const next = section[j] ?? ""
      const tn = next.trim()
      // Only ordinary indented prose continues a value: another field, any
      // checkbox, a heading, a blank line, or non-indented text ends it.
      if (!tn || INDENT_CHECKBOX_RE.test(next) || FIELD_RE.test(next) || HEADING_RE.test(next)) break
      if (!/^\s/.test(next)) break
      parts.push(tn)
      j++
    }
    const joined = parts.join(" ")
    if (key === "canonical docs") canonicalDocs = joined.split(/[,;]/).map((s) => s.trim()).filter(Boolean)
    else rationale = joined
  }
  return { canonicalDocs, rationale }
}

/**
 * Parses the PR body. Fail-closed: a missing section, multiple
 * `## Documentation Impact` headings, zero/multiple checked statuses, an
 * unknown checked status, or duplicate `Rationale:`/`Canonical docs:` fields
 * all produce errors. Only the exact section heading is read; code-fenced
 * headings, HTML-commented sections, and headings of other levels are ignored.
 */
export function parseDeclaration(body: string): Declaration {
  const errors: string[] = []
  const warnings: string[] = []
  const decl: Declaration = { present: true, status: undefined, canonicalDocs: [], rationale: "", errors, warnings }
  const lines = effectiveLines(body)
  const heads: number[] = []
  for (let i = 0; i < lines.length; i++) {
    if (SECTION_RE.test(lines[i] ?? "")) heads.push(i)
  }
  if (heads.length === 0) {
    decl.present = false
    errors.push("Missing `## Documentation Impact` section in the PR body.")
    return decl
  }
  if (heads.length > 1) {
    errors.push(`Found ${heads.length} "## Documentation Impact" sections — exactly one is required.`)
    return decl
  }
  const start = heads[0] ?? 0
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (HEADING_RE.test(lines[i] ?? "")) {
      end = i
      break
    }
  }
  const section = lines.slice(start + 1, end)
  const items: Array<{ checked: boolean; label: string }> = []
  for (const line of section) {
    const m = line.match(CHECKBOX_RE)
    if (m) items.push({ checked: (m[1] ?? "").toLowerCase() === "x", label: (m[2] ?? "").trim() })
  }
  if (items.length === 0) {
    errors.push("No status checkbox found in the `## Documentation Impact` section.")
    return decl
  }
  const checked = items.filter((i) => i.checked)
  const unknown = checked.filter((i) => !STATUS_NAMES.has(i.label))
  if (unknown.length > 0) {
    errors.push(`Unknown checked status: ${unknown.map((i) => i.label).join(", ")}.`)
    return decl
  }
  if (checked.length === 0) {
    errors.push("No status is checked — exactly one of `Architecture docs updated` / `Not applicable` is required.")
    return decl
  }
  if (checked.length > 1) {
    errors.push(`${checked.length} statuses are checked — exactly one is required.`)
    return decl
  }
  const chosen = checked[0]
  if (!chosen) return decl
  decl.status = chosen.label === "Not applicable" ? "not-applicable" : "updated"
  const fields = readFields(section, errors)
  decl.canonicalDocs = fields.canonicalDocs
  decl.rationale = fields.rationale
  return decl
}

// ─── Declaration validation against evidence ──────────────────────────────

function normalizeDoc(d: string): string {
  let s = d.trim().replace(/^`+|`+$/g, "")
  s = s.replace(/^\[[^\]]*\]\(([^)]*)\)$/, "$1")
  if (s.startsWith("./")) s = s.slice(2)
  return s.replace(/\/+$/, "")
}

function docMatch(declared: string, changed: string): boolean {
  const a = normalizeDoc(declared)
  const b = normalizeDoc(changed)
  return a === b || a === (b.split("/").pop() ?? "")
}

/**
 * Validates the parsed declaration against the changed canonical docs.
 * `Architecture docs updated` needs a non-empty Canonical docs value and at
 * least one changed canonical architecture doc; every declared doc must be a
 * canonical architecture path. `Not applicable` needs a non-empty Rationale.
 */
export function validateDeclaration(decl: Declaration, changedDocs: string[]): { errors: string[]; warnings: string[] } {
  const errors: string[] = []
  const warnings: string[] = []
  if (!decl.present) return { errors, warnings }
  if (decl.status === "updated") {
    const misplaced = decl.canonicalDocs.filter((d) => {
      const n = normalizeDoc(d)
      return n && !isCanonicalDoc(n) && n.includes("/")
    })
    for (const m of misplaced) {
      errors.push(`Declared Canonical doc is not under ${ARCH_DOC_DIR}: ${m}`)
    }
    if (decl.canonicalDocs.length === 0) {
      errors.push("`Architecture docs updated` requires a non-empty `Canonical docs:` value in the section.")
    }
    if (changedDocs.length === 0) {
      errors.push(
        "`Architecture docs updated` requires at least one changed canonical architecture doc under " +
          `${ARCH_DOC_DIR}.`,
      )
    } else if (decl.canonicalDocs.length > 0) {
      const changed = changedDocs.map(normalizeDoc)
      const overlap = decl.canonicalDocs.filter((d) => changed.some((c) => docMatch(d, c)))
      if (overlap.length === 0) {
        errors.push("None of the declared `Canonical docs:` values match a changed canonical architecture doc.")
      }
      for (const d of decl.canonicalDocs) {
        if (!changed.some((c) => docMatch(d, c))) warnings.push(`Declared Canonical doc not changed: ${d}`)
      }
    }
  }
  if (decl.status === "not-applicable" && !decl.rationale.trim()) {
    errors.push("`Not applicable` requires a non-empty `Rationale:` value in the section.")
  }
  return { errors, warnings }
}

// ─── Orchestration ─────────────────────────────────────────────────────────

/**
 * Pure entry point: classifies signals, parses and validates the declaration,
 * and computes blocking errors. CI fails only on high signals with an invalid
 * or missing declaration; medium and no-signal cases only warn. Worktree mode
 * is always non-blocking.
 */
export function evaluateCheck(opts: Options): CheckResult {
  const signals = classifyChanges(opts.changes)
  const decl = parseDeclaration(opts.body ?? "")
  const changedDocs = opts.changes.map((c) => c.path).filter(isCanonicalDoc)
  const validation = validateDeclaration(decl, changedDocs)
  const errors: string[] = []
  const warnings: string[] = [...validation.warnings]
  if (!opts.worktree) {
    const high = signals.some((s) => s.tier === "high")
    const problems = [...decl.errors, ...validation.errors]
    if (high && problems.length > 0) {
      errors.push("High architecture impact requires a valid Documentation Impact declaration.")
      errors.push(...problems.map((e) => `  - ${e}`))
    } else {
      warnings.push(...problems.map((e) => `Documentation Impact: ${e}`))
    }
  }
  return { signals, declaration: decl, errors, warnings, pass: opts.worktree || errors.length === 0 }
}

// ─── CLI ───────────────────────────────────────────────────────────────────

function printUsage() {
  console.error("usage: bun run script/check-architecture-impact.ts --base <ref> --head <ref> --pr-body-file <path>")
  console.error("       bun run script/check-architecture-impact.ts --worktree")
  console.error("       bun run script/check-architecture-impact.ts --help")
}

function printHelp() {
  console.log(
    [
      "check-architecture-impact — classify architecture signals and validate the PR Documentation Impact declaration.",
      "",
      "Usage:",
      "  --base <ref>            CI mode: base git ref (merge-base against head)",
      "  --head <ref>            CI mode: head git ref",
      "  --pr-body-file <path>   CI mode: PR body markdown file (never interpolated into commands)",
      "  --worktree              Local mode: report signals as local assessment guidance; local assessment is the",
      "                          primary standard and never requires a PR declaration",
      "  -h, --help              Show this help",
      "",
      "Local assessment (primary standard):",
      "  Inspect the full diff and read the mapped canonical architecture docs for high signals. Update the",
      "  relevant canonical docs and record the changed paths, or record a concrete rationale for no update, in",
      "  the completion or commit-preparation result. Medium/no-signal outcomes can be reported concisely. The",
      "  pre-commit hook is advisory only.",
      "",
      "Exit codes:",
      "  0  pass (worktree mode always passes; CI passes unless high signals have an invalid/missing declaration)",
      "  1  fail (high architecture impact with an invalid or missing Documentation Impact declaration)",
      "  2  usage error",
      "",
      "PR body declaration (when opening a PR):",
      "  ## Documentation Impact",
      "  - [x] Architecture docs updated",
      "      Canonical docs: packages/kilo-docs/pages/contributing/architecture/<doc>.md",
      "  - [ ] Not applicable",
      "      Rationale: <why no architecture doc update is needed>",
      "",
      "Exactly one status may be checked. `Not applicable` requires a non-empty Rationale.",
    ].join("\n"),
  )
}

function argValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name)
  if (i === -1) return undefined
  const v = args[i + 1]
  return v !== undefined && !v.startsWith("--") ? v : undefined
}

// Refs reach git only as separate spawnSync args (no shell). Refs must not
// start with `-` (option smuggling) and only safe characters are allowed.
const REF_RE = /^[A-Za-z0-9._/\-~^]+$/
const validRef = (ref: string | undefined): ref is string =>
  ref !== undefined && ref.length > 0 && !ref.startsWith("-") && REF_RE.test(ref)

/** Operational git failure: printed as a stable `RESULT: FAIL` + exit 1. */
class GitError extends Error {}

function run(cmd: string, args: string[]): string {
  const res = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8" })
  if (res.status !== 0) {
    throw new GitError(`Command failed: ${cmd} ${args.join(" ")}\n${res.stderr?.trim() || res.stdout?.trim() || "unknown error"}`)
  }
  return res.stdout ?? ""
}

interface NameStatusEntry {
  status: "A" | "C" | "D" | "M" | "R" | "T"
  old?: string
  path: string
}

/** Parses null-delimited `git diff --name-status -z` output (tab-unsafe paths safe). */
export function parseNameStatus(output: string): NameStatusEntry[] {
  const fields = output.split("\0")
  const entries: NameStatusEntry[] = []
  for (let i = 0; i < fields.length; ) {
    const statusField = fields[i++] ?? ""
    const status = statusField[0]
    if (status === "R" || status === "C") {
      const old = fields[i++] ?? ""
      const path = fields[i++] ?? ""
      if (old && path) entries.push({ status, old, path })
    } else if (status === "A" || status === "M" || status === "D" || status === "T") {
      const path = fields[i++] ?? ""
      if (path) entries.push({ status, path })
    }
  }
  return entries
}

function rangeChanges(base: string, head: string): FileChange[] {
  const entries = parseNameStatus(
    run("git", ["diff", "--name-status", "-z", "-M", "-C", "--find-copies-harder", "--diff-filter=ACDMRT", `${base}...${head}`]),
  )
  const changes: FileChange[] = []
  let pairId = 0
  for (const e of entries) {
    if (e.status === "R" || e.status === "C") {
      // Old side: deletion diff at the old path (all removed lines). New side:
      // addition diff at the new path (all added lines). Both count as one
      // change (shared pair id) and never duplicate signals.
      const id = `pc-${pairId++}`
      changes.push({
        path: e.old ?? "",
        diff: isCandidate(e.old ?? "") ? run("git", ["diff", "--unified=0", `${base}...${head}`, "--", e.old ?? ""]) : "",
        pair: id,
        pairSide: "old",
      })
      changes.push({
        path: e.path,
        diff: isCandidate(e.path) ? run("git", ["diff", "--unified=0", `${base}...${head}`, "--", e.path]) : "",
        pair: id,
        pairSide: "new",
      })
      continue
    }
    changes.push({ path: e.path, diff: isCandidate(e.path) ? run("git", ["diff", "--unified=0", `${base}...${head}`, "--", e.path]) : "" })
  }
  return changes
}

function worktreeChanges(): FileChange[] {
  const entries = parseNameStatus(
    run("git", ["diff", "--name-status", "-z", "-M", "-C", "--find-copies-harder", "--diff-filter=ACDMRT", "HEAD"]),
  )
  const untracked = run("git", ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean)
  const changes: FileChange[] = []
  let pairId = 0
  for (const e of entries) {
    if (e.status === "R" || e.status === "C") {
      const id = `pc-${pairId++}`
      changes.push({
        path: e.old ?? "",
        diff: isCandidate(e.old ?? "") ? run("git", ["diff", "--unified=0", "HEAD", "--", e.old ?? ""]) : "",
        pair: id,
        pairSide: "old",
      })
      changes.push({
        path: e.path,
        diff: isCandidate(e.path) ? run("git", ["diff", "--unified=0", "HEAD", "--", e.path]) : "",
        pair: id,
        pairSide: "new",
      })
      continue
    }
    changes.push({ path: e.path, diff: isCandidate(e.path) ? run("git", ["diff", "--unified=0", "HEAD", "--", e.path]) : "" })
  }
  for (const f of untracked) {
    const abs = path.join(ROOT, f)
    if (!existsSync(abs)) continue
    const lines = readFileSync(abs, "utf8").split(/\r?\n/)
    changes.push({ path: f, diff: `@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}` })
  }
  return changes
}

function printResult(r: CheckResult, worktree: boolean) {
  const out: string[] = []
  out.push(`check-architecture-impact: ${r.signals.length} architecture signal(s) in changed files.`)
  for (const s of r.signals) out.push(`  [${s.tier}] ${s.kind} — ${s.file} (${ADVICE[s.kind]})`)
  if (r.signals.length === 0) out.push("  none")
  out.push("")
  if (worktree) {
    out.push(WORKTREE_ADVICE)
  } else {
    out.push("Documentation Impact declaration:")
    out.push(`  present:  ${r.declaration.present}`)
    out.push(`  status:   ${r.declaration.status ?? "—"}`)
    if (r.declaration.status === "updated") out.push(`  canonical docs: ${r.declaration.canonicalDocs.join(", ") || "—"}`)
    if (r.declaration.status === "not-applicable") out.push(`  rationale: ${r.declaration.rationale || "—"}`)
  }
  if (r.errors.length > 0) {
    out.push("")
    out.push("BLOCKING issues:")
    for (const e of r.errors) out.push(`  - ${e}`)
  }
  if (r.warnings.length > 0) {
    out.push("")
    out.push("Warnings:")
    for (const w of r.warnings) out.push(`  - ${w}`)
  }
  out.push("")
  out.push(r.pass ? "RESULT: PASS" : "RESULT: FAIL")
  const text = out.join("\n")
  if (r.pass) console.log(text)
  else console.error(text)
}

/** Reads the PR body; a missing/unreadable file is a usage error (exit 2). */
function readBodyFile(p: string): string {
  try {
    return readFileSync(p, "utf8")
  } catch {
    console.error(`Cannot read PR body file: ${p}`)
    printUsage()
    return process.exit(2)
  }
}

/** Operational failures always emit a stable `RESULT: FAIL` and exit 1. */
function failOperational(err: unknown): never {
  if (err instanceof GitError) {
    console.error(`check-architecture-impact: git operation failed.\n${err.message}`)
  } else {
    console.error(`check-architecture-impact: unexpected failure.\n${err instanceof Error ? err.stack ?? err.message : String(err)}`)
  }
  console.error("RESULT: FAIL")
  process.exit(1)
}

function main() {
  const args = process.argv.slice(2)
  if (args.includes("--help") || args.includes("-h")) {
    printHelp()
    process.exit(0)
  }
  const worktree = args.includes("--worktree")
  const base = argValue(args, "--base")
  const head = argValue(args, "--head")
  const bodyFile = argValue(args, "--pr-body-file")
  if (worktree) {
    try {
      printResult(evaluateCheck({ changes: worktreeChanges(), worktree: true }), true)
      process.exit(0)
    } catch (err) {
      failOperational(err)
    }
  }
  if (!validRef(base) || !validRef(head)) {
    console.error("CI mode requires --base <ref> and --head <ref> (safe ref characters only, no leading dash).")
    printUsage()
    process.exit(2)
  }
  if (bodyFile === undefined) {
    console.error("CI mode requires --pr-body-file <path>.")
    printUsage()
    process.exit(2)
  }
  const body = readBodyFile(bodyFile)
  try {
    const result = evaluateCheck({ changes: rangeChanges(base, head), body, worktree: false })
    printResult(result, false)
    process.exit(result.pass ? 0 : 1)
  } catch (err) {
    failOperational(err)
  }
}

if (import.meta.main) {
  main()
}
