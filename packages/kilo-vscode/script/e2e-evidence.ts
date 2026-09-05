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
import { parse as jsoncParse, type ParseError as JsoncParseError } from "jsonc-parser"
import { validateQueuedObservation } from "../src/agent-manager/fixture-backend"

/** Manifest schema version. The launcher's finalize step shares this literal. */
export const EVIDENCE_SCHEMA = "kilo-e2e-evidence/1"

/** Launcher-owned capture log written into the staging dir during the run. */
export const CAPTURE_LOG = "run.log"

/** Written by the harness after copying internal artifacts (launcher reads it after exit). */
export const EVIDENCE_READY = "evidence-ready"

export const MANIFEST = "manifest.json"

/**
 * Current private FD capabilities. Duplicated (not imported) from runtime
 * `packages/opencode/src/kilocode/server/fd-carrier-protocol.ts` FD_CAPABILITIES
 * to avoid cross-package build coupling for this Node-only test harness; keep
 * in sync with that source. Unknown values must still fail validation.
 */
export const PRIVATE_FD_CAPABILITIES = [
  "session/cancelQueued",
  "session/update",
  "session/fork",
  "session/create",
  "session/status",
  "session/get",
  "session/messages",
  "session/children",
] as const

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
  "worktree-removal": ["worktree-removal-dom-evidence"],
  "r9-observation": ["r9-dom-evidence", "r9-observation-runtime-evidence"],
}

/** Backend-snapshot file prefixes per real scenario (written by the runner loop). */
const SNAP_PREFIXES: Record<string, string[]> = {
  "real-session": ["real-snap-"],
  "real-completed": ["rc-snap-"],
  "real-overflow": ["of-snap-"],
  "real-restart": ["rr-snap-", "rr-c-snap-"],
  "real-lifecycle": ["lc-snap-"],
  "worktree-removal": ["p32-snap-"],
  "r9-observation": ["r9-snap-"],
}

/** The scenario readiness marker written by the extension-host runner. */
const READY_MARKERS: Record<string, string[]> = {
  "real-session": ["real-ready"],
  "real-completed": ["real-completed-ready"],
  "real-overflow": ["real-overflow-ready"],
  "real-restart": ["rr-ready"],
  "real-lifecycle": ["lc-ready"],
  "worktree-removal": ["worktree-removal-ready"],
  "r9-observation": ["r9-ready"],
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
  const real = new Set([
    "real-session",
    "real-completed",
    "real-overflow",
    "real-restart",
    "real-lifecycle",
    "worktree-removal",
  ])

  for (const scenario of scenarios) {
    for (const dom of DOM_EVIDENCE[scenario] ?? []) {
      required.push({ rel: dom, base: "scratch" })
    }
    if (real.has(scenario)) {
      required.push(
        { rel: "llm-requests.jsonl", base: "scratch" },
        { rel: `llm-requests-${scenario}.json`, base: "scratch" },
        { rel: `llm-matrix-${scenario}-final.json`, base: "scratch" },
        {
          rel: scenario === "real-restart" || scenario === "real-lifecycle" ? ".kilo/kilo.jsonc" : ".kilo/kilo.json",
          base: "workspace",
        },
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
      { rel: "rr-private-status.json", base: "scratch" },
      { rel: "rr-title-result.json", base: "scratch" },
      { rel: "rr-replay-result.json", base: "scratch" },
      { rel: "rr-gc-*.json", base: "scratch", glob: true },
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
  // P3.2 worktree-removal: the extension-host runtime evidence (manifest +
  // command-table + no-worktree-state facts) and the H-12 tracked rollback
  // file are decision-critical; the served config seed is the same one the
  // backend loaded (already required above via the `real` set).
  if (scenarios.has("worktree-removal")) {
    required.push(
      { rel: "worktree-removal-runtime-evidence", base: "scratch" },
      { rel: "rollback.txt", base: "workspace" },
    )
    optional.push({ rel: ".kilo/package-lock.json", base: "workspace" })
  }
  // P3.3 cloud-claw-removal: the extension-host runtime evidence (manifest +
  // command-table + bundle-list absence facts + retained readiness) is
  // decision-critical; no LLM evidence exists because this scenario never
  // issues model requests. The ready marker is optional (copied when present).
  if (scenarios.has("cloud-claw-removal")) {
    required.push({ rel: "cloud-claw-removal-runtime-evidence", base: "scratch" })
    optional.push({ rel: "cloud-claw-removal-ready", base: "scratch" })
  }
  // P3.4 p3-4-removal: the extension-host runtime evidence (manifest +
  // command-table + bundle-list + workspace-state absence facts, zero model
  // requests, retained readiness) is decision-critical; no LLM evidence exists
  // because this scenario never issues model requests. The ready marker is
  // optional (copied when present).
  if (scenarios.has("p3-4-removal")) {
    required.push({ rel: "p3-4-removal-runtime-evidence", base: "scratch" })
    optional.push({ rel: "p3-4-removal-ready", base: "scratch" })
  }
  if (scenarios.has("real-restart")) {
    required.push(
      { rel: "canonical-gate.json", base: "scratch" },
      { rel: "canonical-archive-before.json", base: "scratch" },
      { rel: "canonical-archive-after.json", base: "scratch" },
      // Canonical-state probe (restartPhase0): the runtime
      // CanonicalConfigService snapshot that makes ModeSwitcher options=[]
      // self-diagnosing (H1 readiness-never-opened vs H2 empty index). The
      // probe fails fast when the round trip never completes, so a successful
      // run always carries this file.
      { rel: "rr-cstate.json", base: "scratch" },
      // Credential provisioning evidence (real SecretStorage, no bypass):
      // proves the project credential ref was stored and canonical state
      // converged to connected + defaultModel before the first session.
      // Never contains the secret value.
      { rel: "rr-credential.json", base: "scratch" },
      // Gate C structured redacted proof — required for real-restart
      // validation (schema/version, fixtureId hash, backend/private pid/port/epoch,
      // protocol/capability, SDK/private statuses, title hash, op hashes,
      // revisions, parity, killed identity, scope). No raw title/key/path/error.
      { rel: "rr-gc-proof.json", base: "scratch" },
    )
    optional.push({ rel: "e2e-custom-called.txt", base: "workspace" })
  }
  if (scenarios.has("real-lifecycle")) {
    required.push(
      { rel: "canonical-gate.json", base: "scratch" },
      { rel: "canonical-archive-before.json", base: "scratch" },
      { rel: "canonical-archive-after.json", base: "scratch" },
      { rel: "lc-cstate.json", base: "scratch" },
      { rel: "lc-credential.json", base: "scratch" },
      { rel: "lc-gc-proof.json", base: "scratch" },
      { rel: "lc-layout-timeline.json", base: "scratch" },
    )
    optional.push(
      { rel: "e2e-custom-called.txt", base: "workspace" },
      { rel: "lc-dom-evidence", base: "scratch" },
    )
  }
  if (scenarios.has("real-session")) {
    required.push(
      { rel: "canonical-gate.json", base: "scratch" },
      { rel: "canonical-archive-before.json", base: "scratch" },
      { rel: "canonical-archive-after.json", base: "scratch" },
      // Real-session canonical-state probe: same diagnostic as real-restart
      // but distinct rs-cstate.json so the five-boundary claim aggregates
      // across manifests without collision.
      { rel: "rs-cstate.json", base: "scratch" },
      // Real-session credential evidence: distinct rs-credential.json file
      // (real SecretStorage, no bypass) — never contains the secret value.
      { rel: "rs-credential.json", base: "scratch" },
      { rel: ".kilo/kilo.jsonc", base: "workspace" },
    )
    // SSE timeline windows around Stop A / Stop B (LOCK-049/050/051):
    // fixture-only, bounded, redacted delivered-event arrival order. Optional
    // so a run without the abort windows still hands off; copied when present.
    optional.push(
      { rel: "sse-timeline-abort-A.json", base: "scratch" },
      { rel: "sse-timeline-abort-B.json", base: "scratch" },
      // Cumulative run-level abort-attempt export (fixture-only, bounded,
      // redacted observer records after Stop B). Absence remains allowed;
      // presence is validated.
      { rel: "abort-attempts.json", base: "scratch" },
      // G3/B9 investigation-only queued observation (fixture-only, bounded,
      // redacted SDK-visible message/status shape for the DOM follow-up on
      // the busy session, recorded before Stop — not backend queue truth).
      // Absence remains allowed; presence is validated. Never a
      // terminal/durable abort outcome, never active-generation interruption.
      { rel: "queued-observation.json", base: "scratch" },
    )
  }
  if (scenarios.has("real-session") || scenarios.has("real-overflow") || scenarios.has("worktree-removal")) {
    optional.push({ rel: ".kilo/package-lock.json", base: "workspace" })
  }
  if (scenarios.has("r9-observation")) {
    required.push(
      { rel: "canonical-gate.json", base: "scratch" },
      { rel: "canonical-archive-before.json", base: "scratch" },
      { rel: "canonical-archive-after.json", base: "scratch" },
      { rel: "r9-observation-runtime-evidence", base: "scratch" },
      { rel: "r9-dom-evidence", base: "scratch" },
      { rel: "r9-cstate.json", base: "scratch" },
    )
    optional.push(
      { rel: "r9-ready", base: "scratch" },
      { rel: "r9-snap-*.json", base: "scratch", glob: true },
      { rel: "r9-panel-request", base: "scratch" },
      { rel: "r9-panel.json", base: "scratch" },
      { rel: "r9-reload-request", base: "scratch" },
      { rel: "r9-reload.json", base: "scratch" },
      { rel: "r9-reload-start", base: "scratch" },
      { rel: "r9-reload-frame", base: "scratch" },
      { rel: "r9-reload-ready", base: "scratch" },
      { rel: "r9-switch-request", base: "scratch" },
      { rel: "r9-switch.json", base: "scratch" },
      { rel: "r9-switch-clicked", base: "scratch" },
      { rel: "r9-switch-confirmed", base: "scratch" },
      { rel: "r9-reconnect-request", base: "scratch" },
      { rel: "r9-reconnect.json", base: "scratch" },
      { rel: "r9-restart-request", base: "scratch" },
      { rel: "r9-restart.json", base: "scratch" },
      { rel: "r9-ack.json", base: "scratch" },
      { rel: "r9-evict.json", base: "scratch" },
      { rel: "r9-status.json", base: "scratch" },
    )
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

/** True when the file must be parseable as evidence (JSON/JSONC or the raw JSONL store). */
function needsParse(dest: string): boolean {
  return dest === "llm-requests.jsonl" || dest.endsWith(".json") || dest.endsWith(".jsonc")
}

/**
 * Fixture-only bounded/redacted envelope checks for the present-when-copied
 * timeline/abort/queued artifacts. Extracted so parseFailure stays under its
 * complexity cap; each branch validates one artifact's shape plus secret
 * redaction and returns the failure or null.
 */
function optionalArtifactFailure(dest: string, parsed: unknown, text: string): string | null {
  if (dest === "sse-timeline-abort-A.json" || dest === "sse-timeline-abort-B.json") {
    const err = validateSseTimeline(parsed)
    if (err) return `sse-timeline abort malformed: ${err}`
    if (text.includes("e2e-fixture-key") || text.includes("KILO_SERVER_PASSWORD"))
      return "sse-timeline abort leaked secret"
    return null
  }
  if (dest === "abort-attempts.json") {
    const err = validateAbortAttempts(parsed)
    if (err) return `abort-attempts malformed: ${err}`
    if (text.includes("e2e-fixture-key") || text.includes("KILO_SERVER_PASSWORD"))
      return "abort-attempts leaked secret"
    return null
  }
  if (dest === "queued-observation.json") {
    const err = validateQueuedObservation(parsed)
    if (err) return `queued-observation malformed: ${err}`
    if (text.includes("e2e-fixture-key") || text.includes("KILO_SERVER_PASSWORD"))
      return "queued-observation leaked secret"
    return null
  }
  return null
}

/** Validate the file parses (JSON/JSONC whole-file, or every JSONL line). Returns the failure or null. */
export function parseFailure(dest: string, bytes: Buffer): string | null {
  if (dest === "llm-requests.jsonl") {
    const lines = bytes
      .toString("utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
    if (lines.length === 0) return "empty JSONL store (no generation request recorded)"
    for (const line of lines) {
      try {
        JSON.parse(line)
      } catch {
        return "corrupt JSONL line"
      }
    }
    return null
  }
  if (dest.endsWith(".jsonc")) {
    const text = bytes.toString("utf8")
    if (text.trim() === "") return "empty file (expected JSONC)"
    const errors: JsoncParseError[] = []
    const parsed = jsoncParse(text, errors, { allowTrailingComma: true })
    if (errors.length > 0) return "invalid JSONC"
    if (parsed === undefined) return "invalid JSONC"
    return null
  }
  if (dest.endsWith(".json")) {
    const text = bytes.toString("utf8")
    if (text.trim() === "") return "empty file (expected JSON)"
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return "invalid JSON"
    }
    if (dest === "rr-gc-proof.json") {
      const err = validateGcProof(parsed)
      if (err) return `rr-gc-proof malformed: ${err}`
      // redaction checks: no raw title leakage via obvious keys
      const raw = text
      if (raw.includes("e2e-fixture-key") || raw.includes("KILO_SERVER_PASSWORD")) return "rr-gc-proof leaked secret"
      // ensure no filesystem path leaked (heuristic: absolute path not allowed except scratch not stored)
      // proof must not contain raw title — titleHash is hex, not raw; check proof doesn't contain plain GateC Title string
      if (/GateC Title/.test(raw)) return "rr-gc-proof leaked raw title"
    }
    if (dest === "lc-gc-proof.json") {
      const err = validateLcProof(parsed)
      if (err) return `lc-gc-proof malformed: ${err}`
      const raw = text
      if (raw.includes("e2e-fixture-key") || raw.includes("KILO_SERVER_PASSWORD")) return "lc-gc-proof leaked secret"
      if (/GcLifecycle Title/.test(raw)) return "lc-gc-proof leaked raw title"
      if (/GateC Title/.test(raw)) return "lc-gc-proof leaked raw title"
    }
    if (dest === "lc-layout-timeline.json") {
      const err = validateLcTimeline(parsed)
      if (err) return `lc-layout-timeline malformed: ${err}`
      const raw = text
      if (raw.includes("e2e-fixture-key") || raw.includes("KILO_SERVER_PASSWORD"))
        return "lc-layout-timeline leaked secret"
      if (/GcLifecycle Title/.test(raw)) return "lc-layout-timeline leaked raw title"
      if (/GateC Title/.test(raw)) return "lc-layout-timeline leaked raw title"
      if (/\/[a-z]+\/[^\s"]*\.kilo/.test(raw)) return "lc-layout-timeline leaked path"
    }
    const optionalFailure = optionalArtifactFailure(dest, parsed, text)
    if (optionalFailure) return optionalFailure
  }
  return null
}

// eslint-disable-next-line complexity
export function validateGcProof(parsed: unknown): string | null {
  const hex16 = /^[0-9a-f]{16}$/
  const isHex16 = (v: unknown): boolean => typeof v === "string" && hex16.test(v)
  const isPid = (v: unknown): boolean => typeof v === "number" && Number.isInteger(v) && v > 0 && v < 1_000_0000
  const isPort = (v: unknown): boolean => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 65535
  const isEpoch = (v: unknown): boolean => typeof v === "number" && Number.isInteger(v) && v >= 1
  const isRevision = (v: unknown): v is { session: number; config?: number } => {
    if (!v || typeof v !== "object" || Array.isArray(v)) return false
    const r = v as Record<string, unknown>
    if (typeof r.session !== "number" || !Number.isInteger(r.session) || r.session < 0) return false
    if (r.config !== undefined && (typeof r.config !== "number" || !Number.isInteger(r.config) || r.config < 0))
      return false
    const allowed = new Set(["session", "config"])
    for (const k of Object.keys(r)) if (!allowed.has(k)) return false
    return true
  }
  const ALLOWED_CAPS = new Set<string>(PRIVATE_FD_CAPABILITIES as readonly string[])
  const ALLOWED_STATE = new Set(["connecting", "connected", "disconnected", "error"])
  const forbidKeys = new Set([
    "title",
    "payload",
    "path",
    "secret",
    "password",
    "apiKey",
    "sessionId",
    "opId",
    "requestId",
    "idempotencyKey",
    "rawTitle",
    "sessionID",
    "requestID",
  ])
  const checkForbidden = (obj: unknown, at: string): string | null => {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null
    const rec = obj as Record<string, unknown>
    for (const k of Object.keys(rec)) {
      if (forbidKeys.has(k)) return `${at}.${k} forbidden key`
      if (/secret|password|apiKey/i.test(k) && !k.endsWith("Hash")) return `${at}.${k} forbidden pattern`
      const child = rec[k]
      if (child && typeof child === "object") {
        const nested = Array.isArray(child) ? null : checkForbidden(child, `${at}.${k}`)
        if (nested) return nested
        if (Array.isArray(child)) {
          for (let i = 0; i < child.length; i++) {
            const el = child[i]
            if (el && typeof el === "object" && !Array.isArray(el)) {
              const e = checkForbidden(el, `${at}.${k}[${i}]`)
              if (e) return e
            }
          }
        }
      }
      if (typeof child === "string" && (child.includes("e2e-fixture-key") || child.includes("KILO_SERVER_PASSWORD"))) {
        return `${at}.${k} leaked secret string`
      }
    }
    return null
  }
  const exactKeys = (obj: Record<string, unknown>, allowed: string[], at: string): string | null => {
    const keys = Object.keys(obj).sort()
    const want = [...allowed].sort()
    if (keys.length !== want.length || !keys.every((k, i) => k === want[i])) {
      return `${at} keys mismatch: got [${keys.join(",")}] want [${want.join(",")}]`
    }
    return null
  }
  const onlyAllowed = (obj: Record<string, unknown>, allowed: string[], at: string): string | null => {
    for (const k of Object.keys(obj)) if (!allowed.includes(k)) return `${at} unknown key`
    return null
  }
  const requireHex = (obj: Record<string, unknown>, key: string, at: string): string | null => {
    if (!isHex16(obj[key])) return `${at}.${key} must be 16-hex`
    return null
  }
  const validateProto = (proto: unknown, at: string): string | null => {
    if (!proto || typeof proto !== "object" || Array.isArray(proto)) return `${at} must be object`
    const p = proto as Record<string, unknown>
    const e = onlyAllowed(p, ["name", "major", "minor"], at)
    if (e) return e
    if (!("name" in p) || !("major" in p)) return `${at} missing name/major`
    if (p.name !== "kilo-private") return `${at}.name must be kilo-private`
    if (p.major !== 1) return `${at}.major must be 1`
    if (
      "minor" in p &&
      (typeof p.minor !== "number" || !Number.isInteger(p.minor as number) || (p.minor as number) < 0)
    )
      return `${at}.minor invalid`
    return null
  }
  const protoEqual = (a: Record<string, unknown>, b: Record<string, unknown>): boolean => {
    return a.name === b.name && a.major === b.major && ((a.minor as number | undefined) ?? 0) === ((b.minor as number | undefined) ?? 0)
  }
  const validateCaps = (caps: unknown, at: string): string | null => {
    if (!Array.isArray(caps)) return `${at} must be array`
    for (let i = 0; i < caps.length; i++) {
      const c = caps[i]
      if (typeof c !== "string") return `${at}[${i}] must be string`
      if (!ALLOWED_CAPS.has(c)) return `${at}[${i}] unknown capability`
    }
    if (!caps.includes("session/update")) return `${at} missing session/update`
    return null
  }
  const validateBackend = (b: unknown, at: string): string | null => {
    if (!b || typeof b !== "object" || Array.isArray(b)) return `${at} missing`
    const rec = b as Record<string, unknown>
    const e = exactKeys(rec, ["pid", "port", "epoch"], at)
    if (e) return e
    if (!isPid(rec.pid)) return `${at}.pid invalid`
    if (!isPort(rec.port)) return `${at}.port invalid`
    if (!isEpoch(rec.epoch)) return `${at}.epoch invalid`
    return null
  }
  const validateStates = (arr: unknown, at: string): string | null => {
    if (!Array.isArray(arr) || arr.length === 0) return `${at} must be non-empty array`
    for (let i = 0; i < arr.length; i++) {
      const el = arr[i]
      if (!el || typeof el !== "object" || Array.isArray(el)) return `${at}[${i}] must be object`
      const r = el as Record<string, unknown>
      const e = exactKeys(r, ["state", "at"], `${at}[${i}]`)
      if (e) return e
      if (typeof r.state !== "string" || !ALLOWED_STATE.has(r.state as string))
        return `${at}[${i}].state must be one of ${[...ALLOWED_STATE].join(",")}`
      if (typeof r.at !== "string" || Number.isNaN(Date.parse(r.at as string))) return `${at}[${i}].at must be ISO date`
    }
    return null
  }
  const validatePrivateShort = (pr: unknown, at: string): string | null => {
    if (!pr || typeof pr !== "object" || Array.isArray(pr)) return `${at} missing`
    const r = pr as Record<string, unknown>
    const e = exactKeys(r, ["pid", "epoch", "available", "hasSessionUpdate", "protocol"], at)
    if (e) return e
    if (r.pid !== null && !isPid(r.pid)) return `${at}.pid invalid`
    if (!isEpoch(r.epoch)) return `${at}.epoch invalid`
    if (typeof r.available !== "boolean" || r.available !== true) return `${at}.available must be true`
    if (typeof r.hasSessionUpdate !== "boolean" || r.hasSessionUpdate !== true)
      return `${at}.hasSessionUpdate must be true`
    const pe = validateProto(r.protocol, `${at}.protocol`)
    if (pe) return pe
    return null
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "not an object"
  const p = parsed as Record<string, unknown>
  const topAllowed = [
    "schema",
    "version",
    "scope",
    "fixtureIdHash",
    "sessionIdHash",
    "titleHash",
    "pre",
    "sse",
    "titleOp",
    "replay",
    "killed",
    "postRestart",
    "replayAfterRestart",
    "parity",
    "collectedAt",
  ]
  {
    const e = exactKeys(p, topAllowed, "proof")
    if (e) return e
  }
  if (p.schema !== "kilo-gc-proof/2") return "schema must be kilo-gc-proof/2"
  if (p.version !== 2) return "version must be 2"
  const FIXED_SCOPE = "real-restart Gate C: SDK-authoritative title + SSE same-epoch + worker-restart new-epoch"
  if (p.scope !== FIXED_SCOPE) return `scope must be "${FIXED_SCOPE}"`
  for (const k of ["fixtureIdHash", "sessionIdHash", "titleHash"]) {
    const e = requireHex(p, k, "proof")
    if (e) return e
  }
  if (typeof p.collectedAt !== "string" || Number.isNaN(Date.parse(p.collectedAt as string)))
    return "collectedAt must be ISO date"
  const forb = checkForbidden(p, "proof")
  if (forb) return forb

  // pre
  if (!p.pre || typeof p.pre !== "object" || Array.isArray(p.pre)) return "pre missing"
  const pre = p.pre as Record<string, unknown>
  {
    const e = exactKeys(pre, ["backend", "private"], "pre")
    if (e) return e
  }
  {
    const be = validateBackend(pre.backend, "pre.backend")
    if (be) return be
  }
  if (!pre.private || typeof pre.private !== "object" || Array.isArray(pre.private)) return "pre.private missing"
  {
    const pr = pre.private as Record<string, unknown>
    const e = exactKeys(
      pr,
      ["pid", "epoch", "available", "state", "protocol", "capabilities", "hasSessionUpdate"],
      "pre.private",
    )
    if (e) return e
    if (pr.pid !== null && !isPid(pr.pid)) return "pre.private.pid invalid"
    if (!isEpoch(pr.epoch)) return "pre.private.epoch invalid"
    if (typeof pr.available !== "boolean") return "pre.private.available must be boolean"
    if (typeof pr.state !== "string" || pr.state.length === 0) return "pre.private.state missing"
    if (typeof pr.hasSessionUpdate !== "boolean") return "pre.private.hasSessionUpdate must be boolean"
    const pe = validateProto(pr.protocol, "pre.private.protocol")
    if (pe) return pe
    const ce = validateCaps(pr.capabilities, "pre.private.capabilities")
    if (ce) return ce
    if (pr.hasSessionUpdate !== true) return "pre.private.hasSessionUpdate must be true"
    if (pr.pid !== (pre.backend as Record<string, unknown>).pid) return "pre.private.pid must equal backend pid"
    if (pr.epoch !== (pre.backend as Record<string, unknown>).epoch) return "pre.private.epoch must equal backend epoch"
  }

  // sse
  if (!p.sse || typeof p.sse !== "object" || Array.isArray(p.sse)) return "sse missing"
  {
    const sse = p.sse as Record<string, unknown>
    const e = exactKeys(sse, ["pre", "conn", "post"], "sse")
    if (e) return e
    for (const side of ["pre", "post"] as const) {
      const node = sse[side] as Record<string, unknown>
      if (!node || typeof node !== "object" || Array.isArray(node)) return `sse.${side} missing`
      const ee = exactKeys(node, ["backend", "private"], `sse.${side}`)
      if (ee) return ee
      const be = validateBackend(node.backend, `sse.${side}.backend`)
      if (be) return be
      const pe = validatePrivateShort(node.private, `sse.${side}.private`)
      if (pe) return pe
    }
    const preB = (sse.pre as Record<string, unknown>).backend as Record<string, unknown>
    const postB = (sse.post as Record<string, unknown>).backend as Record<string, unknown>
    const prePriv = (sse.pre as Record<string, unknown>).private as Record<string, unknown>
    const postPriv = (sse.post as Record<string, unknown>).private as Record<string, unknown>
    if (prePriv.pid !== preB.pid) return "sse.pre.private.pid must equal backend pid"
    if (prePriv.epoch !== preB.epoch) return "sse.pre.private.epoch must equal backend epoch"
    if (postPriv.pid !== postB.pid) return "sse.post.private.pid must equal backend pid"
    if (postPriv.epoch !== postB.epoch) return "sse.post.private.epoch must equal backend epoch"
    if (preB.pid !== postB.pid || preB.port !== postB.port || preB.epoch !== postB.epoch)
      return "sse pre/post backend must be identical (SSE reconnect retains epoch)"
    if (preB.pid !== (pre.backend as Record<string, unknown>).pid)
      return "sse pre backend pid must equal pre.backend.pid"
    const conn = sse.conn as Record<string, unknown>
    if (!conn || typeof conn !== "object" || Array.isArray(conn)) return "sse.conn missing"
    {
      const ce = exactKeys(conn, ["before", "after", "states", "connectedEvents"], "sse.conn")
      if (ce) return ce
      for (const k of ["before", "after"] as const) {
        const be = validateBackend(conn[k], `sse.conn.${k}`)
        if (be) return be
      }
      const before = conn.before as Record<string, unknown>
      const after = conn.after as Record<string, unknown>
      if (before.pid !== after.pid || before.port !== after.port || before.epoch !== after.epoch)
        return "sse.conn before/after must be identical"
      if (before.pid !== preB.pid) return "sse.conn before pid must equal pre pid"
      if (before.port !== preB.port || before.epoch !== preB.epoch) return "sse.conn before must equal pre backend"
      const se = validateStates(conn.states, "sse.conn.states")
      if (se) return se
      if (
        typeof conn.connectedEvents !== "number" ||
        !Number.isInteger(conn.connectedEvents) ||
        conn.connectedEvents < 1
      )
        return "sse.conn.connectedEvents must be >=1"
    }
  }

  // titleOp
  if (!p.titleOp || typeof p.titleOp !== "object" || Array.isArray(p.titleOp)) return "titleOp missing"
  {
    const to = p.titleOp as Record<string, unknown>
    const e = exactKeys(
      to,
      [
        "opIdHash",
        "idempotencyKeyHash",
        "requestIdHash",
        "sessionIdHash",
        "titleHash",
        "order",
        "sdk",
        "private",
        "parity",
        "revision",
      ],
      "titleOp",
    )
    if (e) return e
    for (const k of ["opIdHash", "idempotencyKeyHash", "requestIdHash", "sessionIdHash", "titleHash"]) {
      const ee = requireHex(to, k, "titleOp")
      if (ee) return ee
    }
    if (to.sessionIdHash !== p.sessionIdHash) return "titleOp.sessionIdHash must equal proof sessionIdHash"
    if (to.titleHash !== p.titleHash) return "titleOp.titleHash must equal proof titleHash"
    if (!Array.isArray(to.order) || to.order.length !== 2 || to.order[0] !== "sdk" || to.order[1] !== "private")
      return "titleOp.order must be [sdk,private]"
    {
      const sdk = to.sdk as Record<string, unknown>
      if (!sdk || typeof sdk !== "object" || Array.isArray(sdk)) return "titleOp.sdk missing"
      const se = exactKeys(sdk as Record<string, unknown>, ["status", "httpStatus", "hasData"], "titleOp.sdk")
      if (se) return se
      if (sdk.status !== "succeeded") return "titleOp.sdk.status must be succeeded"
      if (sdk.httpStatus !== 200) return "titleOp.sdk.httpStatus must be 200"
      if (sdk.hasData !== true) return "titleOp.sdk.hasData must be true"
    }
    {
      const priv = to.private as Record<string, unknown>
      if (!priv || typeof priv !== "object" || Array.isArray(priv)) return "titleOp.private missing"
      const ae = exactKeys(priv as Record<string, unknown>, ["status", "hasData"], "titleOp.private")
      if (ae) return ae
      if (priv.status !== "succeeded") return "titleOp.private.status must be succeeded"
      if (priv.hasData !== true) return "titleOp.private.hasData must be true"
    }
    {
      const par = to.parity as Record<string, unknown>
      if (!par || typeof par !== "object" || Array.isArray(par)) return "titleOp.parity missing"
      const pe = exactKeys(par, ["divergence", "details"], "titleOp.parity")
      if (pe) return pe
      if (par.divergence !== null) return "titleOp.parity.divergence must be null"
      if (
        !par.details ||
        typeof par.details !== "object" ||
        Array.isArray(par.details) ||
        Object.keys(par.details as object).length !== 0
      )
        return "titleOp.parity.details must be empty object"
    }
    if (!isRevision(to.revision)) return "titleOp.revision invalid"
  }

  // replay
  if (!p.replay || typeof p.replay !== "object" || Array.isArray(p.replay)) return "replay missing"
  {
    const r = p.replay as Record<string, unknown>
    const e = exactKeys(r, ["found", "private", "revision", "titleHash"], "replay")
    if (e) return e
    if (r.found !== true) return "replay.found must be true"
    if (r.titleHash !== p.titleHash) return "replay.titleHash must equal proof titleHash"
    if (!isHex16(r.titleHash)) return "replay.titleHash must be 16-hex"
    const priv = r.private as Record<string, unknown>
    if (!priv || typeof priv !== "object" || Array.isArray(priv)) return "replay.private missing"
    {
      const ae = exactKeys(priv as Record<string, unknown>, ["status", "hasData"], "replay.private")
      if (ae) return ae
      if (priv.status !== "succeeded") return "replay.private.status must be succeeded"
      if (priv.hasData !== true) return "replay.private.hasData must be true"
    }
    if (!isRevision(r.revision)) return "replay.revision invalid"
    const toRev = (p.titleOp as Record<string, unknown>).revision
    if (JSON.stringify(r.revision) !== JSON.stringify(toRev)) return "replay.revision must equal titleOp.revision"
  }

  // killed
  if (!p.killed || typeof p.killed !== "object" || Array.isArray(p.killed)) return "killed missing"
  {
    const k = p.killed as Record<string, unknown>
    const e = exactKeys(k, ["pid", "port", "epoch"], "killed")
    if (e) return e
    if (!isPid(k.pid)) return "killed.pid invalid"
    if (!isPort(k.port)) return "killed.port invalid"
    if (!isEpoch(k.epoch)) return "killed.epoch invalid"
    const preB = pre.backend as Record<string, unknown>
    if (k.pid !== preB.pid || k.port !== preB.port || k.epoch !== preB.epoch)
      return "killed must equal pre.backend (pre-restart identity)"
  }

  // postRestart
  if (!p.postRestart || typeof p.postRestart !== "object" || Array.isArray(p.postRestart)) return "postRestart missing"
  {
    const pr = p.postRestart as Record<string, unknown>
    const e = exactKeys(pr, ["backend", "private"], "postRestart")
    if (e) return e
    const b = pr.backend as Record<string, unknown>
    if (!b || typeof b !== "object" || Array.isArray(b)) return "postRestart.backend missing"
    {
      const be = exactKeys(b, ["pid", "port", "epoch"], "postRestart.backend")
      if (be) return be
      if (!isPid(b.pid)) return "postRestart.backend.pid invalid"
      if (!isPort(b.port)) return "postRestart.backend.port invalid"
      if (!isEpoch(b.epoch)) return "postRestart.backend.epoch invalid"
    }
    const killed = p.killed as Record<string, unknown>
    if (b.pid === killed.pid) return "postRestart.backend.pid must differ from killed.pid"
    if (b.port === killed.port) return "postRestart.backend.port must differ from killed.port"
    if (!((b.epoch as number) > (killed.epoch as number))) return "postRestart.backend.epoch must be > killed.epoch"
    const priv = pr.private as Record<string, unknown>
    if (!priv || typeof priv !== "object" || Array.isArray(priv)) return "postRestart.private missing"
    {
      const pe = exactKeys(
        priv,
        ["pid", "epoch", "available", "hasSessionUpdate", "protocol", "state", "capabilities"],
        "postRestart.private",
      )
      if (pe) return pe
      if (priv.pid !== b.pid) return "postRestart.private.pid must equal backend pid"
      if (priv.epoch !== b.epoch) return "postRestart.private.epoch must equal backend epoch"
      if (priv.available !== true) return "postRestart.private.available must be true"
      if (priv.hasSessionUpdate !== true) return "postRestart.private.hasSessionUpdate must be true"
      if (typeof priv.state !== "string" || priv.state.length === 0) return "postRestart.private.state missing"
      const pe2 = validateProto(priv.protocol, "postRestart.private.protocol")
      if (pe2) return pe2
      const ce = validateCaps(priv.capabilities, "postRestart.private.capabilities")
      if (ce) return ce
    }
  }

  // replayAfterRestart
  if (!p.replayAfterRestart || typeof p.replayAfterRestart !== "object" || Array.isArray(p.replayAfterRestart))
    return "replayAfterRestart missing"
  {
    const r = p.replayAfterRestart as Record<string, unknown>
    const e = exactKeys(r, ["found", "private", "revision", "titleHash"], "replayAfterRestart")
    if (e) return e
    if (r.found !== true) return "replayAfterRestart.found must be true"
    if (r.titleHash !== p.titleHash) return "replayAfterRestart.titleHash must equal proof titleHash"
    if (!isHex16(r.titleHash)) return "replayAfterRestart.titleHash must be 16-hex"
    const priv = r.private as Record<string, unknown>
    if (!priv || typeof priv !== "object" || Array.isArray(priv)) return "replayAfterRestart.private missing"
    {
      const ae = exactKeys(priv as Record<string, unknown>, ["status", "hasData"], "replayAfterRestart.private")
      if (ae) return ae
      if (priv.status !== "succeeded") return "replayAfterRestart.private.status must be succeeded"
      if (priv.hasData !== true) return "replayAfterRestart.private.hasData must be true"
    }
    if (!isRevision(r.revision)) return "replayAfterRestart.revision invalid"
    const toRev = (p.titleOp as Record<string, unknown>).revision
    if (JSON.stringify(r.revision) !== JSON.stringify(toRev))
      return "replayAfterRestart.revision must equal titleOp.revision"
  }

  // parity top-level must equal titleOp parity
  {
    const par = p.parity as Record<string, unknown>
    if (!par || typeof par !== "object" || Array.isArray(par)) return "parity missing"
    const pe = exactKeys(par, ["divergence", "details"], "parity")
    if (pe) return pe
    if (par.divergence !== null) return "parity.divergence must be null"
    if (
      !par.details ||
      typeof par.details !== "object" ||
      Array.isArray(par.details) ||
      Object.keys(par.details as object).length !== 0
    )
      return "parity.details must be empty object"
    const toPar = (p.titleOp as Record<string, unknown>).parity as Record<string, unknown>
    if (JSON.stringify(par) !== JSON.stringify(toPar)) return "parity must equal titleOp.parity"
  }

  return null
}

// eslint-disable-next-line complexity
export function validateLcProof(parsed: unknown): string | null {
  const hex16 = /^[0-9a-f]{16}$/
  const isHex16 = (v: unknown): boolean => typeof v === "string" && hex16.test(v)
  const isPid = (v: unknown): boolean => typeof v === "number" && Number.isInteger(v) && v > 0 && v < 1_000_0000
  const isPort = (v: unknown): boolean => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 65535
  const isEpoch = (v: unknown): boolean => typeof v === "number" && Number.isInteger(v) && v >= 1
  const isRevision = (v: unknown): v is { session: number; config?: number } => {
    if (!v || typeof v !== "object" || Array.isArray(v)) return false
    const r = v as Record<string, unknown>
    if (typeof r.session !== "number" || !Number.isInteger(r.session) || r.session < 0) return false
    if (r.config !== undefined && (typeof r.config !== "number" || !Number.isInteger(r.config) || r.config < 0))
      return false
    const allowed = new Set(["session", "config"])
    for (const k of Object.keys(r)) if (!allowed.has(k)) return false
    return true
  }
  const ALLOWED_CAPS = new Set<string>(PRIVATE_FD_CAPABILITIES as readonly string[])
  const forbidKeys = new Set([
    "title",
    "payload",
    "path",
    "secret",
    "password",
    "apiKey",
    "sessionId",
    "opId",
    "requestId",
    "idempotencyKey",
    "rawTitle",
    "sessionID",
    "requestID",
    "error",
    "stack",
  ])
  const checkForbidden = (obj: unknown, at: string): string | null => {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null
    const rec = obj as Record<string, unknown>
    for (const k of Object.keys(rec)) {
      if (forbidKeys.has(k)) return `${at}.${k} forbidden key`
      if (/secret|password|apiKey|error/i.test(k) && !k.endsWith("Hash") && k !== "order" && k !== "state")
        return `${at}.${k} forbidden pattern`
      const child = rec[k]
      if (child && typeof child === "object") {
        const nested = Array.isArray(child) ? null : checkForbidden(child, `${at}.${k}`)
        if (nested) return nested
        if (Array.isArray(child)) {
          for (let i = 0; i < child.length; i++) {
            const el = child[i]
            if (el && typeof el === "object" && !Array.isArray(el)) {
              const e = checkForbidden(el, `${at}.${k}[${i}]`)
              if (e) return e
            }
          }
        }
      }
      if (typeof child === "string" && (child.includes("e2e-fixture-key") || child.includes("KILO_SERVER_PASSWORD"))) {
        return `${at}.${k} leaked secret string`
      }
    }
    return null
  }
  const exactKeys = (obj: Record<string, unknown>, allowed: string[], at: string): string | null => {
    const keys = Object.keys(obj).sort()
    const want = [...allowed].sort()
    if (keys.length !== want.length || !keys.every((k, i) => k === want[i])) {
      return `${at} keys mismatch: got [${keys.join(",")}] want [${want.join(",")}]`
    }
    return null
  }
  const onlyAllowed = (obj: Record<string, unknown>, allowed: string[], at: string): string | null => {
    for (const k of Object.keys(obj)) if (!allowed.includes(k)) return `${at} unknown key`
    return null
  }
  const requireHex = (obj: Record<string, unknown>, key: string, at: string): string | null => {
    if (!isHex16(obj[key])) return `${at}.${key} must be 16-hex`
    return null
  }
  const validateProto = (proto: unknown, at: string): string | null => {
    if (!proto || typeof proto !== "object" || Array.isArray(proto)) return `${at} must be object`
    const p = proto as Record<string, unknown>
    const e = onlyAllowed(p, ["name", "major", "minor"], at)
    if (e) return e
    if (!("name" in p) || !("major" in p)) return `${at} missing name/major`
    if (p.name !== "kilo-private") return `${at}.name must be kilo-private`
    if (p.major !== 1) return `${at}.major must be 1`
    if (
      "minor" in p &&
      (typeof p.minor !== "number" || !Number.isInteger(p.minor as number) || (p.minor as number) < 0)
    )
      return `${at}.minor invalid`
    return null
  }
  const protoEqual = (a: Record<string, unknown>, b: Record<string, unknown>): boolean => {
    return a.name === b.name && a.major === b.major && ((a.minor as number | undefined) ?? 0) === ((b.minor as number | undefined) ?? 0)
  }
  const validateCaps = (caps: unknown, at: string): string | null => {
    if (!Array.isArray(caps)) return `${at} must be array`
    for (let i = 0; i < caps.length; i++) {
      const c = caps[i]
      if (typeof c !== "string") return `${at}[${i}] must be string`
      if (!ALLOWED_CAPS.has(c)) return `${at}[${i}] unknown capability`
    }
    if (!caps.includes("session/update")) return `${at} missing session/update`
    return null
  }
  const validateBackend = (b: unknown, at: string): string | null => {
    if (!b || typeof b !== "object" || Array.isArray(b)) return `${at} missing`
    const rec = b as Record<string, unknown>
    const e = exactKeys(rec, ["pid", "port", "epoch"], at)
    if (e) return e
    if (!isPid(rec.pid)) return `${at}.pid invalid`
    if (!isPort(rec.port)) return `${at}.port invalid`
    if (!isEpoch(rec.epoch)) return `${at}.epoch invalid`
    return null
  }
  const validatePrivate = (pr: unknown, at: string): string | null => {
    if (!pr || typeof pr !== "object" || Array.isArray(pr)) return `${at} missing`
    const r = pr as Record<string, unknown>
    const e = exactKeys(r, ["pid", "epoch", "available", "hasSessionUpdate", "protocol", "capabilities", "state"], at)
    if (e) return e
    if (r.pid !== null && !isPid(r.pid)) return `${at}.pid invalid`
    if (!isEpoch(r.epoch)) return `${at}.epoch invalid`
    if (typeof r.available !== "boolean" || r.available !== true) return `${at}.available must be true`
    if (typeof r.hasSessionUpdate !== "boolean" || r.hasSessionUpdate !== true)
      return `${at}.hasSessionUpdate must be true`
    if (typeof r.state !== "string" || r.state.length === 0) return `${at}.state missing`
    const pe = validateProto(r.protocol, `${at}.protocol`)
    if (pe) return pe
    const ce = validateCaps(r.capabilities, `${at}.capabilities`)
    if (ce) return ce
    return null
  }
  const validateBoundarySingle = (b: unknown, at: string): string | null => {
    if (!b || typeof b !== "object" || Array.isArray(b)) return `${at} missing`
    const rec = b as Record<string, unknown>
    const e = exactKeys(rec, ["pre", "post", "orderHash", "orderCount", "titleHash"], at)
    if (e) return e
    for (const side of ["pre", "post"] as const) {
      const node = rec[side] as Record<string, unknown>
      if (!node || typeof node !== "object" || Array.isArray(node)) return `${at}.${side} missing`
      const ee = exactKeys(node, ["backend", "private"], `${at}.${side}`)
      if (ee) return ee
      const be = validateBackend(node.backend, `${at}.${side}.backend`)
      if (be) return be
      const pe = validatePrivate(node.private, `${at}.${side}.private`)
      if (pe) return pe
    }
    if (!isHex16(rec.orderHash)) return `${at}.orderHash must be 16-hex`
    if (typeof rec.orderCount !== "number" || !Number.isInteger(rec.orderCount) || rec.orderCount < 0)
      return `${at}.orderCount invalid`
    if (!isHex16(rec.titleHash)) return `${at}.titleHash must be 16-hex`
    return null
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "not an object"
  const p = parsed as Record<string, unknown>
  const topAllowed = [
    "schema",
    "version",
    "scope",
    "fixtureIdHash",
    "sessionIdHash",
    "siblingIdHash",
    "titleHash",
    "siblingTitleHash",
    "orderHash",
    "pre",
    "titleOp",
    "replay",
    "boundaries",
    "finalReplay",
    "parity",
    "collectedAt",
  ]
  {
    const e = exactKeys(p, topAllowed, "proof")
    if (e) return e
  }
  if (p.schema !== "kilo-gc-lifecycle-proof/2") return "schema must be kilo-gc-lifecycle-proof/2"
  if (p.version !== 2) return "version must be 2"
  const FIXED_SCOPE = "real-lifecycle Gate C: Agent Manager lifecycle with stable identity and same-key replay"
  if (p.scope !== FIXED_SCOPE) return `scope must be "${FIXED_SCOPE}"`
  for (const k of ["fixtureIdHash", "sessionIdHash", "siblingIdHash", "titleHash", "siblingTitleHash", "orderHash"]) {
    const e = requireHex(p, k, "proof")
    if (e) return e
  }
  if (typeof p.collectedAt !== "string" || Number.isNaN(Date.parse(p.collectedAt as string)))
    return "collectedAt must be ISO date"
  const forb = checkForbidden(p, "proof")
  if (forb) return forb

  if (!p.pre || typeof p.pre !== "object" || Array.isArray(p.pre)) return "pre missing"
  {
    const pre = p.pre as Record<string, unknown>
    const e = exactKeys(pre, ["backend", "private"], "pre")
    if (e) return e
    const be = validateBackend(pre.backend, "pre.backend")
    if (be) return be
    const pe = validatePrivate(pre.private, "pre.private")
    if (pe) return pe
    if ((pre.private as Record<string, unknown>).pid !== (pre.backend as Record<string, unknown>).pid)
      return "pre.private.pid must equal backend pid"
    if ((pre.private as Record<string, unknown>).epoch !== (pre.backend as Record<string, unknown>).epoch)
      return "pre.private.epoch must equal backend epoch"
  }

  if (!p.titleOp || typeof p.titleOp !== "object" || Array.isArray(p.titleOp)) return "titleOp missing"
  {
    const to = p.titleOp as Record<string, unknown>
    const e = exactKeys(
      to,
      [
        "opIdHash",
        "idempotencyKeyHash",
        "requestIdHash",
        "sessionIdHash",
        "titleHash",
        "order",
        "sdk",
        "private",
        "parity",
        "revision",
      ],
      "titleOp",
    )
    if (e) return e
    for (const k of ["opIdHash", "idempotencyKeyHash", "requestIdHash", "sessionIdHash", "titleHash"]) {
      const ee = requireHex(to, k, "titleOp")
      if (ee) return ee
    }
    if (to.sessionIdHash !== p.sessionIdHash) return "titleOp.sessionIdHash must equal proof sessionIdHash"
    if (to.titleHash !== p.titleHash) return "titleOp.titleHash must equal proof titleHash"
    if (!Array.isArray(to.order) || to.order.length !== 2 || to.order[0] !== "sdk" || to.order[1] !== "private")
      return "titleOp.order must be [sdk,private]"
    {
      const sdk = to.sdk as Record<string, unknown>
      if (!sdk || typeof sdk !== "object" || Array.isArray(sdk)) return "titleOp.sdk missing"
      const se = exactKeys(sdk as Record<string, unknown>, ["status", "httpStatus", "hasData"], "titleOp.sdk")
      if (se) return se
      if (sdk.status !== "succeeded") return "titleOp.sdk.status must be succeeded"
      if (sdk.httpStatus !== 200) return "titleOp.sdk.httpStatus must be 200"
      if (sdk.hasData !== true) return "titleOp.sdk.hasData must be true"
    }
    {
      const priv = to.private as Record<string, unknown>
      if (!priv || typeof priv !== "object" || Array.isArray(priv)) return "titleOp.private missing"
      const ae = exactKeys(priv as Record<string, unknown>, ["status", "hasData"], "titleOp.private")
      if (ae) return ae
      if (priv.status !== "succeeded") return "titleOp.private.status must be succeeded"
      if (priv.hasData !== true) return "titleOp.private.hasData must be true"
    }
    {
      const par = to.parity as Record<string, unknown>
      if (!par || typeof par !== "object" || Array.isArray(par)) return "titleOp.parity missing"
      const pe = exactKeys(par, ["divergence", "details"], "titleOp.parity")
      if (pe) return pe
      if (par.divergence !== null) return "titleOp.parity.divergence must be null"
      if (
        !par.details ||
        typeof par.details !== "object" ||
        Array.isArray(par.details) ||
        Object.keys(par.details as object).length !== 0
      )
        return "titleOp.parity.details must be empty object"
    }
    if (!isRevision(to.revision)) return "titleOp.revision invalid"
  }

  if (!p.replay || typeof p.replay !== "object" || Array.isArray(p.replay)) return "replay missing"
  {
    const r = p.replay as Record<string, unknown>
    const e = exactKeys(
      r,
      ["found", "private", "revision", "titleHash", "opIdHash", "idempotencyKeyHash", "requestIdHash", "sessionIdHash"],
      "replay",
    )
    if (e) return e
    if (r.found !== true) return "replay.found must be true"
    if (r.titleHash !== p.titleHash) return "replay.titleHash must equal proof titleHash"
    if (!isHex16(r.titleHash)) return "replay.titleHash must be 16-hex"
    for (const k of ["opIdHash", "idempotencyKeyHash", "requestIdHash", "sessionIdHash"] as const) {
      if (!isHex16(r[k])) return `replay.${k} must be 16-hex`
    }
    const titleOp = p.titleOp as Record<string, unknown>
    if (r.opIdHash !== titleOp.opIdHash) return "replay.opIdHash must equal titleOp.opIdHash"
    if (r.idempotencyKeyHash !== titleOp.idempotencyKeyHash)
      return "replay.idempotencyKeyHash must equal titleOp.idempotencyKeyHash"
    if (r.requestIdHash !== titleOp.requestIdHash) return "replay.requestIdHash must equal titleOp.requestIdHash"
    if (r.sessionIdHash !== titleOp.sessionIdHash) return "replay.sessionIdHash must equal titleOp.sessionIdHash"
    const priv = r.private as Record<string, unknown>
    if (!priv || typeof priv !== "object" || Array.isArray(priv)) return "replay.private missing"
    {
      const ae = exactKeys(priv as Record<string, unknown>, ["status", "hasData"], "replay.private")
      if (ae) return ae
      if (priv.status !== "succeeded") return "replay.private.status must be succeeded"
      if (priv.hasData !== true) return "replay.private.hasData must be true"
    }
    if (!isRevision(r.revision)) return "replay.revision invalid"
    const toRev = (p.titleOp as Record<string, unknown>).revision
    if (JSON.stringify(r.revision) !== JSON.stringify(toRev)) return "replay.revision must equal titleOp.revision"
  }

  if (!p.boundaries || typeof p.boundaries !== "object" || Array.isArray(p.boundaries)) return "boundaries missing"
  {
    const b = p.boundaries as Record<string, unknown>
    const e = exactKeys(b, ["panelCloseReopen", "webviewReload", "sessionSwitch"], "boundaries")
    if (e) return e
    const be1 = validateBoundarySingle(b.panelCloseReopen, "boundaries.panelCloseReopen")
    if (be1) return be1
    const be2 = validateBoundarySingle(b.webviewReload, "boundaries.webviewReload")
    if (be2) return be2
    const be3 = (() => {
      const v = b.sessionSwitch
      if (!v || typeof v !== "object" || Array.isArray(v)) return "boundaries.sessionSwitch missing"
      const rec = v as Record<string, unknown>
      const ee = exactKeys(
        rec,
        ["pre", "post", "switched", "orderHash", "orderCount"],
        "boundaries.sessionSwitch",
      )
      if (ee) return ee
      for (const side of ["pre", "post", "switched"] as const) {
        const node = rec[side] as Record<string, unknown>
        if (!node || typeof node !== "object" || Array.isArray(node)) return `boundaries.sessionSwitch.${side} missing`
        const e2 = exactKeys(node, ["backend", "private", "activeIdHash", "titleHash"], `boundaries.sessionSwitch.${side}`)
        if (e2) return e2
        const be = validateBackend(node.backend, `boundaries.sessionSwitch.${side}.backend`)
        if (be) return be
        const pe = validatePrivate(node.private, `boundaries.sessionSwitch.${side}.private`)
        if (pe) return pe
        if (!isHex16(node.activeIdHash)) return `boundaries.sessionSwitch.${side}.activeIdHash must be 16-hex`
        if (!isHex16(node.titleHash)) return `boundaries.sessionSwitch.${side}.titleHash must be 16-hex`
      }
      if (!isHex16(rec.orderHash)) return "boundaries.sessionSwitch.orderHash must be 16-hex"
      if (typeof rec.orderCount !== "number" || !Number.isInteger(rec.orderCount) || rec.orderCount < 0)
        return "boundaries.sessionSwitch.orderCount invalid"
      return null
    })()
    if (be3) return be3
    const preB = (p.pre as Record<string, unknown>).backend as Record<string, unknown>
    for (const key of ["panelCloseReopen", "webviewReload"] as const) {
      const node = b[key] as Record<string, unknown>
      for (const side of ["pre", "post"] as const) {
        const bb = (node[side] as Record<string, unknown>).backend as Record<string, unknown>
        if (bb.pid !== preB.pid || bb.port !== preB.port || bb.epoch !== preB.epoch)
          return `${key}.${side} backend must equal pre.backend`
        const priv = (node[side] as Record<string, unknown>).private as Record<string, unknown>
        const prePriv = (p.pre as Record<string, unknown>).private as Record<string, unknown>
        if (priv.pid !== prePriv.pid || priv.epoch !== prePriv.epoch)
          return `${key}.${side} private pid/epoch must equal pre`
        if (!protoEqual(priv.protocol as Record<string, unknown>, prePriv.protocol as Record<string, unknown>))
          return `${key}.${side} private protocol must equal pre`
        if (
          JSON.stringify((priv.capabilities as string[]).slice().sort()) !==
          JSON.stringify((prePriv.capabilities as string[]).slice().sort())
        )
          return `${key}.${side} private capabilities must equal pre`
      }
      if (node.titleHash !== p.titleHash) return `${key} titleHash must equal titleHash`
      if (node.orderHash !== p.orderHash) return `${key} orderHash must equal orderHash`
    }
    {
      const sw = b.sessionSwitch as Record<string, unknown>
      for (const side of ["pre", "post", "switched"] as const) {
        const bb = (sw[side] as Record<string, unknown>).backend as Record<string, unknown>
        if (bb.pid !== preB.pid || bb.port !== preB.port || bb.epoch !== preB.epoch)
          return `sessionSwitch.${side} backend must equal pre.backend`
        const priv = (sw[side] as Record<string, unknown>).private as Record<string, unknown>
        const prePriv = (p.pre as Record<string, unknown>).private as Record<string, unknown>
        if (priv.pid !== prePriv.pid || priv.epoch !== prePriv.epoch)
          return `sessionSwitch.${side} private pid/epoch must equal pre`
        if (!protoEqual(priv.protocol as Record<string, unknown>, prePriv.protocol as Record<string, unknown>))
          return `sessionSwitch.${side} protocol must equal pre`
        if (
          JSON.stringify((priv.capabilities as string[]).slice().sort()) !==
          JSON.stringify((prePriv.capabilities as string[]).slice().sort())
        )
          return `sessionSwitch.${side} private capabilities must equal pre`
      }
      if ((sw as Record<string, unknown>).orderHash !== p.orderHash)
        return "sessionSwitch orderHash must equal orderHash"
      if ((sw.pre as Record<string, unknown>).titleHash !== p.titleHash)
        return "sessionSwitch pre titleHash must equal titleHash"
      if ((sw.post as Record<string, unknown>).titleHash !== p.titleHash)
        return "sessionSwitch post titleHash must equal titleHash"
      if ((sw.switched as Record<string, unknown>).titleHash !== p.siblingTitleHash)
        return "sessionSwitch switched titleHash must equal siblingTitleHash"
      if (p.siblingTitleHash === p.titleHash) return "siblingTitleHash must differ from titleHash"
      if (p.sessionIdHash === p.siblingIdHash) return "sessionIdHash must differ from siblingIdHash"
      if ((sw.pre as Record<string, unknown>).activeIdHash !== p.sessionIdHash)
        return "sessionSwitch pre activeIdHash must equal sessionIdHash"
      if ((sw.post as Record<string, unknown>).activeIdHash !== p.sessionIdHash)
        return "sessionSwitch post activeIdHash must equal sessionIdHash"
      if ((sw.switched as Record<string, unknown>).activeIdHash !== p.siblingIdHash)
        return "sessionSwitch switched activeIdHash must equal siblingIdHash"
      {
        const counts = [
          (b.panelCloseReopen as Record<string, unknown>).orderCount,
          (b.webviewReload as Record<string, unknown>).orderCount,
          (b.sessionSwitch as Record<string, unknown>).orderCount,
        ]
        const baseline = 2
        for (let i = 0; i < counts.length; i++) {
          if (counts[i] !== baseline)
            return `boundaries orderCount baseline mismatch at ${i}: got ${counts[i]} want ${baseline}`
        }
        const first = counts[0]
        for (const c of counts) if (c !== first) return `boundaries orderCount mismatch ${counts.join(",")}`
      }
    }
  }

  if (!p.finalReplay || typeof p.finalReplay !== "object" || Array.isArray(p.finalReplay)) return "finalReplay missing"
  {
    const r = p.finalReplay as Record<string, unknown>
    const e = exactKeys(
      r,
      ["found", "private", "revision", "titleHash", "opIdHash", "idempotencyKeyHash", "requestIdHash", "sessionIdHash"],
      "finalReplay",
    )
    if (e) return e
    if (r.found !== true) return "finalReplay.found must be true"
    if (r.titleHash !== p.titleHash) return "finalReplay.titleHash must equal proof titleHash"
    if (!isHex16(r.titleHash)) return "finalReplay.titleHash must be 16-hex"
    for (const k of ["opIdHash", "idempotencyKeyHash", "requestIdHash", "sessionIdHash"] as const) {
      if (!isHex16(r[k])) return `finalReplay.${k} must be 16-hex`
    }
    const titleOp = p.titleOp as Record<string, unknown>
    if (r.opIdHash !== titleOp.opIdHash) return "finalReplay.opIdHash must equal titleOp.opIdHash"
    if (r.idempotencyKeyHash !== titleOp.idempotencyKeyHash)
      return "finalReplay.idempotencyKeyHash must equal titleOp.idempotencyKeyHash"
    if (r.requestIdHash !== titleOp.requestIdHash) return "finalReplay.requestIdHash must equal titleOp.requestIdHash"
    if (r.sessionIdHash !== titleOp.sessionIdHash) return "finalReplay.sessionIdHash must equal titleOp.sessionIdHash"
    const priv = r.private as Record<string, unknown>
    if (!priv || typeof priv !== "object" || Array.isArray(priv)) return "finalReplay.private missing"
    {
      const ae = exactKeys(priv as Record<string, unknown>, ["status", "hasData"], "finalReplay.private")
      if (ae) return ae
      if (priv.status !== "succeeded") return "finalReplay.private.status must be succeeded"
      if (priv.hasData !== true) return "finalReplay.private.hasData must be true"
    }
    if (!isRevision(r.revision)) return "finalReplay.revision invalid"
    const toRev = (p.titleOp as Record<string, unknown>).revision
    if (JSON.stringify(r.revision) !== JSON.stringify(toRev)) return "finalReplay.revision must equal titleOp.revision"
    const replayRev = (p.replay as Record<string, unknown>).revision
    if (JSON.stringify(r.revision) !== JSON.stringify(replayRev))
      return "finalReplay.revision must equal replay.revision"
  }

  {
    const par = p.parity as Record<string, unknown>
    if (!par || typeof par !== "object" || Array.isArray(par)) return "parity missing"
    const pe = exactKeys(par, ["divergence", "details"], "parity")
    if (pe) return pe
    if (par.divergence !== null) return "parity.divergence must be null"
    if (
      !par.details ||
      typeof par.details !== "object" ||
      Array.isArray(par.details) ||
      Object.keys(par.details as object).length !== 0
    )
      return "parity.details must be empty object"
    const toPar = (p.titleOp as Record<string, unknown>).parity as Record<string, unknown>
    if (JSON.stringify(par) !== JSON.stringify(toPar)) return "parity must equal titleOp.parity"
  }

  return null
}


// eslint-disable-next-line complexity
export function validateLcTimeline(parsed: unknown): string | null {
  if (!Array.isArray(parsed)) return "timeline must be array"
  if (parsed.length === 0) return "timeline empty"
  const hex16 = /^[0-9a-f]{16}$/
  const allowedPhases = new Set([
    "lifecycle-start",
    "pre-panel-close",
    "post-panel-close-request",
    "post-panel-close-ready",
    "post-panel-reopen-tabs",
    "post-panel-reopen",
    "pre-webview-reload",
    "post-webview-reload-request",
    "post-webview-reload-ready",
    "post-webview-reload",
    "pre-session-switch",
    "switched-session",
    "post-session-switch",
    "pre-proof-write",
    "final-done",
    "final-done-outer",
    "failure-diagnostics",
  ])
  const requiredPhases = [
    "pre-panel-close",
    "post-panel-reopen",
    "pre-webview-reload",
    "post-webview-reload",
    "pre-session-switch",
    "switched-session",
    "post-session-switch",
    "final-done",
  ]
  const forbidKeys = new Set([
    "title",
    "payload",
    "path",
    "secret",
    "password",
    "apiKey",
    "sessionId",
    "sessionID",
    "opId",
    "requestId",
    "requestID",
    "idempotencyKey",
    "rawTitle",
    "error",
    "stack",
    "url",
    "rawUrl",
    "variable",
    "session",
    "request",
    "response",
    "body",
  ])
  const allowedUrlKind = new Set(["vscode-webview", "other"])
  const allowedPageKind = new Set(["webview", "other"])
  const allowedDataTheme = new Set(["kilo-vscode", "other", ""])
  const allowedCat = new Set(["agent-manager", "kilo-chat", "kilo-welcome", "native-chat", "placeholder", "unknown"])
  const exactKeys = (obj: Record<string, unknown>, allowed: string[], at: string): string | null => {
    const keys = Object.keys(obj).sort()
    const want = [...allowed].sort()
    if (keys.length !== want.length || !keys.every((k, i) => k === want[i])) {
      return `${at} keys mismatch: got [${keys.join(",")}] want [${want.join(",")}]`
    }
    return null
  }
  const checkForbidden = (obj: unknown, at: string): string | null => {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null
    const rec = obj as Record<string, unknown>
    for (const k of Object.keys(rec)) {
      if (forbidKeys.has(k)) return `${at}.${k} forbidden key`
      if (/secret|password|apiKey|error/i.test(k) && !k.endsWith("Hash")) return `${at}.${k} forbidden pattern`
      const child = rec[k]
      if (typeof child === "string" && (child.includes("e2e-fixture-key") || child.includes("KILO_SERVER_PASSWORD"))) {
        return `${at}.${k} leaked secret string`
      }
    }
    return null
  }
  let prevTs = -Infinity
  let prevIsoMs = -Infinity
  for (let i = 0; i < parsed.length; i++) {
    const e = parsed[i] as Record<string, unknown>
    if (!e || typeof e !== "object" || Array.isArray(e)) return `entry ${i} not object`
    const ek = exactKeys(e, ["ts", "iso", "phase", "auxiliaryBar", "chat", "editors", "frames"], `entry ${i}`)
    if (ek) return ek
    const forb = checkForbidden(e, `entry ${i}`)
    if (forb) return forb
    if (typeof e.ts !== "number" || !Number.isFinite(e.ts) || !Number.isInteger(e.ts) || e.ts <= 0)
      return `entry ${i} ts invalid`
    if (e.ts < prevTs) return `entry ${i} ts not monotonic`
    prevTs = e.ts as number
    if (typeof e.iso !== "string" || Number.isNaN(Date.parse(e.iso as string))) return `entry ${i} iso invalid`
    const isoMs = Date.parse(e.iso as string)
    if (isoMs < prevIsoMs) return `entry ${i} iso not monotonic`
    prevIsoMs = isoMs
    if (Math.abs(isoMs - (e.ts as number)) > 5000) return `entry ${i} iso/ts mismatch`
    if (typeof e.phase !== "string" || (e.phase as string).length === 0) return `entry ${i} phase invalid`
    if (!allowedPhases.has(e.phase as string)) return `entry ${i} phase unknown`
    if (/GcLifecycle Title|GateC Title/.test(e.phase as string)) return `entry ${i} phase leaked raw title`
    const ab = e.auxiliaryBar as Record<string, unknown> | undefined
    if (!ab || typeof ab !== "object" || Array.isArray(ab)) return `entry ${i} auxiliaryBar missing`
    {
      const ae = exactKeys(
        ab as Record<string, unknown>,
        ["exists", "visible", "width", "height", "focusWithin"],
        `entry ${i}.auxiliaryBar`,
      )
      if (ae) return ae
      const fb = checkForbidden(ab, `entry ${i}.auxiliaryBar`)
      if (fb) return fb
      if (typeof ab.exists !== "boolean" || typeof ab.visible !== "boolean" || typeof ab.focusWithin !== "boolean")
        return `entry ${i} auxiliaryBar fields invalid`
      if (
        typeof ab.width !== "number" ||
        !Number.isInteger(ab.width as number) ||
        (ab.width as number) < 0 ||
        (ab.width as number) > 5000
      )
        return `entry ${i} auxiliaryBar width invalid`
      if (
        typeof ab.height !== "number" ||
        !Number.isInteger(ab.height as number) ||
        (ab.height as number) < 0 ||
        (ab.height as number) > 5000
      )
        return `entry ${i} auxiliaryBar height invalid`
    }
    const ch = e.chat as Record<string, unknown> | undefined
    if (!ch || typeof ch !== "object" || Array.isArray(ch)) return `entry ${i} chat missing`
    {
      const ce = exactKeys(ch as Record<string, unknown>, ["exists", "visible", "inputVisible"], `entry ${i}.chat`)
      if (ce) return ce
      const fb = checkForbidden(ch, `entry ${i}.chat`)
      if (fb) return fb
      if (typeof ch.exists !== "boolean" || typeof ch.visible !== "boolean" || typeof ch.inputVisible !== "boolean")
        return `entry ${i} chat fields invalid`
    }
    const ed = e.editors as Record<string, unknown> | undefined
    if (!ed || typeof ed !== "object" || Array.isArray(ed)) return `entry ${i} editors missing`
    {
      const ee = exactKeys(ed as Record<string, unknown>, ["tabCount", "groupCount", "tabHashes"], `entry ${i}.editors`)
      if (ee) return ee
      const fb = checkForbidden(ed, `entry ${i}.editors`)
      if (fb) return fb
      if (
        typeof ed.tabCount !== "number" ||
        !Number.isInteger(ed.tabCount as number) ||
        (ed.tabCount as number) < 0 ||
        (ed.tabCount as number) > 100
      )
        return `entry ${i} editors tabCount invalid`
      if (
        typeof ed.groupCount !== "number" ||
        !Number.isInteger(ed.groupCount as number) ||
        (ed.groupCount as number) < 0 ||
        (ed.groupCount as number) > 100
      )
        return `entry ${i} editors groupCount invalid`
      if (!Array.isArray(ed.tabHashes)) return `entry ${i} editors tabHashes not array`
      for (let t = 0; t < (ed.tabHashes as unknown[]).length; t++) {
        const h = (ed.tabHashes as unknown[])[t]
        if (typeof h !== "string" || !hex16.test(h)) return `entry ${i} editors tabHashes[${t}] invalid`
      }
    }
    const fr = e.frames as unknown[] | undefined
    if (!Array.isArray(fr)) return `entry ${i} frames missing`
    for (let j = 0; j < fr.length; j++) {
      const f = fr[j] as Record<string, unknown>
      if (!f || typeof f !== "object" || Array.isArray(f)) return `entry ${i} frame ${j} not object`
      const fe = exactKeys(
        f as Record<string, unknown>,
        [
          "urlHash",
          "urlKind",
          "pageKind",
          "dataTheme",
          "hasAm",
          "hasKiloChat",
          "hasPrompt",
          "hasHeader",
          "bodyClassHash",
          "bodyCategory",
          "visible",
        ],
        `entry ${i} frame ${j}`,
      )
      if (fe) return fe
      const fb = checkForbidden(f, `entry ${i} frame ${j}`)
      if (fb) return fb
      if (typeof f.urlHash !== "string" || !hex16.test(f.urlHash as string))
        return `entry ${i} frame ${j} urlHash invalid`
      if (typeof f.urlKind !== "string" || !allowedUrlKind.has(f.urlKind as string))
        return `entry ${i} frame ${j} urlKind invalid`
      if (typeof f.pageKind !== "string" || !allowedPageKind.has(f.pageKind as string))
        return `entry ${i} frame ${j} pageKind invalid`
      if (typeof f.dataTheme !== "string" || !allowedDataTheme.has(f.dataTheme as string))
        return `entry ${i} frame ${j} dataTheme invalid`
      if (
        typeof f.hasAm !== "boolean" ||
        typeof f.hasKiloChat !== "boolean" ||
        typeof f.hasPrompt !== "boolean" ||
        typeof f.hasHeader !== "boolean" ||
        typeof f.visible !== "boolean"
      )
        return `entry ${i} frame ${j} flags invalid`
      if (typeof f.bodyCategory !== "string" || !allowedCat.has(f.bodyCategory as string))
        return `entry ${i} frame ${j} bodyCategory unknown`
      if (f.bodyClassHash !== "" && (typeof f.bodyClassHash !== "string" || !hex16.test(f.bodyClassHash as string)))
        return `entry ${i} frame ${j} bodyClassHash invalid`
    }
    const raw = JSON.stringify(e)
    if (/GcLifecycle Title/.test(raw) || /GateC Title/.test(raw)) return `entry ${i} leaked raw title`
    if (raw.includes("e2e-fixture-key") || raw.includes("KILO_SERVER_PASSWORD")) return `entry ${i} leaked secret`
    if (/\/[a-z]+\/[^\s"]*\.kilo/.test(raw)) return `entry ${i} leaked path`
  }
  const phaseList = (parsed as Array<Record<string, unknown>>).map((x) => x.phase as string)
  const counts = new Map<string, number>()
  for (const ph of phaseList) counts.set(ph, (counts.get(ph) ?? 0) + 1)
  for (const p of requiredPhases) {
    const c = counts.get(p) ?? 0
    if (c === 0) return `timeline missing phase ${p}`
    if (c !== 1) return `timeline phase ${p} must appear exactly once (got ${c})`
  }
  const orderPhases = requiredPhases.filter((p) => p !== "failure-diagnostics")
  const indices = orderPhases.map((p) => phaseList.indexOf(p))
  for (let k = 1; k < indices.length; k++) {
    if (indices[k] < indices[k - 1])
      return `timeline phase order invalid ${orderPhases[k - 1]} before ${orderPhases[k]}`
  }
  return null
}

/**
 * SSE timeline artifact schema (LOCK-049/050/051, fixture-only, basic
 * real-session Stop flow). Duplicated (not imported) from
 * `src/services/cli-backend/sse-timeline.ts` to avoid cross-boundary build
 * coupling for this Node-only test harness; keep in sync with that source.
 */
export const SSE_TIMELINE_SCHEMA = "kilo-sse-timeline/1"
export const SSE_TIMELINE_CAP = 200
export const SSE_TIMELINE_STRING_LIMIT = 500

/**
 * Validate a redacted `sse-timeline-abort-A/B.json` artifact: exact envelope
 * keys, schema/cap sync with the producer, count/dropped/truncation
 * consistency, contiguous arrival-order seq, monotonic client-observed
 * timestamps, allowlisted per-entry metadata keys only (no payload, title, or
 * path beyond the bounded envelope directory), bounded strings, and no leaked
 * secrets. Timestamps are client-observed receipt times by construction —
 * this validator never claims wire/server provenance.
 */
// eslint-disable-next-line complexity
export function validateSseTimeline(parsed: unknown): string | null {
  const exactKeys = (obj: Record<string, unknown>, allowed: string[], at: string): string | null => {
    const keys = Object.keys(obj).sort()
    const want = [...allowed].sort()
    if (keys.length !== want.length || !keys.every((k, i) => k === want[i])) {
      return `${at} keys mismatch: got [${keys.join(",")}] want [${want.join(",")}]`
    }
    return null
  }
  const isIso = (v: unknown): v is string => {
    if (typeof v !== "string") return false
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)) return false
    const ms = Date.parse(v)
    if (Number.isNaN(ms)) return false
    return new Date(ms).toISOString() === v
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "not an object"
  const p = parsed as Record<string, unknown>
  const top = exactKeys(
    p,
    ["schema", "startedAt", "stoppedAt", "observing", "cap", "count", "dropped", "truncated", "entries"],
    "timeline",
  )
  if (top) return top
  if (p.schema !== SSE_TIMELINE_SCHEMA) return `schema must be ${SSE_TIMELINE_SCHEMA}`
  if (p.startedAt !== null && !isIso(p.startedAt))
    return "startedAt must be canonical ISO date (toISOString with milliseconds and UTC) or null"
  if (p.stoppedAt !== null && !isIso(p.stoppedAt))
    return "stoppedAt must be canonical ISO date (toISOString with milliseconds and UTC) or null"
  if (typeof p.observing !== "boolean") return "observing must be boolean"
  if (p.cap !== SSE_TIMELINE_CAP) return `cap must be ${SSE_TIMELINE_CAP}`
  if (typeof p.count !== "number" || !Number.isInteger(p.count) || p.count < 0) return "count invalid"
  if (typeof p.dropped !== "number" || !Number.isInteger(p.dropped) || p.dropped < 0) return "dropped invalid"
  if (typeof p.truncated !== "boolean") return "truncated must be boolean"
  if (p.truncated !== (p.dropped > 0)) return "truncated must equal dropped>0"
  if (!Array.isArray(p.entries)) return "entries must be array"
  if (p.count !== p.entries.length) return "count must equal entries length"
  if (p.count > SSE_TIMELINE_CAP) return "count exceeds cap"
  const allowedEntry = ["seq", "at", "kind", "sessionID", "directory", "transaction", "status"]
  let prevMs = -Infinity
  for (let i = 0; i < p.entries.length; i++) {
    const raw = p.entries[i]
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return `entry ${i} not object`
    const rec = raw as Record<string, unknown>
    for (const k of Object.keys(rec)) {
      if (!allowedEntry.includes(k)) return `entry ${i}.${k} forbidden key`
    }
    if (typeof rec.seq !== "number" || !Number.isInteger(rec.seq) || rec.seq !== i)
      return `entry ${i} seq must be ${i} (arrival order)`
    if (!isIso(rec.at)) return `entry ${i} at must be canonical ISO date (toISOString with milliseconds and UTC)`
    const ms = Date.parse(rec.at as string)
    if (ms < prevMs) return `entry ${i} at not monotonic`
    prevMs = ms
    if (typeof rec.kind !== "string" || rec.kind.length === 0) return `entry ${i} kind invalid`
    if ((rec.kind as string).length > SSE_TIMELINE_STRING_LIMIT) return `entry ${i}.kind exceeds bound`
    for (const k of ["sessionID", "directory", "transaction", "status"] as const) {
      const v = rec[k]
      if (v === undefined) continue
      if (typeof v !== "string" || v.length === 0) return `entry ${i}.${k} invalid`
      if (v.length > SSE_TIMELINE_STRING_LIMIT) return `entry ${i}.${k} exceeds bound`
    }
  }
  const text = JSON.stringify(parsed)
  if (text.includes("e2e-fixture-key") || text.includes("KILO_SERVER_PASSWORD")) return "leaked secret string"
  return null
}

/**
 * Abort-attempt artifact bounds. Duplicated (not imported) from
 * `src/kilo-provider/abort.ts` to avoid cross-boundary build coupling for
 * this Node-only test harness; keep in sync with that source.
 */
export const ABORT_ATTEMPT_LIMIT = 50
export const ABORT_STRING_LIMIT = 500

/**
 * Validate the cumulative run-level `abort-attempts.json` artifact: exact run
 * envelope keys, scenario/collectedAt/total consistency, bounded entry count,
 * and the existing fixture observer record shape only (bounded/redacted —
 * never payloads, titles, or paths beyond the bounded directory field). No
 * receipt/call-count inference: total must equal retained entries length.
 */
// eslint-disable-next-line complexity
export function validateAbortAttempts(parsed: unknown): string | null {
  const exactKeys = (obj: Record<string, unknown>, allowed: string[], at: string): string | null => {
    const keys = Object.keys(obj).sort()
    const want = [...allowed].sort()
    if (keys.length !== want.length || !keys.every((k, i) => k === want[i])) {
      return `${at} keys mismatch: got [${keys.join(",")}] want [${want.join(",")}]`
    }
    return null
  }
  const isCanonicalIso = (v: unknown): v is string => {
    if (typeof v !== "string") return false
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)) return false
    const ms = Date.parse(v)
    if (Number.isNaN(ms)) return false
    return new Date(ms).toISOString() === v
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "not an object"
  const p = parsed as Record<string, unknown>
  const top = exactKeys(p, ["scenario", "collectedAt", "total", "entries"], "abort-attempts")
  if (top) return top
  if (typeof p.scenario !== "string" || p.scenario.length === 0) return "scenario must be non-empty string"
  if (!isCanonicalIso(p.collectedAt)) return "collectedAt must be canonical ISO date (toISOString with milliseconds and UTC)"
  if (typeof p.total !== "number" || !Number.isInteger(p.total) || p.total < 0) return "total invalid"
  if (!Array.isArray(p.entries)) return "entries must be array"
  if (p.total !== p.entries.length) return "total must equal entries length"
  if (p.entries.length > ABORT_ATTEMPT_LIMIT) return "entries exceed limit"
  const allowedEntry = ["sessionID", "directory", "startedAt", "endedAt", "durationMs", "ok", "attempt", "error", "status", "data"]
  for (let i = 0; i < p.entries.length; i++) {
    const raw = p.entries[i]
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return `entry ${i} not object`
    const rec = raw as Record<string, unknown>
    for (const k of Object.keys(rec)) {
      if (!allowedEntry.includes(k)) return `entry ${i}.${k} forbidden key`
    }
    for (const k of ["sessionID", "directory"] as const) {
      const v = rec[k]
      if (typeof v !== "string" || v.length === 0) return `entry ${i}.${k} invalid`
      if (v.length > ABORT_STRING_LIMIT) return `entry ${i}.${k} exceeds bound`
    }
    for (const k of ["startedAt", "endedAt", "durationMs"] as const) {
      const v = rec[k]
      if (typeof v !== "number" || !Number.isInteger(v) || v < 0) return `entry ${i}.${k} invalid`
    }
    if ((rec.endedAt as number) < (rec.startedAt as number)) return `entry ${i} endedAt before startedAt`
    if ((rec.durationMs as number) !== (rec.endedAt as number) - (rec.startedAt as number))
      return `entry ${i} durationMs must equal endedAt-startedAt`
    if (typeof rec.ok !== "boolean") return `entry ${i}.ok must be boolean`
    if (typeof rec.attempt !== "number" || !Number.isInteger(rec.attempt) || rec.attempt < 1)
      return `entry ${i}.attempt invalid`
    if (rec.error !== undefined) {
      if (typeof rec.error !== "string" || rec.error.length === 0) return `entry ${i}.error invalid`
      if (rec.error.length > ABORT_STRING_LIMIT) return `entry ${i}.error exceeds bound`
    }
    if (rec.status !== undefined) {
      if (typeof rec.status !== "number" || !Number.isFinite(rec.status)) return `entry ${i}.status invalid`
    }
    if (rec.data !== undefined && typeof rec.data !== "boolean") return `entry ${i}.data must be boolean`
  }
  const text = JSON.stringify(parsed)
  if (text.includes("e2e-fixture-key") || text.includes("KILO_SERVER_PASSWORD")) return "leaked secret string"
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
    // Optional timeline/abort/queued artifacts stay absent-allowed, but a present
    // artifact must still validate: a malformed or secret-bearing
    // sse-timeline-abort-A/B.json, abort-attempts.json, or queued-observation.json
    // fails the handoff instead of passing through unvalidated. No other optional
    // inventory changes.
    if (
      !isRequired &&
      (dest === "sse-timeline-abort-A.json" ||
        dest === "sse-timeline-abort-B.json" ||
        dest === "abort-attempts.json" ||
        dest === "queued-observation.json")
    ) {
      const failure = parseFailure(dest, bytes)
      if (failure !== null) {
        malformed.push(dest)
        notes.push(`malformed optional artifact ${dest}: ${failure}`)
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
  const status: EvidenceStatus = !success
    ? "failed"
    : !validated
      ? malformedRequired > 0
        ? "malformed"
        : "missing"
      : "complete"

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
