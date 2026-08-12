import { describe, expect, it, mock } from "bun:test"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Deterministic mid-snapshot overwrite: intercept copyFileSync so that, right
// after the real copy, the source is overwritten exactly like the non-owned
// dev watcher would (script/watch-cli.ts rebuilds bin/kilo on source changes).
// This simulates the watcher hitting the copy→re-read window inside
// createCliSnapshot without any timing dependency or large files. All fs
// access goes through createRequire so the mock factory can never run before
// `req` is initialized (no static "node:fs" import in this file).
const req = createRequire(import.meta.url)
let mutate = false
mock.module("node:fs", () => {
  const real = req("node:fs") as typeof import("node:fs")
  return {
    ...real,
    copyFileSync: (src: string, dst: string) => {
      real.copyFileSync(src, dst)
      if (mutate) real.writeFileSync(src, "OVERWRITTEN-BY-WATCHER-v2\n")
    },
  }
})

const { createCliSnapshot } = await import("../../script/p0-bench/snapshot")

describe("p0 CLI snapshot provenance race (source overwritten mid-snapshot)", () => {
  it("fails safely before launch when the source changes between copy and verification", () => {
    const root = join(tmpdir(), `kilo-p0-snap-race-${process.pid}-${Date.now()}`)
    try {
      const source = join(root, "kilo")
      req("node:fs").mkdirSync(root, { recursive: true })
      req("node:fs").writeFileSync(source, "original-binary-v1\n", { mode: 0o755 })
      mutate = true
      try {
        expect(() => createCliSnapshot(source, root)).toThrow(/provenance mismatch/)
      } finally {
        mutate = false
      }
      // The failed snapshot must not leave a run-owned snapshot dir behind.
      expect(req("node:fs").readdirSync(root).filter((name: string) => name.startsWith("kilo-p0-cli-"))).toEqual(
        [],
      )
    } finally {
      req("node:fs").rmSync(root, { recursive: true, force: true })
    }
  })

  it("records matching provenance when the source is not overwritten during the copy", () => {
    const root = join(tmpdir(), `kilo-p0-snap-race-ok-${process.pid}-${Date.now()}`)
    try {
      const source = join(root, "kilo")
      req("node:fs").mkdirSync(root, { recursive: true })
      req("node:fs").writeFileSync(source, "original-binary-v1\n", { mode: 0o755 })
      const snap = createCliSnapshot(source, root)
      try {
        expect(snap.info.sourceSha256).toBe(snap.info.snapshotSha256)
        expect(snap.info.sourceSize).toBe(snap.info.snapshotSize)
      } finally {
        snap.cleanup()
      }
    } finally {
      req("node:fs").rmSync(root, { recursive: true, force: true })
    }
  })
})
