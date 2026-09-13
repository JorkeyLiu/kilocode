import { Effect } from "effect"
import type { FSUtil } from "@opencode-ai/core/fs-util"

// kilocode_change - formatter single-target contract: the formatter is a
// same-path writer for exactly one target path, never a multi-file
// transaction. In-place edits and atomic renames are both allowed, so
// inode/dev may change. After format.file runs, the target must still be a
// regular readable file before any sync/raw read/journal.apply: missing,
// directory/device/FIFO/socket/unknown, dangling symlink, and unreadable
// all fail closed with no disk restore. A symlink to a regular file stats
// as File and stays allowed. Sidecars outside the target are never
// inspected here; they stay out of metadata/journal/planner/revert/CAS.
export namespace FormatTarget {
  export const check = (fs: FSUtil.Interface, file: string): Effect.Effect<void, Error> =>
    Effect.gen(function* () {
      const info = yield* fs.stat(file).pipe(
        Effect.catch(() => Effect.fail(fail(file))),
        Effect.catchDefect(() => Effect.fail(fail(file))),
      )
      if (info.type !== "File") return yield* Effect.fail(fail(file))
      yield* fs.access(file, { readable: true }).pipe(
        Effect.catch(() => Effect.fail(fail(file))),
        Effect.catchDefect(() => Effect.fail(fail(file))),
      )
    })
}

const fail = (file: string): Error =>
  new Error(`Formatter left target missing or not a readable file; refusing to record journal: ${file}`)
