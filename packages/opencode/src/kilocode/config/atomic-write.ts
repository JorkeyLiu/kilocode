/**
 * Atomic config target writes (LOCK-003).
 *
 * Every config target commit goes through temp-file + rename so a concurrent
 * reader never observes a partially written config file. The temp file is
 * removed on typed error, defect, and interruption; on success the rename
 * moves it away and the cleanup finalizer is a no-op.
 *
 * Missing parent directories are created on ENOENT (mirroring the previous
 * `writeWithDirs` behavior for freshly created `.kilo/` targets).
 */
import path from "path"
import type { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect } from "effect"

export namespace KilocodeAtomicWrite {
  /**
   * Atomically replace `file` with `content` via a unique temp file + rename.
   * Fails (dies) with the underlying platform error on any write/rename
   * failure so the caller can roll back other committed targets.
   */
  export const write = Effect.fnUntraced(function* (
    fs: FSUtil.Interface,
    file: string,
    content: string,
  ) {
    const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
    const attempt = Effect.gen(function* () {
      yield* fs.writeFileString(tmp, content)
      yield* fs.rename(tmp, file)
    })
    yield* attempt.pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () =>
          Effect.gen(function* () {
            yield* fs.ensureDir(path.dirname(file))
            yield* attempt
          }),
      ),
      Effect.orDie,
      // rename moves the temp away on success; on any failure or interruption
      // the temp must not be left behind (LOCK-006).
      Effect.ensuring(fs.remove(tmp).pipe(Effect.ignore)),
    )
  })
}
