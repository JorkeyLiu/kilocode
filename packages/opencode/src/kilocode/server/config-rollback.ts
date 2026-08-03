// kilocode_change - new file
/**
 * Shared compensating-rollback primitive for cold config mutations
 * (LOCK-004/006). `restoreTarget` restores a committed config target to its
 * exact pre-mutation state: write the original content back atomically, or
 * delete a newly created target. Deletion tolerates an already-missing file;
 * every other failure surfaces as a rollback failure. Used by both the custom
 * provider delete and save services so one byte-exact restore path covers
 * every committed target.
 */

import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect } from "effect"
import type { Config } from "@/config/config"
import { KilocodeAtomicWrite } from "@/kilocode/config/atomic-write"

/** Restore a committed target to its exact pre-mutation state (LOCK-003). */
export const restoreTarget = (fs: FSUtil.Interface, artifact: Config.PreparedConfig) =>
  artifact.original === undefined
    ? fs.remove(artifact.path).pipe(
        Effect.catchIf((error) => error.reason._tag === "NotFound", () => Effect.void),
        Effect.orDie,
      )
    : KilocodeAtomicWrite.write(fs, artifact.path, artifact.original)
