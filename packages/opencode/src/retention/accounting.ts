import { existsSync, statSync, readdirSync } from "fs"
import { Context, Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import * as Artifact from "@opencode-ai/core/retention/artifact"
import { Global } from "@opencode-ai/core/global"

export function dbPaths(): { main: string; wal: string } {
  const main = Database.path()
  return { main, wal: main + "-wal" }
}

export function safeStat(path: string): number {
  try {
    if (!existsSync(path)) return 0
    return statSync(path).size
  } catch {
    return 0
  }
}

export function artifactBytes(storageDir: string): number {
  let sum = 0
  for (const kind of Artifact.familyKinds()) {
    const dir = `${storageDir}/${kind}`
    if (!existsSync(dir)) continue
    try {
      const entries = readdirSync(dir) as string[]
      for (const entry of entries) {
        const full = `${dir}/${entry}`
        try {
          sum += statSync(full).size
        } catch {}
      }
    } catch {}
  }
  return sum
}

export function physicalBytes(): number {
  const { main, wal } = dbPaths()
  const storageDir = `${Global.Path.data}/storage`
  return safeStat(main) + safeStat(wal) + artifactBytes(storageDir)
}

export function physicalBytesWith(dbPath: string, storageDir: string): number {
  return safeStat(dbPath) + safeStat(dbPath + "-wal") + artifactBytes(storageDir)
}

export function artifactBytesForSession(storageDir: string, sessionID: string): number {
  let sum = 0
  for (const kind of Artifact.familyKinds()) {
    const p = `${storageDir}/${kind}/${sessionID}.json`
    sum += safeStat(p)
  }
  return sum
}

export interface Accounting {
  readonly physicalBytes: () => Effect.Effect<number>
  readonly physicalBytesWith: (dbPath: string, storageDir: string) => Effect.Effect<number>
}

export class Service extends Context.Service<Service, Accounting>()("@opencode/RetentionAccounting") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    return Service.of({
      physicalBytes: () => Effect.sync(() => physicalBytes()),
      physicalBytesWith: (dbPath, storageDir) => Effect.sync(() => physicalBytesWith(dbPath, storageDir)),
    })
  }),
)

export const noop: Accounting = {
  physicalBytes: () => Effect.succeed(0),
  physicalBytesWith: () => Effect.succeed(0),
}
