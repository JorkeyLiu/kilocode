import { describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { cliSnapshotSourceUsable, createCliSnapshot } from "../../script/p0-bench/snapshot"

function shaOf(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex")
}

function execMode(file: string): boolean {
  return (statSync(file).mode & 0o111) !== 0
}

describe("p0 CLI snapshot (immutable per-campaign binary)", () => {
  it("copies the source to a run-owned temp path, preserves the executable bit, and records provenance", () => {
    const root = join(tmpdir(), `kilo-p0-snap-test-${process.pid}-${Date.now()}`)
    mkdirSync(join(root, "src"), { recursive: true })
    try {
      const source = join(root, "src", "kilo")
      writeFileSync(source, "#!/bin/sh\nfake-benchmark-binary\n", { mode: 0o755 })
      const snap = createCliSnapshot(source, tmpdir())
      try {
        // Run-owned temp location, never the versioned evidence dir.
        expect(snap.info.snapshotPath.startsWith(tmpdir())).toBe(true)
        expect(snap.info.snapshotPath.endsWith("/kilo")).toBe(true)
        expect(existsSync(snap.info.snapshotPath)).toBe(true)
        expect(readFileSync(snap.info.snapshotPath, "utf8")).toBe("#!/bin/sh\nfake-benchmark-binary\n")
        expect(execMode(snap.info.snapshotPath)).toBe(true)
        expect(snap.info.sourcePath).toBe(source)
        expect(snap.info.sourceSha256).toBe(shaOf(source))
        expect(snap.info.snapshotSha256).toBe(snap.info.sourceSha256)
        expect(snap.info.sourceSize).toBe(statSync(source).size)
        expect(snap.info.snapshotSize).toBe(snap.info.sourceSize)
        expect(snap.info.createdAt).toBeGreaterThan(0)
      } finally {
        snap.cleanup()
      }
      // Cleanup deletes the run-owned snapshot.
      expect(existsSync(snap.info.snapshotPath)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("keeps the measured binary byte-identical when the source is overwritten mid-campaign", () => {
    const root = join(tmpdir(), `kilo-p0-snap-overwrite-${process.pid}-${Date.now()}`)
    mkdirSync(join(root, "src"), { recursive: true })
    try {
      const source = join(root, "src", "kilo")
      writeFileSync(source, "original-binary-v1\n", { mode: 0o755 })
      const snap = createCliSnapshot(source, tmpdir())
      try {
        const recordedSha = snap.info.snapshotSha256!
        // The non-owned watcher overwrites bin/kilo mid-campaign.
        writeFileSync(source, "OVERWRITTEN-BY-WATCHER-v2\n", { mode: 0o755 })
        expect(shaOf(source)).not.toBe(recordedSha)
        // The measured snapshot is untouched: path, bytes, and recorded SHA.
        expect(shaOf(snap.info.snapshotPath)).toBe(recordedSha)
        expect(snap.info.snapshotSha256).toBe(recordedSha)
        expect(readFileSync(snap.info.snapshotPath, "utf8")).toBe("original-binary-v1\n")
      } finally {
        snap.cleanup()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("fails safely before launch when the source binary is missing", () => {
    const root = join(tmpdir(), `kilo-p0-snap-missing-${process.pid}-${Date.now()}`)
    mkdirSync(root, { recursive: true })
    try {
      expect(() => createCliSnapshot(join(root, "no-such-kilo"), tmpdir())).toThrow()
      expect(cliSnapshotSourceUsable(join(root, "no-such-kilo"))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("fails safely before launch when the source binary is not executable", () => {
    const root = join(tmpdir(), `kilo-p0-snap-noexec-${process.pid}-${Date.now()}`)
    mkdirSync(join(root, "src"), { recursive: true })
    try {
      const source = join(root, "src", "kilo")
      writeFileSync(source, "not-executable\n", { mode: 0o644 })
      expect(cliSnapshotSourceUsable(source)).toBe(false)
      expect(() => createCliSnapshot(source, tmpdir())).toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("cleanup is idempotent and never throws on a second call", () => {
    const root = join(tmpdir(), `kilo-p0-snap-clean-${process.pid}-${Date.now()}`)
    mkdirSync(join(root, "src"), { recursive: true })
    try {
      const source = join(root, "src", "kilo")
      writeFileSync(source, "x\n", { mode: 0o755 })
      const snap = createCliSnapshot(source, tmpdir())
      snap.cleanup()
      expect(existsSync(snap.info.snapshotPath)).toBe(false)
      expect(() => snap.cleanup()).not.toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
