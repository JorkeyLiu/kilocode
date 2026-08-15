/**
 * Run-owned durable evidence handoff for the real E2E harness.
 *
 * Node-only, test-only module (imported by script/e2e-probe.ts and the unit
 * tests; never bundled into the extension). Implements the KILO_E2E_EVIDENCE_DIR
 * contract that eliminates the target-performance campaign's final-window copy
 * race:
 *
 *   - An explicit evidence destination (`KILO_E2E_EVIDENCE_DIR`) is validated
 *     fail-fast (absolute, parent exists, absent-or-empty, never inside the
 *     soon-deleted scratch) BEFORE VS Code launches.
 *   - After the final scenario evidence is written and the extension-host
 *     runner has quiesced (VS Code exited), the harness atomically preserves
 *     the run-owned evidence set: plan, scenario snapshot JSONs, raw LLM
 *     request JSONL, request matrices, PIN evidence, final DOM evidence, and
 *     the run-owned workspace artifacts.
 *   - Every copy is byte-exact: the source is hashed, copied, the destination
 *     re-read and re-hashed, and the source re-read and re-hashed — a changed
 *     source (copy race) or a corrupt copy fails the handoff.
 *  - A manifest JSON records source relative paths, destination paths, byte
 *     sizes, sha256, run identity/scenario/timestamp/provenance, the required
 *     inventory, and an explicit missing/malformed list. A required artifact
 *     that is missing or malformed fails the handoff (status != "complete").
 *  - The manifest records one entry per destination: identical duplicate
 *     references (a required artifact also matched by an optional glob, or a
 *     marker listed twice in the optional inventory) collapse to a single
 *     entry, and a destination claimed by two different sources fails the
 *     handoff immediately instead of silently choosing one.
 *   - The capture log is launcher-owned (script/e2e-probe-launch.mjs tees the
 *     probe's stdout+stderr into the staging dir), so this module writes the
 *     manifest WITHOUT the capture-log entry and then writes the `evidence-ready`
 *     marker; the launcher appends the capture-log entry and atomically renames
 *     the staging dir into the destination after the probe process exits (no
 *     polling race: the rename happens after the probe's stdout pipe closes).
 *
 * Default runs (env var absent) never touch this module's copy path — the
 * harness behaves exactly as before.
 */

import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"

/** Manifest schema version. The launcher's finalize step shares this literal. */
export const EVIDENCE_SCHEMA = "kilo-e2e-evidence/1"

/** Launcher-owned capture log written into the staging dir during the run. */
export const CAPTURE_LOG = "run.log"

/** Written by the harness after copying internal artifacts (launcher reads it after exit). */
export const EVIDENCE_READY = "evidence-ready"

export const MANIFEST = "manifest.json"

export type EvidenceBase = "scratch" | "workspace"

export interface EvidenceSource {
  /** Path relative to the base dir ("plan.json", ".kilo/kilo.json", ...). */
  rel: string
  base: EvidenceBase
  /** Glob entry (e.g. "rc-snap-*.json"): expanded at collection time; zero matches is a failure. */
  glob?: boolean
}

export interface EvidenceEntry {
  /** Absolute source path at copy time (provenance). */
  source: string
  /** Source path relative to its base, e.g. "scratch/plan.json" or "workspace/e2e-custom-called.txt". */
  sourceRel: string
  /** Path inside the evidence destination. */
  dest: string
  bytes: number
  sha256: string
}

export interface EvidenceRunInfo {
  fixtureId: string
  scenario: string
  startedAt: string
  completedAt: string
  durationMs: number
  probePid: number
  /** True when the E2E scenario assertions passed. */
  success: boolean
  provenance: string
  env: Record<string, string | undefined>
}

/** "complete" = every required artifact present, parseable, and byte-exact. */
export type EvidenceStatus = "complete" | "missing" | "malformed" | "failed"

export interface EvidenceManifest {
  schema: string
  run: EvidenceRunInfo
  destination: string
  /** Destination-relative names of the required inventory (glob patterns expanded). */
  required: string[]
  files: EvidenceEntry[]
  missing: string[]
  malformed: string[]
  notes: string[]
  /** Capture-log entry; filled by the launcher after the probe exits. */
  captureLog: EvidenceEntry | null
  status: EvidenceStatus
  validated: boolean
  finalizedAt: string | null
}

/** The dom-evidence file each scenario owns (its final DOM/PIN/matrix evidence). */
const DOM_EVIDENCE: Record<string, string[]> = {
  all: ["tab-close-dom-evidence", "dom-evidence", "variant-dom-evidence"],
  "tab-close": ["tab-close-dom-evidence"],
  "child-task-order": ["dom-evidence"],
  "variant-memory": ["variant-dom-evidence"],
  "topic-navigation": ["topic-dom-evidence"],
  "real-session": ["real-dom-evidence"],
  "real-completed": ["real-completed-dom-evidence"],
  "real-overflow": ["real-overflow-dom-evidence"],
  "real-restart": ["rr-dom-evidence"],
}

/** Backend-snapshot file prefixes per real scenario (written by the runner loop). */
const SNAP_PREFIXES: Record<string, string[]> = {
  "real-session": ["real-snap-"],
  "real-completed": ["rc-snap-"],
  "real-overflow": ["of-snap-"],
  "real-restart": ["rr-snap-", "rr-c-snap-"],
}

/** The scenario readiness marker written by the extension-host runner. */
const READY_MARKERS: Record<string, string[]> = {
  "real-session": ["real-ready"],
  "real-completed": ["real-completed-ready"],
  "real-overflow": ["real-overflow-ready"],
  "real-restart": ["rr-ready"],
}

/** Env vars worth recording in the manifest (whitelist — never arbitrary config). */
const MANIFEST_ENV = ["KILO_E2E_SCENARIO", "KILO_E2E_TIMEOUT", "KILO_P0_PERF", "KILO_E2E_FIXTURE"]

/** The env var the E2E probe/launcher accept for an explicit evidence destination. */
export const EVIDENCE_DIR_ENV = "KILO_E2E_EVIDENCE_DIR"

export function evidenceDirFromEnv(env: Record<string, string | undefined>): string | undefined {
  const raw = env[EVIDENCE_DIR_ENV]
  if (raw === undefined || raw === "") return undefined
  return resolve(raw)
}

/**
 * Probe-side resolution + fail-fast validation of the explicit evidence
 * destination. Returns the resolved destination when the env contract is
 * active (KILO_E2E_EVIDENCE_DIR set), or undefined (default runs behave
 * exactly as before). Requires the launcher-owned staging env, validates the
 * destination (absolute, parent exists, absent-or-empty, never inside the
 * soon-deleted scratch), and throws BEFORE VS Code launches on any violation.
 */
export function evidenceDirFor(scratch: string): string | undefined {
  const evidenceDir = evidenceDirFromEnv(process.env)
  if (!evidenceDir) return undefined
  const staging = process.env.KILO_E2E_EVIDENCE_STAGING
  if (!staging) {
    throw new Error(
      `[probe] KILO_E2E_EVIDENCE_DIR=${evidenceDir} requires the launcher-owned staging dir ` +
        "(KILO_E2E_EVIDENCE_STAGING unset — launch via script/e2e-probe-launch.mjs)",
    )
  }
  validateEvidenceDestination(evidenceDir, scratch)
  console.log(`[probe] evidence handoff enabled: ${evidenceDir} (staging ${staging})`)
  return evidenceDir
}

export function sha256Of(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex")
}

/**
 * Fail-fast destination validation. `scratch` is the run-owned temp root; the
 * destination must never point inside it (it is deleted at cleanup, and the
 * staging sibling would be deleted with it).
 */
export function validateEvidenceDestination(dest: string, scratch: string | undefined): void {
  if (!isAbsolute(dest)) {
    throw new Error(`[probe] KILO_E2E_EVIDENCE_DIR must be an absolute path, got "${dest}"`)
  }
  if (scratch && (dest === scratch || dest.startsWith(scratch + "/"))) {
    throw new Error(
      `[probe] KILO_E2E_EVIDENCE_DIR "${dest}" points inside the run-owned scratch "${scratch}" ` +
        "(the scratch dir is deleted at cleanup; choose a destination outside it)",
    )
  }
  const parent = dirname(dest)
  if (!existsSync(parent) || !statSync(parent).isDirectory()) {
    throw new Error(`[probe] KILO_E2E_EVIDENCE_DIR parent does not exist or is not a directory: "${parent}"`)
  }
  if (existsSync(dest)) {
    if (!statSync(dest).isDirectory()) {
      throw new Error(`[probe] KILO_E2E_EVIDENCE_DIR exists but is not a directory: "${dest}"`)
    }
    const entries = readdirSync(dest)
    if (entries.length > 0) {
      throw new Error(
        `[probe] KILO_E2E_EVIDENCE_DIR exists and is not empty (${entries.slice(0, 5).join(", ")}...); ` +
          "refusing to overwrite a pre-existing directory — use an absent or empty destination",
      )
    }
  }
}

/**
 * The evidence inventory for the selected scenarios. Required entries are the
 * decision-critical artifacts: plan, final DOM evidence, raw LLM request JSONL,
 * the runner's durable LLM copy, the final request matrix, every snapshot JSON,
 * the served workspace config, and (real-completed) the H-3/H-5/H-6/H-12
 * workspace artifacts. Everything else relevant is copied when present without
 * failing the handoff.
 */
export function evidenceInventory(scenarios: Set<string>): { required: EvidenceSource[]; optional: EvidenceSource[] } {
  const required: EvidenceSource[] = [
    { rel: "plan.json", base: "scratch" },
    { rel: "runner-pid", base: "scratch" },
  ]
  const optional: EvidenceSource[] = [
    { rel: "runner-alive", base: "scratch" },
    { rel: "runner-done", base: "scratch" },
    { rel: "ready", base: "scratch" },
  ]
  const real = new Set(["real-session", "real-completed", "real-overflow", "real-restart"])

  for (const scenario of scenarios) {
    for (const dom of DOM_EVIDENCE[scenario] ?? []) {
      required.push({ rel: dom, base: "scratch" })
    }
    if (real.has(scenario)) {
      required.push(
        { rel: "llm-requests.jsonl", base: "scratch" },
        { rel: `llm-requests-${scenario}.json`, base: "scratch" },
        { rel: `llm-matrix-${scenario}-final.json`, base: "scratch" },
        { rel: ".kilo/kilo.json", base: "workspace" },
      )
      for (const prefix of SNAP_PREFIXES[scenario] ?? []) {
        required.push({ rel: `${prefix}*.json`, base: "scratch", glob: true })
      }
      for (const ready of READY_MARKERS[scenario] ?? []) {
        optional.push({ rel: ready, base: "scratch" })
      }
    }
    // Extra markers/evidence each scenario may produce (copied when present).
    optional.push(
      { rel: "tab-close-done", base: "scratch" },
      { rel: "child-phase1-done", base: "scratch" },
      { rel: "child-phase2-ready", base: "scratch" },
      { rel: "child-phase2-done", base: "scratch" },
      { rel: "variant-ready", base: "scratch" },
      { rel: "topic-nav-done", base: "scratch" },
      { rel: "topic-reopen-ready", base: "scratch" },
      { rel: "topic-reopen-done", base: "scratch" },
      { rel: "topic-reload-start", base: "scratch" },
      { rel: "topic-reload-frame", base: "scratch" },
      { rel: "topic-reload-ready", base: "scratch" },
      { rel: "topic-reload-done", base: "scratch" },
      { rel: "real-ready", base: "scratch" },
      { rel: "real-reopen-ready", base: "scratch" },
      { rel: "real-completed-ready", base: "scratch" },
      { rel: "real-completed-reopen-ready", base: "scratch" },
      { rel: "real-completed-mcp-disconnect-done", base: "scratch" },
      { rel: "real-overflow-ready", base: "scratch" },
      { rel: "rr-ready", base: "scratch" },
      { rel: "rr-conn.json", base: "scratch" },
      { rel: "rr-kill.json", base: "scratch" },
      { rel: "rr-reconnect.json", base: "scratch" },
      { rel: "rr-reload-executed", base: "scratch" },
      { rel: "rr-reloaded", base: "scratch" },
      { rel: "rr-pin.json", base: "scratch" },
      { rel: "rr-model-requests.json", base: "scratch" },
    )
  }

  // Every matrix phase is decision-critical LOCK-006 evidence; copy all present.
  optional.push({ rel: "llm-matrix-*.json", base: "scratch", glob: true })

  // real-completed workspace artifacts (H-3/H-5/H-6/H-12 claims).
  if (scenarios.has("real-completed")) {
    required.push(
      { rel: "e2e-custom-called.txt", base: "workspace" },
      { rel: "mcp-fixture/calls.log", base: "workspace" },
      { rel: "ask.txt", base: "workspace" },
      { rel: "rollback.txt", base: "workspace" },
    )
    optional.push(
      { rel: ".kilo/tool/e2e_marker.ts", base: "workspace" },
      { rel: ".kilo/skills/e2e-skill/SKILL.md", base: "workspace" },
      { rel: "mcp-fixture/server.js", base: "workspace" },
      { rel: ".kilo/package-lock.json", base: "workspace" },
    )
  }
  if (scenarios.has("real-restart")) {
    optional.push({ rel: "e2e-custom-called.txt", base: "workspace" })
  }
  if (scenarios.has("real-session") || scenarios.has("real-overflow")) {
    optional.push({ rel: ".kilo/package-lock.json", base: "workspace" })
  }
  return { required, optional }
}

/** Expand a glob source (e.g. "rc-snap-*.json") into concrete relative paths. */
export function expandGlob(base: string, rel: string): string[] {
  const star = rel.indexOf("*")
  if (star === -1) return [rel]
  const prefix = rel.slice(0, star)
  const suffix = rel.slice(star + 1)
  return readdirSync(base)
    .filter((name) => name.startsWith(prefix) && name.endsWith(suffix))
    .sort()
    .map((name) => name)
}

/** True when the file must be parseable as evidence (JSON or the raw JSONL store). */
function needsParse(dest: string): boolean {
  return dest === "llm-requests.jsonl" || dest.endsWith(".json")
}

/** Validate the file parses (JSON whole-file, or every JSONL line). Returns the failure or null. */
export function parseFailure(dest: string, bytes: Buffer): string | null {
  if (dest === "llm-requests.jsonl") {
    const lines = bytes.toString("utf8").split("\n").filter((line) => line.trim() !== "")
    if (lines.length === 0) return "empty JSONL store (no generation request recorded)"
    for (const line of lines) {
      try {
        JSON.parse(line)
      } catch {
        return `corrupt JSONL line: ${JSON.stringify(line.slice(0, 120))}`
      }
    }
    return null
  }
  if (dest.endsWith(".json")) {
    const text = bytes.toString("utf8")
    if (text.trim() === "") return "empty file (expected JSON)"
    try {
      JSON.parse(text)
    } catch {
      return `invalid JSON: ${JSON.stringify(text.slice(0, 120))}`
    }
  }
  return null
}

/**
 * Claim a destination for a source inside `collectEvidence`. Returns true when
 * the claim is new; false when an identical reference already claimed it (the
 * duplicate collapses — one manifest entry per destination). Throws when the
 * same destination maps to a different source: an inventory bug must fail the
 * handoff clearly, never silently pick one.
 */
export function claimDestination(claimed: Map<string, string>, dest: string, src: string): boolean {
  const prior = claimed.get(dest)
  if (prior === undefined) {
    claimed.set(dest, src)
    return true
  }
  if (prior === src) return false
  throw new Error(`conflicting evidence sources for destination "${dest}": "${prior}" vs "${src}"`)
}

export interface CollectOptions {
  staging: string
  scratch: string
  workspace: string
  scenarios: Set<string>
  fixtureId: string
  startedAt: number
  probePid: number
  /** True when the E2E scenario assertions passed before the handoff ran. */
  success: boolean
  destination: string
}

/**
 * Copy the run-owned evidence set into the staging dir byte-exactly, write the
 * manifest draft (without the launcher-owned capture log), and write the
 * `evidence-ready` marker. Sync and fail-fast: any missing or malformed required
 * artifact is recorded AND surfaced via a non-"complete" status. The manifest
 * records one entry per destination (identical duplicate references collapse;
 * conflicting sources for one destination throw).
 */
export function collectEvidence(opts: CollectOptions): EvidenceManifest {
  const { staging, scratch, workspace, scenarios, fixtureId, startedAt, probePid, success, destination } = opts
  const { required, optional } = evidenceInventory(scenarios)
  const files: EvidenceEntry[] = []
  const missing: string[] = []
  const malformed: string[] = []
  const notes: string[] = []
  const requiredDest: string[] = []
  const claimed = new Map<string, string>()

  const baseDir = (base: EvidenceBase) => (base === "scratch" ? scratch : workspace)
  const destRel = (source: EvidenceSource, rel: string) => (source.base === "workspace" ? `workspace/${rel}` : rel)

  const copyOne = (source: EvidenceSource, isRequired: boolean, rel: string): void => {
    const src = join(baseDir(source.base), rel)
    const dest = destRel(source, rel)
    // One manifest entry per destination: identical duplicate references
    // (required/optional inventory overlap) collapse; a different source for
    // the same destination fails clearly.
    if (!claimDestination(claimed, dest, src)) return
    if (!existsSync(src) || !statSync(src).isFile()) {
      if (isRequired) {
        missing.push(dest)
        requiredDest.push(dest)
      }
      return
    }
    if (isRequired) requiredDest.push(dest)
    const bytes = readFileSync(src)
    const hash = sha256Of(bytes)
    const target = join(staging, dest)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, bytes)
    // Byte-exact proof: the copy must hash to the same bytes AND the source
    // must not have changed while we read it (the final-window copy race).
    const copyHash = sha256Of(readFileSync(target))
    if (copyHash !== hash) {
      malformed.push(dest)
      notes.push(`copy hash mismatch for ${dest} (source ${hash} vs copy ${copyHash})`)
      return
    }
    const again = sha256Of(readFileSync(src))
    if (again !== hash) {
      malformed.push(dest)
      notes.push(`source changed during copy for ${dest} (hash ${hash} vs ${again}) — copy race`)
      return
    }
    if (isRequired && needsParse(dest)) {
      const failure = parseFailure(dest, bytes)
      if (failure !== null) {
        malformed.push(dest)
        notes.push(`malformed required artifact ${dest}: ${failure}`)
        return
      }
    }
    files.push({ source: src, sourceRel: `${source.base}/${rel}`, dest, bytes: bytes.length, sha256: hash })
  }

  for (const source of required) {
    if (source.glob) {
      const expanded = expandGlob(baseDir(source.base), source.rel)
      if (expanded.length === 0) {
        missing.push(source.rel)
        requiredDest.push(source.rel)
      }
      for (const rel of expanded) copyOne(source, true, rel)
    } else {
      copyOne(source, true, source.rel)
    }
  }
  for (const source of optional) {
    if (source.glob) {
      for (const rel of expandGlob(baseDir(source.base), source.rel)) copyOne(source, false, rel)
    } else {
      copyOne(source, false, source.rel)
    }
  }

  const missingRequired = missing.length
  const malformedRequired = malformed.length
  const validated = missingRequired === 0 && malformedRequired === 0
  const status: EvidenceStatus = !success ? "failed" : !validated ? (malformedRequired > 0 ? "malformed" : "missing") : "complete"

  const run: EvidenceRunInfo = {
    fixtureId,
    scenario: [...scenarios].join(","),
    startedAt: new Date(startedAt).toISOString(),
    completedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    probePid,
    success,
    provenance: "focused E2E harness (packages/kilo-vscode), fixture-gated, run-owned evidence",
    env: Object.fromEntries(MANIFEST_ENV.map((key) => [key, process.env[key]])),
  }
  const manifest: EvidenceManifest = {
    schema: EVIDENCE_SCHEMA,
    run,
    destination,
    required: requiredDest.sort(),
    files: files.sort((a, b) => a.dest.localeCompare(b.dest)),
    missing: missing.sort(),
    malformed: malformed.sort(),
    notes,
    captureLog: null,
    status,
    validated,
    finalizedAt: null,
  }
  writeFileSync(join(staging, MANIFEST), JSON.stringify(manifest, null, 2))
  writeFileSync(join(staging, EVIDENCE_READY), JSON.stringify({ at: run.completedAt, status }))
  return manifest
}

export interface HandoffOptions {
  /** Undefined when the env contract is inactive (default runs — no-op). */
  evidenceDir: string | undefined
  staging: string
  scratch: string
  workspace: string
  scenarios: Set<string>
  fixtureId: string
  startedAt: number
  /** True when the E2E scenario assertions passed before the handoff ran. */
  success: boolean
}

/**
 * Probe-side handoff entry: run after the extension-host runner quiesced (VS
 * Code exited) but BEFORE scratch cleanup. Copies the run-owned evidence set
 * into the staging dir and returns true when the run must fail (handoff not
 * "complete" — a required artifact is missing or malformed). A no-op (returns
 * false) when no explicit destination was requested, so default runs behave
 * exactly as before. The launcher owns the capture log and atomically renames
 * the staging dir into the destination after this process exits; scratch
 * cleanup still deletes the scratch.
 */
export function runEvidenceHandoff(opts: HandoffOptions): boolean {
  const { evidenceDir, staging, ...rest } = opts
  if (!evidenceDir) return false
  const manifest = collectEvidence({ ...rest, probePid: process.pid, destination: evidenceDir, staging })
  console.log(
    `[probe] evidence handoff: status=${manifest.status} files=${manifest.files.length} ` +
      `missing=${manifest.missing.length} malformed=${manifest.malformed.length} validated=${manifest.validated}`,
  )
  return manifest.status !== "complete"
}
