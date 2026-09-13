import * as fs from "fs"
import * as path from "path"
import type { AssetDirectory, AssetScanResult, CanonicalPaths } from "./types"
import { isValidAssetId } from "./service-views"

export type AssetPathClass =
  | { readonly kind: "ignore" }
  | { readonly kind: "nested"; readonly changedPath: string }
  | { readonly kind: "invalid-id"; readonly id: string }
  | { readonly kind: "valid"; readonly id: string }

export type AssetDescriptorLike = {
  readonly kind: "asset"
  readonly asset: AssetDirectory
  readonly scope: "global" | "project"
  readonly directory?: string
  readonly id: string
}

/**
 * Classify one watcher path for non-skill asset observe.
 * Only direct `<asset>/<id>.md` yields `valid`; nested subdir, non-`.md`,
 * and off-directory paths stay fail-soft (`ignore`/`nested`), invalid ids
 * stay fail-soft with a diagnostic and no error descriptor. Never expands
 * the single-segment descriptor schema. Skills use classifySkillPath.
 */
export function classifyAssetPath(expectedDir: string, changedPath: string): AssetPathClass {
  const base = path.basename(changedPath)
  if (!base.endsWith(".md")) return { kind: "ignore" }
  const relative = path.relative(expectedDir, changedPath)
  if (relative.startsWith("..") || path.isAbsolute(relative) || relative === "") return { kind: "ignore" }
  if (path.dirname(relative) !== ".") return { kind: "nested", changedPath }
  const id = base.slice(0, -".md".length)
  if (!isValidAssetId(id)) return { kind: "invalid-id", id }
  return { kind: "valid", id }
}

export function assetDescriptor(
  scope: "global" | "project",
  dir: AssetDirectory,
  projectRoot: string | undefined,
  id: string,
): AssetDescriptorLike {
  if (scope === "global") return { kind: "asset", asset: dir, scope: "global", id }
  return { kind: "asset", asset: dir, scope: "project", directory: projectRoot!, id }
}

export type PathMeta = { readonly id: string; readonly hash: string }

export function priorByPathFor(scan: AssetScanResult | null, scope: "global" | "project", expectedDir: string): Map<string, PathMeta> {
  const out = new Map<string, PathMeta>()
  if (!scan) return out
  for (const e of scan.entries) {
    if (e.scope === scope && e.filePath.startsWith(expectedDir)) out.set(e.filePath, { id: e.id, hash: e.contentHash })
  }
  return out
}

export function currentByPathFor(scan: AssetScanResult, scope: "global" | "project", expectedDir: string): Map<string, PathMeta> {
  const out = new Map<string, PathMeta>()
  for (const e of scan.entries) {
    if (e.scope === scope && e.filePath.startsWith(expectedDir)) out.set(e.filePath, { id: e.id, hash: e.contentHash })
  }
  return out
}

export function errorFilesOf(scan: AssetScanResult): Set<string> {
  return new Set(scan.errors.map((e) => e.file).filter((f): f is string => typeof f === "string"))
}

/**
 * Diff prior vs current scan for the fallback (no changedPath) watcher path.
 * Returns one descriptor per added/changed/removed id, skipping error files
 * and invalid ids. Dedupes by id so rename (remove old + add new) keeps both.
 */
export function diffAssetDescriptors(
  scope: "global" | "project",
  dir: AssetDirectory,
  projectRoot: string | undefined,
  prior: ReadonlyMap<string, PathMeta>,
  current: ReadonlyMap<string, PathMeta>,
  errorFiles: ReadonlySet<string>,
): AssetDescriptorLike[] {
  const out: AssetDescriptorLike[] = []
  const push = (id: string): void => {
    if (!isValidAssetId(id)) return
    if (out.some((d) => d.id === id)) return
    out.push(assetDescriptor(scope, dir, projectRoot, id))
  }
  for (const [filePath, cur] of current) {
    if (errorFiles.has(filePath)) continue
    const prev = prior.get(filePath)
    if (!prev || prev.hash !== cur.hash || prev.id !== cur.id) push(cur.id)
  }
  for (const [filePath, prev] of prior) {
    if (!current.has(filePath) && !errorFiles.has(filePath)) push(prev.id)
  }
  return out
}

export type AssetRead = { readonly type: "present"; readonly hash: string } | { readonly type: "absent" } | { readonly type: "other" }

/** True when a watcher event is external (not an own-write hash hit). Consumes absent markers via `drop`. */
export function isExternalAssetEvent(read: AssetRead, marker: string | undefined, drop: () => void, coalesce: (hash: string) => boolean): boolean {
  if (read.type === "present") return !coalesce(read.hash)
  if (read.type === "absent") {
    drop()
    return marker !== "absent"
  }
  return false
}

/** Fallback scan decision for dir watchers without a changedPath. */
export function hasExternalChangeInDir(
  listFiles: () => string[],
  priorSize: number,
  read: (filePath: string) => AssetRead,
  coalesce: (filePath: string, hash: string) => boolean,
): boolean {
  try {
    const files = listFiles()
    if (files.length === 0) return priorSize > 0
    for (const filePath of files) {
      const r = read(filePath)
      if (r.type !== "present" || !coalesce(filePath, r.hash)) return true
    }
    return false
  } catch {
    return true
  }
}

/** Canonical skill roots for one scope (singular + plural alias, no second wire asset). */
export function skillRootsFor(paths: CanonicalPaths, scope: "global" | "project"): string[] {
  if (scope === "global") return [paths.globalAssetDirs.skill, path.join(paths.globalRoot, "skills")]
  if (!paths.projectAssetDirs || !paths.projectRoot) return []
  return [paths.projectAssetDirs.skill, path.join(paths.projectRoot, ".kilo", "skills")]
}

export type SkillPathClass =
  | { readonly kind: "ignore" }
  | { readonly kind: "nested"; readonly changedPath: string }
  | { readonly kind: "invalid-id"; readonly id: string }
  | { readonly kind: "valid"; readonly id: string }

/**
 * Classify one watcher path under a specific skill root.
 * Only exact `<root>/<name>/SKILL.md` with a valid name yields `valid`.
 * Root-level flat `.md`, other basenames, deeper nesting, and off-root
 * paths stay fail-soft (`ignore`, or `nested` with a diagnostic for
 * `<name>/...` violations). Never a flat skill file, never schema expansion.
 */
export function classifySkillPath(expectedDir: string, changedPath: string): SkillPathClass {
  const relative = path.relative(expectedDir, changedPath)
  if (relative.startsWith("..") || path.isAbsolute(relative) || relative === "") return { kind: "ignore" }
  if (path.basename(changedPath) !== "SKILL.md") return { kind: "ignore" }
  const dir = path.dirname(relative)
  if (dir === "." || dir.includes(path.sep)) return { kind: "nested", changedPath }
  if (!isValidAssetId(dir)) return { kind: "invalid-id", id: dir }
  return { kind: "valid", id: dir }
}

/** Logical skill id for an exact `<root>/<name>/SKILL.md` file, else undefined. */
export function skillIdFromFile(expectedDir: string, filePath: string): string | undefined {
  const cls = classifySkillPath(expectedDir, filePath)
  return cls.kind === "valid" ? cls.id : undefined
}

/** Enumerate existing `<root>/<name>/SKILL.md` files across skill roots. */
export function listSkillFiles(roots: readonly string[]): string[] {
  const out: string[] = []
  for (const root of roots) {
    let names: string[]
    try {
      names = fs.readdirSync(root)
    } catch {
      continue
    }
    for (const name of names) {
      if (name.startsWith(".")) continue
      const candidate = path.join(root, name, "SKILL.md")
      try {
        const stat = fs.statSync(candidate)
        if (stat.isFile()) out.push(candidate)
      } catch {
        continue
      }
    }
  }
  return out
}

export type SkillMeta = { readonly hash: string; readonly valid: boolean }

/**
 * Diff prior vs current skill files by logical id across both roots.
 * Dedupes by logical id so singular/plural same-name never loses a trigger.
 * Emits added/changed-valid plus removed (prior existed, current missing).
 */
export function diffSkillDescriptors(
  scope: "global" | "project",
  projectRoot: string | undefined,
  roots: readonly string[],
  prior: ReadonlyMap<string, SkillMeta>,
  current: ReadonlyMap<string, SkillMeta>,
): AssetDescriptorLike[] {
  const out: AssetDescriptorLike[] = []
  const push = (id: string): void => {
    if (!isValidAssetId(id)) return
    if (out.some((d) => d.id === id)) return
    out.push(assetDescriptor(scope, "skill", projectRoot, id))
  }
  const idOf = (filePath: string): string | undefined => {
    for (const root of roots) {
      const id = skillIdFromFile(root, filePath)
      if (id !== undefined) return id
    }
    return undefined
  }
  for (const [filePath, cur] of current) {
    const id = idOf(filePath)
    if (id === undefined) continue
    const prev = prior.get(filePath)
    if (!prev || prev.hash !== cur.hash) {
      if (cur.valid) push(id)
    }
  }
  for (const [filePath] of prior) {
    if (!current.has(filePath)) {
      const id = idOf(filePath)
      if (id !== undefined) push(id)
    }
  }
  return out
}

export type SkillHost = {
  readonly isDisposed: () => boolean
  readonly hasProject: boolean
  readonly projectRoot: string | undefined
  readonly roots: readonly string[]
  readonly prior: () => ReadonlyMap<string, SkillMeta>
  readonly scanCurrent: () => ReadonlyMap<string, SkillMeta>
  readonly readValid: (filePath: string) => "present-valid" | "present-invalid" | "absent" | "other"
  readonly runExternal: (prepare: () => boolean) => Promise<void>
  readonly commit: (current: ReadonlyMap<string, SkillMeta>) => void
  readonly notify: (descs: readonly AssetDescriptorLike[]) => void
  readonly error: (message: string) => void
}

/**
 * Skill watcher orchestration across singular/plural roots (vscode-free).
 * Wire descriptor stays logical `{asset:"skill", id}`; guards/enumeration
 * cover both `<root>/skill/<name>/SKILL.md` and `<root>/skills/<name>/SKILL.md`.
 * GUI write/delete/index semantics stay agent-only (no skill own-write here);
 * every external skill event is cold. Rename/delete keep old+new logical ids
 * via per-descriptor dedup in the shared accumulator.
 */
export function handleSkillChanged(host: SkillHost, scope: "global" | "project", changedPath?: string): void {
  if (host.isDisposed()) return
  if (scope === "project" && !host.hasProject) return
  if (changedPath) {
    let rootOf: string | undefined
    for (const root of host.roots) {
      const relative = path.relative(root, changedPath)
      if (!relative.startsWith("..") && !path.isAbsolute(relative) && relative !== "") {
        rootOf = root
        break
      }
    }
    if (rootOf === undefined) return
    const cls = classifySkillPath(rootOf, changedPath)
    if (cls.kind === "ignore") return
    if (cls.kind !== "valid") {
      host.error(cls.kind === "nested" ? `Skill observe skipped: nested path ${changedPath}; expected <name>/SKILL.md` : `Skill observe skipped: invalid skill id ${cls.id}`)
      return
    }
    const id = cls.id
    void host
      .runExternal(() => {
        if (host.isDisposed()) return false
        return true
      })
      .then(() => {
        if (host.isDisposed()) return
        host.commit(host.scanCurrent())
        const state = host.readValid(changedPath)
        if (state === "other" || state === "present-invalid") return
        host.notify([assetDescriptor(scope, "skill", host.projectRoot, id)])
      })
      .catch((err) => host.error(`Skill watcher convergence failed: ${String(err)}`))
    return
  }
  const prior = host.prior()
  void host
    .runExternal(() => {
      if (host.isDisposed()) return false
      return true
    })
    .then(() => {
      if (host.isDisposed()) return
      const current = host.scanCurrent()
      const descs = diffSkillDescriptors(scope, host.projectRoot, host.roots, prior, current)
      host.commit(current)
      if (descs.length > 0) host.notify(descs)
    })
    .catch((err) => host.error(`Skill watcher convergence failed: ${String(err)}`))
}

export type AssetHost = {
  readonly isDisposed: () => boolean
  readonly hasProject: boolean
  readonly projectRoot: string | undefined
  readonly expectedDir: string
  readonly lastScan: () => AssetScanResult | null
  readonly read: (filePath: string) => AssetRead
  readonly listDirFiles: () => string[]
  readonly markerOf: (filePath: string) => string | undefined
  readonly dropMarker: (filePath: string) => void
  readonly coalesce: (filePath: string, hash: string) => boolean
  readonly rescan: () => void
  readonly runExternal: (prepare: () => boolean) => Promise<void>
  readonly hasScanError: (filePath: string) => boolean
  readonly notify: (descs: readonly AssetDescriptorLike[]) => void
  readonly error: (message: string) => void
}

/** Full asset watcher orchestration (vscode-free). Rename/delete arrive as separate events; each id is kept. */
export function handleAssetChanged(
  host: AssetHost,
  scope: "global" | "project",
  dir: AssetDirectory,
  changedPath?: string,
): void {
  if (host.isDisposed()) return
  if (scope === "project" && !host.hasProject) return
  if (changedPath) {
    const cls = classifyAssetPath(host.expectedDir, changedPath)
    if (cls.kind === "ignore") return
    if (cls.kind !== "valid") {
      host.error(cls.kind === "nested" ? `Asset observe skipped: nested path ${changedPath}; descriptor schema is single-segment id` : `Asset observe skipped: invalid asset id ${cls.id}`)
      return
    }
    const read = host.read(changedPath)
    if (!isExternalAssetEvent(read, host.markerOf(changedPath), () => host.dropMarker(changedPath), (h) => host.coalesce(changedPath, h))) return
    void host
      .runExternal(() => {
        if (host.isDisposed()) return false
        host.rescan()
        return true
      })
      .then(() => {
        if (host.isDisposed() || host.hasScanError(changedPath)) return
        host.notify([assetDescriptor(scope, dir, host.projectRoot, cls.id)])
      })
      .catch((err) => host.error(`Asset watcher convergence failed: ${String(err)}`))
    return
  }
  const prior = priorByPathFor(host.lastScan(), scope, host.expectedDir)
  void host
    .runExternal(() => {
      if (host.isDisposed()) return false
      if (!hasExternalChangeInDir(host.listDirFiles, prior.size, host.read, host.coalesce)) return false
      host.rescan()
      return true
    })
    .then(() => {
      if (host.isDisposed()) return
      const scan = host.lastScan()
      if (!scan) return
      const descs = diffAssetDescriptors(scope, dir, host.projectRoot, prior, currentByPathFor(scan, scope, host.expectedDir), errorFilesOf(scan))
      if (descs.length > 0) host.notify(descs)
    })
    .catch((err) => host.error(`Asset watcher convergence failed: ${String(err)}`))
}
