// kilocode_change - new file
import { Effect } from "effect"
import { ConfigErrorV1 } from "@opencode-ai/core/v1/config/error"
import { ConfigOverlayInvalidError } from "@/kilocode/server/httpapi/groups/config-console"

/**
 * Map deep `ConfigInvalidError` / `ConfigJsonError` defects to the typed 400
 * the endpoint declares, carrying the file path, message, and Zod issues, so
 * the SDK decodes the structured body and the VS Code settings panel can
 * render it without losing the user's drafts (LOCK-007). Any other defect
 * stays a defect so the generic defect middleware still reports it. Used by
 * the overlay and both legacy `/config` and `/global/config` PATCH handlers.
 */
export const configFailure = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E | ConfigOverlayInvalidError> =>
  effect.pipe(
    Effect.catchDefect((defect) => {
      if (ConfigErrorV1.InvalidError.isInstance(defect)) {
        return Effect.fail(
          new ConfigOverlayInvalidError({
            name: "ConfigInvalidError",
            data: {
              path: defect.data.path,
              message: defect.data.message,
              issues: defect.data.issues,
            },
          }),
        )
      }
      if (ConfigErrorV1.JsonError.isInstance(defect)) {
        return Effect.fail(
          new ConfigOverlayInvalidError({
            name: "ConfigInvalidError",
            data: {
              path: defect.data.path,
              message: defect.data.message,
            },
          }),
        )
      }
      return Effect.die(defect)
    }),
  )

export * as KiloConfigFailure from "./config-failure"
