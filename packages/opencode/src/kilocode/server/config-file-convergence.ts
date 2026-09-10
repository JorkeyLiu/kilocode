// kilocode_change - new file
/**
 * Canonical GUI disk-write convergence leases (first unit).
 *
 * Extension remains the canonical file persistence owner. This service owns
 * only the CLI private-runtime side: acquire raises the existing
 * ConfigConvergence fence + snapshots pre-fence identities and reads before
 * bytes; resolve re-reads disk (never trusts client outcome/hash) and
 * converges via existing hot/cold semantics:
 * - all before==after -> noop (abort, no rebuild)
 * - any asset change -> cold (commit)
 * - config JSONC top-level changed keys all isHotPatch -> hot
 *   (invalidate per-directory caches + emit config-updated + abort fence,
 *   no dispose/boot; hot invalidate/emit failure falls back to cold commit,
 *   never releases-then-lies-hot)
 * - otherwise cold (commit; response returns after seq/rebuild registration,
 *   never awaiting drain; pass boots from latest disk and coalesces bursts).
 *
 * Private fd methods: `config/convergence/acquire` + `config/convergence/resolve`
 * (no client-declared commit/abort). Capability negotiation is fail-closed.
 * Descriptors are a closed set; runtime derives paths, never accepts arbitrary
 * absolute paths. Any global descriptor => global fence; otherwise a single
 * project directory (multi-dir in one lease is rejected). Project directories
 * are authorized against InstanceStore loaded identities (established via
 * store load when legal-but-unloaded) plus realpath containment in the
 * backend authorized roots; normalized traversal escapes and symlink escapes
 * are rejected. Nonexistent targets are allowed only when the nearest
 * existing parent is contained.
 *
 * Acquire outcomes strictly distinguish fresh/pending (`acquired`) from
 * already-resolved (`resolved` terminal): a resolved-lease acquire replay
 * must never let the extension execute a write (extension fails closed).
 * Pending replay with a different descriptor digest is a conflict.
 * Resolve is idempotent and shares one inflight settlement across concurrent
 * resolve/peer-close callers (same terminal, never die). Terminals are
 * LRU/TTL bounded, no new persisted state: a restart boots fresh and
 * converges naturally from disk.
 *
 * Unreadable files are never absent and never noop/hot: they converge cold
 * (or fail safe with a cold commit), booting finally from disk.
 *
 * TTL and peer-close grace are service-owned fibers in the layer scope
 * (Effect Scope ownership, explicit per-lease interrupt on settle, join on
 * shutdown). No background polling. `peerClosed` registers the tracked grace
 * fiber and returns immediately; shutdown interrupts and joins.
 */

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import * as crypto from "node:crypto"
import { Context, Deferred, Duration, Effect, Fiber, Layer, Option, Queue, Scope } from "effect"
import { ConfigConvergence, type ColdObligation, type ColdScope } from "./config-convergence"
import { logRebuildFailure } from "./config-rebuild"
import { InstanceStore } from "@/project/instance-store"
import { Config } from "@/config/config"
import { InstanceRef } from "@/effect/instance-ref"
import { Global } from "@opencode-ai/core/global"
import { isHotPatch } from "@/kilocode/config/hot-keys"
import { canonicalDirectory } from "@/kilocode/session/canonical-directory"

export const CONVERGENCE_ACQUIRE_OP = "config/convergence/acquire" as const
export const CONVERGENCE_RESOLVE_OP = "config/convergence/resolve" as const
export const CONVERGENCE_ACQUIRE_VERSION = 1 as const
export const CONVERGENCE_RESOLVE_VERSION = 1 as const
export const MAX_CONVERGENCE_LEASES = 32
export const RESOLVED_TERMINAL_CACHE = 128
export const LEASE_TTL_MS = 30_000
export const PEER_CLOSE_GRACE_MS = 750
export const RESOLVED_TTL_MS = 5 * 60_000

let peerGraceOverride: number | undefined
export const setPeerCloseGraceMsForTest = (ms: number | undefined): void => {
  peerGraceOverride = ms
}
export const peerCloseGraceMs = (): number => peerGraceOverride ?? PEER_CLOSE_GRACE_MS

let leaseTtlOverride: number | undefined
export const setLeaseTtlMsForTest = (ms: number | undefined): void => {
  leaseTtlOverride = ms
}
export const leaseTtlMs = (): number => leaseTtlOverride ?? LEASE_TTL_MS

/**
 * F-01/F-04 test seams. All hooks run synchronously inside the acquire
 * critical section (after authorize / after snapshot / before TTL fork) so
 * tests can deterministically inject a post-begin snapshot failure, a TTL
 * registration failure, or a symlink swap between authorize and disk reads.
 * Production never sets them.
 */
export type AcquireTestHooks = {
  readonly afterAuthorize?: () => void
  readonly afterSnapshot?: () => void
  readonly beforeTtl?: () => void
}
let acquireHooks: AcquireTestHooks | undefined
export const setAcquireHooksForTest = (hooks: AcquireTestHooks | undefined): void => {
  acquireHooks = hooks
}

export type FileReadTestHooks = {
  readonly beforeRead?: (file: string) => void
  readonly afterRead?: (file: string) => void
}
let fileReadHooks: FileReadTestHooks | undefined
export const setFileReadHooksForTest = (hooks: FileReadTestHooks | undefined): void => {
  fileReadHooks = hooks
}

export type ConvergenceDescriptor =
  | { readonly kind: "config"; readonly scope: "global" }
  | { readonly kind: "config"; readonly scope: "project"; readonly directory: string }
  | {
      readonly kind: "asset"
      readonly asset: "agent" | "command" | "skill" | "tool" | "plugin" | "rules"
      readonly scope: "global" | "project"
      readonly directory?: string
      readonly id: string
    }

export type FileStatus = "present" | "absent" | "unreadable"
export type ResolvedFile = {
  readonly path: string
  readonly status: FileStatus
  readonly exists: boolean
  readonly hash: string | null
  readonly code?: string
}

export type ConvergenceTerminal = {
  readonly leaseId: string
  readonly outcome: "noop" | "hot" | "cold" | "failed"
  readonly scope: "global" | { readonly directory: string }
  /** Present only when outcome is failed: diagnostic + retry hint (F-06). */
  readonly reason?: string
  readonly retryable?: boolean
}

/** Fresh/pending vs already-resolved are strictly distinguished (F3). */
export type AcquireOutcome =
  | { readonly acquired: true; readonly leaseId: string }
  | { readonly resolved: true; readonly terminal: ConvergenceTerminal }

/**
 * F-04 stable project identity: the authorized realpath captured at
 * authorize time. `existed` records whether the lexical directory itself
 * existed then — nonexistent future targets are allowed only while their
 * parent resolves to the same expected location.
 */
export type DirAuth = { readonly expected: string; readonly existed: boolean }

export type FileEntry = { readonly path: string; readonly dir?: string }

type PendingLease = {
  readonly leaseId: string
  readonly scope: ColdScope
  readonly descriptors: readonly ConvergenceDescriptor[]
  readonly digest: string
  readonly files: readonly FileEntry[]
  readonly before: Map<string, ResolvedFile>
  readonly obligation: ColdObligation
  readonly auth: ReadonlyMap<string, DirAuth>
  readonly createdAt: number
  settled: boolean
  inflight: Deferred.Deferred<void> | undefined
  settlement: { readonly terminal: ConvergenceTerminal } | { readonly cause: unknown } | undefined
}

type ResolvedEntry = { readonly terminal: ConvergenceTerminal; readonly at: number }

const hashBytes = (bytes: string): string => crypto.createHash("sha256").update(bytes, "utf8").digest("hex")

function readResolved(file: string): ResolvedFile {
  try {
    const bytes = fs.readFileSync(file, "utf8")
    return { path: file, status: "present", exists: true, hash: hashBytes(bytes) }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === "ENOENT") return { path: file, status: "absent", exists: false, hash: null }
    // Unreadable (permission, EACCES, etc.) is never absent and never
    // converges noop/hot — it forces cold/fail-safe from disk.
    return { path: file, status: "unreadable", exists: false, hash: `error:${code ?? "unknown"}`, code }
  }
}

function readBytesOpt(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8")
  } catch {
    return undefined
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function isNonEmpty(v: unknown): v is string {
  return typeof v === "string" && v.length > 0
}

const ASSETS = new Set(["agent", "command", "skill", "tool", "plugin", "rules"])

function validateAssetId(id: unknown): string {
  if (typeof id !== "string" || id.length === 0 || id.length > 128) throw new Error("asset id must be 1..128 chars")
  if (id.includes("\0") || id.includes("/") || id.includes("\\") || id === "." || id === "..")
    throw new Error("asset id must be a single safe filename segment")
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw new Error("asset id must match [A-Za-z0-9._-]")
  return id
}

export function validateDescriptors(raw: unknown): readonly ConvergenceDescriptor[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("descriptors must be non-empty array")
  if (raw.length > 8) throw new Error("descriptors limited to 8 per lease")
  const out: ConvergenceDescriptor[] = []
  for (const item of raw) {
    if (!isRecord(item)) throw new Error("descriptor must be object")
    const keys = new Set(Object.keys(item))
    if (item.kind === "config") {
      if (item.scope === "global") {
        if (keys.size !== 2 || !keys.has("kind") || !keys.has("scope")) throw new Error("unexpected config/global field")
        out.push({ kind: "config", scope: "global" })
        continue
      }
      if (item.scope === "project") {
        if (keys.size !== 3 || !keys.has("kind") || !keys.has("scope") || !keys.has("directory"))
          throw new Error("unexpected config/project field")
        if (!isNonEmpty(item.directory)) throw new Error("config/project directory must be non-empty string")
        out.push({ kind: "config", scope: "project", directory: canonicalDirectory(item.directory) })
        continue
      }
      throw new Error("config descriptor scope must be global|project")
    }
    if (item.kind === "asset") {
      if (typeof item.asset !== "string" || !ASSETS.has(item.asset)) throw new Error("asset must be closed set")
      if (item.scope !== "global" && item.scope !== "project") throw new Error("asset scope must be global|project")
      const id = validateAssetId(item.id)
      if (item.scope === "global") {
        if (item.directory !== undefined) throw new Error("global asset must not carry directory")
        if (keys.size !== 4) throw new Error("unexpected global asset field")
        out.push({ kind: "asset", asset: item.asset as never, scope: "global", id })
        continue
      }
      if (!isNonEmpty(item.directory)) throw new Error("project asset directory must be non-empty string")
      if (keys.size !== 5) throw new Error("unexpected project asset field")
      out.push({
        kind: "asset",
        asset: item.asset as never,
        scope: "project",
        directory: canonicalDirectory(item.directory),
        id,
      })
      continue
    }
    throw new Error("descriptor kind must be config|asset")
  }
  const dirs = new Set<string>()
  for (const d of out) {
    if (d.kind === "config" && d.scope === "project") dirs.add(d.directory)
    if (d.kind === "asset" && d.scope === "project") dirs.add(d.directory!)
  }
  if (dirs.size > 1) throw new Error("multi-directory project lease rejected")
  return out
}

function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`
  if (isRecord(v))
    return `{${Object.keys(v)
      .sort()
      .filter((k) => v[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stable(v[k])}`)
      .join(",")}}`
  if (v === null) return "null"
  if (typeof v === "string") return JSON.stringify(v)
  if (typeof v === "number" || typeof v === "boolean") return String(v)
  return `#${typeof v}`
}

/** Canonical digest of a descriptor set: order-independent, exact-match (F4). */
export function descriptorDigest(descriptors: readonly ConvergenceDescriptor[]): string {
  const normalized = [...descriptors].map((d) => ({ ...d }) as Record<string, unknown>).sort((a, b) => {
    const sa = stable(a)
    const sb = stable(b)
    return sa < sb ? -1 : sa > sb ? 1 : 0
  })
  return crypto.createHash("sha256").update(stable(normalized), "utf8").digest("hex")
}

export function leaseScopeFor(descriptors: readonly ConvergenceDescriptor[]): ColdScope {
  const global = descriptors.some((d) => (d.kind === "config" ? d.scope === "global" : d.scope === "global"))
  if (global) return "global"
  const first = descriptors[0]!
  const dir = first.kind === "config" ? (first.scope === "project" ? first.directory : "") : (first.directory ?? "")
  return { directory: dir }
}

function globalConfigFile(): string {
  return path.join(Global.Path.config, "kilo.jsonc")
}

function projectConfigFile(directory: string): string {
  return path.join(directory, ".kilo", "kilo.jsonc")
}

export function resolveDescriptorFiles(descriptors: readonly ConvergenceDescriptor[]): readonly FileEntry[] {
  const files: FileEntry[] = []
  for (const d of descriptors) {
    if (d.kind === "config") {
      if (d.scope === "global") files.push({ path: globalConfigFile() })
      else files.push({ path: projectConfigFile(d.directory), dir: canonicalDirectory(d.directory) })
      continue
    }
    if (d.scope === "global") files.push({ path: path.join(Global.Path.config, d.asset, `${d.id}.md`) })
    else
      files.push({
        path: path.join(path.join(d.directory!, ".kilo"), d.asset, `${d.id}.md`),
        dir: canonicalDirectory(d.directory!),
      })
  }
  const seen = new Set<string>()
  const out: FileEntry[] = []
  for (const f of files) {
    if (seen.has(f.path)) continue
    seen.add(f.path)
    out.push(f)
  }
  return out
}

export function resolveDescriptorPaths(descriptors: readonly ConvergenceDescriptor[]): readonly string[] {
  return resolveDescriptorFiles(descriptors).map((f) => f.path)
}

/**
 * F-02 identity-guarded single read. For project files the lexical
 * directory is verified (non-symlink + realpath == authorized identity)
 * immediately before the read, the test hook window runs, the single
 * filesystem read executes, the second hook window runs, then the same
 * identity is verified again immediately after. Any verification failure
 * discards the just-read bytes (never returned) and throws so the caller
 * fails closed to a failed terminal with a safe release. Global files
 * (dir undefined) carry no project guard.
 *
 * Detect-before-use only: the two verifications bracket the read but
 * cannot atomically prevent an OS-level swap-and-swap-back inside the
 * microsecond window without fd-pinned openat (no portable Bun/Node
 * openat/dirfd primitive is used here; no API is fabricated). A swap
 * that is present at either verification is always detected and its
 * bytes never participate in diff/hot/cold/boot.
 */
function guardedReadResolved(entry: FileEntry, auth: ReadonlyMap<string, DirAuth>): ResolvedFile {
  if (!entry.dir) return readResolved(entry.path)
  const guard = auth.get(entry.dir)
  if (!guard) throw new Error(`directory identity changed: ${entry.dir}`)
  verifyDirectorySync(entry.dir, guard)
  fileReadHooks?.beforeRead?.(entry.path)
  const out = readResolved(entry.path)
  fileReadHooks?.afterRead?.(entry.path)
  verifyDirectorySync(entry.dir, guard)
  return out
}

function guardedReadBytes(entry: FileEntry, auth: ReadonlyMap<string, DirAuth>): string | undefined {
  if (!entry.dir) return readBytesOpt(entry.path)
  const guard = auth.get(entry.dir)
  if (!guard) throw new Error(`directory identity changed: ${entry.dir}`)
  verifyDirectorySync(entry.dir, guard)
  fileReadHooks?.beforeRead?.(entry.path)
  const out = readBytesOpt(entry.path)
  fileReadHooks?.afterRead?.(entry.path)
  verifyDirectorySync(entry.dir, guard)
  return out
}

function parseJsoncTopLevel(bytes: string): Record<string, unknown> | undefined {
  try {
    // Strict like the config loader (src/config/parse.ts): any syntax error
    // makes the doc unparseable (F7) — tolerant recovery must never launder
    // a corrupt file into a hot-provable key set.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { parse } = require("jsonc-parser") as {
      parse: (t: string, e: unknown[], o?: unknown) => unknown
    }
    const errors: unknown[] = []
    const v = parse(bytes, errors, { allowTrailingComma: true })
    if (errors.length > 0) return undefined
    return isRecord(v) ? v : undefined
  } catch {
    return undefined
  }
}

/** Top-level changed keys between two JSONC docs; unparseable => ["*unparseable*"]. */
export function diffTopLevelKeys(before: string | undefined, after: string | undefined): readonly string[] {
  if (before === after) return []
  if (before === undefined || after === undefined) return ["*existence*"]
  const b = parseJsoncTopLevel(before)
  const a = parseJsoncTopLevel(after)
  if (!b || !a) return ["*unparseable*"]
  const keys = new Set([...Object.keys(b), ...Object.keys(a)])
  const changed: string[] = []
  for (const k of keys) {
    if (!(k in b) || !(k in a) || stable(b[k]) !== stable(a[k])) changed.push(k)
  }
  return changed
}

function isWithin(target: string, root: string): boolean {
  if (target === root) return true
  return target.startsWith(root.endsWith(path.sep) ? root : root + path.sep)
}

function nearestExistingAncestor(normalized: string): string | null {
  let cur = normalized
  for (let i = 0; i < 64; i++) {
    try {
      fs.accessSync(cur)
      return cur
    } catch {
      const parent = path.dirname(cur)
      if (parent === cur) return null
      cur = parent
    }
  }
  return null
}

function realpathOrNull(p: string): string | null {
  try {
    return fs.realpathSync(p)
  } catch {
    return null
  }
}

/**
 * F-04 stable-identity re-verification. Runs synchronously immediately
 * before every disk-read round (acquire snapshot, acquire before-text,
 * resolve after-snapshot, resolve hot proof). The lexical directory must
 * still be a non-symlink whose realpath equals the authorized identity;
 * nonexistent future targets are allowed only while the nearest existing
 * parent resolves to the same expected location. Any deviation fails
 * closed (throw) so the caller never reads the symlink target and never
 * converges from it. Global-only leases carry an empty auth map.
 */
function verifyDirectorySync(lexical: string, auth: DirAuth): void {
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(lexical)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if ((code === "ENOENT" || code === "ENOTDIR") && !auth.existed) {
      const ancestor = nearestExistingAncestor(lexical)
      if (!ancestor) throw new Error(`directory identity changed: ${lexical}`)
      const realAncestor = realpathOrNull(ancestor)
      if (!realAncestor) throw new Error(`directory identity changed: ${lexical}`)
      const remainder = path.relative(ancestor, lexical)
      if (remainder.split(path.sep).includes("..")) throw new Error(`directory identity changed: ${lexical}`)
      const current = remainder ? path.join(realAncestor, remainder) : realAncestor
      if (current !== auth.expected) throw new Error(`directory identity changed: ${lexical}`)
      return
    }
    throw new Error(`directory identity changed: ${lexical}`)
  }
  if (stat.isSymbolicLink()) throw new Error(`directory identity changed: ${lexical}`)
  const current = realpathOrNull(lexical)
  if (!current || current !== auth.expected) throw new Error(`directory identity changed: ${lexical}`)
}

function verifyAllSync(auth: ReadonlyMap<string, DirAuth>): void {
  for (const [lexical, entry] of auth) verifyDirectorySync(lexical, entry)
}

export interface ConfigFileConvergence {
  readonly acquire: (leaseId: string, descriptors: readonly ConvergenceDescriptor[]) => Effect.Effect<AcquireOutcome>
  readonly resolve: (leaseId: string) => Effect.Effect<ConvergenceTerminal>
  readonly peerClosed: () => Effect.Effect<void>
  readonly shutdown: Effect.Effect<void>
  readonly unresolvedCount: () => Effect.Effect<number>
}

export class Service extends Context.Service<Service, ConfigFileConvergence>()("@kilocode/ConfigFileConvergence") {}

export const noopFileConvergence: ConfigFileConvergence = {
  acquire: (leaseId) => Effect.succeed({ acquired: true as const, leaseId }),
  resolve: (leaseId) => Effect.succeed({ leaseId, outcome: "noop" as const, scope: "global" as const }),
  peerClosed: () => Effect.void,
  shutdown: Effect.void,
  unresolvedCount: () => Effect.succeed(0),
}

function pruneResolved(cache: Map<string, ResolvedEntry>): void {
  const now = Date.now()
  for (const [k, v] of cache) {
    if (now - v.at > RESOLVED_TTL_MS) cache.delete(k)
  }
  while (cache.size > RESOLVED_TERMINAL_CACHE) {
    const first = cache.keys().next()
    if (first.done) break
    cache.delete(first.value)
  }
}

export const layer = Layer.effect(
  Service,
  Effect.acquireRelease(
    Effect.gen(function* () {
      const convergence = Option.getOrElse(
        yield* Effect.serviceOption(ConfigConvergence.Service),
        () => ConfigConvergence.noop,
      )
      const config = Option.getOrElse(yield* Effect.serviceOption(Config.Service), () => undefined)
      const storeOpt = Option.getOrElse(yield* Effect.serviceOption(InstanceStore.Service), () => undefined)
      // Service-owned scope for TTL + peer-close fibers (F5/F12). Fibers
      // forked here are interrupted and joined on layer release; per-lease
      // TTL fibers are additionally interrupted on settle.
      const layerScope = yield* Scope.Scope
      const pending = new Map<string, PendingLease>()
      const resolved = new Map<string, ResolvedEntry>()
      const timers = new Map<string, Fiber.Fiber<void, unknown>>()
      const peerFibers = new Set<Fiber.Fiber<void, unknown>>()
      // F-01: serialize acquire check/reserve/begin/register so two concurrent
      // acquires with the same leaseId cannot both raise a fence. The digest
      // comparison lives inside the same critical section.
      const acquireGate = yield* Queue.unbounded<void>()
      yield* Queue.offer(acquireGate, void 0)
      let shuttingDown = false
      let peerGraceScheduled = false

      const interruptTimer = (leaseId: string): Effect.Effect<void> =>
        Effect.gen(function* () {
          const fiber = timers.get(leaseId)
          if (!fiber) return
          timers.delete(leaseId)
          yield* Fiber.interrupt(fiber).pipe(Effect.catchCause(() => Effect.void))
        })

      const snapshotBefore = (files: readonly FileEntry[], auth: ReadonlyMap<string, DirAuth>): Map<string, ResolvedFile> => {
        const m = new Map<string, ResolvedFile>()
        for (const f of files) m.set(f.path, guardedReadResolved(f, auth))
        return m
      }

      /**
       * Authorize one project directory (F8) and capture its stable
       * identity (F-04): the authorized realpath. Every later disk-read
       * round re-verifies the same identity before reading.
       */
      const authorizeDirectory = (directory: string): Effect.Effect<DirAuth> =>
        Effect.gen(function* () {
          const normalized = canonicalDirectory(directory)
          // Top-level symlink swap fails closed here: a replaced lexical
          // directory is a link, never a stable identity.
          const lexicalLink = (() => {
            try {
              return fs.lstatSync(normalized).isSymbolicLink()
            } catch {
              return false
            }
          })()
          if (lexicalLink) return yield* Effect.die(new Error(`directory not authorized: ${directory}`))
          const ancestor = nearestExistingAncestor(normalized)
          if (!ancestor) return yield* Effect.die(new Error(`directory not authorized: ${directory}`))
          const realAncestor = realpathOrNull(ancestor)
          if (!realAncestor) return yield* Effect.die(new Error(`directory not authorized: ${directory}`))
          const remainder = path.relative(ancestor, normalized)
          if (remainder.split(path.sep).includes(".."))
            return yield* Effect.die(new Error(`directory not authorized: ${directory}`))
          const realTarget = remainder ? path.join(realAncestor, remainder) : realAncestor
          // The lexical path must resolve to the authorized realpath when it
          // exists: any symlink component in the remainder is an escape.
          if (ancestor === normalized) {
            const current = realpathOrNull(normalized)
            if (!current || current !== realTarget)
              return yield* Effect.die(new Error(`directory not authorized: ${directory}`))
          }
          const roots: string[] = []
          const pushRoot = (p: string | null): void => {
            if (p && !roots.includes(p)) roots.push(p)
          }
          pushRoot(realpathOrNull(process.cwd()))
          try {
            pushRoot(realpathOrNull(Global.Path.config) ?? Global.Path.config)
          } catch {
            pushRoot(Global.Path.config)
          }
          pushRoot(realpathOrNull(os.tmpdir()))
          let loaded: string[] = []
          if (storeOpt) {
            loaded = yield* storeOpt.directories().pipe(
              Effect.catch(() => Effect.succeed([] as string[])),
              Effect.catchDefect(() => Effect.succeed([] as string[])),
            )
            // Other loaded identities (excluding the target itself) remain
            // authorized roots. The target's own current realpath is never a
            // self-authorizing root — otherwise a symlink swap of a loaded
            // directory would authorize its own escape (F-04).
            for (const d of loaded) {
              if (d === normalized) continue
              pushRoot(realpathOrNull(d) ?? d)
            }
          }
          const trustedContained = roots.some((r) => isWithin(realTarget, r) || isWithin(realAncestor, r))
          if (!trustedContained) {
            // Loaded-identity fallback (F-04): the normalized string matches a
            // cached identity but realpath containment failed. Allow only a
            // stable identity — an existing non-symlink directory. A top-level
            // symlink swap (loaded dir replaced by a link to /etc) must be
            // rejected; nonexistent targets under an authorized parent are
            // already allowed via trustedContained above, so anything else
            // here is rejected.
            const stableIdentity = storeOpt !== undefined && loaded.includes(normalized) && ancestor === normalized
            const link = yield* Effect.sync(() => {
              try {
                return fs.lstatSync(normalized).isSymbolicLink()
              } catch {
                return false
              }
            })
            if (!stableIdentity || link) return yield* Effect.die(new Error(`directory not authorized: ${directory}`))
          }
          // Legal-but-unloaded identity: establish via the store so the
          // fence snapshots the exact pre-fence identity (F8). Nonexistent
          // targets (future writes) skip the load; the parent containment
          // above is their authorization.
          const targetExists = (() => {
            try {
              fs.accessSync(normalized)
              return true
            } catch {
              return false
            }
          })()
          if (!storeOpt) return { expected: realTarget, existed: targetExists } as DirAuth
          if (!targetExists) return { expected: realTarget, existed: false } as DirAuth
          const snap = yield* storeOpt.snapshot(normalized).pipe(
            Effect.catch(() => Effect.succeed(Option.none())),
            Effect.catchDefect(() => Effect.succeed(Option.none())),
          )
          if (snap._tag === "Some") return { expected: realTarget, existed: true } as DirAuth
          const loadExit = yield* storeOpt.load({ directory: normalized }).pipe(Effect.exit)
          if (loadExit._tag === "Failure")
            return yield* Effect.die(new Error(`directory not loadable: ${directory}`))
          return { expected: realTarget, existed: true } as DirAuth
        })

      const authorizeDescriptors = (
        descriptors: readonly ConvergenceDescriptor[],
      ): Effect.Effect<ReadonlyMap<string, DirAuth>> =>
        Effect.gen(function* () {
          const dirs = new Set<string>()
          for (const d of descriptors) {
            if (d.kind === "config" && d.scope === "project") dirs.add(d.directory)
            if (d.kind === "asset" && d.scope === "project") dirs.add(d.directory!)
          }
          const auth = new Map<string, DirAuth>()
          for (const dir of dirs) {
            const entry = yield* authorizeDirectory(dir)
            auth.set(canonicalDirectory(dir), entry)
          }
          return auth as ReadonlyMap<string, DirAuth>
        })

      const hotConverge = (scope: ColdScope): Effect.Effect<void> =>
        Effect.gen(function* () {
          if (!config) return yield* Effect.die(new Error("config service unavailable for hot converge"))
          // Strict fail-preserving operations (F-03): the lenient
          // invalidate/invalidateProject/emitUpdated swallow failures, which
          // would hide a hot failure and lie hot. Hot paths use the strict
          // variants so any failure propagates and the caller falls back to a
          // cold commit (never releases-then-lies-hot).
          const strict = config as typeof config & {
            invalidateStrict?: () => Effect.Effect<void>
            invalidateProjectStrict?: () => Effect.Effect<void>
            emitUpdatedStrict?: (directory: string) => Effect.Effect<void>
          }
          const invalidateGlobal = strict.invalidateStrict ? strict.invalidateStrict() : strict.invalidate()
          const emitUpdated = (directory: string): Effect.Effect<void> =>
            strict.emitUpdatedStrict ? strict.emitUpdatedStrict(directory) : strict.emitUpdated(directory)
          const invalidateDir = (directory: string): Effect.Effect<void> =>
            Effect.gen(function* () {
              if (!storeOpt) {
                if (strict.invalidateProjectStrict) yield* strict.invalidateProjectStrict()
                else yield* strict.invalidateProject()
                return
              }
              const snap = yield* storeOpt.snapshot(directory).pipe(
                Effect.catch(() => Effect.succeed(Option.none())),
                Effect.catchDefect(() => Effect.succeed(Option.none())),
              )
              if (snap._tag === "None") return
              if (strict.invalidateProjectStrict)
                yield* strict.invalidateProjectStrict().pipe(Effect.provideService(InstanceRef, snap.value))
              else yield* strict.invalidateProject().pipe(Effect.provideService(InstanceRef, snap.value))
            })
          if (scope === "global") {
            yield* invalidateGlobal
            if (storeOpt) {
              const dirs = yield* storeOpt.directories().pipe(
                Effect.catch(() => Effect.succeed([] as string[])),
                Effect.catchDefect(() => Effect.succeed([] as string[])),
              )
              yield* Effect.forEach(dirs, invalidateDir, { discard: true })
            } else {
              if (strict.invalidateProjectStrict) yield* strict.invalidateProjectStrict()
              else yield* strict.invalidateProject()
            }
            // Registration order: invalidations complete before the event.
            yield* emitUpdated("global")
            return
          }
          yield* invalidateDir(scope.directory)
          yield* emitUpdated(scope.directory)
        })

      const beforeText = new Map<string, Map<string, string | undefined>>()

      /** Record a terminal and clear all lease state (F-06). */
      const finishTerminal = (lease: PendingLease, terminal: ConvergenceTerminal): Effect.Effect<void> =>
        Effect.sync(() => {
          pending.delete(lease.leaseId)
          beforeText.delete(lease.leaseId)
          resolved.set(lease.leaseId, { terminal, at: Date.now() })
          pruneResolved(resolved)
        })

      /**
       * Terminal failure path (F-06): best-effort release the held fence,
       * clear timer/pending, and record an observable failed terminal with a
       * diagnostic + retry hint. Never throws: the fence release falls back
       * to the raw ticket when the coordinator abort is itself broken, so no
       * failure retains pending + timer-removed + fence-held.
       */
      const failLease = (
        lease: PendingLease,
        scopeOut: ConvergenceTerminal["scope"],
        reason: string,
        retryable: boolean,
      ): Effect.Effect<ConvergenceTerminal> =>
        Effect.gen(function* () {
          yield* convergence.abort(lease.obligation).pipe(
            Effect.catchCause(() =>
              lease.obligation.fence.release.pipe(Effect.asVoid, Effect.catchCause(() => Effect.void)),
            ),
          )
          const terminal: ConvergenceTerminal = {
            leaseId: lease.leaseId,
            outcome: "failed",
            scope: scopeOut,
            reason,
            retryable,
          }
          yield* finishTerminal(lease, terminal)
          return terminal
        })

      /** Single settlement body; runs exactly once per lease (F2). */
      const settle = (lease: PendingLease): Effect.Effect<ConvergenceTerminal> =>
        Effect.gen(function* () {
          // F-02/F-04: every single project read is identity-guarded
          // (verify-before + read + verify-after, detect-before-use). A
          // swap present at either verification discards the bytes and
          // defects to a failed terminal without converging. Global files
          // carry no project guard.
          const after = yield* Effect.sync(() => snapshotBefore(lease.files, lease.auth))
          let outcome: ConvergenceTerminal["outcome"] = "noop"
          let anyChange = false
          let anyUnreadable = false
          for (const f of lease.files) {
            const b = lease.before.get(f.path)
            const a = after.get(f.path)
            if (!b || !a) continue
            if (b.status === "unreadable" || a.status === "unreadable") anyUnreadable = true
            if (b.status !== a.status || b.hash !== a.hash) anyChange = true
          }
          // F-02: unreadable is never absent and never noop/hot — even when the
          // before/after error hashes are stable. A stable unreadable pair
          // still converges cold (boot finally from disk); commit/abort
          // failures below convert to a failed terminal per F-06.
          if (anyUnreadable) {
            outcome = "cold"
          } else if (anyChange) {
            outcome = "cold"
            const onlyConfig = lease.descriptors.every((d) => d.kind === "config")
            if (onlyConfig) {
              const texts = beforeText.get(lease.leaseId)
              if (texts) {
                const keys: string[] = []
                let provable = true
                for (const f of lease.files) {
                  const b = lease.before.get(f.path)
                  const a = after.get(f.path)
                  if (b && a && b.status === a.status && b.hash === a.hash) continue
                  // F-02: hot-proof re-read is identity-guarded per file;
                  // swapped bytes are discarded, never diffed.
                  const bt = texts.get(f.path)
                  const at = guardedReadBytes(f, lease.auth)
                  const diff = diffTopLevelKeys(bt, at)
                  if (diff.includes("*unparseable*") || diff.includes("*existence*")) {
                    provable = false
                    break
                  }
                  keys.push(...diff)
                }
                if (provable) {
                  if (keys.length === 0) outcome = "noop"
                  else if (isHotPatch(Object.fromEntries(keys.map((k) => [k, true])))) outcome = "hot"
                  else outcome = "cold"
                }
              }
            }
          }
          const scopeOut: ConvergenceTerminal["scope"] =
            lease.scope === "global" ? "global" : { directory: lease.scope.directory }
          if (outcome === "cold") {
            const exit = yield* convergence.commit(lease.obligation).pipe(Effect.exit)
            if (exit._tag === "Failure")
              return yield* failLease(lease, scopeOut, `cold commit failed: ${String(exit.cause)}`, true)
            const terminal: ConvergenceTerminal = { leaseId: lease.leaseId, outcome, scope: scopeOut }
            yield* finishTerminal(lease, terminal)
            return terminal
          }
          if (outcome === "hot") {
            // Hot invalidate/emit failure must not leak the fence nor lie
            // hot: fail closed into a cold commit from disk (F-03/F-06).
            const hotExit = yield* hotConverge(lease.scope).pipe(Effect.exit)
            if (hotExit._tag === "Success") {
              const abortExit = yield* convergence.abort(lease.obligation).pipe(Effect.exit)
              if (abortExit._tag === "Failure")
                return yield* failLease(lease, scopeOut, `hot abort failed: ${String(abortExit.cause)}`, true)
              const terminal: ConvergenceTerminal = { leaseId: lease.leaseId, outcome, scope: scopeOut }
              yield* finishTerminal(lease, terminal)
              return terminal
            }
            yield* logRebuildFailure("config-file-convergence hot fallback to cold", hotExit.cause).pipe(
              Effect.catchCause(() => Effect.void),
            )
            const coldExit = yield* convergence.commit(lease.obligation).pipe(Effect.exit)
            if (coldExit._tag === "Failure")
              return yield* failLease(
                lease,
                scopeOut,
                `hot fallback cold commit failed: ${String(coldExit.cause)}`,
                true,
              )
            const terminal: ConvergenceTerminal = { leaseId: lease.leaseId, outcome: "cold", scope: scopeOut }
            yield* finishTerminal(lease, terminal)
            return terminal
          }
          const abortExit = yield* convergence.abort(lease.obligation).pipe(Effect.exit)
          if (abortExit._tag === "Failure")
            return yield* failLease(lease, scopeOut, `noop abort failed: ${String(abortExit.cause)}`, true)
          const terminal: ConvergenceTerminal = { leaseId: lease.leaseId, outcome, scope: scopeOut }
          yield* finishTerminal(lease, terminal)
          return terminal
        })

      /** Shared inflight settlement: concurrent callers get the same terminal (F2). */
      const resolveLeaseEffect = (leaseId: string, _reason: string): Effect.Effect<ConvergenceTerminal> =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const hit = resolved.get(leaseId)
            if (hit) return hit.terminal
            const lease = pending.get(leaseId)
            if (!lease) return yield* Effect.die(new Error(`unknown convergence lease ${leaseId}`))
            const ongoing = lease.inflight
            if (ongoing) {
              yield* restore(Deferred.await(ongoing))
              const done = lease.settlement
              if (done && "terminal" in done) return done.terminal
              // F-06 safety net: a settlement without a terminal must still
              // resolve to an observable failed terminal, never die holding
              // the fence.
              const scopeOut: ConvergenceTerminal["scope"] =
                lease.scope === "global" ? "global" : { directory: lease.scope.directory }
              const terminal: ConvergenceTerminal = {
                leaseId,
                outcome: "failed",
                scope: scopeOut,
                reason: "settlement missing",
                retryable: true,
              }
              return terminal
            }
            const gate = yield* Deferred.make<void>()
            lease.inflight = gate
            lease.settled = true
            // Cancel the TTL fiber: it no longer owns this lease. The TTL
            // path deletes its own entry before calling resolve, so this
            // never self-interrupts (F5).
            const timer = timers.get(leaseId)
            if (timer) timers.delete(leaseId)
            const exit = yield* restore(settle(lease).pipe(Effect.exit))
            if (timer) yield* Fiber.interrupt(timer).pipe(Effect.catchCause(() => Effect.void))
            if (exit._tag === "Success") {
              lease.settlement = { terminal: exit.value }
              yield* Deferred.succeed(gate, void 0).pipe(Effect.catchCause(() => Effect.void))
              return exit.value
            }
            // F-06: settle itself defected (snapshot/read crash). Terminally
            // clear timer/pending, release the fence, and record an observable
            // failed terminal shared by all inflight waiters; later reobserve
            // of the same lease returns the same terminal without recommitting.
            const scopeOut: ConvergenceTerminal["scope"] =
              lease.scope === "global" ? "global" : { directory: lease.scope.directory }
            yield* convergence.abort(lease.obligation).pipe(
              Effect.catchCause(() =>
                lease.obligation.fence.release.pipe(Effect.asVoid, Effect.catchCause(() => Effect.void)),
              ),
            )
            yield* interruptTimer(leaseId)
            const terminal: ConvergenceTerminal = {
              leaseId,
              outcome: "failed",
              scope: scopeOut,
              reason: `settlement failed: ${String(exit.cause)}`,
              retryable: true,
            }
            yield* Effect.sync(() => {
              pending.delete(leaseId)
              beforeText.delete(leaseId)
              resolved.set(leaseId, { terminal, at: Date.now() })
              pruneResolved(resolved)
            })
            lease.settlement = { terminal }
            yield* Deferred.succeed(gate, void 0).pipe(Effect.catchCause(() => Effect.void))
            return terminal
          }),
        )

      const acquireInner = (leaseId: string, descriptors: readonly ConvergenceDescriptor[]): Effect.Effect<AcquireOutcome> =>
        Effect.gen(function* () {
          if (!isNonEmpty(leaseId) || leaseId.length > 128) return yield* Effect.die(new Error("leaseId invalid"))
          const hit = resolved.get(leaseId)
          if (hit) return { resolved: true as const, terminal: hit.terminal }
          const digest = descriptorDigest(descriptors)
          const existing = pending.get(leaseId)
          // Pending replay requires the exact canonical digest (F4). This
          // comparison lives inside the acquire critical section (F-01).
          if (existing) {
            if (existing.digest !== digest) return yield* Effect.die(new Error("descriptor conflict for lease"))
            return { acquired: true as const, leaseId }
          }
          if (shuttingDown) return yield* Effect.die(new Error("convergence shutting down"))
          if (pending.size >= MAX_CONVERGENCE_LEASES) return yield* Effect.die(new Error("lease limit reached"))
          // Authorize project directories and establish store identity
          // before raising the fence (F8). The returned map is the F-04
          // stable identity re-verified before every disk-read round.
          const auth = yield* authorizeDescriptors(descriptors)
          const scope = leaseScopeFor(descriptors)
          const files = resolveDescriptorFiles(descriptors)
          // F-01: begin failure clears the reservation (the gate is released
          // by the ensuring below) and the concurrent caller safely retries
          // with its own begin — never a second fence for one successful
          // acquire, never an untracked timer.
          const obligation = yield* convergence.begin(scope)
          // F-01 second layer: any failure after begin up to successful
          // pending registration precisely releases the same obligation
          // (abort) and interrupts a half-registered timer, so no
          // barrier/pending/timer leaks and the next acquire is usable.
          // Interrupt during this window is also a failure exit and aborts.
          let ttlFiber: Fiber.Fiber<void, unknown> | undefined
          const register = Effect.gen(function* () {
            yield* Effect.sync(() => {
              acquireHooks?.afterAuthorize?.()
            })
            // F-02/F-04: before-read round is identity-guarded per
            // file; a swap injected after authorize is discarded.
            const before = yield* Effect.sync(() => snapshotBefore(files, auth))
            yield* Effect.sync(() => {
              acquireHooks?.afterSnapshot?.()
            })
            const lease: PendingLease = {
              leaseId,
              scope,
              descriptors,
              digest,
              files,
              before,
              obligation,
              auth,
              createdAt: Date.now(),
              settled: false,
              inflight: undefined,
              settlement: undefined,
            }
            yield* Effect.sync(() => {
              pending.set(leaseId, lease)
            })
            // Retain before text for config files (bounded) to allow hot proof.
            // F-02: each before-text read is identity-guarded per file.
            yield* Effect.sync(() => {
              const texts = new Map<string, string | undefined>()
              for (const d of descriptors) {
                if (d.kind !== "config") continue
                const entry: FileEntry =
                  d.scope === "global"
                    ? { path: globalConfigFile() }
                    : { path: projectConfigFile(d.directory), dir: canonicalDirectory(d.directory) }
                texts.set(entry.path, guardedReadBytes(entry, auth)?.slice(0, 1_000_000))
              }
              beforeText.set(leaseId, texts)
            })
            yield* Effect.sync(() => {
              acquireHooks?.beforeTtl?.()
            })
            // Service-owned TTL fiber (F5): expiry runs the same disk-based
            // resolve. The fiber deletes its own entry before resolving so
            // settle never self-interrupts. Resolve/shutdown interrupt it.
            const ttl = leaseTtlMs()
            const fiber = yield* Effect.forkIn(layerScope)(
              Effect.gen(function* () {
                yield* Effect.sleep(Duration.millis(ttl))
                const still = timers.get(leaseId)
                if (!still) return
                timers.delete(leaseId)
                yield* resolveLeaseEffect(leaseId, "ttl").pipe(Effect.catchCause(() => Effect.void))
              }).pipe(Effect.catchCause(() => Effect.void)),
            )
            ttlFiber = fiber
            yield* Effect.sync(() => {
              timers.set(leaseId, fiber)
            })
            return { acquired: true as const, leaseId }
          })
          return yield* register.pipe(
            Effect.onExit((exit) => {
              if (exit._tag === "Success") return Effect.void
              return Effect.gen(function* () {
                const fiber = ttlFiber
                if (fiber) {
                  timers.delete(leaseId)
                  yield* Fiber.interrupt(fiber).pipe(Effect.catchCause(() => Effect.void))
                }
                yield* Effect.sync(() => {
                  pending.delete(leaseId)
                  beforeText.delete(leaseId)
                })
                yield* convergence.abort(obligation).pipe(Effect.catchCause(() => Effect.void))
              })
            }),
          )
        })

      /**
       * F-01 atomic acquire: check/reserve/begin/register run serialized
       * through the service gate. Two concurrent acquires with the same
       * leaseId cannot both pass the pending check — the loser observes the
       * winner's pending entry (same digest) or its resolved terminal, with
       * deterministic result semantics and exactly one physical fence.
       */
      const acquireEffect = (
        leaseId: string,
        descriptors: readonly ConvergenceDescriptor[],
      ): Effect.Effect<AcquireOutcome> =>
        Effect.flatMap(Queue.take(acquireGate), () =>
          Effect.ensuring(
            Effect.uninterruptibleMask((restore) => restore(acquireInner(leaseId, descriptors))),
            Queue.offer(acquireGate, void 0),
          ),
        )

      const peerClosedEffect: Effect.Effect<void> = Effect.gen(function* () {
        if (shuttingDown) return
        if (pending.size === 0) return
        if (peerGraceScheduled) return
        peerGraceScheduled = true
        // Register the tracked grace fiber and return immediately (F12):
        // one bounded delay, no polling, then the same disk-based resolve
        // for every still-unresolved lease (re-read after the grace so
        // leases acquired during the grace are covered). Never plain abort.
        const grace = peerCloseGraceMs()
        const fiber = yield* Effect.forkIn(layerScope)(
          Effect.gen(function* () {
            yield* Effect.sleep(Duration.millis(grace)).pipe(Effect.catchCause(() => Effect.void))
            const ids = [...pending.keys()]
            yield* Effect.forEach(ids, (id) => resolveLeaseEffect(id, "peer-close").pipe(Effect.catchCause(() => Effect.void)), {
              discard: true,
            })
            peerGraceScheduled = false
            peerFibers.delete(fiber)
          }).pipe(Effect.catchCause(() => Effect.void)),
        )
        peerFibers.add(fiber)
      }).pipe(Effect.catchCause(() => Effect.void))

      const shutdownEffect: Effect.Effect<void> = Effect.gen(function* () {
        if (shuttingDown && pending.size === 0 && timers.size === 0 && peerFibers.size === 0) return
        shuttingDown = true
        // F-01 explicit shutdown: interrupt and join all service-owned
        // TTL/peer-grace fibers, then release every unresolved obligation
        // without booting. Production serve calls this via AppRuntime
        // before InstanceStore disposal (Layer release alone is
        // insufficient because serve never disposes AppRuntime). In-flight
        // settlements (caller-owned fibers awaiting the shared gate) are
        // joined: their commit/abort runs under the shuttingDown guard in
        // ConfigConvergence, which releases without forking a boot worker.
        // Idempotent: repeated calls observe empty sets and return.
        const gates = yield* Effect.sync(() => {
          const out: Deferred.Deferred<void>[] = []
          for (const lease of pending.values()) {
            if (lease.inflight) out.push(lease.inflight)
          }
          return out
        })
        for (const fiber of [...peerFibers]) {
          yield* Fiber.interrupt(fiber).pipe(Effect.catchCause(() => Effect.void))
        }
        peerFibers.clear()
        peerGraceScheduled = false
        for (const [id, fiber] of [...timers]) {
          timers.delete(id)
          yield* Fiber.interrupt(fiber).pipe(Effect.catchCause(() => Effect.void))
        }
        const ids = yield* Effect.sync(() => [...pending.keys()])
        yield* Effect.forEach(
          ids,
          (id) =>
            Effect.gen(function* () {
              const lease = pending.get(id)
              if (!lease) return
              if (lease.inflight) return
              pending.delete(id)
              beforeText.delete(id)
              yield* convergence.abort(lease.obligation).pipe(Effect.catchCause(() => Effect.void))
            }),
          { discard: true },
        )
        for (const gate of gates) {
          yield* Deferred.await(gate).pipe(Effect.catchCause(() => Effect.void))
        }
        const leftover = yield* Effect.sync(() => [...pending.keys()])
        yield* Effect.forEach(
          leftover,
          (id) =>
            Effect.gen(function* () {
              const lease = pending.get(id)
              if (!lease) return
              pending.delete(id)
              beforeText.delete(id)
              yield* convergence.abort(lease.obligation).pipe(Effect.catchCause(() => Effect.void))
            }),
          { discard: true },
        )
      })

      const svc: ConfigFileConvergence = {
        acquire: acquireEffect,
        resolve: (leaseId: string) => resolveLeaseEffect(leaseId, "resolve"),
        peerClosed: () => peerClosedEffect,
        shutdown: shutdownEffect,
        unresolvedCount: () => Effect.sync(() => pending.size),
      }
      return Service.of(svc)
    }),
    (svc) => svc.shutdown,
  ),
)

export const defaultLayer = layer

export * as ConfigFileConvergence from "./config-file-convergence"

/** Pure request validators for the fd carrier (fail-closed, no side effects). */
export function validateAcquireRequest(raw: unknown): { leaseId: string; descriptors: readonly ConvergenceDescriptor[] } {
  if (!isRecord(raw)) throw new Error("params must be object")
  const allowed = new Set(["v", "leaseId", "opId", "requestId", "idempotencyKey", "descriptors"])
  for (const k of Object.keys(raw)) if (!allowed.has(k)) throw new Error("unexpected field")
  if (raw.v !== CONVERGENCE_ACQUIRE_VERSION) throw new Error("v must be 1")
  if (!isNonEmpty(raw.leaseId)) throw new Error("leaseId must be non-empty string")
  if (!isNonEmpty(raw.opId)) throw new Error("opId must be non-empty string")
  if (!isNonEmpty(raw.requestId)) throw new Error("requestId must be non-empty string")
  if (!isNonEmpty(raw.idempotencyKey)) throw new Error("idempotencyKey must be non-empty string")
  if (raw.idempotencyKey !== raw.opId || raw.requestId !== raw.opId || raw.leaseId !== raw.opId)
    throw new Error("leaseId/opId/idempotencyKey/requestId must bind to one token")
  if ((raw.leaseId as string).length > 128) throw new Error("leaseId too long")
  const descriptors = validateDescriptors(raw.descriptors)
  return { leaseId: raw.leaseId as string, descriptors }
}

export function validateResolveRequest(raw: unknown): { leaseId: string } {
  if (!isRecord(raw)) throw new Error("params must be object")
  const allowed = new Set(["v", "leaseId", "opId", "requestId", "idempotencyKey"])
  for (const k of Object.keys(raw)) if (!allowed.has(k)) throw new Error("unexpected field")
  if (raw.v !== CONVERGENCE_RESOLVE_VERSION) throw new Error("v must be 1")
  if (!isNonEmpty(raw.leaseId)) throw new Error("leaseId must be non-empty string")
  if (!isNonEmpty(raw.opId)) throw new Error("opId must be non-empty string")
  if (!isNonEmpty(raw.requestId)) throw new Error("requestId must be non-empty string")
  if (!isNonEmpty(raw.idempotencyKey)) throw new Error("idempotencyKey must be non-empty string")
  if (raw.idempotencyKey !== raw.opId || raw.requestId !== raw.opId || raw.leaseId !== raw.opId)
    throw new Error("leaseId/opId/idempotencyKey/requestId must bind to one token")
  return { leaseId: raw.leaseId as string }
}
