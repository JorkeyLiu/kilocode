import { SessionID } from "@/session/schema"
import { ForkPayload } from "@/server/routes/instance/httpapi/groups/session"
import { Effect, Schema } from "effect"
import { HttpServerRequest } from "effect/unstable/http"
import { HttpApiError } from "effect/unstable/httpapi"

export namespace KiloSessionHttpApi {
  type Input = {
    params: { sessionID: SessionID }
    payload: typeof ForkPayload.Type
  }

  type Raw = {
    params: { sessionID: SessionID }
    request: HttpServerRequest.HttpServerRequest
  }

  export function forkRaw<A extends { id: SessionID }, E, R>(fork: (ctx: Input) => Effect.Effect<A, E, R>) {
    return Effect.fn("KiloSessionHttpApi.forkRaw")(function* (ctx: Raw) {
      const body = yield* Effect.orDie(ctx.request.text)
      const payload = yield* Effect.gen(function* () {
        if (body.trim().length === 0) return {}

        const json = yield* Effect.try({
          try: () => JSON.parse(body) as unknown,
          catch: () => new HttpApiError.BadRequest({}),
        })
        // Strict unknown-field rejection before stripping (preserves bodyless legacy)
        if (json !== null && typeof json === "object" && !Array.isArray(json)) {
          const j = json as Record<string, unknown>
          const allowedRoot = new Set(["messageID", "idempotencyKey", "requestId", "opId", "context"])
          for (const k of Object.keys(j)) if (!allowedRoot.has(k)) return yield* new HttpApiError.BadRequest({})
          const c = j.context as unknown
          if (c !== null && typeof c === "object" && !Array.isArray(c)) {
            const allowedCtx = new Set(["directory", "sessionId", "parentSessionId", "configVersion", "sessionRevision"])
            for (const k of Object.keys(c as Record<string, unknown>)) if (!allowedCtx.has(k)) return yield* new HttpApiError.BadRequest({})
          }
          if ("payload" in j && j.payload !== null && typeof j.payload === "object" && !Array.isArray(j.payload)) {
            const allowedPayload = new Set(["messageId"])
            for (const k of Object.keys(j.payload as Record<string, unknown>)) if (!allowedPayload.has(k)) return yield* new HttpApiError.BadRequest({})
          }
        }
        return yield* Schema.decodeUnknownEffect(ForkPayload)(json).pipe(
          Effect.mapError(() => new HttpApiError.BadRequest({})),
        )
      })
      return yield* fork({ params: ctx.params, payload })
    })
  }
}
