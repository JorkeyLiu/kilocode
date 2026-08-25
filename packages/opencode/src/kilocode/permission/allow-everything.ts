import { Permission } from "@/permission"
import { SessionID } from "@/session/schema"
import { Effect } from "effect"
import z from "zod"

export namespace AllowEverythingPermission {
  export type Input = z.infer<typeof Permission.AllowEverythingInput>

  export function effect(input: Input) {
    return Effect.gen(function* () {
      const svc = yield* Permission.Service
      if (!input.enable) {
        if (input.sessionID) {
          yield* svc.allowEverything({ enable: false, sessionID: SessionID.make(input.sessionID) })
          return true
        }
        yield* svc.allowEverything({ enable: false })
        return true
      }

      yield* svc.allowEverything({
        enable: true,
        requestID: input.requestID as any,
        sessionID: input.sessionID ? SessionID.make(input.sessionID) : undefined,
      })

      return true
    })
  }
}
