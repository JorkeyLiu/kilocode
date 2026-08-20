import { eq } from "drizzle-orm"
import { Effect } from "effect"
import type { SessionID } from "@/session/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { Database } from "@opencode-ai/core/database/database"
import { SessionRevision } from "@opencode-ai/core/session/revision"

export const key = "kilocode.sandbox"

export type Value = {
  enabled: boolean
  version: number
}

export function parse(metadata: Record<string, unknown> | null | undefined): Value | undefined {
  const value = metadata?.[key]
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const enabled = Reflect.get(value, "enabled")
  const version = Reflect.get(value, "version")
  if (typeof enabled !== "boolean" || !Number.isInteger(version) || (version as number) < 0) return
  return { enabled, version: version as number }
}

export function merge(metadata: Record<string, unknown> | null | undefined, value: Value) {
  return { ...metadata, [key]: value }
}

export function inherit(metadata: Record<string, unknown> | null | undefined) {
  const value = parse(metadata)
  if (!value) return
  return merge(undefined, { enabled: value.enabled, version: 0 })
}

export function remove(metadata: Record<string, unknown> | null | undefined) {
  if (!metadata || !(key in metadata)) return metadata
  const next = { ...metadata }
  delete next[key]
  return next
}

export const read = Effect.fn("SandboxState.read")(function* (sessionID: SessionID) {
  const { db } = yield* Database.Service
  const row = yield* db
    .select({ metadata: SessionTable.metadata })
    .from(SessionTable)
    .where(eq(SessionTable.id, sessionID))
    .get()
    .pipe(Effect.orDie)
  return parse(row?.metadata)
})

export const write = Effect.fn("SandboxState.write")(function* (sessionID: SessionID, value: Value) {
  const { db } = yield* Database.Service
  yield* db
    .transaction((tx) =>
      Effect.gen(function* () {
        const row = yield* tx
          .select({ metadata: SessionTable.metadata })
          .from(SessionTable)
          .where(eq(SessionTable.id, sessionID))
          .get()
        if (!row) yield* Effect.die(`SandboxState.write: session ${sessionID} not found`)
        yield* tx
          .update(SessionTable)
          .set({
            metadata: merge(row!.metadata, value),
          })
          .where(eq(SessionTable.id, sessionID))
          .run()
        yield* SessionRevision.advance(sessionID, tx)
      }),
    )
    .pipe(Effect.orDie)
})

export const clear = Effect.fn("SandboxState.clear")(function* (sessionID: SessionID) {
  const { db } = yield* Database.Service
  yield* db
    .transaction((tx) =>
      Effect.gen(function* () {
        const row = yield* tx
          .select({ metadata: SessionTable.metadata })
          .from(SessionTable)
          .where(eq(SessionTable.id, sessionID))
          .get()
        if (!row) yield* Effect.die(`SandboxState.clear: session ${sessionID} not found`)
        yield* tx
          .update(SessionTable)
          .set({
            metadata: remove(row!.metadata),
          })
          .where(eq(SessionTable.id, sessionID))
          .run()
        yield* SessionRevision.advance(sessionID, tx)
      }),
    )
    .pipe(Effect.orDie)
})
