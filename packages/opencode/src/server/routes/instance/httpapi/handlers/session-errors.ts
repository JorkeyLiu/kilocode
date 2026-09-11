import type { NotFoundError as StorageNotFoundError } from "@/storage/storage"
import type { Session } from "@/session/session"
import type { Snapshot } from "@/snapshot"
import { Effect } from "effect"
import { HttpApiError } from "effect/unstable/httpapi"
import * as ApiError from "../errors"

export function mapStorageNotFound<A, R>(self: Effect.Effect<A, StorageNotFoundError, R>) {
  return self.pipe(Effect.mapError((error) => ApiError.notFound(error.message)))
}

export function mapBusy<A, R>(self: Effect.Effect<A, Session.BusyError, R>) {
  return self.pipe(
    Effect.catchTag("SessionBusyError", (error) =>
      Effect.fail(
        new ApiError.SessionBusyError({
          sessionID: error.sessionID,
          message: `Session is busy: ${error.sessionID}`,
        }),
      ),
    ),
  )
}

// kilocode_change start - Snapshot v2: typed snapshot failures map to explicit HTTP classes.
// Busy stays 409 via SessionBusyError; path validation is 400; git restore/revert is 500, never conflict.
export function mapRevert<A, R>(
  self: Effect.Effect<A, Session.BusyError | Snapshot.RestoreError | Snapshot.RevertError | Snapshot.PathError, R>,
) {
  return self.pipe(
    Effect.catchTag("SessionBusyError", (error) =>
      Effect.fail(
        new ApiError.SessionBusyError({
          sessionID: error.sessionID,
          message: `Session is busy: ${error.sessionID}`,
        }),
      ),
    ),
    Effect.catchTag("SnapshotPathError", () => Effect.fail(new HttpApiError.BadRequest({}))),
    Effect.catchTag("SnapshotRestoreError", () => Effect.fail(new HttpApiError.InternalServerError({}))),
    Effect.catchTag("SnapshotRevertError", () => Effect.fail(new HttpApiError.InternalServerError({}))),
  )
}
// kilocode_change end
