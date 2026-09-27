import * as path from "path"
import type { AssetDirectory, AssetScanResult, CanonicalPaths } from "./types"
import { ASSET_DIRECTORIES } from "./types"
import { sameCanonicalPath } from "./paths"
import { isValidAssetId } from "./service-views"
import { skillRootsFor, skillIdFromFile, type SkillMeta } from "./asset-observe"
import type { ConvergenceDescriptor } from "./convergence"

export type LifecycleInput = {
  readonly paths: CanonicalPaths
  readonly hasProject: boolean
  readonly projectRoot: string | undefined
  readonly materializationReady: boolean
  readonly globalHash: string | null
  readonly projectHash: string | null
  readonly scan: AssetScanResult | null
  readonly skills: ReadonlyMap<string, SkillMeta>
}

export function descriptorKey(d: ConvergenceDescriptor): string {
  if (d.kind === "config") return d.scope === "global" ? "config|global" : `config|project|${d.directory}`
  const dir = d.scope === "global" ? "" : (d.directory ?? "")
  return `asset|${d.asset}|${d.scope}|${dir}|${d.id}`
}

function typeForFile(paths: CanonicalPaths, file: string): AssetDirectory | null {
  const dir = path.dirname(file)
  for (const name of ASSET_DIRECTORIES) {
    if (name === "skill") continue
    if (sameCanonicalPath(dir, paths.globalAssetDirs[name])) return name
    const p = paths.projectAssetDirs?.[name]
    if (p && sameCanonicalPath(dir, p)) return name
  }
  return null
}

function configDescs(input: LifecycleInput, put: (d: ConvergenceDescriptor) => void): void {
  if (input.globalHash !== null) put({ kind: "config", scope: "global" })
  if (input.hasProject && input.projectRoot && input.projectHash !== null) {
    put({ kind: "config", scope: "project", directory: input.projectRoot })
  }
}

function assetDescs(input: LifecycleInput, put: (d: ConvergenceDescriptor) => void): void {
  const scan = input.scan
  if (!scan) return
  const errors = new Set(scan.errors.map((e) => e.file).filter((f): f is string => typeof f === "string"))
  // Duplicate global/project ids are NOT filtered here. Extension
  // materialization retains both scan entries and reports a conflict via
  // selector diagnostics; the backend resolves per-file descriptors with its
  // own deterministic precedence/conflict handling. Filtering both would
  // converge wrong (backend reads neither while extension retains both).
  // Incremental asset observe already notifies per changed id, so bootstrap
  // must emit both scopes to match rather than none.
  for (const e of scan.entries) {
    if (errors.has(e.filePath)) continue
    if (!isValidAssetId(e.id)) continue
    if (e.scope === "project" && (!input.hasProject || !input.projectRoot)) continue
    const t = typeForFile(input.paths, e.filePath)
    if (!t) continue
    if (e.scope === "global") put({ kind: "asset", asset: t, scope: "global", id: e.id })
    else put({ kind: "asset", asset: t, scope: "project", directory: input.projectRoot!, id: e.id })
  }
}

function skillScope(
  input: LifecycleInput,
  file: string,
  gRoots: readonly string[],
  pRoots: readonly string[],
): { id: string; scope: "global" | "project" } | null {
  for (const r of gRoots) {
    const v = skillIdFromFile(r, file)
    if (v !== undefined) return { id: v, scope: "global" }
  }
  if (!input.hasProject || !input.projectRoot) return null
  for (const r of pRoots) {
    const v = skillIdFromFile(r, file)
    if (v !== undefined) return { id: v, scope: "project" }
  }
  return null
}

function skillDescs(input: LifecycleInput, put: (d: ConvergenceDescriptor) => void): void {
  const gRoots = skillRootsFor(input.paths, "global")
  const pRoots = input.hasProject ? skillRootsFor(input.paths, "project") : []
  for (const [file, meta] of input.skills) {
    if (!meta.valid) continue
    const found = skillScope(input, file, gRoots, pRoots)
    if (!found || !isValidAssetId(found.id)) continue
    if (found.scope === "global") put({ kind: "asset", asset: "skill", scope: "global", id: found.id })
    else put({ kind: "asset", asset: "skill", scope: "project", directory: input.projectRoot!, id: found.id })
  }
}

/**
 * Validated on-disk descriptors for lifecycle rebuild. Pure, no IO.
 * [] when not ready/empty/invalid — caller never borrows empty-notify default.
 */
export function buildLifecycleDescriptors(input: LifecycleInput): ConvergenceDescriptor[] {
  if (!input.materializationReady) return []
  const out = new Map<string, ConvergenceDescriptor>()
  const put = (d: ConvergenceDescriptor): void => {
    const k = descriptorKey(d)
    if (!out.has(k)) out.set(k, d)
  }
  configDescs(input, put)
  assetDescs(input, put)
  skillDescs(input, put)
  return [...out.values()].sort((a, b) => (descriptorKey(a) < descriptorKey(b) ? -1 : 1))
}

/** Notify scope covering mixed global/project batches in one coalescer call. */
export function lifecycleNotifyScope(descs: readonly ConvergenceDescriptor[], hasProject: boolean): "global" | "project" {
  if (hasProject && descs.some((d) => d.scope === "project")) return "project"
  return "global"
}

/**
 * Single lifecycle gate: init-done + FD-ready, once; else retain intent, no timer.
 * Returns validated descriptors when the one cold enumeration should be sent.
 * Empty/invalid (undefined) retains the intent so a later FD-ready or a
 * post-correction notify can still send it. Fired-once is owned by the caller.
 */
export function pollLifecycleDescs(
  gate: { disposed: boolean; initCompleted: boolean; lifecycleFired: boolean },
  probe: (() => boolean) | undefined,
  input: LifecycleInput,
): ConvergenceDescriptor[] | undefined {
  if (gate.disposed || !gate.initCompleted || gate.lifecycleFired) return undefined
  let ready = false
  try {
    ready = probe?.() ?? false
  } catch {
    ready = false
  }
  if (!ready) return undefined
  const descs = buildLifecycleDescriptors(input)
  if (descs.length === 0) return undefined
  return descs
}

/** Fingerprint for init-gap asset comparison (entries + errors + duplicates). */
export function scanFp(scan: AssetScanResult | null): string {
  if (!scan) return "null"
  const entries = [...scan.entries]
    .map((e) => `${e.scope}|${e.id}|${e.filePath}|${e.contentHash}`)
    .sort()
    .join(";")
  return `${entries}#${scan.errors.length}#${scan.duplicateIds.length}`
}

/** Fingerprint for init-gap skill comparison. */
export function skillFp(skills: ReadonlyMap<string, SkillMeta> | null): string {
  if (!skills) return "null"
  return [...skills.entries()]
    .map(([f, m]) => `${f}|${m.hash}|${m.valid}`)
    .sort()
    .join(";")
}
