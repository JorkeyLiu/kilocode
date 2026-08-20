import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { SessionImportService } from "@/kilocode/session-import/service"
import { SessionImportType } from "@/kilocode/session-import/types"
import { InstanceHttpApi } from "@/server/routes/instance/httpapi/api"

/** Map a service rejection to the correct HTTP error.
 *  - Typed ValidationError → 400 BadRequest (expected client input error)
 *  - Anything else → rethrow as defect → 500 (unexpected internal failure)
 */
const mapServiceError = (err: unknown) => {
  if (err instanceof SessionImportType.ValidationError) return new HttpApiError.BadRequest({})
  throw err
}

export const sessionImportHandlers = HttpApiBuilder.group(InstanceHttpApi, "session-import", (handlers) =>
  Effect.gen(function* () {
    const project = Effect.fn("SessionImportHttpApi.project")(function* (ctx: { payload: unknown }) {
      const parsed = SessionImportType.Project.safeParse(ctx.payload)
      if (!parsed.success) return yield* new HttpApiError.BadRequest({})
      return yield* Effect.tryPromise({
        try: () => SessionImportService.project(parsed.data),
        catch: mapServiceError,
      })
    })

    const session = Effect.fn("SessionImportHttpApi.session")(function* (ctx: { payload: unknown }) {
      const parsed = SessionImportType.Session.safeParse(ctx.payload)
      if (!parsed.success) return yield* new HttpApiError.BadRequest({})
      return yield* Effect.tryPromise({
        try: () => SessionImportService.session(parsed.data),
        catch: mapServiceError,
      })
    })

    const message = Effect.fn("SessionImportHttpApi.message")(function* (ctx: { payload: unknown }) {
      const parsed = SessionImportType.Message.safeParse(ctx.payload)
      if (!parsed.success) return yield* new HttpApiError.BadRequest({})
      return yield* Effect.tryPromise({
        try: () => SessionImportService.message(parsed.data),
        catch: mapServiceError,
      })
    })

    const part = Effect.fn("SessionImportHttpApi.part")(function* (ctx: { payload: unknown }) {
      const parsed = SessionImportType.Part.safeParse(ctx.payload)
      if (!parsed.success) return yield* new HttpApiError.BadRequest({})
      return yield* Effect.tryPromise({
        try: () => SessionImportService.part(parsed.data),
        catch: mapServiceError,
      })
    })

    return handlers
      .handle("project", project)
      .handle("session", session)
      .handle("message", message)
      .handle("part", part)
  }),
)
