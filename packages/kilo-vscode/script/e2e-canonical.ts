/**
 * Canonical S5 post-cutover helpers for the real-restart E2E harness (Node-only,
 * never bundled into the extension). Provides a single run-owned fresh canonical
 * data root for the whole real-restart run, the hidden-storage-cutover wiring,
 * and read-only evidence collection for the fresh identity/zero-state gate plus
 * archive/marker identity sufficient to prove no archive mutation across the five
 * boundaries.
 *
 * Pure helpers are unit-tested; the only side-effecting entry is
 * ensureFreshCanonicalRoot which spawns the existing hidden
 * `__internal-storage-cutover` CLI command and writes run-owned artifacts into
 * the scratch dir (never the user's real home).
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"
import { writeRealGlobalSeed } from "./e2e-restart-seed"

const ARCHIVE_ID_RE = /^\d{8}T\d{6}Z-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Single fresh canonical data root for the whole real-restart run. */
export function canonicalDataRoot(scratch: string): string {
  return join(resolve(scratch), "xdg-data", "kilo")
}

/** Absolute DB path for the canonical root. */
export function canonicalDbPath(scratch: string): string {
  return join(canonicalDataRoot(scratch), "kilo.db")
}

/** Derive archive locations exactly like @opencode-ai/core/cutover/archive.ts. */
export function deriveArchiveFor(dataRoot: string): { parent: string; base: string; archiveRoot: string; p4: string } {
  const abs = resolve(dataRoot)
  const parent = dirname(abs)
  const base = basename(abs)
  const archiveRoot = join(parent, `${base}-archive`)
  const p4 = join(archiveRoot, "p4.2")
  return { parent, base, archiveRoot, p4 }
}

export function isValidArchiveID(id: string): boolean {
  return ARCHIVE_ID_RE.test(id)
}

export function isValidUUID(id: string): boolean {
  return UUID_RE.test(id)
}

/** True when the dataRoot is strictly inside the run-owned scratch. */
export function isIsolatedDataRoot(scratch: string, dataRoot: string): boolean {
  const s = resolve(scratch)
  const d = resolve(dataRoot)
  return d === s || d.startsWith(s + "/")
}

/**
 * Parse the hidden cutover CLI stdout (single JSON line per op).
 * Returns the archive identity on success or throws with actionable context.
 */
export function parseCutoverOutput(stdout: string): { archiveID: string; archivePath: string } {
  const text = stdout.trim()
  if (!text) throw new Error("cutover output empty")
  // The CLI may have extra lines; find the JSON line containing "ok":true
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
  let last: unknown
  for (const line of lines) {
    try {
      last = JSON.parse(line)
    } catch {
      continue
    }
    const obj = last as Record<string, unknown>
    if (obj && obj.ok === true && typeof obj.archiveID === "string") {
      const archiveID = String(obj.archiveID)
      const archivePath = typeof obj.archivePath === "string" ? String(obj.archivePath) : ""
      if (!isValidArchiveID(archiveID)) throw new Error(`invalid archiveID in cutover output: ${archiveID}`)
      return { archiveID, archivePath }
    }
  }
  throw new Error(`cutover output missing ok archiveID: ${text.slice(0, 500)}`)
}

/**
 * Read-only validation of the canonical gate evidence artifact.
 * Returns undefined when valid, else a failure reason.
 */
// eslint-disable-next-line complexity
export function validateGateEvidence(obj: unknown): string | undefined {
  if (!obj || typeof obj !== "object") return "gate evidence not an object"
  const o = obj as Record<string, unknown>
  const ident = o.identity as Record<string, unknown> | undefined
  if (!ident || typeof ident.uuid !== "string" || !isValidUUID(String(ident.uuid))) return "identity.uuid invalid"
  if (ident.schema_version !== "1") return `identity.schema_version expected 1 got ${String(ident.schema_version)}`
  if (typeof ident.cutover_archive_id !== "string" || !isValidArchiveID(String(ident.cutover_archive_id))) {
    return "identity.cutover_archive_id invalid"
  }
  const zero = o.zeroState as Record<string, unknown> | undefined
  if (!zero) return "zeroState missing"
  // Every zero-table count must be 0 and session_changefeed_state must be 1 row zero retained
  for (const [k, v] of Object.entries(zero)) {
    if (k === "session_changefeed_state" || k === "storage_identity_count" || k === "session_changefeed_state_count")
      continue
    if (typeof v !== "number") return `zeroState ${k} not a number`
    if (v !== 0) return `zeroState ${k}=${v} expected 0`
  }
  if (zero.session_changefeed_state_count !== 1) return "session_changefeed_state_count expected 1"
  if (zero.storage_identity_count !== 1) return "storage_identity_count expected 1"
  const scs = zero.session_changefeed_state as Record<string, unknown> | undefined
  if (!scs || scs.retained_rows !== 0 || scs.retained_bytes !== 0) return "session_changefeed_state retained not zero"
  const family = o.family as Record<string, unknown> | undefined
  if (!family) return "family missing"
  for (const k of ["session_diff", "session_diff_base", "session_share"]) {
    if (family[k] !== 0) return `family ${k} expected 0 entries`
  }
  if (o.autoVacuum !== 2) return `autoVacuum expected 2 got ${String(o.autoVacuum)}`
  return undefined
}

/**
 * Collect a bounded snapshot of archive/marker state for before/after comparison.
 * Read-only, synchronous, byte-bounded (manifests only).
 */
export function collectArchiveState(dataRoot: string): {
  archives: Array<{ id: string; mtimeMs: number; bytes: number; sha256?: string }>
  markers: { cutover: boolean; rollback: boolean; lease: boolean }
  archiveCount: number
} {
  const { parent, base, p4 } = deriveArchiveFor(dataRoot)
  const cutover = join(parent, `.cutover-${base}.marker.json`)
  const rollback = join(parent, `.rollback-${base}.marker.json`)
  const lease = join(parent, `.kilo-${base}.lease.json`)
  const markers = {
    cutover: existsSync(cutover),
    rollback: existsSync(rollback),
    lease: existsSync(lease),
  }
  let archives: Array<{ id: string; mtimeMs: number; bytes: number; sha256?: string }> = []
  if (existsSync(p4)) {
    const entries = readdirSync(p4)
    for (const name of entries) {
      if (name.startsWith(".tmp-")) continue
      const full = join(p4, name)
      try {
        const st = statSync(full)
        if (!st.isDirectory()) continue
        const manifest = join(full, "manifest.json")
        let bytes = 0
        let sha256: string | undefined
        if (existsSync(manifest)) {
          const buf = readFileSync(manifest)
          bytes = buf.length
          // No error guard needed: hashing an in-memory buffer with a fixed
          // algorithm cannot throw. An absent manifest leaves sha256 unset,
          // matching the optional-sha256 contract.
          sha256 = createHash("sha256").update(buf).digest("hex")
        }
        archives.push({ id: name, mtimeMs: st.mtimeMs, bytes, sha256 })
      } catch (err) {
        // TOCTOU only: an entry listed by readdirSync can vanish or become
        // unstattable before statSync (concurrent tmp-dir cleanup). Skip it,
        // but never silently — a missing archive must stay visible because
        // before/after evidence depends on a complete inventory.
        console.error(
          `[canonical] skipping unstattable archive entry ${name}: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
    archives.sort((a, b) => a.id.localeCompare(b.id))
  }
  return { archives, markers, archiveCount: archives.length }
}

/**
 * Validate that no archive mutation happened between before and after.
 * Returns undefined when stable, else an actionable reason.
 * Fails explicitly when the pre-run state had zero archives — the harness
 * requires a fresh canonical DB and at least one archive before the first
 * canonical-era session.
 */
export function archiveMutationError(
  before: ReturnType<typeof collectArchiveState>,
  after: ReturnType<typeof collectArchiveState>,
): string | undefined {
  if (before.archiveCount === 0)
    return `archive count before is 0 — fresh canonical DB and at least one archive must exist before the Extension Host creates the canonical-era session`
  if (before.archiveCount !== after.archiveCount) {
    return `archive count changed before=${before.archiveCount} after=${after.archiveCount}`
  }
  const idsBefore = before.archives.map((a) => a.id).sort()
  const idsAfter = after.archives.map((a) => a.id).sort()
  if (idsBefore.join(",") !== idsAfter.join(","))
    return `archive ids changed before=[${idsBefore.join(",")}] after=[${idsAfter.join(",")}]`
  for (const b of before.archives) {
    const a = after.archives.find((x) => x.id === b.id)
    if (!a) return `archive ${b.id} missing after`
    if (a.mtimeMs !== b.mtimeMs) return `archive ${b.id} mtime changed before=${b.mtimeMs} after=${a.mtimeMs}`
    if (b.sha256 && a.sha256 && b.sha256 !== a.sha256) return `archive ${b.id} manifest hash changed`
    if (a.bytes !== b.bytes) return `archive ${b.id} manifest bytes changed`
  }
  // Markers must remain absent (no cutover/rollback in-flight during run)
  if (after.markers.cutover) return "cutover marker present after run"
  if (after.markers.rollback) return "rollback marker present after run"
  return undefined
}

/** Ensure the harness never targets the user's real home/data. */
export function assertIsolatedOrThrow(scratch: string, dataRoot: string): void {
  if (!isIsolatedDataRoot(scratch, dataRoot)) {
    throw new Error(
      `dataRoot ${dataRoot} not inside run-owned scratch ${scratch} — refusing to target real HOME/XDG data`,
    )
  }
}

/** The real-* scenario names that consume the hermetic global root seed. */
const REAL_SCENARIOS = ["real-session", "real-completed", "real-overflow", "real-restart", "real-lifecycle"]

/** True when the scenario set requires the fresh canonical DB + hidden cutover + archive stability. */
export function needsCanonicalStorage(scenarios: Set<string>): boolean {
  return scenarios.has("real-restart") || scenarios.has("real-session") || scenarios.has("real-lifecycle")
}

/**
 * Pre-launch preparation shared by the canonical-era scenarios: seed the
 * run-owned global canonical root (<scratch>/xdg-config/kilo) for every
 * real-* scenario — the no-op plugin dependency guard plus the canonical
 * agent .md assets ModeSwitcher serves post-S5 cutover — then allocate the
 * fresh canonical data root and run the cutover gate for real-restart AND
 * real-session (predicate: needsCanonicalStorage).
 * Call BEFORE the first VS Code launch / kilo serve spawn.
 */
export async function prepareCanonicalRun(opts: {
  scenarios: Set<string>
  scratch: string
  repoRoot: string
  realRestart: boolean
}): Promise<void> {
  if (REAL_SCENARIOS.some((name) => opts.scenarios.has(name))) {
    const seed = writeRealGlobalSeed(opts.scratch)
    console.log(`[probe] real global seed: ${seed.configDir} (${seed.assetFiles.length} agent assets)`)
  }
  if (opts.realRestart || needsCanonicalStorage(opts.scenarios)) {
    await ensureFreshCanonicalRoot({ scratch: opts.scratch, repoRoot: opts.repoRoot })
  }
}

/** Resolve the Bun-only gate helper path for the current run. */
function resolveGateHelper(repoRoot?: string): string {
  const candidates: string[] = []
  if (repoRoot) {
    candidates.push(join(resolve(repoRoot), "packages/kilo-vscode/script/e2e-canonical-gate.ts"))
    candidates.push(join(resolve(repoRoot), "script/e2e-canonical-gate.ts"))
  }
  const envRoot = process.env.KILO_E2E_ROOT
  if (envRoot) {
    candidates.push(join(resolve(envRoot), "script/e2e-canonical-gate.ts"))
    candidates.push(join(resolve(envRoot), "packages/kilo-vscode/script/e2e-canonical-gate.ts"))
  }
  try {
    // When executed via bun test, import.meta.url points at this file.
    const selfDir = dirname(fileURLToPath((import.meta as unknown as { url: string }).url))
    candidates.push(join(selfDir, "e2e-canonical-gate.ts"))
  } catch {
    // Bundled contexts lack import.meta.url; the cwd-based candidates below cover that case.
  }
  candidates.push(join(resolve(process.cwd()), "script/e2e-canonical-gate.ts"))
  candidates.push(join(resolve(process.cwd()), "packages/kilo-vscode/script/e2e-canonical-gate.ts"))
  for (const p of candidates) if (existsSync(p)) return p
  throw new Error(`gate helper not found; tried ${candidates.join(", ")}`)
}

/** Strictly parse JSON produced by the Bun gate helper. */
function parseGateJson(stdout: string, helper: string): Record<string, unknown> {
  const text = stdout.trim()
  if (!text) throw new Error(`gate helper ${helper} produced empty output`)
  let obj: unknown
  try {
    obj = JSON.parse(text)
  } catch (e) {
    throw new Error(
      `gate helper ${helper} produced invalid JSON: ${String((e as Error).message)} — ${text.slice(0, 500)}`,
    )
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj))
    throw new Error(`gate helper ${helper} produced non-object JSON`)
  return obj as Record<string, unknown>
}

/**
 * Scratch-scoped environment for parent-side spawns (Bun gate helper init/read
 * and the hidden-cutover CLI): XDG_* and HOME all point inside the run-owned
 * scratch so core import-time side effects cannot touch real HOME.
 */
function scratchEnv(scratch: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: scratch,
    XDG_CONFIG_HOME: join(scratch, "xdg-config"),
    XDG_DATA_HOME: join(scratch, "xdg-data"),
    XDG_CACHE_HOME: join(scratch, "xdg-cache"),
    XDG_STATE_HOME: join(scratch, "xdg-state"),
  }
}

/**
 * Execute the existing hidden storage cutover against the isolated root and
 * collect read-only gate + archive evidence. Uses the smallest existing
 * equivalent that creates the canonical identity/zero-state gate (the hidden CLI
 * command) and never duplicates cutover logic. Call before launching the
 * Extension Host so the fresh DB is proven before the first session is created.
 *
 * Writes `canonical-gate.json`, `canonical-archive-before.json` into the
 * scratch dir and returns the canonical paths for the harness to forward as
 * child env (KILO_DB + XDG_* already isolated via the scratch XDG tree).
 */
export async function ensureFreshCanonicalRoot(opts: {
  scratch: string
  repoRoot: string
}): Promise<{ dataRoot: string; dbPath: string; archiveID: string; archivePath: string }> {
  const { scratch, repoRoot } = opts
  const dataRoot = canonicalDataRoot(scratch)
  const dbPath = canonicalDbPath(scratch)
  assertIsolatedOrThrow(scratch, dataRoot)
  mkdirSync(dataRoot, { recursive: true })
  mkdirSync(join(dataRoot, "storage", "session_diff"), { recursive: true })
  mkdirSync(join(dataRoot, "storage", "session_diff_base"), { recursive: true })
  mkdirSync(join(dataRoot, "storage", "session_share"), { recursive: true })
  if (!existsSync(dbPath)) {
    const helper = resolveGateHelper(repoRoot)
    const spawned = spawnSync("bun", ["run", helper, "--init", "--dbPath", dbPath], {
      encoding: "utf8",
      env: scratchEnv(scratch),
    })
    if (spawned.status !== 0) {
      const combined = `${spawned.stdout ?? ""}\n${spawned.stderr ?? ""}`
      throw new Error(`gate helper init failed (status ${spawned.status}): ${combined.slice(0, 4000)}`)
    }
  }
  const cliEntry = join(repoRoot, "packages/opencode/src/index.ts")
  if (!existsSync(cliEntry)) throw new Error(`cli entry missing at ${cliEntry}`)
  const spawned = spawnSync(
    "bun",
    ["run", "--conditions=browser", cliEntry, "__internal-storage-cutover", "cutover", "--data-root", dataRoot],
    {
      encoding: "utf8",
      env: scratchEnv(scratch),
    },
  )
  const combined = `${spawned.stdout ?? ""}\n${spawned.stderr ?? ""}`
  if (spawned.status !== 0) {
    if (combined.includes("fresh canonical DB already active")) {
      // Already canonical — fall through to gate collection.
    } else {
      throw new Error(`hidden cutover failed (status ${spawned.status}): ${combined.slice(0, 4000)}`)
    }
  }
  let archiveID = ""
  let archivePath = ""
  if (spawned.status === 0) {
    const parsed = parseCutoverOutput(spawned.stdout ?? "")
    archiveID = parsed.archiveID
    archivePath = parsed.archivePath
  } else {
    // When already active we still need to read the existing identity for evidence.
    // Read gate below to extract it.
  }
  // Collect gate evidence read-only via the Bun helper (Node never loads bun:sqlite).
  const gate = await readGateEvidence(dbPath, dataRoot, repoRoot, scratch)
  if (!archiveID) archiveID = String((gate.identity as Record<string, unknown>).cutover_archive_id ?? "")
  const validation = validateGateEvidence(gate)
  if (validation)
    throw new Error(`canonical gate validation failed: ${validation} — ${JSON.stringify(gate).slice(0, 2000)}`)
  writeFileSync(join(scratch, "canonical-gate.json"), JSON.stringify(gate, null, 2))
  const before = collectArchiveState(dataRoot)
  if (before.archiveCount === 0) {
    throw new Error(
      `canonical archive count is 0 after cutover — fresh canonical DB and at least one archive must exist before the Extension Host creates the canonical-era session (dataRoot=${dataRoot})`,
    )
  }
  writeFileSync(join(scratch, "canonical-archive-before.json"), JSON.stringify(before, null, 2))
  console.log(`[probe] canonical gate ready: archiveID=${archiveID} dataRoot=${dataRoot}`)
  return { dataRoot, dbPath, archiveID, archivePath }
}

/**
 * Read-only gate evidence directly from the canonical DB file (no lease, no mutation).
 * Node path never imports bun:sqlite — it spawns the Bun helper with an arg array.
 */
export async function readGateEvidence(
  dbPath: string,
  dataRoot: string,
  repoRoot?: string,
  scratch?: string,
): Promise<Record<string, unknown>> {
  const helper = resolveGateHelper(repoRoot)
  const spawned = spawnSync("bun", ["run", helper, "--dbPath", dbPath, "--dataRoot", dataRoot], {
    encoding: "utf8",
    env: scratch ? scratchEnv(scratch) : { ...process.env },
  })
  if (spawned.status !== 0) {
    const combined = `${spawned.stdout ?? ""}\n${spawned.stderr ?? ""}`
    throw new Error(`gate helper failed (status ${spawned.status}): ${combined.slice(0, 4000)}`)
  }
  const gate = parseGateJson(spawned.stdout ?? "", helper)
  // Strict validation of helper output shape before returning
  if (!gate.identity || typeof gate.identity !== "object")
    throw new Error(`gate helper ${helper} output missing identity`)
  if (typeof gate.autoVacuum !== "number") throw new Error(`gate helper ${helper} output missing autoVacuum`)
  if (!gate.zeroState || typeof gate.zeroState !== "object")
    throw new Error(`gate helper ${helper} output missing zeroState`)
  if (!gate.family || typeof gate.family !== "object") throw new Error(`gate helper ${helper} output missing family`)
  // Ensure the helper echoed back the requested paths (no shell interpolation drift)
  if (gate.dbPath !== undefined && gate.dbPath !== dbPath)
    throw new Error(`gate helper dbPath mismatch: ${String(gate.dbPath)} vs ${dbPath}`)
  if (gate.dataRoot !== undefined && gate.dataRoot !== dataRoot) throw new Error(`gate helper dataRoot mismatch`)
  return gate
}

/** Exported for unit tests: locate the helper. */
export function _resolveGateHelperForTest(repoRoot?: string): string {
  return resolveGateHelper(repoRoot)
}

/** Exported for unit tests: strict JSON parsing of helper output. */
export function _parseGateJsonForTest(stdout: string, helper: string): Record<string, unknown> {
  return parseGateJson(stdout, helper)
}

/**
 * After the run, collect the after-state, compare to before, write the after
 * artifact, and throw if any archive/marker mutation is observed. Keeps the
 * bounded evidence inside the existing manifest inventory.
 */
export function assertArchiveStable(scratch: string, dataRoot: string): ReturnType<typeof collectArchiveState> {
  const beforePath = join(scratch, "canonical-archive-before.json")
  if (!existsSync(beforePath))
    throw new Error("canonical-archive-before.json missing — ensureFreshCanonicalRoot was not called")
  const before = JSON.parse(readFileSync(beforePath, "utf8")) as ReturnType<typeof collectArchiveState>
  if (before.archiveCount === 0)
    throw new Error(
      `archive stability check failed: archive count before is 0 — fresh canonical DB and at least one archive must exist before the Extension Host creates the canonical-era session`,
    )
  const after = collectArchiveState(dataRoot)
  writeFileSync(join(scratch, "canonical-archive-after.json"), JSON.stringify(after, null, 2))
  const err = archiveMutationError(before, after)
  if (err) throw new Error(`archive stability check failed: ${err}`)
  console.log(`[probe] PASS canonical archive stable: ${before.archiveCount} archive(s) unchanged, no marker mutation`)
  return after
}
