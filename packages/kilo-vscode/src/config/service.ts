/**
 * P4.1 Canonical Config Service — lifecycle-owned singleton.
 *
 * One service instance in extension activation owns:
 * - File watchers for canonical config files and asset directories
 * - Materialization state, content/version stamps
 * - SecretStorage adapter
 * - Derived selector indexes (persisted/rehydrated via state adapters)
 * - Asset scanning for six asset directories in both scopes
 * - Disposal lifecycle
 *
 * KiloProvider instances subscribe; webviews never own authoritative config.
 *
 * External edits: watcher detects → re-materialize → emit new snapshot.
 * GUI writes: atomic file edit → detect stale → commit → re-materialize.
 * Invalid edits: retain exact prior valid materialization, emit diagnostics.
 * Own writes: per-file timestamp coalescing — never suppress external edits.
 */

import * as path from "path"
import * as fs from "fs"
import type { Disposable } from "./types"
import { isE2EFixtureEnabled } from "../util/e2e-fixture"
import type {
  MaterializedConfig,
  ScopedContent,
  ValidationError,
  AssetDirectory,
  CanonicalPaths,
  StateAdapter,
  WatcherAdapter,
  TypedEmitter,
  EmitterFactory,
  AssetScanEntry,
  AssetScanResult,
  FileReadResult,
  CanonicalStamp,
} from "./types"
import { sameStamp, parseOwnedCredentialRef } from "./types"
import { ASSET_DIRECTORIES } from "./types"
import { Roots, resolveCanonicalPaths, sameCanonicalPath } from "./paths"
import { materialize, MaterializeVersionCounter, type MaterializeInput } from "./materialize"
import { validateConfig, validateMarkdownAsset } from "./validate"
import { validateCrossScope } from "./validate"
import { parseJsonc, readFile, contentHash, parseMarkdown } from "./parse"
import { writeJsoncWithConflictDetection } from "./write"
import {
  type SecretAdapter,
  createVscodeSecretAdapter,
  hasCredential,
  listStoredCredentialIds,
  storeCredential,
  removeCredential,
  retrieveCredential,
  restoreCredentialRef,
  removeCredentialRef,
  secretKey,
  parseSecretKey,
} from "./secret-adapter"
import { type ConfigSnapshot, snapshot as makeSnapshot } from "./snapshot"
import {
  type ProviderIndex,
  type AgentIndex,
  type ModelIndex,
  type SelectorDiagnostics,
  buildProviderIndex,
  buildAgentIndex,
  buildModelIndex,
  SELECTOR_INDEX_VERSION,
  STATE_KEYS,
  persistProviderIndex,
  rehydrateProviderIndex,
  persistAgentIndex,
  rehydrateAgentIndex,
  persistModelIndex,
  rehydrateModelIndex,
  markIndexStale,
} from "./selectors"
import {
  isRecord,
  parseScopeDocument,
  isValidAssetId,
  assembleAssetMarkdown,
  createDefaultEmitterFactory,
  buildAgentEntriesFromScan as buildAgentEntries,
  computeProviderCredentialStatus as computeCredentialStatus,
  stampView,
  assetStampView,
  readAssetView,
  fixtureSnapshotView,
  checkStaleForWriteView,
  buildMergedDocView,
  validateCrossScopeCompositionView,
  scopeConfigView,
} from "./service-views"

// ── Events ───────────────────────────────────────────────────────────

export interface CanonicalConfigEvent {
  /** The new snapshot after materialization. */
  readonly snapshot: ConfigSnapshot
  /** Whether this was triggered by an external edit (watcher) vs GUI write. */
  readonly source: "external" | "gui" | "init"
  /** Whether the materialization had errors (invalid edit retained prior). */
  readonly hasErrors: boolean
  /** Validation errors from the materialization, if any. */
  readonly errors: readonly ValidationError[]
  readonly stamp: CanonicalStamp
}

export interface CanonicalConfigError {
  readonly kind: "invalid" | "stale" | "conflict" | "watcher-error" | "init-failure"
  readonly message: string
  readonly errors?: readonly ValidationError[]
}

/** Per-directory asset scan summary for the fixture state snapshot. */
export interface CanonicalAssetDirSummary {
  readonly dir: AssetDirectory
  readonly scope: "global" | "project"
  readonly entries: number
  readonly errors: number
}

/**
 * Read-only runtime snapshot of the canonical materialization state
 * (KILO_E2E_FIXTURE only, served through the extension.ts fixture bridge).
 * Pure diagnostics: lets the E2E harness distinguish readiness-never-opened
 * from ready-but-empty-index without touching any runtime behavior.
 */
export interface CanonicalStateSnapshot {
  readonly globalRoot: string
  readonly projectRoot: string | null
  readonly materializationReady: boolean
  readonly successfulMaterializationStamp: CanonicalStamp | null
  readonly lastMaterializationError: string | null
  readonly assetScan: readonly CanonicalAssetDirSummary[]
  readonly agentIndex: { readonly size: number; readonly ids: readonly string[] } | null
  readonly providerIndex: {
    readonly size: number
    readonly ids: readonly string[]
    readonly entries: readonly {
      readonly id: string
      readonly hasCredential: boolean
      readonly modelIds: readonly string[]
    }[]
    readonly connected: readonly string[]
  } | null
  readonly defaultModel: string | null
  readonly defaultSelection: { readonly providerID: string; readonly modelID: string } | null
}

// ── Service ──────────────────────────────────────────────────────────

export interface CanonicalConfigServiceOptions {
  /** Override roots for testing. */
  roots?: Roots
  /** Override secret adapter for testing. */
  secretAdapter?: SecretAdapter
  /** Override global state adapter for testing. */
  globalState?: StateAdapter
  /** Override workspace state adapter for testing. */
  workspaceState?: StateAdapter
  /** Override watcher adapter for testing. */
  watcherAdapter?: WatcherAdapter
  /** Override emitter factory for testing (default: vscode.EventEmitter). */
  emitterFactory?: EmitterFactory
  /** Test-only seam for mutating an asset between write and final CAS. */
  beforeAssetFinalCas?: (filePath: string) => void
  /** Test-only seam for mutating JSONC before the atomic final CAS. */
  beforeConfigFinalCas?: (filePath: string) => void
}

export type ConfigScopePatch = {
  readonly patch: Record<string, unknown>
  readonly expectedHash: string
}

export type CompositeConfigWriteResult =
  | {
      readonly ok: true
      readonly snapshot: ConfigSnapshot
      readonly hashes: { readonly global: string | null; readonly project: string | null }
      readonly materializationVersion: number
      readonly stamp: CanonicalStamp
    }
  | {
      readonly ok: false
      readonly kind: "stale" | "invalid" | "conflict" | "disposed" | "io"
      readonly message: string
      readonly errors?: readonly ValidationError[]
      readonly scope?: "global" | "project"
    }

class ConvergenceError extends Error {
  constructor(
    readonly kind: "disposed" | "io",
    message: string,
  ) {
    super(message)
    this.name = "ConvergenceError"
  }
}

export class CanonicalConfigService implements Disposable {
  private readonly paths: CanonicalPaths
  private readonly secrets: SecretAdapter
  private readonly globalState: StateAdapter | undefined
  private readonly workspaceState: StateAdapter | undefined
  private readonly watcher: WatcherAdapter | undefined
  private readonly versionCounter = new MaterializeVersionCounter()
  private readonly watchers: Disposable[] = []
  private readonly onChangeEmitter: TypedEmitter<CanonicalConfigEvent>
  private readonly onErrorEmitter: TypedEmitter<CanonicalConfigError>
  private readonly beforeAssetFinalCas: ((filePath: string) => void) | undefined
  private readonly beforeConfigFinalCas: ((filePath: string) => void) | undefined

  /** Current valid materialization. Null before first successful materialization. */
  private current: MaterializedConfig | null = null

  /** Current snapshot (immutable, retainable by callers). */
  private currentSnapshot: ConfigSnapshot | null = null

  /**
   * Service-owned successful-materialization stamp (P4.1).
   * Set only after an error-free materialization. Reset on disposal.
   * Late subscribers query this — snapshot existence alone is never readiness.
   */
  private successfulMaterializationStamp: CanonicalStamp | null = null

  /**
   * Message of the last error emitted through onDidError (fixture diagnostics
   * only). Captured by wrapping the error emitter — no emit-site changes.
   */
  private lastError: string | null = null

  /** Content hashes of the last-read global/project config files. */
  private globalHash: string | null = null
  private projectHash: string | null = null

  /**
   * Per-file own-write content hashes for coalescing (Blocker 5).
   * Keyed by file path; value is the content hash of the bytes we wrote.
   * Watcher events are coalesced only when reread bytes hash equals this.
   */
  private ownWriteHashes = new Map<string, string>()

  /** Debounce timers for watcher events. */
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()

  /**
   * Revision-gated convergence scheduler (Blocker 6).
   * Monotonically increasing revision; ALL materialization/index persistence/
   * event publication, whether watcher or write initiated, runs through this
   * serialized scheduler. Obsolete work cannot publish; latest work is
   * guaranteed to run. Each task checks its own revision before publishing.
   */
  private revision = 0
  private pendingRevision = 0
  private eventQueue: Array<() => Promise<void> | void> = []
  private processingQueue = false

  /**
   * Per-path write locks (Blocker 10).
   * Serializes writes per canonical path; final CAS before rename.
   */
  private writeLocks = new Map<string, Promise<unknown>>()

  /**
   * Initialize idempotency (Blocker 7).
   * One tracked promise; dispose prevents future resource creation/publication.
   */
  private initPromise: Promise<void> | null = null
  private initStarted = false

  /** Last materialized asset scan (for dedup and stale detection). */
  private lastAssetScan: AssetScanResult | null = null

  /**
   * Rehydrated indexes for immediate UI presentation (Blocker 3).
   * Retained until disk reconciliation replaces or marks them stale.
   */
  private rehydratedProviderIndex: ProviderIndex | null = null
  private rehydratedAgentIndex: AgentIndex | null = null
  private rehydratedGlobalModelIndex: ModelIndex | null = null
  private rehydratedProjectModelIndex: ModelIndex | null = null

  /**
   * Persisted agent index (Blocker 4).
   * Built only from validated agent scan entries; persisted on init/every valid change.
   */
  private persistedAgentIndex: AgentIndex | null = null

  /** Disposed flag. */
  private disposed = false

  constructor(
    private readonly context: any,
    opts: CanonicalConfigServiceOptions = {},
  ) {
    this.paths = resolveCanonicalPaths(opts.roots ?? new Roots(undefined))
    this.secrets = opts.secretAdapter ?? createVscodeSecretAdapter(context)
    this.globalState = opts.globalState
    this.workspaceState = opts.workspaceState
    this.watcher = opts.watcherAdapter
    this.beforeAssetFinalCas = opts.beforeAssetFinalCas
    this.beforeConfigFinalCas = opts.beforeConfigFinalCas

    // Use injected emitter factory or fall back to in-memory implementation
    const ef = opts.emitterFactory ?? createDefaultEmitterFactory()
    this.onChangeEmitter = ef.create<CanonicalConfigEvent>()
    this.onErrorEmitter = this.trackErrors(ef.create<CanonicalConfigError>())
    this.onDidChange = this.onChangeEmitter.event
    this.onDidError = this.onErrorEmitter.event
  }

  /**
   * Wrap the raw error emitter so the last emitted error message is recorded
   * for the fixture state snapshot. Fire/dispose semantics are unchanged.
   */
  private trackErrors(raw: TypedEmitter<CanonicalConfigError>): TypedEmitter<CanonicalConfigError> {
    return {
      event: raw.event,
      fire: (e: CanonicalConfigError) => {
        this.lastError = e.message
        raw.fire(e)
      },
      dispose: () => raw.dispose(),
    }
  }

  // ── Public API ─────────────────────────────────────────────────────

  /** Event: materialization changed (new snapshot available). */
  readonly onDidChange: (listener: (e: CanonicalConfigEvent) => void) => { dispose(): void }

  /** Event: error during materialization or watching. */
  readonly onDidError: (listener: (e: CanonicalConfigError) => void) => { dispose(): void }

  /** Get the current immutable snapshot. Callers retain this without being affected by later edits. */
  get snapshot(): ConfigSnapshot | null {
    return this.currentSnapshot
  }

  /**
   * P4.1: Whether the service has completed at least one successful
   * error-free materialization. Snapshot existence alone is not evidence
   * of readiness — an errored materialization can produce a snapshot.
   * Late subscribers must use this gate, not snapshot presence.
   */
  get materializationReady(): boolean {
    return this.successfulMaterializationStamp !== null
  }

  /** Stamp from the last successful error-free materialization. */
  get lastReadyStamp(): CanonicalStamp | null {
    return this.successfulMaterializationStamp
  }

  /** Message of the last error emitted through onDidError (fixture diagnostics). */
  get lastMaterializationError(): string | null {
    return this.lastError
  }

  /**
   * E2E fixture bridge (KILO_E2E_FIXTURE only, registered by extension.ts):
   * read-only snapshot of the canonical runtime state — roots, readiness,
   * stamps, asset scan summary, and selector index sizes/ids. Throws when the
   * fixture env is absent so no production path can depend on it. Pure read:
   * no mutation, no events, no watchers.
   */
  fixtureStateSnapshot(): CanonicalStateSnapshot {
    if (!isE2EFixtureEnabled()) throw new Error("fixture canonicalState requires KILO_E2E_FIXTURE")
    return fixtureSnapshotView({
      paths: this.paths,
      scan: this.lastAssetScan,
      provider: this.providerIndex,
      agent: this.agentIndex,
      snapshot: this.currentSnapshot,
      ready: this.materializationReady,
      readyStamp: this.lastReadyStamp,
      error: this.lastError,
    })
  }

  /**
   * Fixture-gated credential seeding for the real-restart E2E scenario.
   * Uses the existing production `storeSecret("project","provider",...)` API
   * behind the KILO_E2E_FIXTURE bridge and converges canonical state through
   * the existing GUI-write materialization scheduler (identity rewrite via
   * writeConfig). Does not expose the secret value. Returns a small success
   * payload only after the published selector index reports the provider
   * connected and the config model is visible. Throws when the fixture env is
   * absent.
   */
  // eslint-disable-next-line complexity
  async seedFixtureProviderCredential(
    id: string = "e2e-local",
    value: string = "e2e-fixture-key",
  ): Promise<
    | {
        ok: true
        providerId: string
        hasCredential: true
        connected: readonly string[]
        defaultModel: string | null
        defaultSelection: { providerID: string; modelID: string } | null
        materializationVersion: number
      }
    | { ok: false; reason: string }
  > {
    if (!isE2EFixtureEnabled()) throw new Error("fixture seedFixtureProviderCredential requires KILO_E2E_FIXTURE")
    // Production path: store the credential in run-owned SecretStorage.
    await this.storeSecret("project", "provider", id, value)
    // Bounded wait for project hash or initial materialization readiness before
    // the identity rewrite. This covers the cold-start race where extension.ts
    // fires canonicalConfig.initialize() fire-and-forget and the runner seeds
    // before that promise has produced a project hash. Uses a 10s max / 50ms
    // cadence poll that is cancellable on disposal — no arbitrary sleep drives
    // correctness.
    let hash = this.getConfigHash("project")
    if (hash === null) {
      const deadline = Date.now() + 10_000
      while (hash === null) {
        if (this.disposed) return { ok: false, reason: "service disposed before project config hash became available" }
        // If initial materialization has already completed but the project hash
        // is still null, the config is genuinely missing/invalid — no need to
        // wait the full deadline. The hash can only appear together with a
        // successful materialization, so readiness without hash is terminal.
        if (this.materializationReady) break
        if (Date.now() > deadline) break
        await new Promise<void>((resolve) => setTimeout(resolve, 50))
        if (this.disposed) return { ok: false, reason: "service disposed before project config hash became available" }
        hash = this.getConfigHash("project")
      }
      if (hash === null) {
        // After bounded wait: if the materialization already converged (e.g.
        // re-seed where credential already visible), return success without
        // synthesizing a hash. Otherwise report the precise missing-hash failure
        // — never synthesize a hash or overwrite user data.
        const snap = this.fixtureStateSnapshot()
        const entry = snap.providerIndex?.entries.find((e) => e.id === id)
        if (snap.materializationReady && entry?.hasCredential && snap.defaultModel) {
          return {
            ok: true,
            providerId: id,
            hasCredential: true as const,
            connected: snap.providerIndex!.connected,
            defaultModel: snap.defaultModel,
            defaultSelection: snap.defaultSelection,
            materializationVersion: snap.successfulMaterializationStamp?.materializationVersion ?? 0,
          }
        }
        return { ok: false, reason: "no project config hash for convergence write" }
      }
    }
    // storeSecret ordering is preserved: secret stored, hash/readiness awaited,
    // then identity rewrite triggers existing materialization/revision machinery.
    const write = await this.writeConfig("project", {}, hash)
    if (!write.ok) {
      return { ok: false, reason: `convergence write failed: ${write.kind}: ${write.message}` }
    }
    // The writeConfig path already awaited enqueueAndRunMaterialization("gui"),
    // so the published selector index now reflects the stored credential.
    // Bounded visibility poll (10s max, 50ms cadence, cancellable on disposal).
    const deadline = Date.now() + 10_000
    for (;;) {
      if (this.disposed) return { ok: false, reason: "service disposed before credential converged" }
      const snap = this.fixtureStateSnapshot()
      const entry = snap.providerIndex?.entries.find((e) => e.id === id)
      const converged = snap.materializationReady && entry?.hasCredential === true && snap.defaultModel !== null
      if (converged) {
        return {
          ok: true,
          providerId: id,
          hasCredential: true as const,
          connected: snap.providerIndex!.connected,
          defaultModel: snap.defaultModel,
          defaultSelection: snap.defaultSelection,
          materializationVersion: snap.successfulMaterializationStamp?.materializationVersion ?? 0,
        }
      }
      if (Date.now() > deadline) {
        return {
          ok: false,
          reason: `credential status did not converge: materializationReady=${snap.materializationReady} hasCredential=${entry?.hasCredential} defaultModel=${snap.defaultModel}`,
        }
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 50))
    }
  }

  /** Get the current materialized config value (frozen). */
  get materialized(): MaterializedConfig | null {
    return this.current
  }

  /** Whether the service has been disposed. */
  get isDisposed(): boolean {
    return this.disposed
  }

  /** Whether a workspace folder is available for project scope operations. */
  get hasProject(): boolean {
    return this.paths.projectRoot !== undefined
  }

  /** Structured failure when project scope is requested but no workspace folder exists. */
  private projectAbsent(kind: "invalid" | "stale" | "io" = "invalid"): {
    ok: false
    kind: "invalid" | "stale" | "io" | "disposed"
    message: string
  } {
    return { ok: false, kind, message: "No workspace folder available; project scope operations are not configured" }
  }

  /** Get canonical paths. */
  get canonicalPaths(): Readonly<CanonicalPaths> {
    return this.paths
  }

  /** Get the secret adapter. */
  get secretStore(): SecretAdapter {
    return this.secrets
  }

  /**
   * Initialize: rehydrate indexes, scan files, materialize, start watchers.
   * Must be called once during activation, before consumers subscribe.
   * Initialization is idempotent: subsequent calls return the same promise (Blocker 7).
   */
  initialize(): Promise<void> {
    if (this.disposed) return Promise.resolve()

    // Idempotent: return existing promise if already initializing (Blocker 7)
    if (this.initStarted) return this.initPromise!
    this.initPromise = this.doInitialize()
    this.initStarted = true
    return this.initPromise
  }

  private async doInitialize(): Promise<void> {
    if (this.disposed) return

    // Rehydrate persisted indexes for immediate presentation (Blocker 3)
    this.rehydrateIndexes()

    // Scan all six asset directories in both scopes (before materialization
    // so persistIndexes() has scan data for agent index rebuild)
    this.lastAssetScan = this.scanAssets()

    // Initial materialization from disk (through convergence scheduler).
    // persistIndexes() rebuilds agent index from this.lastAssetScan (Finding 4).
    try {
      await this.enqueueAndRunMaterialization("init")
    } catch (err) {
      if (!this.disposed) throw err
      return
    }

    // Disposal check after await — no watcher creation after disposal
    if (this.disposed) return

    // Start watching canonical files and asset directories
    this.startWatchers()
  }

  /**
   * Write a JSONC config update for a scope.
   * Applies partial set/unset operations to the full stamped current scope
   * document; never treats patch as replacement (Blocker 9).
   * Validates both scoped candidate and cross-scope composition before
   * disk commit (Blocker 9).
   * Serializes per canonical path with final CAS before rename (Blocker 10).
   */
  async writeConfig(
    scope: "global" | "project",
    patch: Record<string, unknown>,
    expectedHash: string,
  ): Promise<
    | { ok: true; snapshot: ConfigSnapshot; contentHash: string }
    | {
        ok: false
        kind: "stale" | "invalid" | "conflict" | "disposed" | "io"
        message: string
        errors?: readonly ValidationError[]
      }
  > {
    if (this.disposed) return { ok: false, kind: "disposed", message: "Service disposed" }
    if (scope === "project" && !this.hasProject) return this.projectAbsent()

    const filePath = scope === "global" ? this.paths.globalConfigFile : this.paths.projectConfigFile!

    // Serialize writes per canonical path (Blocker 10)
    const prev = this.writeLocks.get(filePath) ?? Promise.resolve()
    const locked = prev.then(() => this.doWriteConfig(scope, patch, expectedHash, filePath))
    this.writeLocks.set(filePath, locked)

    try {
      return await locked
    } catch (err) {
      return {
        ok: false,
        kind: this.disposed ? "disposed" : "io",
        message: `Config write failed: ${String(err)}`,
      }
    } finally {
      // Clean up lock if this is the last waiter
      if (this.writeLocks.get(filePath) === locked) {
        this.writeLocks.delete(filePath)
      }
    }
  }

  /**
   * Commit one logical GUI save across both canonical JSONC scopes.
   * Both candidates are validated before either byte is changed. The two
   * canonical paths are locked in deterministic order and already-written
   * bytes/state are restored if the second commit or convergence fails.
   */
  async writeConfigScopes(
    scopes: Partial<Record<"global" | "project", ConfigScopePatch>>,
    stamp?: CanonicalStamp,
  ): Promise<CompositeConfigWriteResult> {
    if (this.disposed) return { ok: false, kind: "disposed", message: "Service disposed" }
    if (stamp && (!sameStamp(stamp, this.stamp) || stamp.assetHash !== null)) {
      return { ok: false, kind: "stale", message: "Canonical config materialization is stale" }
    }
    // Guard: project scope requires workspace folder
    if (scopes.project && !this.hasProject) return this.projectAbsent()
    const entries = (["global", "project"] as const).filter((scope) => scopes[scope])
    if (entries.length === 0) {
      return {
        ok: true,
        snapshot: this.currentSnapshot!,
        hashes: { global: this.globalHash, project: this.projectHash },
        materializationVersion: this.currentSnapshot?.generation ?? 0,
        stamp: this.stamp,
      }
    }
    const paths = entries.map((scope) =>
      scope === "global" ? this.paths.globalConfigFile : this.paths.projectConfigFile!,
    )
    const run = async (): Promise<CompositeConfigWriteResult> => {
      const prior = new Map<string, FileReadResult>()
      for (const scope of entries) {
        prior.set(this.scopePath(scope), readFile(this.scopePath(scope)))
      }
      const candidates = await this.buildCompositeCandidates(scopes, entries, prior)
      if ("ok" in candidates && !candidates.ok) return candidates

      const globalDoc =
        (candidates as Map<"global" | "project", Record<string, unknown>>).get("global") ??
        this.scopeDoc("global", prior)
      const projectDoc =
        (candidates as Map<"global" | "project", Record<string, unknown>>).get("project") ??
        this.scopeDoc("project", prior)
      const existingErr = this.validateExistingScopes(
        candidates as Map<"global" | "project", Record<string, unknown>>,
        prior,
      )
      if (existingErr) return existingErr
      const cross = validateCrossScope(globalDoc, projectDoc)
      if (cross.length > 0) {
        return {
          ok: false,
          kind: "conflict",
          message: `Cross-scope conflict: ${cross.map((e) => e.message).join("; ")}`,
          errors: cross,
        }
      }

      return this.commitCompositeWrites(
        scopes,
        entries,
        candidates as Map<"global" | "project", Record<string, unknown>>,
        prior,
      )
    }

    return this.withConfigLocks(paths, run)
  }

  private scopePath(scope: "global" | "project"): string {
    return scope === "global" ? this.paths.globalConfigFile : this.paths.projectConfigFile!
  }

  private scopeDoc(scope: "global" | "project", prior: Map<string, FileReadResult>): Record<string, unknown> {
    const filePath = scope === "global" ? this.paths.globalConfigFile : this.paths.projectConfigFile
    return filePath ? parseScopeDocument(prior.get(filePath)) : {}
  }

  private async buildCompositeCandidates(
    scopes: Partial<Record<"global" | "project", ConfigScopePatch>>,
    entries: readonly ("global" | "project")[],
    prior: Map<string, FileReadResult>,
  ): Promise<Map<"global" | "project", Record<string, unknown>> | CompositeConfigWriteResult> {
    const candidates = new Map<"global" | "project", Record<string, unknown>>()
    for (const scope of entries) {
      const input = scopes[scope]!
      const filePath = this.scopePath(scope)
      const existing = prior.get(filePath)!
      const stale = this.checkStaleForWrite(existing, input.expectedHash)
      if (stale) return { ...stale, scope }
      const candidate = this.buildMergedDoc(existing, input.patch)
      const validation = validateConfig(JSON.stringify(candidate), scope, filePath)
      if (!validation.valid) {
        return {
          ok: false,
          kind: "invalid",
          scope,
          message: `Validation failed: ${validation.errors.map((e) => e.message).join("; ")}`,
          errors: validation.errors,
        }
      }
      candidates.set(scope, candidate)
    }
    return candidates
  }

  private validateExistingScopes(
    candidates: Map<"global" | "project", Record<string, unknown>>,
    prior: Map<string, FileReadResult>,
  ): CompositeConfigWriteResult | null {
    for (const scope of ["global", "project"] as const) {
      if (candidates.has(scope)) continue
      const filePath = scope === "global" ? this.paths.globalConfigFile : this.paths.projectConfigFile
      if (!filePath) continue
      const raw = prior.get(filePath)
      if (!raw) continue
      if (raw.type === "failure")
        return { ok: false, kind: "invalid", scope, message: `Cannot read ${scope} config: ${raw.message}` }
      if (raw.type === "present") {
        const validation = validateConfig(raw.bytes, scope, filePath)
        if (!validation.valid)
          return { ok: false, kind: "invalid", scope, message: `Invalid ${scope} config`, errors: validation.errors }
      }
    }
    return null
  }

  private async commitCompositeWrites(
    scopes: Partial<Record<"global" | "project", ConfigScopePatch>>,
    entries: readonly ("global" | "project")[],
    candidates: Map<"global" | "project", Record<string, unknown>>,
    prior: Map<string, FileReadResult>,
  ): Promise<CompositeConfigWriteResult> {
    const priorState = this.capturePriorState()
    const written: Array<{ scope: "global" | "project"; filePath: string; bytes: FileReadResult; hash: string }> = []
    try {
      for (const scope of entries) {
        const input = scopes[scope]!
        const filePath = this.scopePath(scope)
        const result = writeJsoncWithConflictDetection(
          filePath,
          candidates.get(scope)!,
          input.expectedHash,
          scope,
          this.beforeConfigFinalCas,
        )
        if ("conflict" in result) {
          await this.restoreConfigBytes(written)
          return {
            ok: false,
            kind: "stale",
            scope,
            message: "Canonical config changed externally; save was not applied",
          }
        }
        const before = prior.get(filePath)!
        written.push({ scope, filePath, bytes: before, hash: result.written.contentHash })
        this.markOwnWrite(filePath, result.written.contentHash)
      }
      this.revision++
      await this.enqueueAndRunMaterialization("gui")
      if (this.disposed) throw new ConvergenceError("disposed", "Service disposed during config convergence")
      return {
        ok: true,
        snapshot: this.currentSnapshot!,
        hashes: { global: this.globalHash, project: this.projectHash },
        materializationVersion: this.currentSnapshot!.generation,
        stamp: this.stamp,
      }
    } catch (err) {
      await this.restoreConfigBytes(written)
      this.restorePriorState(priorState)
      return {
        ok: false,
        kind: err instanceof ConvergenceError ? err.kind : "io",
        message: `Materialization convergence failed; prior bytes restored: ${String(err)}`,
      }
    }
  }

  private async withConfigLocks<T>(paths: string[], run: () => Promise<T>): Promise<T> {
    const ordered = [...paths].sort()
    const prior = ordered.map((filePath) => this.writeLocks.get(filePath) ?? Promise.resolve())
    const gate = Promise.all(prior).then(run)
    for (const filePath of ordered) this.writeLocks.set(filePath, gate)
    try {
      return await gate
    } finally {
      for (const filePath of ordered) if (this.writeLocks.get(filePath) === gate) this.writeLocks.delete(filePath)
    }
  }

  private async restoreConfigBytes(
    written: Array<{ scope: "global" | "project"; filePath: string; bytes: FileReadResult; hash: string }>,
  ): Promise<void> {
    for (const item of written.reverse()) {
      const current = readFile(item.filePath)
      if (current.type !== "present" || current.hash !== item.hash) continue
      if (item.bytes.type === "present") {
        fs.writeFileSync(item.filePath, item.bytes.bytes, "utf-8")
        this.markOwnWrite(item.filePath, item.bytes.hash)
      } else if (item.bytes.type === "absent") {
        fs.unlinkSync(item.filePath)
      }
      if (item.scope === "global") this.globalHash = item.bytes.type === "present" ? item.bytes.hash : null
      else this.projectHash = item.bytes.type === "present" ? item.bytes.hash : null
    }
  }

  private async doWriteConfig(
    scope: "global" | "project",
    patch: Record<string, unknown>,
    expectedHash: string,
    filePath: string,
  ): Promise<
    | { ok: true; snapshot: ConfigSnapshot; contentHash: string }
    | {
        ok: false
        kind: "stale" | "invalid" | "conflict" | "disposed" | "io"
        message: string
        errors?: readonly ValidationError[]
      }
  > {
    if (this.disposed) return { ok: false, kind: "disposed", message: "Service disposed" }
    const existing = readFile(filePath)

    // Final CAS before rename (Blocker 10)
    const staleErr = this.checkStaleForWrite(existing, expectedHash)
    if (staleErr) return staleErr

    // Build full document: merge patch onto current scoped document (Blocker 9)
    const fullDoc = this.buildMergedDoc(existing, patch)

    // Validate the scoped candidate (Blocker 9)
    const validation = validateConfig(JSON.stringify(fullDoc), scope, filePath)
    if (!validation.valid) {
      return {
        ok: false,
        kind: "invalid",
        message: `Validation failed: ${validation.errors.map((e) => e.message).join("; ")}`,
        errors: validation.errors,
      }
    }

    // Validate cross-scope composition (Blocker 9)
    const crossErr = this.checkCrossScopeForWrite(scope, fullDoc)
    if (crossErr) return crossErr

    // Write atomically via the existing write module
    const { writeJsoncWithConflictDetection } = await import("./write")
    const result = writeJsoncWithConflictDetection(filePath, fullDoc, expectedHash, scope, this.beforeConfigFinalCas)

    if ("conflict" in result) {
      return {
        ok: false,
        kind: "stale",
        message: `Write conflict: file changed externally`,
      }
    }

    // Mark own write with content hash for coalescing (Blocker 5)
    this.markOwnWrite(filePath, result.written.contentHash)

    // Bump revision and re-materialize through convergence scheduler (Finding 6)
    this.revision++
    try {
      await this.enqueueAndRunMaterialization("gui")
      if (this.disposed) throw new ConvergenceError("disposed", "Service disposed during config convergence")
    } catch (err) {
      // Gap 9: Log the convergence failure
      console.error(`[Kilo Config] Convergence failure during config write: ${String(err)}`)
      // Convergence failure: structured failure, never swallowed success.
      // Restore service-owned prior bytes only if the just-written hash still matches
      // (Finding: convergence failure write rollback).
      const check = readFile(filePath)
      if (check.type === "present" && check.hash === result.written.contentHash) {
        // Our write is still the latest — restore prior bytes
        if (existing.type === "present") {
          const dir = path.dirname(filePath)
          const tmp = `${filePath}.${process.pid}.restore.tmp`
          try {
            fs.writeFileSync(tmp, existing.bytes, "utf-8")
            fs.renameSync(tmp, filePath)
          } catch (restoreErr) {
            try {
              fs.unlinkSync(tmp)
            } catch (cleanupErr) {
              console.error(`[Kilo Config] Restore temp cleanup failed for ${tmp}: ${String(cleanupErr)}`)
            }
            console.error(`[Kilo Config] Prior bytes restore failed for ${filePath}: ${String(restoreErr)}`)
          }
          if (scope === "global") this.globalHash = existing.hash
          else this.projectHash = existing.hash
        } else if (existing.type === "absent") {
          // File didn't exist before our write — delete to restore absence
          try {
            fs.unlinkSync(filePath)
          } catch (err) {
            console.error(`[Kilo Config] File removal restore failed for ${filePath}: ${String(err)}`)
          }
          if (scope === "global") this.globalHash = null
          else this.projectHash = null
        }
      }
      // Credential rollback is handled by processCredentialIntent caller
      return {
        ok: false,
        kind: err instanceof ConvergenceError ? err.kind : this.disposed ? "disposed" : "io",
        message: `Materialization convergence failed after write — prior bytes restored: ${String(err)}`,
      }
    }

    return {
      ok: true,
      snapshot: this.currentSnapshot!,
      contentHash: result.written.contentHash,
    }
  }

  /**
   * Write a markdown asset file atomically.
   * Validates against the asset schema before writing.
   * Asset writes require expected hash/stamp and return stale conflict on
   * changed/deleted source. Validates ID as safe filename segment (Blocker 11).
   * Stamped creates require expected state "absent" (Blocker 11).
   *
   * Gap 7: Routes through per-path lock and final immediate stamp check,
   * same as config writes. No unstamped path.
   */
  async writeAsset(
    assetType: AssetDirectory,
    id: string,
    frontmatter: Record<string, unknown>,
    body: string,
    scope: "global" | "project",
    expectedHash: string,
  ): Promise<
    | { ok: true; contentHash: string }
    | { ok: false; kind: "invalid" | "stale" | "io" | "disposed"; message: string; errors?: readonly ValidationError[] }
  > {
    if (this.disposed) return { ok: false, kind: "disposed", message: "Service disposed" }
    if (scope === "project" && !this.hasProject) return this.projectAbsent()

    if (!isValidAssetId(id)) {
      return { ok: false, kind: "invalid", message: `Invalid asset ID "${id}": must be a single safe filename segment` }
    }

    const dir = scope === "global" ? this.paths.globalAssetDirs[assetType] : this.paths.projectAssetDirs![assetType]
    const filePath = path.join(dir, `${id}.md`)

    // Gap 7: Per-path write lock for assets (same as config writes)
    const prev = this.writeLocks.get(filePath) ?? Promise.resolve()
    const locked = prev.then(() => this.doWriteAsset(assetType, id, frontmatter, body, scope, filePath, expectedHash))
    this.writeLocks.set(filePath, locked)
    try {
      return await locked
    } catch (err) {
      return {
        ok: false,
        kind: this.disposed ? "disposed" : "io",
        message: `Asset write failed: ${String(err)}`,
      }
    } finally {
      if (this.writeLocks.get(filePath) === locked) {
        this.writeLocks.delete(filePath)
      }
    }
  }

  private async doWriteAsset(
    assetType: AssetDirectory,
    id: string,
    frontmatter: Record<string, unknown>,
    body: string,
    scope: "global" | "project",
    filePath: string,
    expectedHash: string,
  ): Promise<
    | { ok: true; contentHash: string }
    | { ok: false; kind: "invalid" | "stale" | "io" | "disposed"; message: string; errors?: readonly ValidationError[] }
  > {
    if (this.disposed) return { ok: false, kind: "disposed", message: "Service disposed" }
    const existing = readFile(filePath)

    const stampResult = this.checkAssetStamp(existing, filePath, expectedHash)
    if (stampResult) return stampResult

    const content = assembleAssetMarkdown(frontmatter, body)
    const validation = validateMarkdownAsset(content, assetType, filePath)
    if (!validation.valid) {
      return {
        ok: false,
        kind: "invalid",
        message: `Asset validation failed: ${validation.errors.map((e) => e.message).join("; ")}`,
        errors: validation.errors,
      }
    }

    // Gap 9: No empty catches — visible cleanup on failure
    try {
      const result = this.writeAssetFile(filePath, content, expectedHash)
      if (!result.ok) return result.value
    } catch (err) {
      // Structured error return — no rethrow from public mutation API
      const kind = this.disposed ? "disposed" : "io"
      return { ok: false, kind, message: `Asset write failed: ${String(err)}` }
    }

    const priorScan = this.lastAssetScan
    this.lastAssetScan = this.scanAssets()
    this.markOwnWrite(filePath, contentHash(content))

    // Bump revision and re-materialize through convergence scheduler (Finding 6)
    this.revision++
    try {
      await this.enqueueAndRunMaterialization("gui")
      if (this.disposed) throw new ConvergenceError("disposed", "Service disposed during asset convergence")
    } catch (err) {
      console.error(`[Kilo Config] Convergence failure during asset write: ${String(err)}`)
      this.lastAssetScan = priorScan
      const check = readFile(filePath)
      if (check.type === "present" && check.hash === contentHash(content)) {
        if (existing.type === "present") {
          const tmpRestore = `${filePath}.${process.pid}.restore.tmp`
          try {
            fs.writeFileSync(tmpRestore, existing.bytes, "utf-8")
            fs.renameSync(tmpRestore, filePath)
          } catch (restoreErr) {
            try {
              fs.unlinkSync(tmpRestore)
            } catch (cleanupErr) {
              console.error(`[Kilo Config] Asset restore cleanup failed for ${tmpRestore}: ${String(cleanupErr)}`)
            }
            console.error(`[Kilo Config] Asset prior bytes restore failed for ${filePath}: ${String(restoreErr)}`)
          }
        } else if (existing.type === "absent") {
          try {
            fs.unlinkSync(filePath)
          } catch (cleanupErr) {
            console.error(`[Kilo Config] Asset removal cleanup failed for ${filePath}: ${String(cleanupErr)}`)
          }
        }
      }
      // Correction 11: structured failure after conditional byte rollback,
      // never unconditional success after catch
      const kind = err instanceof ConvergenceError ? err.kind : this.disposed ? "disposed" : "io"
      return { ok: false, kind, message: `Convergence failure: ${String(err)}` }
    }

    return { ok: true, contentHash: contentHash(content) }
  }

  private writeAssetFile(
    filePath: string,
    content: string,
    expectedHash: string,
  ): { ok: true } | { ok: false; value: { ok: false; kind: "invalid" | "stale"; message: string } } {
    const tmp = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(tmp, content, "utf-8")
      this.beforeAssetFinalCas?.(filePath)
      const finalStamp = this.checkAssetFinalCas(filePath, expectedHash)
      if (finalStamp) {
        this.removeTemp(tmp, "Asset temp cleanup failed")
        return { ok: false, value: finalStamp }
      }
      fs.renameSync(tmp, filePath)
      return { ok: true }
    } catch (err) {
      this.removeTemp(tmp, "Asset temp cleanup failed")
      throw err
    }
  }

  private removeTemp(filePath: string, message: string): void {
    try {
      fs.unlinkSync(filePath)
    } catch (err) {
      console.error(`[Kilo Config] ${message} for ${filePath}: ${String(err)}`)
    }
  }

  /**
   * Check asset stamp validity (Finding 11). Returns a stale/invalid result
   * or null if the stamp check passes.
   */
  private checkAssetStamp(
    existing: FileReadResult,
    filePath: string,
    expectedHash: string,
  ): { ok: false; kind: "invalid" | "stale"; message: string } | null {
    if (existing.type === "absent") {
      if (expectedHash !== "absent") {
        return { ok: false, kind: "stale", message: `Asset file was deleted externally: ${filePath}` }
      }
      return null
    }
    if (existing.type === "failure") {
      return { ok: false, kind: "stale", message: `Asset file unreadable: ${filePath}: ${existing.message}` }
    }
    // existing.type === "present"
    if (expectedHash === "absent") {
      return { ok: false, kind: "stale", message: `Asset file already exists: ${filePath}` }
    }
    if (existing.hash !== expectedHash) {
      return {
        ok: false,
        kind: "stale",
        message: `Asset file was modified externally (expected ${expectedHash}, got ${existing.hash})`,
      }
    }
    return null
  }

  private checkAssetFinalCas(
    filePath: string,
    expectedHash: string,
  ): { ok: false; kind: "invalid" | "stale"; message: string } | null {
    return this.checkAssetStamp(readFile(filePath), filePath, expectedHash)
  }

  /**
   * Store a credential in SecretStorage and return the opaque ref.
   */
  async storeSecret(scope: "global" | "project", kind: "provider" | "mcp", id: string, value: string): Promise<string> {
    const ref = await storeCredential(this.secrets, scope, kind, id, value)
    return ref ?? `secret:${secretKey(scope, kind, id)}`
  }

  /**
   * Check if a credential ref exists without exposing the value.
   */
  async hasSecret(ref: string): Promise<boolean> {
    return hasCredential(this.secrets, ref)
  }

  /** Resolve an opaque credential reference inside the extension host only. */
  async resolveSecret(ref: string): Promise<string | undefined> {
    return retrieveCredential(this.secrets, ref)
  }

  /** Restore a credential to the exact opaque reference authored by its record. */
  async restoreSecret(ref: string, value: string): Promise<void> {
    await restoreCredentialRef(this.secrets, ref, value)
  }

  /**
   * Remove a credential from SecretStorage.
   */
  async removeSecret(scope: "global" | "project", kind: "provider" | "mcp", id: string): Promise<void> {
    await removeCredential(this.secrets, scope, kind, id)
  }

  async removeSecretRef(ref: string): Promise<void> {
    await removeCredentialRef(this.secrets, ref)
  }

  async cleanupProviderCredential(
    scope: "global" | "project",
    id: string,
    priorRecord: Record<string, unknown> | undefined,
    postWriteStamp: CanonicalStamp,
  ): Promise<
    | { ok: true }
    | {
        ok: false
        restored: boolean
        retry: boolean
        mode?: "delete" | "restore"
        message: string
        stamp: CanonicalStamp
        retryID: string
        ref?: string
        priorRecord?: Record<string, unknown>
        priorValue?: string
      }
  > {
    const priorRef =
      isRecord(priorRecord) && typeof priorRecord.credential === "string" ? priorRecord.credential : undefined
    // Cleanup may touch only the exact validated stored ref. When the prior
    // record carries no credential ref there is nothing verifiably owned to
    // remove — never reconstruct `secret:kilo.credentials.<scope>.provider.<id>`.
    if (!priorRef) {
      return { ok: true }
    }
    const owned = parseSecretKey(priorRef.slice("secret:".length))
    if (!owned || owned.kind !== "provider" || owned.id !== id || owned.scope !== scope) {
      return {
        ok: false,
        restored: false,
        retry: false,
        mode: "delete",
        message:
          "Prior provider credential ref is invalid; provider deletion remains committed and no credential was removed",
        stamp: this.stamp,
        retryID: `${scope}:${id}`,
        priorRecord,
      }
    }
    const ref = priorRef
    const priorValue = await this.readPriorSecret(priorRef)
    if (priorValue === undefined) {
      return {
        ok: false,
        restored: false,
        retry: true,
        mode: "delete",
        message: "Prior provider credential is unavailable; provider deletion remains committed",
        stamp: this.stamp,
        retryID: `${scope}:${id}`,
        ref,
        priorRecord,
      }
    }
    try {
      await this.removeSecretRef(ref)
      return { ok: true }
    } catch (err) {
      try {
        await this.restoreSecret(priorRef, priorValue)
      } catch (restoreErr) {
        return {
          ok: false,
          restored: false,
          retry: true,
          mode: "delete",
          message: `Provider deletion committed; prior credential restoration failed: ${String(restoreErr)}`,
          stamp: this.stamp,
          retryID: `${scope}:${id}`,
          ref,
          priorRecord,
          priorValue,
        }
      }
      if (!sameStamp(postWriteStamp, this.stamp))
        return this.rollbackRestoredProviderSecret(
          scope,
          id,
          priorRecord,
          priorRef,
          priorValue,
          `Provider cleanup became stale: ${String(err)}`,
        )
      const current = this.getScopeConfig(scope)
      const providers = isRecord(current.provider) ? { ...current.provider } : {}
      const expected = postWriteStamp[scope === "global" ? "globalHash" : "projectHash"] ?? "absent"
      const restored = await this.writeConfig(scope, { provider: { ...providers, [id]: priorRecord } }, expected)
      if (restored.ok)
        return {
          ok: false,
          restored: true,
          retry: false,
          mode: "restore",
          message: `Credential cleanup failed; prior provider record and secret were restored: ${String(err)}`,
          stamp: this.stamp,
          retryID: `${scope}:${id}`,
          ref,
        }
      return this.rollbackRestoredProviderSecret(
        scope,
        id,
        priorRecord,
        priorRef,
        priorValue,
        `Provider cleanup record restoration failed: ${restored.message}`,
      )
    }
  }

  /**
   * Remove an MCP credential after a successful config commit that removed the ref.
   * Uses the exact validated stored ref from the prior record — never reconstructs from
   * scope/kind/name. When the prior record carries no credential ref there is nothing
   * verifiably owned to remove.
   */
  async cleanupMcpCredential(
    scope: "global" | "project",
    name: string,
    priorRecord: Record<string, unknown> | undefined,
    postWriteStamp: CanonicalStamp,
  ): Promise<
    | { ok: true }
    | {
        ok: false
        restored: boolean
        retry: boolean
        mode?: "delete" | "restore"
        message: string
        stamp: CanonicalStamp
        retryID: string
        ref?: string
        priorRecord?: Record<string, unknown>
        priorValue?: string
      }
  > {
    const priorRef =
      isRecord(priorRecord) && typeof priorRecord.credential === "string" ? priorRecord.credential : undefined
    // Cleanup may touch only the exact validated stored ref. When the prior
    // record carries no credential ref there is nothing verifiably owned to
    // remove — never reconstruct `secret:kilo.credentials.<scope>.mcp.<name>`.
    if (!priorRef) {
      return { ok: true }
    }
    const owned = parseSecretKey(priorRef.slice("secret:".length))
    if (!owned || owned.kind !== "mcp" || owned.id !== name || owned.scope !== scope) {
      return {
        ok: false,
        restored: false,
        retry: false,
        mode: "delete",
        message: "Prior MCP credential ref is invalid; MCP deletion remains committed and no credential was removed",
        stamp: this.stamp,
        retryID: `${scope}:mcp:${name}`,
        priorRecord,
      }
    }
    const ref = priorRef
    const priorValue = await this.readPriorSecret(priorRef)
    if (priorValue === undefined) {
      return {
        ok: false,
        restored: false,
        retry: true,
        mode: "delete",
        message: "Prior MCP credential is unavailable; MCP deletion remains committed",
        stamp: this.stamp,
        retryID: `${scope}:mcp:${name}`,
        ref,
        priorRecord,
      }
    }
    try {
      await this.removeSecretRef(ref)
      return { ok: true }
    } catch (err) {
      try {
        await this.restoreSecret(priorRef, priorValue)
      } catch (restoreErr) {
        return {
          ok: false,
          restored: false,
          retry: true,
          mode: "delete",
          message: `MCP deletion committed; prior credential restoration failed: ${String(restoreErr)}`,
          stamp: this.stamp,
          retryID: `${scope}:mcp:${name}`,
          ref,
          priorRecord,
          priorValue,
        }
      }
      if (!sameStamp(postWriteStamp, this.stamp))
        return this.rollbackRestoredMcpSecret(
          scope,
          name,
          priorRecord,
          priorRef,
          priorValue,
          `MCP cleanup became stale: ${String(err)}`,
        )
      const current = this.getScopeConfig(scope)
      const mcps = isRecord(current.mcp) ? { ...current.mcp } : {}
      const expected = postWriteStamp[scope === "global" ? "globalHash" : "projectHash"] ?? "absent"
      const restored = await this.writeConfig(scope, { mcp: { ...mcps, [name]: priorRecord } }, expected)
      if (restored.ok)
        return {
          ok: false,
          restored: true,
          retry: false,
          mode: "restore",
          message: `Credential cleanup failed; prior MCP record and secret were restored: ${String(err)}`,
          stamp: this.stamp,
          retryID: `${scope}:mcp:${name}`,
          ref,
        }
      return this.rollbackRestoredMcpSecret(
        scope,
        name,
        priorRecord,
        priorRef,
        priorValue,
        `MCP cleanup record restoration failed: ${restored.message}`,
      )
    }
  }

  private async rollbackRestoredMcpSecret(
    scope: "global" | "project",
    name: string,
    priorRecord: Record<string, unknown> | undefined,
    ref: string,
    value: string,
    message: string,
  ): Promise<{
    ok: false
    restored: boolean
    retry: boolean
    mode: "delete" | "restore"
    message: string
    stamp: CanonicalStamp
    retryID: string
    ref?: string
    priorRecord?: Record<string, unknown>
    priorValue?: string
  }> {
    try {
      await this.removeSecretRef(ref)
      return {
        ok: false,
        restored: false,
        retry: true,
        mode: "delete",
        message,
        stamp: this.stamp,
        retryID: `${scope}:mcp:${name}`,
        ref,
        priorRecord,
        priorValue: value,
      }
    } catch (error) {
      return {
        ok: false,
        restored: true,
        retry: true,
        mode: "restore",
        message: `${message}; cleanup rollback failed: ${String(error)}`,
        stamp: this.stamp,
        retryID: `${scope}:mcp:${name}`,
        ref,
        priorRecord,
        priorValue: value,
      }
    }
  }

  private async rollbackRestoredProviderSecret(
    scope: "global" | "project",
    id: string,
    priorRecord: Record<string, unknown> | undefined,
    ref: string,
    value: string,
    message: string,
  ): Promise<{
    ok: false
    restored: boolean
    retry: boolean
    mode: "delete" | "restore"
    message: string
    stamp: CanonicalStamp
    retryID: string
    ref?: string
    priorRecord?: Record<string, unknown>
    priorValue?: string
  }> {
    try {
      await this.removeSecretRef(ref)
      return {
        ok: false,
        restored: false,
        retry: true,
        mode: "delete",
        message,
        stamp: this.stamp,
        retryID: `${scope}:${id}`,
        ref,
        priorRecord,
        priorValue: value,
      }
    } catch (error) {
      return {
        ok: false,
        restored: true,
        retry: true,
        mode: "restore",
        message: `${message}; cleanup rollback failed: ${String(error)}`,
        stamp: this.stamp,
        retryID: `${scope}:${id}`,
        ref,
        priorRecord,
        priorValue: value,
      }
    }
  }

  private async readPriorSecret(ref: string): Promise<string | undefined> {
    try {
      return await this.resolveSecret(ref)
    } catch (error) {
      console.error(`[Kilo Config] Prior credential retrieval failed for ${ref}: ${String(error)}`)
      return undefined
    }
  }

  /**
   * List all stored provider IDs for a scope.
   */
  async listStoredProviders(scope: "global" | "project"): Promise<Set<string>> {
    return listStoredCredentialIds(this.secrets, scope, "provider")
  }

  /**
   * Candidate-processing API: accepts GUI credential intent, stores secret
   * first, returns a canonical ref, commits config, and rolls back
   * newly-created/changed owned secret if config commit fails (Blocker 8).
   * Captures prior secret value; on exception, restores prior or deletes new.
   */
  async processCredentialIntent(
    scope: "global" | "project",
    kind: "provider" | "mcp",
    id: string,
    plaintext: string,
    configPatch: Record<string, unknown>,
    expectedHash: string,
    stamp?: CanonicalStamp,
    priorRef?: string,
  ): Promise<
    | { ok: true; snapshot: ConfigSnapshot; ref: string }
    | { ok: false; kind: "stale" | "invalid" | "disposed" | "io"; message: string; errors?: readonly ValidationError[] }
  > {
    if (this.disposed) return { ok: false, kind: "disposed", message: "Service disposed" }

    const newKey = secretKey(scope, kind, id)
    const newRef = `secret:${newKey}`

    // Validate priorRef against expected scope/kind/id. Only the exact
    // validated prior canonical credential ref is used for prior reads and
    // rollback — never a reconstructed derived key.
    let validatedPriorRef: string | undefined
    if (priorRef) {
      const parsed = parseOwnedCredentialRef(priorRef)
      if (parsed && parsed.scope === scope && parsed.kind === kind && parsed.id === id) {
        validatedPriorRef = priorRef
      }
      // Invalid/cross-scope/cross-kind ref: treat as no prior (do not read
      // an orphaned derived key).
    }

    // Capture prior secret value from the exact validated prior ref (Blocker 8).
    // If no valid prior ref, there is no verifiable prior secret.
    let priorValue: string | undefined
    if (validatedPriorRef) {
      try {
        priorValue = await retrieveCredential(this.secrets, validatedPriorRef)
      } catch (err) {
        console.error(`[Kilo Config] Credential retrieval failed for ${validatedPriorRef}: ${String(err)}`)
        return {
          ok: false,
          kind: this.disposed ? "disposed" : "io",
          message: `Credential retrieval failed: ${String(err)}`,
        }
      }
    }

    let attempted = false
    try {
      // Store the secret first
      attempted = true
      await storeCredential(this.secrets, scope, kind, id, plaintext)

      // Try to commit config
      if (stamp && (!sameStamp(stamp, this.stamp) || stamp.assetHash !== null)) {
        const rollback = await this.rollbackCredential(newRef, priorValue)
        if (rollback) return rollback
        return { ok: false, kind: "stale", message: "Canonical config materialization is stale" }
      }
      const result = await this.writeConfig(scope, configPatch, expectedHash)

      if (!result.ok) {
        // Roll back: restore prior value or delete if no prior (Blocker 8)
        const rollback = await this.rollbackCredential(newRef, priorValue)
        if (rollback) return rollback
        return this.normalizeCredentialFailure(result)
      }

      return { ok: true, snapshot: result.snapshot, ref: newRef }
    } catch (err) {
      // Exception: restore prior value or delete if no prior (Blocker 8)
      console.error(`[Kilo Config] Credential intent failed for ${newRef}: ${String(err)}`)
      if (attempted) {
        const rollback = await this.rollbackCredential(newRef, priorValue)
        if (rollback) return rollback
      }
      return { ok: false, kind: this.disposed ? "disposed" : "io", message: `Credential intent failed: ${String(err)}` }
    }
  }

  /**
   * Remove a credential after a successful config commit that removed the ref.
   * Only removes owned secrets.
   */
  async removeCredentialAfterCommit(scope: "global" | "project", kind: "provider" | "mcp", id: string): Promise<void> {
    await removeCredential(this.secrets, scope, kind, id)
  }

  /**
   * Build a provider index from the current materialization.
   * Credential status is derived from each record's exact `credential` ref
   * via parseOwnedCredentialRef — never from a SecretStorage prefix scan.
   */
  buildProviderIndex(existingSelectedId: string | null = null): ProviderIndex | null {
    if (!this.currentSnapshot) return null
    return buildProviderIndex(this.currentSnapshot, existingSelectedId)
  }

  /**
   * Build a provider index with pre-computed credential status (async).
   * Reads each provider record's exact credential ref from the materialization
   * and validates it against SecretStorage — no prefix scan.
   */
  async buildProviderIndexAsync(existingSelectedId: string | null = null): Promise<ProviderIndex | null> {
    if (!this.currentSnapshot) return null
    const credentialStatus = await this.computeProviderCredentialStatus(this.currentSnapshot)
    return buildProviderIndex(this.currentSnapshot, existingSelectedId, credentialStatus)
  }

  /**
   * Build an agent index from agent entries.
   */
  buildAgentIndex(
    agentEntries: Array<{
      id: string
      displayName: string
      description?: string
      mode?: "primary" | "secondary" | "specialized"
      hidden?: boolean
      color?: string
      source: "global" | "project"
    }>,
    existingSelectedId: string | null = null,
  ): AgentIndex | null {
    if (!this.currentSnapshot) return null
    return buildAgentIndex(this.currentSnapshot, agentEntries, existingSelectedId)
  }

  /**
   * Build a model index from the current materialization.
   */
  buildModelIndex(
    scope: "global" | "project",
    existingSelectedModel: string | null = null,
    existingSelectedVariant: string | null = null,
  ): ModelIndex | null {
    if (!this.currentSnapshot) return null
    return buildModelIndex(this.currentSnapshot, scope, existingSelectedModel, existingSelectedVariant)
  }

  /**
   * Build a provider index from an explicit snapshot (for transactional publication).
   * Used by persistIndexes which runs before this.currentSnapshot is assigned.
   * Credential status is derived from each record's exact credential ref.
   */
  private async buildProviderIndexAsyncFromSnapshot(snapshot: ConfigSnapshot): Promise<ProviderIndex | null> {
    const credentialStatus = await this.computeProviderCredentialStatus(snapshot)
    return buildProviderIndex(snapshot, this.persistedAgentIndex?.selectedId ?? null, credentialStatus)
  }

  /**
   * Compute per-provider credential status from each record's exact credential ref.
   * Reads the ref from the materialized config and validates against SecretStorage.
   * No prefix scan — each status traces to a validated canonical record ref.
   */
  private async computeProviderCredentialStatus(snapshot: ConfigSnapshot): Promise<Map<string, boolean>> {
    return computeCredentialStatus(snapshot, this.secrets)
  }

  /**
   * Build a model index from an explicit snapshot (for transactional publication).
   * Used by persistIndexes which runs before this.currentSnapshot is assigned.
   */
  private buildModelIndexFromSnapshot(snapshot: ConfigSnapshot, scope: "global" | "project"): ModelIndex | null {
    return buildModelIndex(snapshot, scope, null, null)
  }

  /**
   * Get the content hash for a scope's config file (for draft stamps).
   */
  getConfigHash(scope: "global" | "project"): string | null {
    return scope === "global" ? this.globalHash : this.projectHash
  }

  get stamp(): CanonicalStamp {
    return stampView(this.globalHash, this.projectHash, this.currentSnapshot?.generation ?? 0)
  }

  getAssetStamp(assetType: AssetDirectory, id: string, scope: "global" | "project"): string {
    return assetStampView(this.paths, this.hasProject, assetType, id, scope)
  }

  readAsset(
    assetType: AssetDirectory,
    id: string,
    scope: "global" | "project",
  ):
    | { ok: true; frontmatter: Record<string, unknown>; body: string; contentHash: string }
    | { ok: false; message: string } {
    return readAssetView(this.paths, this.hasProject, assetType, id, scope)
  }

  async deleteAsset(
    assetType: AssetDirectory,
    id: string,
    scope: "global" | "project",
    expectedHash: string,
  ): Promise<
    { ok: true; contentHash: "absent" } | { ok: false; kind: "invalid" | "stale" | "io" | "disposed"; message: string }
  > {
    if (this.disposed) return { ok: false, kind: "disposed", message: "Service disposed" }
    if (scope === "project" && !this.hasProject) return this.projectAbsent()
    if (!isValidAssetId(id)) return { ok: false, kind: "invalid", message: `Invalid asset ID "${id}"` }
    const dir = scope === "global" ? this.paths.globalAssetDirs[assetType] : this.paths.projectAssetDirs![assetType]
    const filePath = path.join(dir, `${id}.md`)
    const prev = this.writeLocks.get(filePath) ?? Promise.resolve()
    const locked = prev.then(async () => {
      const existing = readFile(filePath)
      const stamp = this.checkAssetStamp(existing, filePath, expectedHash)
      if (stamp) return stamp
      if (existing.type === "absent") return { ok: true as const, contentHash: "absent" as const }
      try {
        fs.unlinkSync(filePath)
        this.lastAssetScan = this.scanAssets()
        this.markOwnWrite(filePath, "absent")
        this.revision++
        await this.enqueueAndRunMaterialization("gui")
        if (this.disposed)
          return { ok: false as const, kind: "disposed" as const, message: "Service disposed during asset convergence" }
        return { ok: true as const, contentHash: "absent" as const }
      } catch (err) {
        try {
          if (existing.type === "present") {
            fs.mkdirSync(path.dirname(filePath), { recursive: true })
            fs.writeFileSync(filePath, existing.bytes, "utf-8")
            this.lastAssetScan = this.scanAssets()
          }
        } catch (restoreErr) {
          console.error(`[Kilo Config] Asset delete rollback failed for ${filePath}: ${String(restoreErr)}`)
        }
        return {
          ok: false as const,
          kind: this.disposed ? ("disposed" as const) : ("io" as const),
          message: `Asset delete failed: ${String(err)}`,
        }
      }
    })
    this.writeLocks.set(filePath, locked)
    try {
      return await locked
    } finally {
      if (this.writeLocks.get(filePath) === locked) this.writeLocks.delete(filePath)
    }
  }

  /** Return the authored canonical document for a GUI draft, never backend config. */
  getScopeConfig(scope: "global" | "project"): Record<string, unknown> {
    if (scope === "project" && !this.hasProject) return {}
    const filePath = scope === "global" ? this.paths.globalConfigFile : this.paths.projectConfigFile!
    return scopeConfigView(readFile(filePath))
  }

  /**
   * Get the last asset scan result.
   */
  get assetScan(): AssetScanResult | null {
    return this.lastAssetScan
  }

  /** Get rehydrated provider index for immediate UI presentation. */
  get providerIndex(): ProviderIndex | null {
    return this.rehydratedProviderIndex
  }

  /** Get rehydrated agent index for immediate UI presentation. */
  get agentIndex(): AgentIndex | null {
    return this.rehydratedAgentIndex ?? this.persistedAgentIndex
  }

  /** Get rehydrated global model index for immediate UI presentation. */
  get globalModelIndex(): ModelIndex | null {
    return this.rehydratedGlobalModelIndex
  }

  /** Get rehydrated project model index for immediate UI presentation. */
  get projectModelIndex(): ModelIndex | null {
    return this.rehydratedProjectModelIndex
  }

  /**
   * Process a single asset file during scan. Returns the scan entry if valid,
   * null if the file should be skipped. Pushes errors for invalid files.
   * Gap 3: Retains prior entry for malformed/unreadable replacements.
   */
  private processAssetFile(
    filePath: string,
    dirName: string,
    scope: "global" | "project",
    raw: Extract<FileReadResult, { type: "present" | "failure" }>,
    priorByPath: Map<string, AssetScanEntry>,
  ): { entry: AssetScanEntry; error?: undefined } | { entry?: undefined; error: true } {
    const id = path.basename(filePath).replace(/\.md$/, "")

    if (raw.type === "failure") {
      this.assetErrors.push({
        path: ["asset", dirName, scope, id],
        message: `Cannot read asset ${filePath}: ${raw.message}`,
        scope,
        file: filePath,
      })
      const prior = priorByPath.get(filePath)
      if (prior) return { entry: prior }
      return { error: true }
    }

    // raw.type === "present" here
    const validation = validateMarkdownAsset(raw.bytes, dirName as any, filePath)
    if (!validation.valid) {
      this.assetErrors.push(...validation.errors)
      const prior = priorByPath.get(filePath)
      if (prior) return { entry: prior }
      return { error: true }
    }

    // Gap 3: Check YAML Document.errors that schema validation may not surface
    if (!this.checkYamlErrors(raw.bytes, filePath, dirName, scope, id)) {
      const prior = priorByPath.get(filePath)
      if (prior) return { entry: prior }
      return { error: true }
    }

    // Capture validated frontmatter for index building (Correction 5)
    const parsed = parseMarkdown(raw.bytes)
    return { entry: { id, filePath, contentHash: raw.hash, scope, frontmatter: parsed.data, body: parsed.content } }
  }

  /** Temp array for errors during scanAssets. Reset each call. */
  private assetErrors: ValidationError[] = []

  /**
   * Gap 3: Check YAML frontmatter for parse errors that Zod schema validation
   * may not surface (e.g. incomplete flow sequences). Returns true if no errors.
   */
  private checkYamlErrors(
    bytes: string,
    filePath: string,
    dirName: string,
    scope: "global" | "project",
    id: string,
  ): boolean {
    try {
      const { parseDocument: yamlParseDoc } = require("yaml")
      const fmMatch = bytes.match(/^---\r?\n([\s\S]*?)\r?\n---/)
      if (!fmMatch) return true
      const doc = yamlParseDoc(fmMatch[1])
      if (!doc.errors || doc.errors.length === 0) return true
      for (const e of doc.errors) {
        this.assetErrors.push({
          path: ["asset", dirName, scope, id],
          message: `YAML parse error in ${filePath}: ${e.message}`,
          scope,
          file: filePath,
        })
      }
      return false
    } catch (yamlErr) {
      console.error(`[Kilo Config] YAML library not available for extra error check: ${String(yamlErr)}`)
      return true
    }
  }

  /**
   * Scan all six asset directories in both scopes.
   * One stable ID per asset type; duplicate IDs across scopes or files are
   * validation conflicts. Distinguishes ENOENT from errors (Blocker 12).
   *
   * Gap 3: Tracks prior valid entries by canonical path/type/ID.
   * A malformed/unreadable replacement retains the prior entry and marks
   * index stale/invalid; valid deletion removes it; valid add/change replaces it.
   */
  scanAssets(): AssetScanResult {
    const priorScan = this.lastAssetScan
    const entries: AssetScanEntry[] = []
    const errors: ValidationError[] = []
    this.assetErrors = errors
    const duplicateIds: {
      type: AssetDirectory
      id: string
      scopeA: string
      scopeB: string
      fileA: string
      fileB: string
    }[] = []
    const seenIds = new Map<string, AssetScanEntry>()

    for (const dirName of ASSET_DIRECTORIES) {
      for (const scope of ["global", "project"] as const) {
        if (scope === "project" && !this.hasProject) continue
        const dir = scope === "global" ? this.paths.globalAssetDirs[dirName] : this.paths.projectAssetDirs![dirName]

        // Ensure directory exists
        try {
          fs.mkdirSync(dir, { recursive: true })
        } catch (err) {
          console.error(`[Kilo Config] Failed to create asset directory ${dir}: ${String(err)}`)
        }

        const priorDirEntries = priorScan
          ? priorScan.entries.filter((e) => e.scope === scope && sameCanonicalPath(path.dirname(e.filePath), dir))
          : []
        const priorByPath = new Map(priorDirEntries.map((e) => [e.filePath, e]))
        const add = (entry: AssetScanEntry): void => {
          const existing = seenIds.get(`${dirName}:${entry.id}`)
          if (existing) {
            duplicateIds.push({
              type: dirName,
              id: entry.id,
              scopeA: existing.scope,
              scopeB: entry.scope,
              fileA: existing.filePath,
              fileB: entry.filePath,
            })
          } else {
            seenIds.set(`${dirName}:${entry.id}`, entry)
          }
          entries.push(entry)
        }

        // Read all .md files in the directory
        let files: string[]
        try {
          files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"))
        } catch (err: any) {
          if (err?.code !== "ENOENT") {
            errors.push({
              path: ["asset", dirName, scope],
              message: `Cannot read asset directory ${dir}: ${err?.message ?? String(err)}`,
              scope,
              file: dir,
            })
            for (const prior of priorDirEntries) add(prior)
          }
          files = []
        }

        for (const file of files) {
          const filePath = path.join(dir, file)
          const raw = readFile(filePath)
          if (raw.type === "absent") continue

          const result = this.processAssetFile(filePath, dirName, scope, raw, priorByPath)
          if (result.entry) add(result.entry)
        }
      }
    }

    this.assetErrors = []
    return { entries, errors, duplicateIds }
  }

  /**
   * Gap 5: Pending materialization promises tracked for settle-on-dispose.
   * Each entry is { resolve, reject, rev } — dispose settles them with
   * a structured disposed error; the promise returned by
   * enqueueAndRunMaterialization rejects instead of hanging.
   */
  private pendingMaterializations: Array<{
    resolve: () => void
    reject: (err: Error) => void
    rev: number
  }> = []

  /**
   * Dispose all watchers and resources.
   * Gap 5: Settles queued promises with structured disposed error.
   * Gap 6: Prevents future resource creation/publication.
   * Clears the event queue to prevent late publication (Finding 6/7).
   */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true

    // P4.1: Clear successful-materialization state so a disposed service
    // never appears ready to late subscribers.
    this.successfulMaterializationStamp = null

    // Gap 5: Settle all pending materialization promises.
    // Resolve (not reject) to prevent unhandled rejection for fire-and-forget callers
    // (e.g. watcher events). The disposed state is checked at the start of each queue task
    // and in materializeFromDisk, so resolved callers will early-return.
    for (const pending of this.pendingMaterializations) {
      pending.resolve()
    }
    this.pendingMaterializations.length = 0

    // Cancel pending debounce timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer)
    }
    this.debounceTimers.clear()

    // Fixture seed bounded waits are cancellable via the disposed flag
    // checked on every 50ms poll iteration. No additional timer bookkeeping
    // is required — pending 50ms sleeps resolve naturally and observe disposal.

    // Dispose all file watchers
    for (const w of this.watchers) {
      w.dispose()
    }
    this.watchers.length = 0

    // Clear event queue to prevent late publication
    this.eventQueue.length = 0

    this.ownWriteHashes.clear()
    this.writeLocks.clear()

    this.onChangeEmitter.dispose()
    this.onErrorEmitter.dispose()
  }

  // ── Internal ───────────────────────────────────────────────────────

  /**
   * Rehydrate persisted indexes from state adapters.
   * Rehydrated indexes are not authoritative materializations; they
   * provide immediate presentation data while we reconcile disk state.
   */
  private rehydrateIndexes(): void {
    // Rehydrate for immediate UI presentation (Blocker 3).
    // Materialization reconciles and re-persists with current disk state.
    if (this.globalState) {
      this.rehydratedProviderIndex = rehydrateProviderIndex(this.globalState)
      this.rehydratedGlobalModelIndex = rehydrateModelIndex(this.globalState, "global")
    }
    if (this.workspaceState) {
      this.rehydratedAgentIndex = rehydrateAgentIndex(this.workspaceState)
      this.rehydratedProjectModelIndex = rehydrateModelIndex(this.workspaceState, "project")
    }
  }

  /**
   * Materialize from disk files. Called on init, after writes, and on watcher events.
   * On any read/parse/schema/validation/I/O failure, preserves the exact prior
   * valid MaterializedConfig and emits change/error with structured diagnostics.
   * ENOENT alone is legal absence/deletion.
   *
   * When expectedRevision is provided, checks before publishing whether a newer
   * revision has been committed. Stale materializations return without publishing
   * (Finding 6 — latest-revision convergence scheduler).
   */
  private async materializeFromDisk(source: "init" | "gui" | "external", expectedRevision?: number): Promise<void> {
    if (this.disposed) return

    // P4.1: Clear readiness BEFORE any read/validation/error path can fire.
    // The latest materialization is not error-free until the entire pass
    // succeeds (read + validate + materialize + persist + publish).
    this.successfulMaterializationStamp = null

    const globalResult = this.readScopeContent("global")
    const projectResult = this.readScopeContent("project")

    const hasInvalid = globalResult.type === "invalid" || projectResult.type === "invalid"
    if (hasInvalid) {
      try {
        await this.handleInvalidMaterialization(source, globalResult, projectResult)
      } catch (err) {
        if (source !== "init") throw this.asConvergenceError(err)
        console.error(`[Kilo Config] Initial diagnostic persistence failed: ${String(err)}`)
      }
      return
    }

    const input: MaterializeInput = {
      global: globalResult.type === "valid" ? globalResult.content : null,
      project: projectResult.type === "valid" ? projectResult.content : null,
      versionCounter: this.versionCounter,
    }

    const result = materialize(input, this.current)

    const candidateGlobalHash = globalResult.type === "valid" ? globalResult.hash : null
    const candidateProjectHash = projectResult.type === "valid" ? projectResult.hash : null
    const candidateConfig = result.config
    const candidateSnapshot = makeSnapshot(result.config)

    if (expectedRevision !== undefined && this.revision > expectedRevision) return

    const priorSnapshot = this.capturePriorState()
    try {
      await this.persistIndexes(candidateSnapshot, result.errors)
    } catch (persistErr) {
      this.restorePriorState(priorSnapshot)
      console.error(`[Kilo Config] Index persistence failed: ${String(persistErr)}`)
      this.onErrorEmitter.fire({
        kind: "invalid",
        message: `Index persistence failed: ${String(persistErr)}`,
        errors: [],
      })
      if (source !== "init") throw this.asConvergenceError(persistErr)
      return
    }

    if (this.disposed) return
    if (expectedRevision !== undefined && this.revision > expectedRevision) return

    this.globalHash = candidateGlobalHash
    this.projectHash = candidateProjectHash
    this.current = candidateConfig
    this.currentSnapshot = candidateSnapshot

    // P4.1: Record successful materialization stamp only on error-free
    // materialization. Snapshot existence alone is insufficient evidence;
    // errored materializations may produce a snapshot.
    if (result.errors.length === 0) {
      this.successfulMaterializationStamp = this.stamp
    }

    this.onChangeEmitter.fire({
      snapshot: this.currentSnapshot,
      source,
      hasErrors: result.errors.length > 0,
      errors: result.errors,
      stamp: this.stamp,
    })
    if (result.errors.length > 0) {
      this.onErrorEmitter.fire({
        kind: "invalid",
        message: `Materialization had ${result.errors.length} validation error(s)`,
        errors: result.errors,
      })
    }
  }

  private asConvergenceError(err: unknown): ConvergenceError {
    if (err instanceof ConvergenceError) return err
    return new ConvergenceError(this.disposed ? "disposed" : "io", String(err))
  }

  private async handleInvalidMaterialization(
    source: "init" | "gui" | "external",
    globalResult: ReturnType<typeof this.readScopeContent>,
    projectResult: ReturnType<typeof this.readScopeContent>,
  ): Promise<void> {
    const allErrors: ValidationError[] = [
      ...(globalResult.type === "invalid" ? globalResult.errors : []),
      ...(projectResult.type === "invalid" ? projectResult.errors : []),
    ]

    if (this.current) {
      // Invalid with prior: preserve materialization, persist stale/invalid diagnostics
      await this.persistDiagnosticIndexes()
      if (this.disposed) return
      this.onChangeEmitter.fire({
        snapshot: this.currentSnapshot!,
        source,
        hasErrors: true,
        errors: allErrors,
        stamp: this.stamp,
      })
      return
    }

    // Invalid without prior: emit diagnostics, persist stale/invalid indexes
    this.onErrorEmitter.fire({
      kind: "init-failure",
      message: `Initial load failed: ${allErrors.length} validation error(s)`,
      errors: allErrors,
    })
    await this.persistDiagnosticIndexes()
  }

  /**
   * Read and parse a scoped config file using discriminated result (Blocker 1).
   * Returns { type: "absent" } for ENOENT (legal absence/deletion).
   * Returns { type: "invalid", errors } for parse/validation failures.
   * Returns { type: "valid", content } for successfully parsed files.
   * Non-ENOENT failures preserve prior snapshot/index and emit diagnostics (Blocker 2).
   */
  private readScopeContent(
    scope: "global" | "project",
  ):
    | { type: "valid"; content: ScopedContent; hash: string }
    | { type: "absent" }
    | { type: "invalid"; errors: readonly ValidationError[] } {
    if (scope === "project" && !this.hasProject) return { type: "absent" }
    const filePath = scope === "global" ? this.paths.globalConfigFile : this.paths.projectConfigFile!
    const raw = readFile(filePath)

    // ENOENT is legal absence — no error (Blocker 1)
    if (raw.type === "absent") return { type: "absent" }

    // Non-ENOENT failure: emit diagnostics, preserve prior (Blocker 2)
    if (raw.type === "failure") {
      const err: ValidationError = {
        path: [],
        message: `File read error: ${raw.code} — ${raw.message}`,
        scope,
        file: filePath,
      }
      this.onErrorEmitter.fire({
        kind: "invalid",
        message: `Cannot read ${scope} config at ${filePath}: ${raw.message}`,
        errors: [err],
      })
      return { type: "invalid", errors: [err] }
    }

    const validation = validateConfig(raw.bytes, scope, filePath)
    if (!validation.valid || !validation.parsed) {
      // Validation failure: emit diagnostics, preserve prior valid (Blocker 2)
      this.onErrorEmitter.fire({
        kind: "invalid",
        message: `Invalid ${scope} config at ${filePath}`,
        errors: validation.errors,
      })
      return { type: "invalid", errors: validation.errors }
    }

    return {
      type: "valid",
      hash: raw.hash,
      content: {
        scope,
        root: scope === "global" ? this.paths.globalRoot : this.paths.projectRoot!,
        raw: validation.parsed,
        provenance: {
          scope,
          canonicalPath: filePath,
          explicit: true,
          operator: "single",
        },
      },
    }
  }

  /**
   * Persist derived indexes to state adapters.
   * Provider/model global facts go globalState; composed/project agent
   * and project model facts go workspaceState.
   *
   * Finding 3: After successful persistence, replaces rehydrated fields
   * with the freshly reconciled data so getters return authoritative state.
   *
   * Finding 4: Agent index is rebuilt and persisted on every call, including
   * empty scan results (empty deletion). Malformed/unreadable assets preserve
   * prior entries and mark stale/invalid.
   */
  private async persistIndexes(snapshot: ConfigSnapshot, errors?: readonly ValidationError[]): Promise<void> {
    if (!snapshot) return

    const isInvalid = errors !== undefined && errors.length > 0
    const isNoPriorInvalid = isInvalid && !this.lastValidMaterializationExists()

    const priorState = this.capturePersistState()
    const writtenKeys: Array<{ state: StateAdapter; key: string; prior: unknown }> = []

    try {
      await this.persistProviderIndexes(snapshot, isNoPriorInvalid, writtenKeys)
      await this.persistModelIndexes(snapshot, isNoPriorInvalid, writtenKeys)
      await this.persistAgentIndexFromSnapshot(snapshot, isNoPriorInvalid, writtenKeys)
      if (this.disposed) throw new ConvergenceError("disposed", "Service disposed during index persistence")
    } catch (err) {
      await this.rollbackPersistKeys(writtenKeys)
      this.restorePersistState(priorState)
      throw err
    }
  }

  private async persistProviderIndexes(
    snapshot: ConfigSnapshot,
    markStale: boolean,
    writtenKeys: Array<{ state: StateAdapter; key: string; prior: unknown }>,
  ): Promise<void> {
    const idx = await this.buildProviderIndexAsyncFromSnapshot(snapshot)
    if (!idx || !this.globalState) return
    const final = markStale ? markIndexStale(idx) : idx
    // Capture prior state key BEFORE persist for correct rollback on failure
    writtenKeys.push({
      state: this.globalState,
      key: STATE_KEYS.providers,
      prior: this.globalState.get(STATE_KEYS.providers),
    })
    await persistProviderIndex(this.globalState, final)
    this.rehydratedProviderIndex = final
  }

  private async persistModelIndexes(
    snapshot: ConfigSnapshot,
    markStale: boolean,
    writtenKeys: Array<{ state: StateAdapter; key: string; prior: unknown }>,
  ): Promise<void> {
    for (const scope of ["global", "project"] as const) {
      const state = scope === "global" ? this.globalState : this.workspaceState
      if (!state) continue
      const idx = this.buildModelIndexFromSnapshot(snapshot, scope)
      if (!idx) continue
      const final = markStale
        ? (markIndexStale(idx as ModelIndex & { readonly diagnostics: SelectorDiagnostics }) as ModelIndex)
        : idx
      const key = scope === "global" ? STATE_KEYS.globalModel : STATE_KEYS.projectModel
      // Capture prior state key BEFORE persist for correct rollback on failure
      writtenKeys.push({ state, key, prior: state.get(key) })
      await persistModelIndex(state, final, scope)
      if (scope === "global") this.rehydratedGlobalModelIndex = final
      else this.rehydratedProjectModelIndex = final
    }
  }

  private async persistAgentIndexFromSnapshot(
    snapshot: ConfigSnapshot,
    markStale: boolean,
    writtenKeys: Array<{ state: StateAdapter; key: string; prior: unknown }>,
  ): Promise<void> {
    const entries = this.lastAssetScan ? this.buildAgentEntriesFromScan(this.lastAssetScan) : []
    const idx = buildAgentIndex(snapshot, entries, this.persistedAgentIndex?.selectedId ?? null)
    const scanInvalid = this.lastAssetScan !== null && this.lastAssetScan.errors.length > 0
    const duplicates = (this.lastAssetScan?.duplicateIds ?? []).filter((item) => item.type === "agent")
    const conflicts = duplicates.map((item) => ({
      field: `agent.${item.id}`,
      scopes: [item.scopeA, item.scopeB] as ("global" | "project")[],
      message: `Duplicate agent ID "${item.id}" across ${item.scopeA} and ${item.scopeB}`,
      id: item.id,
    }))
    const diagnosed =
      conflicts.length > 0
        ? {
            ...idx,
            diagnostics: {
              ...idx.diagnostics,
              invalid: true,
              stale: true,
              conflicts: [...idx.diagnostics.conflicts, ...conflicts],
            },
          }
        : idx
    const final =
      markStale || scanInvalid || conflicts.length > 0 ? (markIndexStale(diagnosed) as AgentIndex) : diagnosed
    this.persistedAgentIndex = final
    if (this.workspaceState) {
      // Capture prior state key BEFORE persist for correct rollback on failure
      writtenKeys.push({
        state: this.workspaceState,
        key: STATE_KEYS.agents,
        prior: this.workspaceState.get(STATE_KEYS.agents),
      })
      await persistAgentIndex(this.workspaceState, final)
    }
    this.rehydratedAgentIndex = final
  }

  private capturePersistState() {
    return {
      providerIndex: this.rehydratedProviderIndex,
      agentIndex: this.rehydratedAgentIndex,
      globalModelIndex: this.rehydratedGlobalModelIndex,
      projectModelIndex: this.rehydratedProjectModelIndex,
      persistedAgentIndex: this.persistedAgentIndex,
    }
  }

  private restorePersistState(prior: ReturnType<typeof this.capturePersistState>): void {
    this.rehydratedProviderIndex = prior.providerIndex
    this.rehydratedAgentIndex = prior.agentIndex
    this.rehydratedGlobalModelIndex = prior.globalModelIndex
    this.rehydratedProjectModelIndex = prior.projectModelIndex
    this.persistedAgentIndex = prior.persistedAgentIndex
  }

  private async rollbackPersistKeys(
    writtenKeys: Array<{ state: StateAdapter; key: string; prior: unknown }>,
  ): Promise<void> {
    for (const { state, key, prior } of writtenKeys) {
      await state.update(key, prior !== undefined ? prior : undefined)
    }
  }

  /**
   * Gap 1: Persist diagnostic-only indexes when no prior valid materialization
   * exists and the initial load failed. Retains prior persisted entries and
   * marks them stale/invalid with structured reasons. Does NOT create
   * current materialization or snapshot.
   */
  private async persistDiagnosticIndexes(): Promise<void> {
    const priorState = this.capturePersistState()
    const writtenKeys: Array<{ state: StateAdapter; key: string; prior: unknown }> = []

    try {
      // Mark every rehydrated index as stale/invalid with structured reason
      if (this.rehydratedProviderIndex && this.globalState) {
        const marked = markIndexStale(this.rehydratedProviderIndex)
        writtenKeys.push({
          state: this.globalState,
          key: STATE_KEYS.providers,
          prior: this.globalState.get(STATE_KEYS.providers),
        })
        await persistProviderIndex(this.globalState, marked)
        this.rehydratedProviderIndex = marked
      }
      if (this.rehydratedGlobalModelIndex && this.globalState) {
        const marked = markIndexStale(
          this.rehydratedGlobalModelIndex as ModelIndex & { readonly diagnostics: SelectorDiagnostics },
        )
        writtenKeys.push({
          state: this.globalState,
          key: STATE_KEYS.globalModel,
          prior: this.globalState.get(STATE_KEYS.globalModel),
        })
        await persistModelIndex(this.globalState, marked as ModelIndex, "global")
        this.rehydratedGlobalModelIndex = marked as ModelIndex
      }
      if (this.rehydratedProjectModelIndex && this.workspaceState) {
        const marked = markIndexStale(
          this.rehydratedProjectModelIndex as ModelIndex & { readonly diagnostics: SelectorDiagnostics },
        )
        writtenKeys.push({
          state: this.workspaceState,
          key: STATE_KEYS.projectModel,
          prior: this.workspaceState.get(STATE_KEYS.projectModel),
        })
        await persistModelIndex(this.workspaceState, marked as ModelIndex, "project")
        this.rehydratedProjectModelIndex = marked as ModelIndex
      }
      await this.persistDiagnosticAgentIndex(writtenKeys)
      // If no rehydrated indexes exist, create empty diagnostic indexes
      const emptyProvider: ProviderIndex = {
        version: SELECTOR_INDEX_VERSION,
        materializationVersion: 0,
        materializationHash: "",
        diagnostics: { invalid: true, stale: true, conflicts: [], provenance: {} },
        providers: [],
        selectedId: null,
        timestamp: Date.now(),
      }
      if (!this.rehydratedProviderIndex && this.globalState) {
        writtenKeys.push({
          state: this.globalState,
          key: STATE_KEYS.providers,
          prior: this.globalState.get(STATE_KEYS.providers),
        })
        this.rehydratedProviderIndex = emptyProvider
        await persistProviderIndex(this.globalState, emptyProvider)
      }
      const emptyAgent: AgentIndex = {
        version: SELECTOR_INDEX_VERSION,
        materializationVersion: 0,
        materializationHash: "",
        diagnostics: { invalid: true, stale: true, conflicts: [], provenance: {} },
        agents: [],
        selectedId: null,
        defaultId: null,
        timestamp: Date.now(),
      }
      if (!this.rehydratedAgentIndex && this.workspaceState) {
        writtenKeys.push({
          state: this.workspaceState,
          key: STATE_KEYS.agents,
          prior: this.workspaceState.get(STATE_KEYS.agents),
        })
        this.rehydratedAgentIndex = emptyAgent
        await persistAgentIndex(this.workspaceState, emptyAgent)
      }
    } catch (err) {
      await this.rollbackPersistKeys(writtenKeys)
      this.restorePersistState(priorState)
      throw err
    }
  }

  private async persistDiagnosticAgentIndex(
    writtenKeys: Array<{ state: StateAdapter; key: string; prior: unknown }>,
  ): Promise<void> {
    if (!this.workspaceState) return
    const idx =
      this.currentSnapshot && this.lastAssetScan
        ? buildAgentIndex(
            this.currentSnapshot,
            this.buildAgentEntriesFromScan(this.lastAssetScan),
            this.rehydratedAgentIndex?.selectedId ?? this.persistedAgentIndex?.selectedId ?? null,
          )
        : this.rehydratedAgentIndex
    if (!idx) return
    const marked = markIndexStale(idx)
    writtenKeys.push({
      state: this.workspaceState,
      key: STATE_KEYS.agents,
      prior: this.workspaceState.get(STATE_KEYS.agents),
    })
    await persistAgentIndex(this.workspaceState, marked)
    this.rehydratedAgentIndex = marked
  }

  /**
   * Check if a last-valid materialization exists in persisted state.
   * Used to determine diagnostic state when no valid data is available.
   */
  private lastValidMaterializationExists(): boolean {
    return this.rehydratedProviderIndex !== null || this.rehydratedAgentIndex !== null
  }

  /**
   * Capture current service fields for transactional rollback.
   */
  private capturePriorState() {
    return {
      config: this.current,
      snapshot: this.currentSnapshot,
      globalHash: this.globalHash,
      projectHash: this.projectHash,
      providerIndex: this.rehydratedProviderIndex,
      agentIndex: this.rehydratedAgentIndex,
      globalModelIndex: this.rehydratedGlobalModelIndex,
      projectModelIndex: this.rehydratedProjectModelIndex,
      persistedAgentIndex: this.persistedAgentIndex,
    }
  }

  /**
   * Restore service fields from a prior state snapshot (transactional rollback).
   */
  private restorePriorState(prior: ReturnType<typeof this.capturePriorState>): void {
    this.current = prior.config
    this.currentSnapshot = prior.snapshot
    this.globalHash = prior.globalHash
    this.projectHash = prior.projectHash
    this.rehydratedProviderIndex = prior.providerIndex
    this.rehydratedAgentIndex = prior.agentIndex
    this.rehydratedGlobalModelIndex = prior.globalModelIndex
    this.rehydratedProjectModelIndex = prior.projectModelIndex
    this.persistedAgentIndex = prior.persistedAgentIndex
  }

  /**
   * Start file watchers for canonical config files and asset directories.
   * Watchers and debounce timers are owned/disposed exactly.
   */
  private startWatchers(): void {
    // Watch global config file
    this.watchFile(this.paths.globalConfigFile, () => this.onFileChanged("global"))
    // Watch project config file (only when project root exists)
    if (this.paths.projectConfigFile) {
      this.watchFile(this.paths.projectConfigFile, () => this.onFileChanged("project"))
    }

    // Watch asset directories
    for (const dir of ASSET_DIRECTORIES) {
      this.watchDir(this.paths.globalAssetDirs[dir], (changedPath) => this.onAssetChanged("global", dir, changedPath))
      if (this.paths.projectAssetDirs) {
        this.watchDir(this.paths.projectAssetDirs[dir], (changedPath) =>
          this.onAssetChanged("project", dir, changedPath),
        )
      }
    }
  }

  /**
   * Watch a single file. Creates the file's parent dir watcher if it doesn't exist.
   */
  private watchFile(filePath: string, onChange: () => void): void {
    const dir = path.dirname(filePath)
    const fileName = path.basename(filePath)

    // Ensure parent directory exists for watcher
    try {
      fs.mkdirSync(dir, { recursive: true })
    } catch (err) {
      console.error(`[Kilo Config] Failed to create watcher directory ${dir}: ${String(err)}`)
    }

    if (this.watcher) {
      const d = this.watcher.watch(dir, fileName, onChange, onChange, onChange)
      this.watchers.push(d)
    }
    // When no watcher adapter is provided, watchers are not started
    // (e.g. in tests that don't need file watching)
  }

  /**
   * Watch a directory for changes (asset directories).
   * Correction 10: passes the changed path to the callback for exact coalescing.
   */
  private watchDir(dirPath: string, onChange: (changedPath?: string) => void): void {
    try {
      fs.mkdirSync(dirPath, { recursive: true })
    } catch (err) {
      console.error(`[Kilo Config] Failed to create asset watcher directory ${dirPath}: ${String(err)}`)
    }

    if (this.watcher) {
      const d = this.watcher.watch(dirPath, "**/*", onChange, onChange, onChange)
      this.watchers.push(d)
    }
  }

  /**
   * Debounce rapid file system events (50ms).
   */
  private debounce(key: string, fn: () => void): void {
    const existing = this.debounceTimers.get(key)
    if (existing) clearTimeout(existing)
    this.debounceTimers.set(
      key,
      setTimeout(() => {
        this.debounceTimers.delete(key)
        fn()
      }, 50),
    )
  }

  /**
   * Mark a file as having been written by us with the content hash (Blocker 5).
   * Coalescing is hash-based: only when reread bytes hash equals this.
   */
  private markOwnWrite(filePath: string, hash: string): void {
    this.ownWriteHashes.set(filePath, hash)
  }

  /**
   * Check if a file change should be coalesced (Blocker 5).
   * Returns true only when reread bytes hash equals the exact recorded
   * own-write hash. Any different/missing bytes are processed as external.
   */
  private shouldCoalesce(filePath: string, currentHash: string): boolean {
    const recordedHash = this.ownWriteHashes.get(filePath)
    if (recordedHash === undefined) return false
    // Only coalesce if bytes match exactly
    if (currentHash === recordedHash) {
      this.ownWriteHashes.delete(filePath)
      return true
    }
    // Different bytes — external edit, don't coalesce
    this.ownWriteHashes.delete(filePath)
    return false
  }

  /**
   * Enqueue an event through the revision-gated convergence scheduler (Blocker 6).
   * All materialization/publication runs through this serialized scheduler.
   * Each task checks its own revision before publishing; stale work is skipped.
   */
  private enqueueEvent(fn: () => Promise<void> | void): void {
    this.eventQueue.push(fn)
    this.processQueue()
  }

  /**
   * Enqueue a materialization and return a promise that resolves when it completes.
   * The materialization checks its own revision before publishing; if a newer
   * revision has been committed since enqueue, the stale materialization is
   * skipped and the promise resolves (the latest materialization already ran).
   * This is the single convergence scheduler entry point for ALL materialization
   * paths: init, GUI write, and external watcher (Finding 6).
   *
   * Gap 5: The promise is tracked; dispose() settles it with a structured
   * error instead of leaving it hanging.
   */
  private enqueueAndRunMaterialization(source: "init" | "gui" | "external", prepare?: () => boolean): Promise<void> {
    const enqueuedRev = this.revision
    return new Promise<void>((resolve, reject) => {
      const pending = { resolve, reject, rev: enqueuedRev }
      this.pendingMaterializations.push(pending)

      this.eventQueue.push(async () => {
        try {
          // Post-dispose guard: check before starting work
          if (this.disposed || this.revision > enqueuedRev) {
            resolve()
            return
          }
          if (prepare && !prepare()) {
            resolve()
            return
          }
          await this.materializeFromDisk(source, enqueuedRev)
          resolve()
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)))
        } finally {
          // Remove from pending list after work completes (not before),
          // so dispose() can settle this promise if called during work
          const idx = this.pendingMaterializations.indexOf(pending)
          if (idx >= 0) this.pendingMaterializations.splice(idx, 1)
        }
      })
      this.processQueue()
    })
  }

  private async processQueue(): Promise<void> {
    if (this.processingQueue) return
    this.processingQueue = true

    try {
      while (this.eventQueue.length > 0) {
        if (this.disposed) break
        const task = this.eventQueue.shift()!
        try {
          await task()
        } catch (err) {
          console.error(`[Kilo Config] Queue task failed: ${String(err)}`)
          // A failed task settles its own promise/error channel; later queued work continues
        }
      }
    } finally {
      this.processingQueue = false
    }
  }

  /**
   * Handle a config file change from the watcher (Blocker 5, 6).
   * Uses hash-based coalescing and revision-gated queue.
   */
  private onFileChanged(scope: "global" | "project"): void {
    if (this.disposed) return
    if (scope === "project" && !this.hasProject) return

    const filePath = scope === "global" ? this.paths.globalConfigFile : this.paths.projectConfigFile!

    // Read current bytes for hash comparison (Blocker 5)
    const raw = readFile(filePath)
    if (raw.type === "present") {
      if (this.shouldCoalesce(filePath, raw.hash)) return
    } else if (raw.type === "absent") {
      // File deleted — clear own-write hash and process
      this.ownWriteHashes.delete(filePath)
    }
    // failure falls through to process

    void this.enqueueAndRunMaterialization("external").catch((err) => {
      if (!this.disposed) {
        this.onErrorEmitter.fire({
          kind: "watcher-error",
          message: `Config watcher convergence failed: ${String(err)}`,
        })
      }
    })
  }

  /**
   * Handle an asset directory change from the watcher.
   * Correction 10: receives exact changed path, coalesces only that file's hash
   * against that file's own-write marker. Unrelated sibling files do not influence it.
   * Rescans assets and re-materializes through convergence scheduler (Finding 6).
   */
  private onAssetChanged(_scope: "global" | "project", _dir: AssetDirectory, changedPath?: string): void {
    if (this.disposed) return
    if (_scope === "project" && !this.hasProject) return

    void this.enqueueAndRunMaterialization("external", () => {
      if (this.disposed) return false
      // Correction 10: if the changed path is known, only check that file's
      // own-write hash. Sibling files do not influence the coalescing decision.
      let hasExternalChange = false
      if (changedPath) {
        const raw = readFile(changedPath)
        if (raw.type !== "present" || !this.shouldCoalesce(changedPath, raw.hash)) {
          hasExternalChange = true
        }
      } else {
        // Fallback: no path provided, scan full directory (backward compat)
        const dir = _scope === "global" ? this.paths.globalAssetDirs[_dir] : this.paths.projectAssetDirs![_dir]
        try {
          const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"))
          if (files.length === 0) {
            const priorEntries = this.lastAssetScan
              ? this.lastAssetScan.entries.filter((e) => e.scope === _scope && e.filePath.startsWith(dir))
              : []
            if (priorEntries.length > 0) hasExternalChange = true
          } else {
            for (const file of files) {
              const filePath = path.join(dir, file)
              const raw = readFile(filePath)
              if (raw.type !== "present" || !this.shouldCoalesce(filePath, raw.hash)) {
                hasExternalChange = true
                break
              }
            }
          }
        } catch (err) {
          console.error(`[Kilo Config] Asset watcher scan failed: ${String(err)}`)
          hasExternalChange = true
        }
      }

      if (!hasExternalChange) return false

      this.lastAssetScan = this.scanAssets()
      return true
    }).catch((err) => {
      if (!this.disposed) {
        this.onErrorEmitter.fire({ kind: "watcher-error", message: `Asset watcher convergence failed: ${String(err)}` })
      }
    })
  }

  /**
   * Restore a credential to its prior value, or delete if no prior (Blocker 8).
   * Uses the exact validated ref — never reconstructs from scope/kind/id.
   */
  private async restoreCredentialState(ref: string, priorValue: string | undefined): Promise<void> {
    if (priorValue !== undefined) {
      await restoreCredentialRef(this.secrets, ref, priorValue)
    } else {
      await removeCredentialRef(this.secrets, ref)
    }
  }

  private async rollbackCredential(
    ref: string,
    priorValue: string | undefined,
  ): Promise<{ ok: false; kind: "disposed" | "io"; message: string } | null> {
    try {
      await this.restoreCredentialState(ref, priorValue)
      return null
    } catch (err) {
      console.error(`[Kilo Config] Credential rollback failed for ${ref}: ${String(err)}`)
      return {
        ok: false,
        kind: this.disposed ? "disposed" : "io",
        message: `Credential rollback failed: ${String(err)}`,
      }
    }
  }

  private normalizeCredentialFailure(
    result: Extract<Awaited<ReturnType<CanonicalConfigService["writeConfig"]>>, { ok: false }>,
  ): {
    ok: false
    kind: "stale" | "invalid" | "disposed" | "io"
    message: string
    errors?: readonly ValidationError[]
  } {
    if (result.kind === "conflict") {
      return { ...result, kind: "invalid" }
    }
    return {
      ok: false,
      kind: result.kind,
      message: result.message,
      errors: result.errors,
    }
  }

  /**
   * Check stale/conflict for a write operation using discriminated read result (Blocker 10).
   */
  private checkStaleForWrite(
    existing: FileReadResult,
    expectedHash: string,
  ): { ok: false; kind: "stale"; message: string } | null {
    return checkStaleForWriteView(existing, expectedHash)
  }

  /**
   * Build merged document from existing file + patch (Blocker 9).
   */
  private buildMergedDoc(existing: FileReadResult, patch: Record<string, unknown>): Record<string, unknown> {
    return buildMergedDocView(existing, patch)
  }

  /**
   * Validate cross-scope composition before write (Blocker 9).
   * Gap 2: Rejects write when opposite scope file is present-but-unparseable
   * or unreadable. Legal absence alone is empty.
   */
  private checkCrossScopeForWrite(
    scope: "global" | "project",
    fullDoc: Record<string, unknown>,
  ): { ok: false; kind: "invalid"; message: string; errors: readonly ValidationError[] } | null {
    const otherScope = scope === "global" ? "project" : "global"
    if (otherScope === "project" && !this.hasProject) {
      // No project root — no cross-scope conflict possible
      return null
    }
    const otherFilePath = otherScope === "global" ? this.paths.globalConfigFile : this.paths.projectConfigFile!
    const otherExisting = readFile(otherFilePath)

    // Gap 2: present-but-unparseable or unreadable rejects write preflight
    if (otherExisting.type === "failure") {
      return {
        ok: false,
        kind: "invalid",
        message: `Cannot read ${otherScope} config at ${otherFilePath}: ${otherExisting.message}`,
        errors: [
          {
            path: [],
            message: `Cannot read ${otherScope} config: ${otherExisting.code} — ${otherExisting.message}`,
            scope: otherScope,
            file: otherFilePath,
          },
        ],
      }
    }
    if (otherExisting.type === "absent") {
      // Legal absence — treat as empty
      const crossErrors = validateCrossScope(scope === "global" ? fullDoc : {}, scope === "project" ? fullDoc : {})
      if (crossErrors.length > 0) {
        return {
          ok: false,
          kind: "invalid",
          message: `Cross-scope conflict: ${crossErrors.map((e) => e.message).join("; ")}`,
          errors: crossErrors,
        }
      }
      return null
    }

    const otherParsed = parseJsonc(otherExisting.bytes)
    let otherDoc: Record<string, unknown> = {}
    if (otherParsed.ok) {
      otherDoc = otherParsed.value
    } else {
      // Gap 2: present but unparseable
      return {
        ok: false,
        kind: "invalid",
        message: `${otherScope} config at ${otherFilePath} is not valid JSONC`,
        errors: [
          {
            path: [],
            message: `${otherScope} config is not valid JSONC: ${otherParsed.error}`,
            scope: otherScope,
            file: otherFilePath,
          },
        ],
      }
    }
    // Correction 4: opposite bytes must also pass validateConfig for the opposite scope
    const otherValidation = validateConfig(otherExisting.bytes, otherScope, otherFilePath)
    if (!otherValidation.valid) {
      return {
        ok: false,
        kind: "invalid",
        message: `${otherScope} config at ${otherFilePath} is invalid: ${otherValidation.errors.map((e) => e.message).join("; ")}`,
        errors: otherValidation.errors,
      }
    }
    const crossErrors = validateCrossScope(
      scope === "global" ? fullDoc : otherDoc,
      scope === "project" ? fullDoc : otherDoc,
    )
    if (crossErrors.length > 0) {
      return {
        ok: false,
        kind: "invalid",
        message: `Cross-scope conflict: ${crossErrors.map((e) => e.message).join("; ")}`,
        errors: crossErrors,
      }
    }
    return null
  }

  /**
   * Validate cross-scope composition for single/keyed conflict detection (Blocker 9).
   * Delegates to the shared validateCrossScope rule.
   */
  private validateCrossScopeComposition(
    global: Record<string, unknown>,
    project: Record<string, unknown>,
  ): ValidationError[] {
    return validateCrossScopeCompositionView(global, project)
  }

  /**
   * Build agent index entries from validated scan results (Blocker 4).
   * Uses retained frontmatter from scan entries — never rereads malformed bytes.
   * On malformed/unreadable replacement, the prior entry's frontmatter is used.
   */
  private buildAgentEntriesFromScan(scan: AssetScanResult): Array<{
    id: string
    displayName: string
    description?: string
    mode?: "primary" | "secondary" | "specialized"
    hidden?: boolean
    color?: string
    source: "global" | "project"
    filePath?: string
    frontmatter?: Record<string, unknown>
    body?: string
    assetHash?: string
  }> {
    return buildAgentEntries(scan, this.paths)
  }
}
