import { describe, expect, test } from "bun:test"
import {
  descriptorDigest,
  diffTopLevelKeys,
  leaseScopeFor,
  resolveDescriptorPaths,
  validateAcquireRequest,
  validateDescriptors,
  validateResolveRequest,
} from "@/kilocode/server/config-file-convergence"
import { isHotPatch } from "@/kilocode/config/hot-keys"

describe("config-file-convergence descriptors", () => {
  test("closed descriptor set with binding validation", () => {
    const dir = "/tmp/proj"
    const descriptors = validateDescriptors([
      { kind: "config", scope: "project", directory: dir },
      { kind: "asset", asset: "agent", scope: "project", directory: dir, id: "helper" },
    ])
    expect(descriptors.length).toBe(2)
    expect(leaseScopeFor(descriptors)).toEqual({ directory: dir })
    const files = resolveDescriptorPaths(descriptors)
    expect(files.length).toBe(2)
    expect(files[0]!.endsWith(".kilo/kilo.jsonc")).toBe(true)
    expect(files[1]!.endsWith("agent/helper.md")).toBe(true)
  })

  test("skill descriptor resolves to singular+plural SKILL.md candidates, never flat", () => {
    const project = validateDescriptors([
      { kind: "asset", asset: "skill", scope: "project", directory: "/tmp/proj", id: "helper" },
    ])
    const files = resolveDescriptorPaths(project)
    expect(files.length).toBe(2)
    expect(files[0]!.endsWith(".kilo/skill/helper/SKILL.md")).toBe(true)
    expect(files[1]!.endsWith(".kilo/skills/helper/SKILL.md")).toBe(true)
    expect(files.some((f) => f.endsWith("skill/helper.md"))).toBe(false)
    const global = validateDescriptors([{ kind: "asset", asset: "skill", scope: "global", id: "helper" }])
    const gfiles = resolveDescriptorPaths(global)
    expect(gfiles.length).toBe(2)
    expect(gfiles[0]!.endsWith("skill/helper/SKILL.md")).toBe(true)
    expect(gfiles[1]!.endsWith("skills/helper/SKILL.md")).toBe(true)
  })

  test("global descriptor strengthens to global fence", () => {
    const descriptors = validateDescriptors([
      { kind: "config", scope: "global" },
      { kind: "config", scope: "project", directory: "/tmp/proj" },
    ])
    expect(leaseScopeFor(descriptors)).toBe("global")
  })

  test("multi-directory project lease rejected", () => {
    expect(() =>
      validateDescriptors([
        { kind: "config", scope: "project", directory: "/tmp/a" },
        { kind: "config", scope: "project", directory: "/tmp/b" },
      ]),
    ).toThrow()
  })

  test("shape validation rejects traversal ids and unknown fields", () => {
    // Normalized traversal escapes (e.g. /tmp/a/../../etc -> /etc) are an
    // authorization rejection at acquire time, not a shape rejection here;
    // shape validation only normalizes. Asset ids stay a closed segment set.
    expect(() => validateDescriptors([{ kind: "config", scope: "project", directory: "/tmp/a/../../etc" } as never])).not.toThrow()
    expect(() =>
      validateDescriptors([{ kind: "asset", asset: "agent", scope: "global", id: "../evil" } as never]),
    ).toThrow()
    expect(() => validateDescriptors([{ kind: "config", scope: "global", path: "/etc/passwd" } as never])).toThrow()
  })

  test("descriptor digest is order-independent and exact (F4)", () => {
    const a = validateDescriptors([
      { kind: "config", scope: "global" },
      { kind: "config", scope: "project", directory: "/tmp/p" },
    ])
    void a
    const d1 = descriptorDigest([
      { kind: "config", scope: "project", directory: "/tmp/p" },
      { kind: "asset", asset: "agent", scope: "project", directory: "/tmp/p", id: "helper" },
    ])
    const d2 = descriptorDigest([
      { kind: "asset", asset: "agent", scope: "project", directory: "/tmp/p", id: "helper" },
      { kind: "config", scope: "project", directory: "/tmp/p" },
    ])
    expect(d1).toBe(d2)
    const d3 = descriptorDigest([
      { kind: "config", scope: "project", directory: "/tmp/p" },
      { kind: "asset", asset: "agent", scope: "project", directory: "/tmp/p", id: "other" },
    ])
    expect(d3).not.toBe(d1)
    const d4 = descriptorDigest([{ kind: "config", scope: "global" }])
    expect(d4).not.toBe(d1)
    // Scope confusion changes the digest: project vs global never collide.
    const d5 = descriptorDigest([{ kind: "asset", asset: "agent", scope: "global", id: "helper" }])
    expect(d5).not.toBe(d1)
  })

  test("acquire/resolve binding requires single token", () => {
    const id = "gui-1"
    const descriptors = [{ kind: "config", scope: "global" }]
    const acquire = validateAcquireRequest({ v: 1, leaseId: id, opId: id, requestId: id, idempotencyKey: id, descriptors })
    expect(acquire.leaseId).toBe(id)
    expect(() =>
      validateAcquireRequest({ v: 1, leaseId: id, opId: "other", requestId: id, idempotencyKey: id, descriptors }),
    ).toThrow()
    const resolve = validateResolveRequest({ v: 1, leaseId: id, opId: id, requestId: id, idempotencyKey: id })
    expect(resolve.leaseId).toBe(id)
  })

  test("hot vs cold classification from top-level keys", () => {
    const before = JSON.stringify({ model: "a", permission: { ask: true } })
    const afterHot = JSON.stringify({ model: "b", permission: { ask: true } })
    const keys = diffTopLevelKeys(before, afterHot)
    expect(keys).toEqual(["model"])
    expect(isHotPatch(Object.fromEntries(keys.map((k) => [k, true])))).toBe(true)
    const afterCold = JSON.stringify({ model: "a", permission: { ask: true }, mcp: {} })
    const coldKeys = diffTopLevelKeys(before, afterCold)
    expect(isHotPatch(Object.fromEntries(coldKeys.map((k) => [k, true])))).toBe(false)
    expect(diffTopLevelKeys(before, before)).toEqual([])
    // Existence and unparseable diffs are never hot-provable.
    expect(diffTopLevelKeys(undefined, afterHot)).toEqual(["*existence*"])
    expect(diffTopLevelKeys("{not json", afterHot)).toEqual(["*unparseable*"])
  })
})
