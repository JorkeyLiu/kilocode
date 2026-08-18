/**
 * P4.1 Config Foundation — Paths tests.
 *
 * Covers:
 * - Canonical path resolution
 * - Roots injection for test isolation
 * - Asset directory paths
 */

import { describe, expect, it } from "bun:test"
import { Roots, globalConfigFile, projectConfigFile, assetDir, resolveCanonicalPaths, CONFIG_FILENAME } from "../../../src/config/paths"

describe("Roots", () => {
  it("defaults global root to ~/.config/kilo", () => {
    const roots = new Roots("/workspace")
    expect(roots.getGlobalRoot()).toContain(".config/kilo")
    expect(roots.getProjectRoot()).toBe("/workspace")
  })

  it("accepts custom global root", () => {
    const roots = new Roots("/workspace", "/custom/global")
    expect(roots.getGlobalRoot()).toBe("/custom/global")
    expect(roots.getProjectRoot()).toBe("/workspace")
  })

  it("returns undefined project root when none provided", () => {
    const roots = new Roots(undefined)
    expect(roots.getProjectRoot()).toBeUndefined()
    expect(roots.getGlobalRoot()).toContain(".config/kilo")
  })
})

describe("canonical paths", () => {
  it("CONFIG_FILENAME is kilo.jsonc", () => {
    expect(CONFIG_FILENAME).toBe("kilo.jsonc")
  })

  it("global config file is <globalRoot>/kilo.jsonc", () => {
    const roots = new Roots("/workspace", "/global")
    expect(globalConfigFile(roots)).toBe("/global/kilo.jsonc")
  })

  it("project config file is <workspaceRoot>/.kilo/kilo.jsonc", () => {
    const roots = new Roots("/workspace", "/global")
    expect(projectConfigFile(roots)).toBe("/workspace/.kilo/kilo.jsonc")
  })

  it("project config file is undefined when no project root", () => {
    const roots = new Roots(undefined, "/global")
    expect(projectConfigFile(roots)).toBeUndefined()
  })

  it("asset dirs under global root", () => {
    const roots = new Roots("/workspace", "/global")
    expect(assetDir(roots, "global", "agent")).toBe("/global/agent")
    expect(assetDir(roots, "global", "command")).toBe("/global/command")
    expect(assetDir(roots, "global", "skill")).toBe("/global/skill")
    expect(assetDir(roots, "global", "tool")).toBe("/global/tool")
    expect(assetDir(roots, "global", "plugin")).toBe("/global/plugin")
    expect(assetDir(roots, "global", "rules")).toBe("/global/rules")
  })

  it("asset dirs under project root", () => {
    const roots = new Roots("/workspace", "/global")
    expect(assetDir(roots, "project", "agent")).toBe("/workspace/.kilo/agent")
    expect(assetDir(roots, "project", "command")).toBe("/workspace/.kilo/command")
    expect(assetDir(roots, "project", "skill")).toBe("/workspace/.kilo/skill")
    expect(assetDir(roots, "project", "tool")).toBe("/workspace/.kilo/tool")
    expect(assetDir(roots, "project", "plugin")).toBe("/workspace/.kilo/plugin")
    expect(assetDir(roots, "project", "rules")).toBe("/workspace/.kilo/rules")
  })

  it("project asset dirs are undefined when no project root", () => {
    const roots = new Roots(undefined, "/global")
    expect(assetDir(roots, "project", "agent")).toBeUndefined()
  })

  it("resolveCanonicalPaths returns all paths", () => {
    const roots = new Roots("/workspace", "/global")
    const paths = resolveCanonicalPaths(roots)
    expect(paths.globalRoot).toBe("/global")
    expect(paths.globalConfigFile).toBe("/global/kilo.jsonc")
    expect(paths.projectRoot).toBe("/workspace")
    expect(paths.projectConfigFile).toBe("/workspace/.kilo/kilo.jsonc")
    expect(Object.keys(paths.globalAssetDirs)).toHaveLength(6)
    expect(paths.projectAssetDirs).toBeDefined()
    expect(Object.keys(paths.projectAssetDirs!)).toHaveLength(6)
  })

  it("resolveCanonicalPaths returns no project paths when no project root", () => {
    const roots = new Roots(undefined, "/global")
    const paths = resolveCanonicalPaths(roots)
    expect(paths.globalRoot).toBe("/global")
    expect(paths.globalConfigFile).toBe("/global/kilo.jsonc")
    expect(paths.projectRoot).toBeUndefined()
    expect(paths.projectConfigFile).toBeUndefined()
    expect(Object.keys(paths.globalAssetDirs)).toHaveLength(6)
    expect(paths.projectAssetDirs).toBeUndefined()
  })
})
