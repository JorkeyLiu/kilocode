import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Effect, Layer, Option } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { canonicalDirectory } from "../../src/kilocode/session/canonical-directory"
import { configUiDefaultsPrivate } from "../../src/kilocode/config-ui-defaults"
import { InstanceStore } from "../../src/project/instance-store"
import { TestConfig } from "../fixture/config"

function req(dir: string, requestId = "req-scope-1") {
  return { v: 1 as const, requestId, op: "config/ui-defaults" as const, context: { directory: dir }, payload: {} }
}

function stubStore(directory: string) {
  const ctx = { directory, worktree: directory, project: { id: "test", worktree: directory, vcs: "git", sandboxes: [] } } as unknown as import("../../src/project/instance-context").InstanceContext
  const svc: InstanceStore.Interface = {
    load: () => Effect.succeed(ctx),
    reload: () => Effect.succeed(ctx),
    dispose: () => Effect.void,
    disposeSafe: () => Effect.void,
    disposeDirectory: () => Effect.void,
    disposeAll: () => Effect.void,
    provide: (_input, effect) => effect as never,
    snapshot: () => Effect.succeed(Option.some(ctx)),
    directories: () => Effect.succeed([directory]),
  }
  return Layer.succeed(InstanceStore.Service, svc)
}

describe("config/ui-defaults same-physical-directory scope", () => {
  test("two spellings of the same physical directory both succeed (symlink alias)", async () => {
    const tmpRoot = fs.realpathSync(os.tmpdir())
    const real = await fs.promises.mkdtemp(path.join(tmpRoot, "uidefaults-real-"))
    const realResolved = fs.realpathSync(real)
    const alias = `${realResolved}-alias-${Date.now()}`
    await fs.promises.symlink(realResolved, alias)
    try {
      const aliasResolved = FSUtil.resolve(alias)
      const realEquiv = FSUtil.resolve(realResolved)
      expect(aliasResolved).toBe(realEquiv)
      // Precondition: pure lexical canonicalization keeps the two spellings
      // distinct (macOS /var <-> /private/var is the production instance;
      // the explicit test-owned symlink reproduces it hermetically).
      expect(canonicalDirectory(alias)).not.toBe(canonicalDirectory(realResolved))

      const effective = {
        permission: { edit: "ask" },
        terminal_command_display: "collapsed",
        auto_collapse_reasoning: true,
        sandbox: { enabled: true },
      }
      const run = (dir: string, id: string) =>
        Effect.runPromise(
          (configUiDefaultsPrivate(req(dir, id)) as Effect.Effect<unknown>).pipe(
            Effect.provide(stubStore(realResolved)),
            Effect.provide(TestConfig.layer({ get: () => Effect.succeed(effective as never) })),
          ),
        ) as Promise<Record<string, unknown>>

      const viaReal = await run(realResolved, "req-scope-real")
      expect(viaReal.status).toBe("succeeded")
      const viaAlias = await run(alias, "req-scope-alias")
      expect(viaAlias.status).toBe("succeeded")
      if (viaAlias.status === "succeeded") {
        expect((viaAlias as { requestId: string }).requestId).toBe("req-scope-alias")
        const wire = JSON.stringify((viaAlias as { data: unknown }).data)
        expect(wire).not.toContain("ask")
      }
    } finally {
      await fs.promises.rm(alias, { recursive: true, force: true }).catch(() => undefined)
      await fs.promises.rm(real, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  test("truly different physical directories stay scope_mismatch with no secret leak", async () => {
    const tmpRoot = fs.realpathSync(os.tmpdir())
    const dirA = await fs.promises.mkdtemp(path.join(tmpRoot, "uidefaults-a-"))
    const dirB = await fs.promises.mkdtemp(path.join(tmpRoot, "uidefaults-b-"))
    const permissionToken = "UIDEFAULTS-SECRET-permission-rule-scope-9d21"
    const providerToken = "UIDEFAULTS-SECRET-provider-key-scope-51ae"
    try {
      const realA = fs.realpathSync(dirA)
      const realB = fs.realpathSync(dirB)
      expect(FSUtil.resolve(realA)).not.toBe(FSUtil.resolve(realB))

      const effective = {
        permission: { edit: permissionToken },
        provider: { openai: { key: providerToken } },
        terminal_command_display: "collapsed",
        sandbox: { enabled: true },
      }
      const out = (await Effect.runPromise(
        (configUiDefaultsPrivate(req(realA, "req-scope-cross")) as Effect.Effect<unknown>).pipe(
          // Stored runtime belongs to dirB while the request carries dirA.
          Effect.provide(stubStore(realB)),
          Effect.provide(TestConfig.layer({ get: () => Effect.succeed(effective as never) })),
        ),
      )) as Record<string, unknown>
      expect(out.status).toBe("failed")
      const failure = out.failure as { code: string; message: string; retryable: boolean }
      expect(failure.code).toBe("scope_mismatch")
      expect(failure.message).toBe("directory mismatch")
      expect(failure.retryable).toBe(false)
      expect((out as { data?: unknown }).data).toBeUndefined()
      const wire = JSON.stringify(out)
      expect(wire).not.toContain(permissionToken)
      expect(wire).not.toContain(providerToken)
      expect(wire).not.toContain(realB)
    } finally {
      await fs.promises.rm(dirA, { recursive: true, force: true }).catch(() => undefined)
      await fs.promises.rm(dirB, { recursive: true, force: true }).catch(() => undefined)
    }
  })
})
