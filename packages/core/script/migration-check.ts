// Pure fail-closed assertions for `bun script/migration.ts --check`.
//
// This module performs no filesystem or database I/O so each boundary is
// reproducible in tests with synthetic inputs. Orchestration (reading the SQL
// snapshot directories, the TS wrappers, the registry, applying the registry
// chain to :memory: SQLite, collecting Drizzle declarations) lives in
// `migration.ts`, which feeds plain data into these assertions.
//
// Intentionally not compared: CHECK constraints. SQLite cannot add a CHECK
// with ALTER TABLE, so closed-kind enforcement is implemented as triggers
// (see 20260822000000_add_changefeed_kind_check,
// 20260922000000_add_generation_recovery) while the Drizzle declaration keeps
// the CHECK form. Comparing CHECK text would false-positive on that intended
// divergence, so parity covers tables, columns (presence, type affinity,
// nullability), and indexes (presence, uniqueness, column order, partial
// predicate text under moderate normalization) only.

import { getTableConfig } from "drizzle-orm/sqlite-core"
import type { SQLiteTable } from "drizzle-orm/sqlite-core"

export type DeclaredColumn = {
  name: string
  sqlType: string
  notNull: boolean
  primary: boolean
}

export type DeclaredIndex = {
  name: string
  unique: boolean
  partial: boolean
  where: string | null
  columns: string[]
}

export type DeclaredTable = {
  name: string
  columns: DeclaredColumn[]
  indexes: DeclaredIndex[]
}

export type DbColumn = {
  name: string
  type: string
  notnull: number
}

export type DbIndex = {
  name: string
  unique: boolean
  sql: string | null
  columns: string[]
}

export type DbTable = {
  columns: DbColumn[]
  indexes: DbIndex[]
}

// Runtime-owned tables intentionally absent from the Drizzle schema globs
// (drizzle.config.ts: `./src/**/*.sql.ts`, `./src/**/sql.ts`). Exactly these
// two exist after a full registry apply; any third terminal user table is a
// fail-closed divergence. Never derived from migration-script CREATE TABLE
// names: that union would silently allow historical temporary tables.
export const RUNTIME_OWNED_TABLES: readonly string[] = [
  // Journal of applied migration ids, created by DatabaseMigration.applyOnly
  // (src/database/migration.ts), not by any registry migration.
  "migration",
  // Singleton probed by cutover/identity and database bootstrap, created by
  // 20260823000000_add_storage_identity with no Drizzle declaration.
  "storage_identity",
]

// The migrated database must contain exactly the declared tables plus the
// runtime-owned whitelist: no more, no less. SQLite `sqlite_%` internals are
// excluded from the comparison. A missing whitelist entry fails just like a
// missing declared table; an extra table (including a historical temporary
// table left behind by an old migration) fails as undeclared drift.
export function assertTableSetParity(declared: string[], actual: string[]): void {
  if (new Set(declared).size !== declared.length) {
    throw new Error("Duplicate Drizzle-declared table names.")
  }
  const db = new Set(actual.filter((name) => !name.startsWith("sqlite_")))
  const want = new Set([...declared, ...RUNTIME_OWNED_TABLES])
  const missing = [...want].filter((name) => !db.has(name)).sort()
  const extra = [...db].filter((name) => !want.has(name)).sort()
  if (missing.length > 0 || extra.length > 0) {
    const detail = [
      missing.length > 0 ? `missing from migrated database: ${missing.join(", ")}` : null,
      extra.length > 0 ? `not declared in schema or whitelist: ${extra.join(", ")}` : null,
    ]
      .filter((part) => part !== null)
      .join("; ")
    throw new Error(
      `Migrated database table set diverged from Drizzle declarations + runtime-owned whitelist (${detail}).`,
    )
  }
}

// Legacy UNIQUE table constraint kept as-is by hand-written migrations instead
// of a same-name unique index. For exactly these declared index names, accept
// a unique non-partial index on the table (including sqlite_autoindex_*) that
// covers the same columns in the same order. Anything else (missing
// uniqueness, reordered columns, partial cover) still fails. Additions here
// must cite the migration that owns the divergence.
const UNIQUE_CONSTRAINT_EQUIVALENTS = new Map([
  [
    "session_changefeed_session_revision_kind_idx",
    {
      // Declared in src/retention/sql.ts; the registry chain creates
      // CONSTRAINT session_changefeed_session_revision_kind_unique instead
      // (20260820000000_add_retention_foundation) and no later migration
      // renames it.
      columns: ["session_id", "revision", "kind"],
    },
  ],
])

function renderDeclaredWhere(where: unknown, name: string): string | null {
  if (where === undefined) return null
  const chunks = (where as { queryChunks: unknown }).queryChunks
  if (!Array.isArray(chunks)) {
    throw new Error(`Declared index ${name} uses an unsupported WHERE expression; teach migration-check.ts how to compare it.`)
  }
  let out = ""
  for (const chunk of chunks as unknown[]) {
    if (typeof chunk === "string") {
      out += chunk
      continue
    }
    if (typeof chunk === "object" && chunk !== null && "value" in chunk) {
      const value = (chunk as { value: unknown }).value
      if (Array.isArray(value)) {
        out += value.join("")
        continue
      }
    }
    if (typeof chunk === "object" && chunk !== null && "name" in chunk && typeof (chunk as { name: unknown }).name === "string") {
      out += `"${(chunk as { name: string }).name}"`
      continue
    }
    throw new Error(`Declared index ${name} uses an unsupported WHERE expression; teach migration-check.ts how to compare it.`)
  }
  const text = out.trim()
  return text.length > 0 ? text : null
}

function extractWherePredicate(sqlText: string | null): string | null {
  if (sqlText === null || sqlText === undefined) return null
  const match = /\bWHERE\b/i.exec(sqlText)
  if (!match || match.index === undefined) return null
  const text = sqlText.slice(match.index + match[0].length).trim()
  return text.length > 0 ? text : null
}

function normalizeWhere(text: string): string {
  return text
    .replaceAll('"', "")
    .replaceAll("`", "")
    .replaceAll("[", "")
    .replaceAll("]", "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase()
}

export function toDeclaredTable(table: SQLiteTable): DeclaredTable {
  const config = getTableConfig(table)
  return {
    name: config.name,
    columns: config.columns.map((column) => ({
      name: column.name,
      sqlType: column.getSQLType(),
      notNull: column.notNull,
      primary: column.primary,
    })),
    indexes: config.indexes.map((index) => {
      const where = renderDeclaredWhere(index.config.where, index.config.name)
      return {
        name: index.config.name,
        unique: index.config.unique,
        partial: where !== null,
        where,
        columns: index.config.columns.map((column) => {
          if ("name" in column && typeof column.name === "string") return column.name
          throw new Error(
            `Declared index ${index.config.name} uses an expression column; teach migration-check.ts how to compare it.`,
          )
        }),
      }
    }),
  }
}

// Every SQL snapshot directory must have a TS wrapper. TS-only hand-written
// migrations (no SQL snapshot) are the established pattern and stay allowed;
// the reverse (SQL without a wrapper) means the runtime registry chain would
// silently skip shipped SQL.
export function assertSqlWrappers(sqlNames: string[], tsNames: string[]): void {
  const ts = new Set(tsNames)
  const missing = sqlNames.filter((name) => !ts.has(name))
  if (missing.length > 0) {
    throw new Error(
      `Database migration TypeScript wrapper is missing for ${missing.join(", ")}. Hand-write packages/core/src/database/migration/<id>.ts with matching migration.id plus a registry entry in migration.gen.ts, then run \`bun script/migration.ts --check\` from packages/core. Do not run drizzle-kit generate.`,
    )
  }
}

// The registry must correspond exactly to the TS migration files: same set,
// strictly ascending by name, no duplicates.
export function assertRegistryParity(tsNames: string[], registryIds: string[]): void {
  const sorted = [...tsNames].sort()
  if (JSON.stringify(tsNames) !== JSON.stringify(sorted)) {
    throw new Error("Database migration registry order diverged from filename sort. Fix the registry import order.")
  }
  if (new Set(tsNames).size !== tsNames.length) {
    throw new Error("Duplicate database migration filenames.")
  }
  const missing = sorted.filter((name) => !registryIds.includes(name))
  const extra = registryIds.filter((id) => !sorted.includes(id))
  if (missing.length > 0 || extra.length > 0) {
    const detail = [
      missing.length > 0 ? `missing from registry: ${missing.join(", ")}` : null,
      extra.length > 0 ? `stale registry entries: ${extra.join(", ")}` : null,
    ]
      .filter((part) => part !== null)
      .join("; ")
    throw new Error(`Database migration registry is stale (${detail}). Hand-edit packages/core/src/database/migration.gen.ts to match the TS migration files and ids, then run \`bun script/migration.ts --check\` from packages/core. Do not run drizzle-kit generate.`)
  }
  if (new Set(registryIds).size !== registryIds.length) {
    throw new Error("Duplicate database migration registry entries.")
  }
}

export function assertMigrationId(name: string, id: string): void {
  if (id !== name) {
    throw new Error(`Database migration id mismatch: file ${name} exports id ${JSON.stringify(id)}.`)
  }
}

function affinity(type: string): string {
  return type.toUpperCase().split(/[\s(]/)[0] ?? ""
}

function orderedColumns(left: string[], right: string[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function assertTableParity(declared: DeclaredTable, db: DbTable | null): void {
  if (db === null) {
    throw new Error(`Declared table ${declared.name} is missing from the migrated database: no migration creates it.`)
  }
  const cols = new Map(db.columns.map((column) => [column.name, column]))
  for (const column of declared.columns) {
    const found = cols.get(column.name)
    if (!found) {
      throw new Error(
        `Declared column ${declared.name}.${column.name} is missing from the migrated database: schema has no migration.`,
      )
    }
    if (affinity(found.type) !== affinity(column.sqlType)) {
      throw new Error(
        `Declared column ${declared.name}.${column.name} type mismatch: schema declares ${column.sqlType} but migration built ${found.type}.`,
      )
    }
    // Primary-key columns imply NOT NULL in SQLite even when
    // pragma_table_info reports notnull=0 for TEXT PRIMARY KEY, so only
    // non-PK columns carry a nullability assertion.
    if (!column.primary && column.notNull !== (found.notnull === 1)) {
      throw new Error(
        `Declared column ${declared.name}.${column.name} nullability mismatch: schema declares ${column.notNull ? "NOT NULL" : "NULL"} but migration built ${found.notnull === 1 ? "NOT NULL" : "NULL"}.`,
      )
    }
  }
  for (const column of db.columns) {
    if (!declared.columns.some((item) => item.name === column.name)) {
      throw new Error(
        `Migrated database column ${declared.name}.${column.name} is not declared in schema: migration drifted from Drizzle declarations.`,
      )
    }
  }
  const idx = new Map(db.indexes.map((index) => [index.name, index]))
  for (const index of declared.indexes) {
    const found = idx.get(index.name)
    if (!found) {
      const equivalent = UNIQUE_CONSTRAINT_EQUIVALENTS.get(index.name)
      const declaredWhere = index.where ?? null
      if (
        equivalent &&
        index.unique &&
        !index.partial &&
        declaredWhere === null &&
        orderedColumns(index.columns, equivalent.columns)
      ) {
        const cover = db.indexes.find(
          (item) => item.unique && orderedColumns(item.columns, equivalent.columns) && extractWherePredicate(item.sql) === null,
        )
        if (cover) continue
      }
      throw new Error(
        `Declared index ${declared.name}.${index.name} is missing from the migrated database: schema has no migration.`,
      )
    }
    if (found.unique !== index.unique) {
      throw new Error(
        `Declared index ${declared.name}.${index.name} uniqueness mismatch: schema declares ${index.unique ? "UNIQUE" : "non-unique"} but migration built ${found.unique ? "UNIQUE" : "non-unique"}.`,
      )
    }
    const actualWhere = extractWherePredicate(found.sql)
    const declaredWhere = index.where ?? null
    if ((actualWhere === null) !== (declaredWhere === null)) {
      throw new Error(
        `Declared index ${declared.name}.${index.name} partial-predicate mismatch: schema declares ${declaredWhere === null ? "no predicate" : `WHERE ${declaredWhere}`} but migration built ${actualWhere === null ? "no predicate" : `WHERE ${actualWhere}`}.`,
      )
    }
    if (
      declaredWhere !== null &&
      actualWhere !== null &&
      normalizeWhere(declaredWhere) !== normalizeWhere(actualWhere)
    ) {
      throw new Error(
        `Declared index ${declared.name}.${index.name} partial-predicate mismatch: schema declares WHERE ${declaredWhere} but migration built WHERE ${actualWhere}.`,
      )
    }
    if (JSON.stringify(found.columns) !== JSON.stringify(index.columns)) {
      throw new Error(
        `Declared index ${declared.name}.${index.name} column mismatch: schema declares (${index.columns.join(", ")}) but migration built (${found.columns.join(", ")}).`,
      )
    }
  }
  for (const index of db.indexes) {
    if (index.name.startsWith("sqlite_autoindex_")) continue
    if (!declared.indexes.some((item) => item.name === index.name)) {
      throw new Error(
        `Migrated database index ${declared.name}.${index.name} is not declared in schema: migration drifted from Drizzle declarations.`,
      )
    }
  }
}
