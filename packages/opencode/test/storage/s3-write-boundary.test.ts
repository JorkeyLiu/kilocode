import { describe, expect } from "bun:test"
import path from "path"
import { Effect, Exit, Layer } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Global } from "@opencode-ai/core/global"
import { Storage } from "@/storage/storage"
import * as Artifact from "@opencode-ai/core/retention/artifact"
import { testEffect } from "../lib/effect"

const dir = path.join(Global.Path.data, "storage")
const it = testEffect(Layer.mergeAll(Storage.defaultLayer, FSUtil.defaultLayer, CrossSpawnSpawner.defaultLayer))

const scope = Effect.fnUntraced(function* () {
  const root = ["session_diff", `test-${crypto.randomUUID()}`]
  const fs = yield* FSUtil.Service
  const svc = yield* Storage.Service
  yield* Effect.addFinalizer(() => fs.remove(path.join(dir, ...root), { recursive: true, force: true }).pipe(Effect.ignore))
  return { root, svc }
})

describe("S3 write boundary", () => {
  it.live("unknown write fails with UnregisteredArtifactError", () =>
    Effect.gen(function* () {
      const { svc } = yield* scope()
      const exit = yield* svc.write(["unregistered_xyz", "id"], { foo: "bar" }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const str = String(exit.cause)
        expect(str).toContain("UnregisteredArtifactError")
      }
      const err = yield* Effect.flip(svc.write(["unregistered_xyz", "id"], { foo: "bar" }))
      expect(err).toBeInstanceOf(Artifact.UnregisteredArtifactError)
      expect((err as Artifact.UnregisteredArtifactError)._tag).toBe("UnregisteredArtifactError")
    }),
  )

  it.live("empty write fails with UnregisteredArtifactError", () =>
    Effect.gen(function* () {
      const { svc } = yield* scope()
      const err = yield* Effect.flip(svc.write([], { foo: "bar" }))
      expect(err).toBeInstanceOf(Artifact.UnregisteredArtifactError)
      expect(String(err.message)).toContain("empty")
    }),
  )

  it.live("unknown update fails with UnregisteredArtifactError", () =>
    Effect.gen(function* () {
      const { svc } = yield* scope()
      const err = yield* Effect.flip(svc.update(["unregistered_xyz", "id"], () => {}))
      expect(err).toBeInstanceOf(Artifact.UnregisteredArtifactError)
    }),
  )

  it.live("empty update fails with UnregisteredArtifactError", () =>
    Effect.gen(function* () {
      const { svc } = yield* scope()
      const err = yield* Effect.flip(svc.update([], () => {}))
      expect(err).toBeInstanceOf(Artifact.UnregisteredArtifactError)
    }),
  )

  it.live("registered update on missing key throws NotFoundError", () =>
    Effect.gen(function* () {
      const { root, svc } = yield* scope()
      const key = [...root, "missing-update-target"]
      const err = yield* Effect.flip(svc.update<{ v: number }>(key, (draft) => { draft.v += 1 }))
      expect(err).toBeInstanceOf(Storage.NotFoundError)
      expect(err._tag).toBe("NotFoundError")
    }),
  )

  it.live("registered write and update succeed", () =>
    Effect.gen(function* () {
      const { root, svc } = yield* scope()
      const key = [...root, "registered-ok"]
      yield* svc.write(key, { v: 1 })
      const updated = yield* svc.update<{ v: number }>(key, (draft) => { draft.v += 1 })
      expect(updated).toEqual({ v: 2 })
      expect(yield* svc.read<{ v: number }>(key)).toEqual({ v: 2 })
    }),
  )

  it.live("assertFamilyWrite fails on empty prefix", () =>
    Effect.gen(function* () {
      expect(() => Artifact.assertFamilyWrite([])).toThrow()
      try {
        Artifact.assertFamilyWrite([])
        expect(false).toBe(true)
      } catch (err) {
        expect(err).toBeInstanceOf(Artifact.UnregisteredArtifactError)
      }
      const eff = Artifact.assertFamilyWriteEffect([])
      expect(eff).toBeInstanceOf(Artifact.UnregisteredArtifactError)
    }),
  )

  it.live("assertFamilyWrite passes registered family kinds and fails unknown", () =>
    Effect.gen(function* () {
      expect(() => Artifact.assertFamilyWrite(["session_diff", "id"])).not.toThrow()
      expect(() => Artifact.assertFamilyWrite(["snapshot", "id"])).not.toThrow()
      expect(() => Artifact.assertFamilyWrite(["unregistered_xyz"])).toThrow()
      const effOk = Artifact.assertFamilyWriteEffect(["session_share", "id"])
      expect((effOk as { _tag: string })._tag).toBe("ok")
      const effFail = Artifact.assertFamilyWriteEffect(["unknown"])
      expect(effFail).toBeInstanceOf(Artifact.UnregisteredArtifactError)
    }),
  )
})
