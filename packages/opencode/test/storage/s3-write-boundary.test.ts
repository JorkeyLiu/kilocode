import { describe, expect } from "bun:test"
import path from "path"
import fs from "node:fs/promises"
import { Effect, Exit, Layer } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Global } from "@opencode-ai/core/global"
import { Storage } from "@/storage/storage"
import * as Artifact from "@opencode-ai/core/retention/artifact"
import { writeExclusiveJson, writeFamilyExclusiveJson, storageFileForKey } from "@/storage/claimed-file"
import { testEffect } from "../lib/effect"

const dir = path.join(Global.Path.data, "storage")
const it = testEffect(Layer.mergeAll(Storage.defaultLayer, FSUtil.defaultLayer, CrossSpawnSpawner.defaultLayer))

const scope = Effect.fnUntraced(function* () {
  const root = ["session_diff", `test-${crypto.randomUUID()}`]
  const fs = yield* FSUtil.Service
  const svc = yield* Storage.Service
  yield* Effect.addFinalizer(() =>
    fs.remove(path.join(dir, ...root), { recursive: true, force: true }).pipe(Effect.ignore),
  )
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
      const err = yield* Effect.flip(
        svc.update<{ v: number }>(key, (draft) => {
          draft.v += 1
        }),
      )
      expect(err).toBeInstanceOf(Storage.NotFoundError)
      expect(err._tag).toBe("NotFoundError")
    }),
  )

  it.live("registered write and update succeed", () =>
    Effect.gen(function* () {
      const { root, svc } = yield* scope()
      const key = [...root, "registered-ok"]
      yield* svc.write(key, { v: 1 })
      const updated = yield* svc.update<{ v: number }>(key, (draft) => {
        draft.v += 1
      })
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

  it.live("assertStrictFamilyWrite allows family kinds and rejects snapshot/legacy/unknown/empty", () =>
    Effect.gen(function* () {
      expect(() => Artifact.assertStrictFamilyWrite(["session_diff", "id"])).not.toThrow()
      expect(() => Artifact.assertStrictFamilyWrite(["session_diff_base", "id"])).not.toThrow()
      expect(() => Artifact.assertStrictFamilyWrite(["session_share", "id"])).not.toThrow()
      expect(() => Artifact.assertStrictFamilyWrite(["snapshot", "id"])).toThrow()
      expect(() => Artifact.assertStrictFamilyWrite(["session-export.db", "id"])).toThrow()
      expect(() => Artifact.assertStrictFamilyWrite(["unregistered_xyz"])).toThrow()
      expect(() => Artifact.assertStrictFamilyWrite([])).toThrow()
      const ok = Artifact.assertStrictFamilyWriteEffect(["session_share", "id"])
      expect((ok as { _tag: string })._tag).toBe("ok")
      expect(Artifact.assertStrictFamilyWriteEffect(["snapshot", "id"])).toBeInstanceOf(
        Artifact.UnregisteredArtifactError,
      )
      expect(Artifact.assertStrictFamilyWriteEffect(["session-export.db"])).toBeInstanceOf(
        Artifact.UnregisteredArtifactError,
      )
      expect(Artifact.assertStrictFamilyWriteEffect(["unknown"])).toBeInstanceOf(Artifact.UnregisteredArtifactError)
      expect(Artifact.assertStrictFamilyWriteEffect([])).toBeInstanceOf(Artifact.UnregisteredArtifactError)
    }),
  )

  it.live("writeFamilyExclusiveJson allows family kinds", () =>
    Effect.gen(function* () {
      const svcFs = yield* FSUtil.Service
      const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()]
      const keys: string[][] = [
        ["session_diff", ids[0]!],
        ["session_diff_base", ids[1]!],
        ["session_share", ids[2]!],
      ]
      for (const key of keys) {
        const target = storageFileForKey(key)
        yield* Effect.addFinalizer(() => svcFs.remove(target).pipe(Effect.ignore))
        yield* Effect.promise(() => writeFamilyExclusiveJson(key, { v: 1 }))
        const raw = yield* Effect.promise(() => fs.readFile(target, "utf8").then((t) => JSON.parse(t)))
        expect(raw).toEqual({ v: 1 })
      }
    }),
  )

  it.live("writeFamilyExclusiveJson rejects snapshot/legacy/unknown/empty", () =>
    Effect.gen(function* () {
      const cases: string[][] = [["snapshot", "id"], ["session-export.db", "id"], ["unregistered_xyz", "id"], []]
      for (const key of cases) {
        const exit = yield* Effect.promise(() => writeFamilyExclusiveJson(key, { v: 1 })).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          const cause = String(exit.cause)
          expect(cause).toContain("UnregisteredArtifactError")
        }
        const direct = yield* Effect.tryPromise({
          try: () => writeFamilyExclusiveJson(key, { v: 1 }),
          catch: (e) => e as unknown,
        }).pipe(
          Effect.flip,
          Effect.map((e) => e as Artifact.UnregisteredArtifactError),
          Effect.exit,
        )
        expect(Exit.isSuccess(direct)).toBe(true)
        if (key.length > 0) {
          const target = storageFileForKey(key)
          const exists = yield* Effect.promise(() =>
            fs
              .stat(target)
              .then(() => true)
              .catch(() => false),
          )
          expect(exists).toBe(false)
        }
      }
    }),
  )

  it.live("bare writeExclusiveJson still usable for sandbox", () =>
    Effect.gen(function* () {
      const svcFs = yield* FSUtil.Service
      const tmp = path.join(Global.Path.data, "tmp-sandbox-test", `${crypto.randomUUID()}.json`)
      yield* Effect.addFinalizer(() => svcFs.remove(tmp).pipe(Effect.ignore))
      yield* Effect.promise(() =>
        writeExclusiveJson(tmp, {
          enabled: true,
          mode: "allow" as const,
          allowedHosts: [],
          writablePaths: [],
          version: 0,
        }),
      )
      const raw = yield* Effect.promise(() => fs.readFile(tmp, "utf8").then((t) => JSON.parse(t)))
      expect(raw.enabled).toBe(true)
    }),
  )
})
