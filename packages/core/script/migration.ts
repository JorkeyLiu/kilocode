#!/usr/bin/env bun

import { $ } from "bun"
import path from "path"
import { pathToFileURL } from "url"
import { parseArgs } from "util"
import { sql } from "drizzle-orm"
import type { SQLiteTable } from "drizzle-orm/sqlite-core"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { Effect } from "effect"
import { DatabaseMigration } from "../src/database/migration"
import {
  assertMigrationId,
  assertRegistryParity,
  assertSqlWrappers,
  assertTableParity,
  assertTableSetParity,
  toDeclaredTable,
} from "./migration-check"
import type { DbTable, DeclaredTable } from "./migration-check"

const root = path.resolve(import.meta.dirname, "../../..")
const sqlDir = path.join(root, "packages/core/migration")
const tsDir = path.join(root, "packages/core/src/database/migration")
const registry = path.join(root, "packages/core/src/database/migration.gen.ts")

// Fail-closed gate for the destructive non-check path (`bun run migration`).
// Plain filesystem names in, no I/O: tests import this without ever spawning
// drizzle-kit generate. Non-empty TS-only set (hand-written migrations with
// no SQL snapshot) means the SQL snapshot is stale and untrusted, and running
// generate would rewrite SQL snapshots plus shrink the registry down to the
// SQL-only subset, dropping history and emitting duplicate CREATEs.
export function assertGenerateAllowed(sqlNames: string[], tsNames: string[]): void {
  const sql = new Set(sqlNames)
  const tsOnly = tsNames.filter((name) => !sql.has(name))
  if (tsOnly.length === 0) return
  const preview = tsOnly.slice(0, 5).join(", ")
  throw new Error(
    `Refusing drizzle-kit generate: ${tsOnly.length} TypeScript-only migration(s) have no SQL snapshot (${preview}${tsOnly.length > 5 ? ", ..." : ""}). ` +
      `Hand-written TS migrations in packages/core/src/database/migration are the established authoring pattern; the SQL snapshot in packages/core/migration is stale and untrusted for these entries. ` +
      `Running generate would rewrite SQL snapshots and shrink the registry from ${tsNames.length} TS entries to ${sqlNames.length} SQL-only entries, dropping history and emitting duplicate CREATE statements. ` +
      `Add new migrations as hand-written TS files plus a registry entry in migration.gen.ts instead; do not run generate.`,
  )
}

if (import.meta.main) {
  const args = parseArgs({
    args: process.argv.slice(2),
    options: {
      check: { type: "boolean" },
      name: { type: "string" },
    },
  })

  if (args.values.check) {
    await check()
    process.exit(0)
  }

  // Fail closed before any drizzle-kit generate or snapshot/registry rewrite.
  const preSqlNames = (
    await Array.fromAsync(new Bun.Glob("*/migration.sql").scan({ cwd: sqlDir }))
  )
    .map((file) => file.split("/")[0])
    .filter((name) => name !== undefined)
    .sort()
  const preTsNames = (await Array.fromAsync(new Bun.Glob("*.ts").scan({ cwd: tsDir })))
    .map((file) => file.replace(/\.ts$/, ""))
    .sort()
  assertGenerateAllowed(preSqlNames, preTsNames)

  await $`bun drizzle-kit generate ${args.values.name ? ["--name", args.values.name] : []}`.cwd(
    path.join(root, "packages/core"),
  )

  const sqlMigrations = (await Array.fromAsync(new Bun.Glob("*/migration.sql").scan({ cwd: sqlDir })))
    .map((file) => file.split("/")[0])
    .filter((name) => name !== undefined)
    .sort()

  for (const name of sqlMigrations) {
    if (await Bun.file(path.join(tsDir, `${name}.ts`)).exists()) continue
    await Bun.write(
      path.join(tsDir, `${name}.ts`),
      renderMigration(name, await Bun.file(path.join(sqlDir, name, "migration.sql")).text()),
    )
  }

  await Bun.write(registry, renderRegistry(sqlMigrations))
}

async function check() {
  // Track 1: every SQL snapshot directory has a TS wrapper. TS-only
  // hand-written migrations are the established pattern, so the reverse
  // direction is intentionally not required here.
  const sqlNames = (
    await Array.fromAsync(new Bun.Glob("*/migration.sql").scan({ cwd: sqlDir }))
  )
    .map((file) => file.split("/")[0])
    .filter((name) => name !== undefined)
    .sort()
  const tsNames = (
    await Array.fromAsync(new Bun.Glob("*.ts").scan({ cwd: tsDir }))
  )
    .map((file) => file.replace(/\.ts$/, ""))
    .sort()
  assertSqlWrappers(sqlNames, tsNames)

  // Track 2: the registry corresponds exactly to the TS migration files,
  // strictly ascending by filename with no duplicates, and every module's
  // default migration.id equals its filename.
  if ((await Bun.file(registry).text()) !== renderRegistry(tsNames)) {
    throw new Error("Database migration registry is stale. Hand-edit packages/core/src/database/migration.gen.ts to match the TS migration files and ids, then run `bun script/migration.ts --check` from packages/core. Do not run drizzle-kit generate.")
  }
  const registryModule = (await import(pathToFileURL(registry).href)) as { migrations: { id: string }[] }
  const registryIds = registryModule.migrations.map((migration) => migration.id)
  assertRegistryParity(tsNames, registryIds)
  for (const name of tsNames) {
    const module = (await import(pathToFileURL(path.join(tsDir, `${name}.ts`)).href)) as { default: { id: string } }
    assertMigrationId(name, module.default.id)
  }

  // Track 3: apply the real registry chain to :memory: SQLite and verify every
  // Drizzle-declared table (drizzle config schema globs) exists with matching
  // columns and indexes. This never runs drizzle-kit generate, so it cannot
  // emit duplicate historical DDL; the SQL snapshot stays untouched.
  // CHECK constraints are intentionally not compared (see migration-check.ts):
  // closed-kind enforcement moved to triggers while declarations keep CHECKs.
  const coreDir = path.join(root, "packages/core")
  const schemaFiles = new Set([
    ...(await Array.fromAsync(new Bun.Glob("src/**/*.sql.ts").scan({ cwd: coreDir }))),
    ...(await Array.fromAsync(new Bun.Glob("src/**/sql.ts").scan({ cwd: coreDir }))),
  ])
  const declared: DeclaredTable[] = []
  for (const file of [...schemaFiles].sort()) {
    const ns = (await import(pathToFileURL(path.join(coreDir, file)).href)) as Record<string, unknown>
    for (const value of Object.values(ns)) {
      try {
        declared.push(toDeclaredTable(value as SQLiteTable))
      } catch (err) {
        // Non-table exports (e.g. the Timestamps helper) fail inside
        // getTableConfig; declared-index failures must stay fail-closed so an
        // expression column never silently drops a whole table.
        if (err instanceof Error && err.message.startsWith("Declared index")) throw err
      }
    }
  }

  await Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* EffectDrizzleSqlite.makeWithDefaults()
      yield* DatabaseMigration.apply(db)
      for (const table of declared) {
        if (!/^[a-z_]+$/.test(table.name)) throw new Error(`Unexpected table name ${JSON.stringify(table.name)}.`)
        const columns = (yield* db.all(
          sql.raw(`SELECT name, type, "notnull" FROM pragma_table_info('${table.name}')`),
        )) as { name: string; type: string; notnull: number }[]
        const master = (yield* db.all(
          sql.raw(`SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = '${table.name}'`),
        )) as { name: string; sql: string | null }[]
        const flags = (yield* db.all(sql.raw(`SELECT name, "unique" FROM pragma_index_list('${table.name}')`))) as {
          name: string
          unique: number
        }[]
        const unique = new Map(flags.map((row) => [row.name, row.unique === 1]))
        const indexes: DbTable["indexes"] = []
        for (const row of master) {
          if (!/^[a-z0-9_]+$/i.test(row.name)) throw new Error(`Unexpected index name ${JSON.stringify(row.name)}.`)
          const cols = (yield* db.all(
            sql.raw(`SELECT name FROM pragma_index_info('${row.name}') ORDER BY seqno`),
          )) as { name: string }[]
          indexes.push({ name: row.name, unique: unique.get(row.name) ?? false, sql: row.sql, columns: cols.map((col) => col.name) })
        }
        assertTableParity(table, { columns, indexes })
      }
      // Track 4: the terminal table set equals declarations plus the exact
      // runtime-owned whitelist. Raw sqlite_master names go in unfiltered so
      // the `sqlite_%` builtin exclusion stays owned and tested by the pure
      // assertion; historical temporary tables fail here as undeclared drift.
      const names = (yield* db.all(sql.raw(`SELECT name FROM sqlite_master WHERE type = 'table'`))) as {
        name: string
      }[]
      assertTableSetParity(
        declared.map((table) => table.name),
        names.map((row) => row.name),
      )
    }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
  )

  console.log(
    `Core migration check passed: ${sqlNames.length} SQL wrappers, ${tsNames.length} registry entries, ${declared.length} tables verified.`,
  )
}

function renderMigration(name: string, sql: string) {
  return `import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: ${JSON.stringify(name)},
  up(tx) {
    return Effect.gen(function* () {
${sql
  .split("--> statement-breakpoint")
  .map((statement) => statement.trim())
  .filter((statement) => statement.length > 0)
  .map(renderRun)
  .join("\n")}
    })
  },
} satisfies DatabaseMigration.Migration
`
}

function renderRun(statement: string) {
  const lines = statement.replaceAll("\t", "  ").split("\n")
  if (lines.length === 1) return `      yield* tx.run(\`${escapeTemplate(lines[0])}\`)`
  return `      yield* tx.run(\`\n${lines.map((line) => `        ${escapeTemplate(line)}`).join("\n")}\n      \`)`
}

function escapeTemplate(line: string) {
  return line.replaceAll("\\", "\\\\").replaceAll("`", "\\`").replaceAll("${", "\\${")
}

function renderRegistry(names: string[]) {
  return `import type { DatabaseMigration } from "./migration"

export const migrations = (
  await Promise.all([
${names.map((name) => `    import("./migration/${name}"),`).join("\n")}
  ])
).map((module) => module.default) satisfies DatabaseMigration.Migration[]
`
}
