import { describe, expect } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import { Auth } from "../../../src/auth"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { testEffect } from "../../lib/effect"

const node = CrossSpawnSpawner.defaultLayer

const it = testEffect(Layer.mergeAll(Auth.defaultLayer, node, FSUtil.defaultLayer))

describe("Auth snapshot/restore (LOCK-002)", () => {
  it.instance("snapshot/restore preserves exact bytes and mode", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const authPath = path.join(Global.Path.data, "auth.json")
      // Trailing 0xff is not valid UTF-8: a string round-trip would corrupt
      // it, so the byte-exact snapshot must preserve it verbatim.
      const raw = new Uint8Array([
        0x7b, 0x22, 0x61, 0x6e, 0x6f, 0x6e, 0x22, 0x3a, 0x20, 0x22, 0x78, 0x22, 0x7d, 0xff,
      ])
      yield* fs.ensureDir(path.dirname(authPath))
      yield* fs.writeFile(authPath, raw)
      yield* fs.chmod(authPath, 0o640)

      const snap = yield* Auth.snapshotFile(fs)
      expect(snap.content).toEqual(raw)
      expect(snap.mode).toBe(0o640)

      // Mutate the file, then restore: exact bytes + mode come back.
      yield* fs.writeFileString(authPath, "{}")
      yield* fs.chmod(authPath, 0o600)
      yield* Auth.restoreFile(fs, snap)
      expect(yield* fs.readFile(authPath)).toEqual(raw)
      const stat = yield* fs.stat(authPath)
      expect(stat.mode & 0o777).toBe(0o640)
    }),
  )

  it.instance("snapshot/restore of a missing file removes it again on restore", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const authPath = path.join(Global.Path.data, "auth.json")
      // Establish the missing-file precondition (an earlier test may have
      // restored the file).
      yield* fs.remove(authPath).pipe(Effect.ignore)
      const snap = yield* Auth.snapshotFile(fs)
      expect(snap.content).toBeUndefined()
      // A concurrent writer created the file after the snapshot; restoring
      // the missing-file snapshot must delete it.
      yield* fs.writeFileString(authPath, "{}")
      yield* Auth.restoreFile(fs, snap)
      expect(yield* fs.exists(authPath)).toBe(false)
    }),
  )
})
