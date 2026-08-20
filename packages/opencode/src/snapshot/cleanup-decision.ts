import { Cause, Effect, Option } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { ProjectV2 } from "@opencode-ai/core/project"
import * as Log from "@opencode-ai/core/util/log"
import { fetchLiveHashes } from "./live-collector"

const log = Log.create({ service: "snapshot.cleanup" })

export function shouldPrune(live: ReadonlySet<string> | null): boolean {
  return live !== null
}

export const resolveLiveForPrune = (projectID: ProjectV2.ID): Effect.Effect<ReadonlySet<string> | null> =>
  Effect.serviceOption(Database.Service).pipe(
    Effect.flatMap((opt) => {
      if (Option.isNone(opt)) return Effect.succeed(null)
      const { db } = opt.value
      return fetchLiveHashes(db, projectID).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            log.warn("failed to collect live snapshots, skipping prune", { cause: Cause.pretty(cause) })
            return null
          }),
        ),
      )
    }),
  )
