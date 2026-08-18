/**
 * P4.1 Config foundation — path resolution tests.
 *
 * Uses run-owned temp directories with real filesystem operations.
 * No mocks; no vscode dependency.
 */

import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { Roots, globalConfigFile, projectConfigFile, assetDir, resolveCanonicalPaths, CONFIG_FILENAME, sameCanonicalPath } from "../../src/config/paths"

let root: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-config-paths-"))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe("canonical paths", () => {
  describe("Roots", () => {
    it("creates roots with explicit global and project", () => {
      const globalRoot = path.join(root, "global")
      const projectRoot = path.join(root, "project")
      const roots = new Roots(projectRoot, globalRoot)

      expect(roots.getGlobalRoot()).toBe(globalRoot)
      expect(roots.getProjectRoot()).toBe(projectRoot)
    })

    it("defaults global root to ~/.config/kilo when not provided", () => {
      const projectRoot = path.join(root, "project")
      const roots = new Roots(projectRoot)
      expect(roots.getGlobalRoot()).toContain(".config")
      expect(roots.getGlobalRoot()).toContain("kilo")
      expect(roots.getProjectRoot()).toBe(projectRoot)
    })

    it("returns undefined project root when none provided", () => {
      const roots = new Roots(undefined)
      expect(roots.getProjectRoot()).toBeUndefined()
      expect(roots.getGlobalRoot()).toContain(".config")
    })
  })

  describe("CONFIG_FILENAME", () => {
    it("is kilo.jsonc per R10", () => {
      expect(CONFIG_FILENAME).toBe("kilo.jsonc")
    })
  })

  describe("globalConfigFile", () => {
    it("resolves to <globalRoot>/kilo.jsonc", () => {
      const gRoot = path.join(root, "global")
      const pRoot = path.join(root, "project")
      const roots = new Roots(pRoot, gRoot)
      const expected = path.join(gRoot, "kilo.jsonc")
      expect(globalConfigFile(roots)).toBe(expected)
    })
  })

  describe("projectConfigFile", () => {
    it("resolves to <projectRoot>/.kilo/kilo.jsonc", () => {
      const gRoot = path.join(root, "global")
      const pRoot = path.join(root, "project")
      const roots = new Roots(pRoot, gRoot)
      const expected = path.join(pRoot, ".kilo", "kilo.jsonc")
      expect(projectConfigFile(roots)).toBe(expected)
    })

    it("returns undefined when no project root", () => {
      const gRoot = path.join(root, "global")
      const roots = new Roots(undefined, gRoot)
      expect(projectConfigFile(roots)).toBeUndefined()
    })
  })

  describe("assetDir", () => {
    it("resolves global asset dirs under globalRoot", () => {
      const gRoot = path.join(root, "global")
      const pRoot = path.join(root, "project")
      const roots = new Roots(pRoot, gRoot)
      expect(assetDir(roots, "global", "agent")).toBe(path.join(gRoot, "agent"))
      expect(assetDir(roots, "global", "command")).toBe(path.join(gRoot, "command"))
      expect(assetDir(roots, "global", "skill")).toBe(path.join(gRoot, "skill"))
      expect(assetDir(roots, "global", "tool")).toBe(path.join(gRoot, "tool"))
      expect(assetDir(roots, "global", "plugin")).toBe(path.join(gRoot, "plugin"))
      expect(assetDir(roots, "global", "rules")).toBe(path.join(gRoot, "rules"))
    })

    it("resolves project asset dirs under projectRoot/.kilo", () => {
      const gRoot = path.join(root, "global")
      const pRoot = path.join(root, "project")
      const roots = new Roots(pRoot, gRoot)
      expect(assetDir(roots, "project", "agent")).toBe(path.join(pRoot, ".kilo", "agent"))
      expect(assetDir(roots, "project", "command")).toBe(path.join(pRoot, ".kilo", "command"))
      expect(assetDir(roots, "project", "skill")).toBe(path.join(pRoot, ".kilo", "skill"))
      expect(assetDir(roots, "project", "tool")).toBe(path.join(pRoot, ".kilo", "tool"))
      expect(assetDir(roots, "project", "plugin")).toBe(path.join(pRoot, ".kilo", "plugin"))
      expect(assetDir(roots, "project", "rules")).toBe(path.join(pRoot, ".kilo", "rules"))
    })

    it("returns undefined for project asset dirs when no project root", () => {
      const gRoot = path.join(root, "global")
      const roots = new Roots(undefined, gRoot)
      expect(assetDir(roots, "project", "agent")).toBeUndefined()
    })
  })

  describe("resolveCanonicalPaths", () => {
    it("resolves all canonical paths", () => {
      const gRoot = path.join(root, "global")
      const pRoot = path.join(root, "project")
      const roots = new Roots(pRoot, gRoot)
      const paths = resolveCanonicalPaths(roots)

      expect(paths.globalRoot).toBe(gRoot)
      expect(paths.globalConfigFile).toBe(path.join(gRoot, "kilo.jsonc"))
      expect(paths.projectRoot).toBe(pRoot)
      expect(paths.projectConfigFile).toBe(path.join(pRoot, ".kilo", "kilo.jsonc"))
      expect(paths.globalAssetDirs.agent).toBe(path.join(gRoot, "agent"))
      expect(paths.projectAssetDirs!.agent).toBe(path.join(pRoot, ".kilo", "agent"))
      expect(paths.globalAssetDirs.command).toBe(path.join(gRoot, "command"))
      expect(paths.projectAssetDirs!.command).toBe(path.join(pRoot, ".kilo", "command"))
    })

    it("returns no project paths when no project root", () => {
      const gRoot = path.join(root, "global")
      const roots = new Roots(undefined, gRoot)
      const paths = resolveCanonicalPaths(roots)

      expect(paths.globalRoot).toBe(gRoot)
      expect(paths.globalConfigFile).toBe(path.join(gRoot, "kilo.jsonc"))
      expect(paths.projectRoot).toBeUndefined()
      expect(paths.projectConfigFile).toBeUndefined()
      expect(paths.projectAssetDirs).toBeUndefined()
    })
  })

  describe("sameCanonicalPath", () => {
    it("matches Windows separators independently of the host platform", () => {
      expect(sameCanonicalPath("C:\\workspace\\.kilo\\agent", "C:/workspace/.kilo/agent")).toBe(true)
      expect(sameCanonicalPath("C:\\workspace\\.kilo\\agent", "D:/workspace/.kilo/agent")).toBe(false)
    })
  })
})
