import { Effect } from "effect"
import type { FSUtil } from "@opencode-ai/core/fs-util"

// kilocode_change - write-anchored external drift guard for journal writers.
// Re-reads disk inside the held worktree exclusive and strict-compares
// existence plus raw bytes against the pre-read baseline. Raw bytes keep
// EncodedIO/afs semantics (encoding/BOM/symlink target) without new logic.
// Directory always mismatches: it is neither absent nor file bytes.
export namespace WriteCas {
  export const same = (left: Buffer | null, right: Buffer | null): boolean => {
    if (left === null || right === null) return left === null && right === null
    return left.equals(right)
  }

  export const match = (
    fs: FSUtil.Interface,
    file: string,
    base: Buffer | null,
  ): Effect.Effect<boolean> =>
    Effect.gen(function* () {
      const info = yield* fs
        .stat(file)
        .pipe(Effect.catch(() => Effect.succeed(undefined)), Effect.catchDefect(() => Effect.succeed(undefined)))
      if (!info) return base === null
      if (info.type === "Directory") return false
      const bytes = yield* fs
        .readFile(file)
        .pipe(
          Effect.map((data) => Buffer.from(data)),
          Effect.catch(() => Effect.succeed(undefined as Buffer | undefined)),
          Effect.catchDefect(() => Effect.succeed(undefined as Buffer | undefined)),
        )
      if (!bytes) return false
      return same(base, bytes)
    })

  export const error = (file: string): Error =>
    new Error(`File changed on disk after read; write refused to avoid overwriting external changes: ${file}`)
}
