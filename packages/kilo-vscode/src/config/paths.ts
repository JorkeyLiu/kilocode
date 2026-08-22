/**
 * P4.1 Canonical config foundation — path resolution.
 *
 * Fixed canonical paths per R10:
 * - Global: `<globalRoot>/kilo.jsonc`
 * - Project: `<workspaceRoot>/.kilo/kilo.jsonc`
 * - Asset dirs: `agent`, `command`, `skill`, `tool`, `plugin`, `rules` under each root
 *
 * Injection points (Roots class) allow tests to override OS-dependent
 * roots without touching real filesystem paths.
 */

import * as path from "path"
import * as os from "os"
import type { AssetDirectory, CanonicalPaths } from "./types"
import { ASSET_DIRECTORIES } from "./types"

/**
 * Default global config root, spec-compliant XDG resolution: `$XDG_CONFIG_HOME/kilo`
 * when XDG_CONFIG_HOME is set to an absolute path, otherwise `<homedir>/.config/kilo`.
 * Per the XDG base-directory spec, a non-absolute or empty override is ignored and
 * falls through to the homedir path. This follows the spec directly; it is not an
 * exact match of xdg-basedir's implementation.
 */
export function defaultGlobalRoot(): string {
  const override = process.env.XDG_CONFIG_HOME
  if (override !== undefined && path.isAbsolute(override)) return path.join(override, "kilo")
  return path.join(os.homedir(), ".config", "kilo")
}

/**
 * Injectable roots for test isolation. All path resolution flows through
 * this so tests can point at temp directories without OS-level side effects.
 */
export class Roots {
  private readonly globalRoot: string
  private readonly projectRoot: string | undefined

  constructor(projectRoot: string | undefined, globalRoot?: string) {
    this.projectRoot = projectRoot
    this.globalRoot = globalRoot ?? defaultGlobalRoot()
  }

  static default(projectRoot: string | undefined): Roots {
    return new Roots(projectRoot)
  }

  getGlobalRoot(): string {
    return this.globalRoot
  }

  getProjectRoot(): string | undefined {
    return this.projectRoot
  }
}

/** Canonical config file name (LOCK-010 / R10). */
export const CONFIG_FILENAME = "kilo.jsonc"

/** Global config file path. */
export function globalConfigFile(roots: Roots): string {
  return path.join(roots.getGlobalRoot(), CONFIG_FILENAME)
}

/** Project config file path. Returns undefined when no project root. */
export function projectConfigFile(roots: Roots): string | undefined {
  const projectRoot = roots.getProjectRoot()
  if (projectRoot === undefined) return undefined
  return path.join(projectRoot, ".kilo", CONFIG_FILENAME)
}

/** Asset directory path for a given scope and directory name. Returns undefined for project scope when no project root. */
export function assetDir(roots: Roots, scope: "global" | "project", dir: AssetDirectory): string | undefined {
  if (scope === "global") return path.join(roots.getGlobalRoot(), dir)
  const projectRoot = roots.getProjectRoot()
  if (projectRoot === undefined) return undefined
  return path.join(projectRoot, ".kilo", dir)
}

/** Resolve all canonical paths. */
export function resolveCanonicalPaths(roots: Roots): CanonicalPaths {
  const globalAssetDirs: Record<AssetDirectory, string> = {} as Record<AssetDirectory, string>

  for (const dir of ASSET_DIRECTORIES) {
    globalAssetDirs[dir] = path.join(roots.getGlobalRoot(), dir)
  }

  const projectRoot = roots.getProjectRoot()
  if (projectRoot === undefined) {
    return {
      globalRoot: roots.getGlobalRoot(),
      globalConfigFile: globalConfigFile(roots),
      projectRoot: undefined,
      projectConfigFile: undefined,
      globalAssetDirs,
      projectAssetDirs: undefined,
    }
  }

  const projectAssetDirs: Record<AssetDirectory, string> = {} as Record<AssetDirectory, string>
  for (const dir of ASSET_DIRECTORIES) {
    projectAssetDirs[dir] = path.join(projectRoot, ".kilo", dir)
  }

  return {
    globalRoot: roots.getGlobalRoot(),
    globalConfigFile: globalConfigFile(roots),
    projectRoot,
    projectConfigFile: path.join(projectRoot, ".kilo", CONFIG_FILENAME),
    globalAssetDirs,
    projectAssetDirs,
  }
}

/** Compare authored paths with the platform API represented by the input. */
export function sameCanonicalPath(a: string, b: string): boolean {
  const win = /^(?:[A-Za-z]:[\\/]|\\\\)/.test(a) || /^(?:[A-Za-z]:[\\/]|\\\\)/.test(b) || a.includes("\\") || b.includes("\\")
  const api = win ? path.win32 : path
  return api.normalize(api.resolve(a)) === api.normalize(api.resolve(b))
}
