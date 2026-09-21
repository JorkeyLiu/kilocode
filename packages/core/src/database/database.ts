import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { layer as sqliteLayer } from "#sqlite"
import { Context, Effect, Layer } from "effect"
import { sql } from "drizzle-orm"
import { Global } from "../global"
import { Flag } from "../flag/flag"
import { isAbsolute, join, dirname, resolve } from "path"
import { existsSync } from "fs" // kilocode_change
import fs from "fs/promises"
import { DatabaseMigration } from "./migration"
import { InstallationChannel } from "../installation/version"
import { acquireLease } from "../cutover/lease"
import { deriveArchive } from "../cutover/archive-path"
import * as Log from "../util/log"

const makeDatabase = EffectDrizzleSqlite.makeWithDefaults()
type DatabaseShape = Effect.Success<typeof makeDatabase>

export interface Interface {
  db: DatabaseShape
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/storage/Database") {}

export function markerPathsForFile(file: string): { cutover: string; rollback: string } | undefined {
  if (file === ":memory:" || file.includes(":memory:")) return undefined
  const abs = resolve(file)
  const dataRoot = dirname(abs)
  const { parent, base } = deriveArchive(dataRoot)
  return {
    cutover: join(parent, `.cutover-${base}.marker.json`),
    rollback: join(parent, `.rollback-${base}.marker.json`),
  }
}

export async function assertNoActivationMarker(file: string): Promise<void> {
  const markers = markerPathsForFile(file)
  if (!markers) return
  for (const p of [markers.cutover, markers.rollback] as const) {
    const exists = await fs
      .access(p)
      .then(() => true)
      .catch(() => false)
    if (exists) throw new Error(`DB activation blocked: marker exists at ${p} - recovery required`)
  }
}

const createDbEffect = Effect.gen(function* () {
  const db = yield* makeDatabase

  yield* db.run("PRAGMA journal_mode = WAL")
  yield* db.run("PRAGMA synchronous = NORMAL")
  yield* db.run("PRAGMA busy_timeout = 5000")
  yield* db.run("PRAGMA cache_size = -64000")
  yield* db.run("PRAGMA foreign_keys = ON")
  yield* db.run("PRAGMA wal_checkpoint(PASSIVE)")
  yield* DatabaseMigration.apply(db)

  const ident = yield* db
    .get<{
      uuid: string
      schema_version: string
      cutover_archive_id: string
    }>(sql`SELECT uuid, schema_version, cutover_archive_id FROM storage_identity WHERE id = 1`)
    .pipe(
      Effect.catch((e: any) => {
        const msg = String((e as any)?.message ?? e)
        if (msg.includes("no such table")) return Effect.succeed(undefined as any)
        return Effect.fail(e as unknown as Error)
      }),
      Effect.orDie,
    )
  if (ident) {
    const isUUID = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
    const isValidArchiveID = (id: string) =>
      /^\d{8}T\d{6}Z-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
    if (!isUUID(ident.uuid)) yield* Effect.die(new Error(`invalid storage uuid ${ident.uuid}`))
    if (ident.schema_version !== "1") yield* Effect.die(new Error(`schema version mismatch`))
    if (!ident.cutover_archive_id || !isValidArchiveID(ident.cutover_archive_id))
      yield* Effect.die(new Error(`invalid cutover archive id ${ident.cutover_archive_id}`))
    const av = yield* db.get<{ auto_vacuum: number }>(sql`PRAGMA auto_vacuum`).pipe(Effect.orDie)
    if ((av as any)?.auto_vacuum !== 2)
      yield* Effect.die(new Error(`auto_vacuum must be 2, got ${(av as any)?.auto_vacuum}`))
  }

  return { db }
})

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const file = path()
    if (file === ":memory:") {
      return Layer.effect(Service, createDbEffect).pipe(Layer.provide(sqliteLayer({ filename: file })))
    }
    const dataRoot = dirname(resolve(file))
    const handle = yield* Effect.promise(() => acquireLease(dataRoot)).pipe(
      Effect.mapError((e: any) => new Error(`DB lease acquisition failed: ${String(e?.message ?? e)}`)),
      Effect.orDie,
    )
    // attach release to the unwrap scope so it lives for layer lifetime
    yield* Effect.addFinalizer(() => Effect.promise(() => handle.release()).pipe(Effect.orDie))
    yield* Effect.tryPromise({
      try: () => assertNoActivationMarker(file),
      catch: (e) => e as Error,
    }).pipe(Effect.orDie)
    return Layer.effect(Service, createDbEffect).pipe(Layer.provide(sqliteLayer({ filename: file })))
  }),
) as unknown as Layer.Layer<Service, never, never>

export function layerFromPath(filename: string): Layer.Layer<Service, never, never> {
  if (filename === ":memory:" || filename.includes(":memory:")) {
    return Layer.effect(Service, createDbEffect).pipe(
      Layer.provide(sqliteLayer({ filename })),
    ) as unknown as Layer.Layer<Service, never, never>
  }
  return Layer.unwrap(
    Effect.gen(function* () {
      const dataRoot = dirname(resolve(filename))
      const handle = yield* Effect.promise(() => acquireLease(dataRoot)).pipe(
        Effect.mapError(
          (e: any) => new Error(`DB lease acquisition failed for ${filename}: ${String(e?.message ?? e)}`),
        ),
        Effect.orDie,
      )
      yield* Effect.addFinalizer(() => Effect.promise(() => handle.release()).pipe(Effect.orDie))
      yield* Effect.tryPromise({
        try: () => assertNoActivationMarker(filename),
        catch: (e) => e as Error,
      }).pipe(Effect.orDie)
      return Layer.effect(Service, createDbEffect).pipe(Layer.provide(sqliteLayer({ filename })))
    }),
  ) as unknown as Layer.Layer<Service, never, never>
}

export function layerNoLease(filename: string) {
  return Layer.effect(Service, createDbEffect).pipe(Layer.provide(sqliteLayer({ filename })))
}

const log = Log.create({ service: "database" })

export function path() {
  if (Flag.KILO_DB) {
    if (Flag.KILO_DB === ":memory:" || isAbsolute(Flag.KILO_DB)) return Flag.KILO_DB
    return join(Global.Path.data, Flag.KILO_DB)
  }
  if (
    ["latest", "beta", "prod"].includes(InstallationChannel) ||
    process.env.KILO_DISABLE_CHANNEL_DB === "1" ||
    process.env.KILO_DISABLE_CHANNEL_DB === "true"
  )
    return join(Global.Path.data, "kilo.db")
  const safe = InstallationChannel.replace(/[^a-zA-Z0-9._-]/g, "-")
  const next = join(Global.Path.data, `kilo-${safe}.db`)
  const prev = join(Global.Path.data, `opencode-${safe}.db`)
  if (!existsSync(next) && existsSync(prev)) {
    log.warn("using legacy opencode channel database fallback", {
      channel: InstallationChannel,
      safe,
      canonical: next,
      legacy: prev,
    })
    return prev
  }
  return next
}

export const defaultLayer = Layer.unwrap(
  Effect.gen(function* () {
    return layerFromPath(path())
  }),
).pipe(Layer.provide(Global.defaultLayer)) as unknown as Layer.Layer<Service, never, never>

export * as Database from "./database"
