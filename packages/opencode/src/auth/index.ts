import path from "path"
import { Effect, Layer, Record, Result, Schema, Context } from "effect"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import { Global } from "@opencode-ai/core/global"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Telemetry } from "@kilocode/kilo-telemetry" // kilocode_change

export const OAUTH_DUMMY_KEY = "kilo-oauth-dummy-key" // kilocode_change

const file = path.join(Global.Path.data, "auth.json")

const fail = (message: string) => (cause: unknown) => new AuthError({ message, cause })

export class Oauth extends Schema.Class<Oauth>("OAuth")({
  type: Schema.Literal("oauth"),
  refresh: Schema.String,
  access: Schema.String,
  expires: NonNegativeInt,
  accountId: Schema.optional(Schema.String),
  enterpriseUrl: Schema.optional(Schema.String),
}) {}

export class Api extends Schema.Class<Api>("ApiAuth")({
  type: Schema.Literal("api"),
  key: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
}) {}

export class WellKnown extends Schema.Class<WellKnown>("WellKnownAuth")({
  type: Schema.Literal("wellknown"),
  key: Schema.String,
  token: Schema.String,
}) {}

export const Info = Schema.Union([Oauth, Api, WellKnown]).annotate({ discriminator: "type", identifier: "Auth" })
export type Info = Schema.Schema.Type<typeof Info>

export class AuthError extends Schema.TaggedErrorClass<AuthError>()("AuthError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

export interface Interface {
  readonly get: (providerID: string) => Effect.Effect<Info | undefined, AuthError>
  readonly all: () => Effect.Effect<Record<string, Info>, AuthError>
  readonly set: (key: string, info: Info) => Effect.Effect<void, AuthError>
  readonly remove: (key: string) => Effect.Effect<void, AuthError>
}

// kilocode_change start - exact auth-file artifact for compensating rollback
// (LOCK-003): Auth.remove persists the file before chmod/telemetry, so a
// thrown failure after persistence leaves the file mutated while the caller
// sees failure. Callers that must roll back (custom provider deletion) capture
// the exact persisted bytes + mode BEFORE the mutation and restore them on
// compensation instead of inferring removal from method success. Content is
// raw bytes (LOCK-002): an auth file may contain arbitrary UTF-8 or binary
// payloads, and a string round-trip can corrupt non-UTF-8 bytes.
export type AuthSnapshot = {
  readonly content: Uint8Array | undefined
  readonly mode: number
}

export const snapshotFile = (fs: FSUtil.Interface): Effect.Effect<AuthSnapshot, AuthError> =>
  Effect.gen(function* () {
    const content = yield* fs
      .readFile(file)
      .pipe(
        Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)),
        Effect.mapError(fail("Failed to read auth data")),
      )
    if (content === undefined) return { content: undefined, mode: 0o600 }
    const stat = yield* fs.stat(file).pipe(Effect.mapError(fail("Failed to stat auth data")))
    return { content, mode: stat.mode & 0o777 }
  })

export const restoreFile = (fs: FSUtil.Interface, snap: AuthSnapshot): Effect.Effect<void, AuthError> =>
  Effect.gen(function* () {
    if (snap.content === undefined) {
      yield* fs
        .remove(file)
        .pipe(
          Effect.catchIf((error) => error.reason._tag === "NotFound", () => Effect.void),
          Effect.mapError(fail("Failed to restore auth data")),
        )
      return
    }
    // Byte-exact restore: write the raw bytes, then reapply the captured mode.
    yield* fs.writeFile(file, snap.content).pipe(Effect.mapError(fail("Failed to restore auth data")))
    yield* fs.chmod(file, snap.mode).pipe(Effect.mapError(fail("Failed to restore auth data")))
  })
// kilocode_change end

export class Service extends Context.Service<Service, Interface>()("@opencode/Auth") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fsys = yield* FSUtil.Service
    const decode = Schema.decodeUnknownOption(Info)

    const all = Effect.fn("Auth.all")(function* () {
      if (process.env.KILO_AUTH_CONTENT) {
        try {
          return JSON.parse(process.env.KILO_AUTH_CONTENT)
        } catch (err) {}
      }

      const data = (yield* fsys.readJson(file).pipe(Effect.orElseSucceed(() => ({})))) as Record<string, unknown>
      return Record.filterMap(data, (value) => Result.fromOption(decode(value), () => undefined))
    })

    const get = Effect.fn("Auth.get")(function* (providerID: string) {
      return (yield* all())[providerID]
    })

    const set = Effect.fn("Auth.set")(function* (key: string, info: Info) {
      const norm = key.replace(/\/+$/, "")
      const data = yield* all()
      if (norm !== key) delete data[key]
      delete data[norm + "/"]
      yield* fsys
        .writeJson(file, { ...data, [norm]: info }, 0o600)
        .pipe(Effect.mapError(fail("Failed to write auth data")))
    })

    const remove = Effect.fn("Auth.remove")(function* (key: string) {
      const norm = key.replace(/\/+$/, "")
      const data = yield* all()
      delete data[key]
      delete data[norm]
      yield* fsys.writeJson(file, data, 0o600).pipe(Effect.mapError(fail("Failed to write auth data")))

      // kilocode_change start - Track logout and reset telemetry identity for Kilo
      if (key === "kilo") {
        yield* Effect.promise(() => Telemetry.updateIdentity(null))
      }
      Telemetry.trackAuthLogout(key)
      // kilocode_change end
    })

    return Service.of({ get, all, set, remove })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(FSUtil.defaultLayer))

export * as Auth from "."
