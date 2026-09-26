import { describe, expect, test } from "bun:test"
import { $ } from "bun"
import path from "path"
import { pathToFileURL } from "url"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { sql } from "drizzle-orm"
import { index, sqliteTable, text } from "drizzle-orm/sqlite-core"
import type { SQLiteTable } from "drizzle-orm/sqlite-core"
import { Effect } from "effect"
import type { SqlClient as SqlClientService } from "effect/unstable/sql/SqlClient"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { SessionOperationTable } from "@opencode-ai/core/session/sql"
import {
  RUNTIME_OWNED_TABLES,
  assertRegistryParity,
  assertSqlWrappers,
  assertTableParity,
  assertTableSetParity,
  toDeclaredTable,
} from "../script/migration-check"
import { assertGenerateAllowed } from "../script/migration"

const run = <A, E>(effect: Effect.Effect<A, E, SqlClientService>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
  )

const makeDb = EffectDrizzleSqlite.makeWithDefaults()

describe("MigrationGuard", () => {
  test("registry chain matches declared schema, and a missing gen_id column fails closed", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseMigration.apply(db)
        const load = (name: string) =>
          Effect.gen(function* () {
            const columns = yield* db.all<{ name: string; type: string; notnull: number }>(
              sql.raw(`SELECT name, type, "notnull" FROM pragma_table_info('${name}')`),
            )
            const master = yield* db.all<{ name: string; sql: string | null }>(
              sql.raw(`SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = '${name}'`),
            )
            const flags = yield* db.all<{ name: string; unique: number }>(
              sql.raw(`SELECT name, "unique" FROM pragma_index_list('${name}')`),
            )
            const unique = new Map(flags.map((row) => [row.name, row.unique === 1]))
            const indexes = []
            for (const row of master) {
              const cols = yield* db.all<{ name: string }>(
                sql.raw(`SELECT name FROM pragma_index_info('${row.name}') ORDER BY seqno`),
              )
              indexes.push({
                name: row.name,
                unique: unique.get(row.name) ?? false,
                sql: row.sql,
                columns: cols.map((col) => col.name),
              })
            }
            return { columns, indexes }
          })
        const declared = toDeclaredTable(SessionOperationTable)
        expect(declared.columns.some((column) => column.name === "gen_id")).toBe(true)
        const table = yield* load("session_operation")
        assertTableParity(declared, table)
        // Simulate a registry chain that never created the column: the loaded
        // database state is real, only the stale absence is projected.
        const stale = { ...table, columns: table.columns.filter((column) => column.name !== "gen_id") }
        expect(() => assertTableParity(declared, stale)).toThrow("session_operation.gen_id")
      }),
    )
  })

  test("registry missing an entry fails closed", () => {
    expect(() =>
      assertRegistryParity(
        ["20260824000000_add_operation_record", "20260926000000_add_provider_gen_link"],
        ["20260824000000_add_operation_record"],
      ),
    ).toThrow("20260926000000_add_provider_gen_link")
  })

  test("SQL snapshot without a TS wrapper fails closed", () => {
    expect(() =>
      assertSqlWrappers(
        ["20260824000000_add_operation_record", "20260926000000_add_provider_gen_link"],
        ["20260824000000_add_operation_record"],
      ),
    ).toThrow("20260926000000_add_provider_gen_link")
  })

  test("diagnostics point to --check and never recommend the bare generate path", () => {
    let wrapperErr: Error | null = null
    try {
      assertSqlWrappers(
        ["20260824000000_add_operation_record", "20260926000000_add_provider_gen_link"],
        ["20260824000000_add_operation_record"],
      )
    } catch (error) {
      wrapperErr = error as Error
    }
    expect(wrapperErr).not.toBeNull()
    expect(wrapperErr!.message).toContain("20260926000000_add_provider_gen_link")
    expect(wrapperErr!.message).toContain("`bun script/migration.ts --check`")
    expect(wrapperErr!.message).toContain("Do not run drizzle-kit generate")
    expect(wrapperErr!.message).not.toContain("Run `bun script/migration.ts` from")

    let registryErr: Error | null = null
    try {
      assertRegistryParity(
        ["20260824000000_add_operation_record", "20260926000000_add_provider_gen_link"],
        ["20260824000000_add_operation_record"],
      )
    } catch (error) {
      registryErr = error as Error
    }
    expect(registryErr).not.toBeNull()
    expect(registryErr!.message).toContain("20260926000000_add_provider_gen_link")
    expect(registryErr!.message).toContain("`bun script/migration.ts --check`")
    expect(registryErr!.message).toContain("Do not run drizzle-kit generate")
    expect(registryErr!.message).not.toContain("Run `bun script/migration.ts` from")
  })

  test("partial predicate text mismatch fails closed", () => {
    const declared = {
      name: "session_operation",
      columns: [],
      indexes: [
        {
          name: "session_operation_message_id_idx",
          unique: false,
          partial: true,
          where: `"message_id" IS NOT NULL`,
          columns: ["message_id"],
        },
      ],
    }
    const base = {
      columns: [],
      indexes: [
        {
          name: "session_operation_message_id_idx",
          unique: false,
          sql: `CREATE INDEX "session_operation_message_id_idx" ON "session_operation" ("message_id") WHERE "message_id" IS NOT NULL`,
          columns: ["message_id"],
        },
      ],
    }
    expect(() => assertTableParity(declared, base)).not.toThrow()
    // Quoting, case, and whitespace differences normalize away.
    const formatted = {
      ...base,
      indexes: [
        {
          ...base.indexes[0],
          sql: "CREATE INDEX session_operation_message_id_idx ON session_operation (message_id) where  message_id   is not null",
        },
      ],
    }
    expect(() => assertTableParity(declared, formatted)).not.toThrow()
    const changed = {
      ...base,
      indexes: [{ ...base.indexes[0], sql: `CREATE INDEX "session_operation_message_id_idx" ON "session_operation" ("message_id") WHERE "message_id" IS NULL` }],
    }
    expect(() => assertTableParity(declared, changed)).toThrow("partial-predicate mismatch")
    const dropped = {
      ...base,
      indexes: [{ ...base.indexes[0], sql: `CREATE INDEX "session_operation_message_id_idx" ON "session_operation" ("message_id")` }],
    }
    expect(() => assertTableParity(declared, dropped)).toThrow("partial-predicate mismatch")
    const added = {
      name: "session_operation",
      columns: [],
      indexes: [
        {
          name: "session_operation_message_id_idx",
          unique: false,
          partial: false,
          where: null,
          columns: ["message_id"],
        },
      ],
    }
    expect(() => assertTableParity(added, base)).toThrow("partial-predicate mismatch")
  })

  test("unique constraint equivalent requires ordered non-partial cover", () => {
    const declared = {
      name: "session_changefeed",
      columns: [],
      indexes: [
        {
          name: "session_changefeed_session_revision_kind_idx",
          unique: true,
          partial: false,
          where: null,
          columns: ["session_id", "revision", "kind"],
        },
      ],
    }
    const cover = {
      columns: [],
      indexes: [
        {
          name: "sqlite_autoindex_session_changefeed_1",
          unique: true,
          sql: null,
          columns: ["session_id", "revision", "kind"],
        },
      ],
    }
    expect(() => assertTableParity(declared, cover)).not.toThrow()
    const reordered = {
      ...cover,
      indexes: [{ ...cover.indexes[0], columns: ["kind", "revision", "session_id"] }],
    }
    expect(() => assertTableParity(declared, reordered)).toThrow("is missing from the migrated database")
    const partial = {
      ...cover,
      indexes: [
        {
          ...cover.indexes[0],
          name: "session_changefeed_partial_cover",
          sql: `CREATE UNIQUE INDEX "session_changefeed_partial_cover" ON "session_changefeed" ("session_id", "revision", "kind") WHERE "kind" IS NOT NULL`,
        },
      ],
    }
    expect(() => assertTableParity(declared, partial)).toThrow("is missing from the migrated database")
  })

  test("table set parity is exact: extra tables and missing whitelist entries fail", () => {
    // Lock the precise whitelist: exactly the migration journal plus
    // storage_identity. Any third runtime-owned table must update the
    // whitelist, its citations, and this test together.
    expect([...RUNTIME_OWNED_TABLES].sort()).toEqual(["migration", "storage_identity"])
    // sqlite_% builtins never count.
    expect(() => assertTableSetParity([], ["sqlite_sequence", "migration", "storage_identity"])).not.toThrow()
    // Third terminal user table fails closed, even one shaped like a
    // historical temporary table a migration-script CREATE-name union would
    // have allowed.
    expect(() => assertTableSetParity(["widget"], ["widget", "migration", "storage_identity", "legacy_tmp"])).toThrow(
      "legacy_tmp",
    )
    // Whitelist entry absent from the database fails instead of passing as a
    // tolerated subset.
    expect(() => assertTableSetParity(["widget"], ["widget", "migration"])).toThrow("storage_identity")
    // Declared table absent from the database fails at set level too.
    expect(() => assertTableSetParity(["widget"], ["migration", "storage_identity"])).toThrow("widget")
  })

  test("full registry chain matches declared set plus exact whitelist", async () => {
    const coreDir = path.resolve(import.meta.dirname, "..")
    const schemaFiles = new Set([
      ...(await Array.fromAsync(new Bun.Glob("src/**/*.sql.ts").scan({ cwd: coreDir }))),
      ...(await Array.fromAsync(new Bun.Glob("src/**/sql.ts").scan({ cwd: coreDir }))),
    ])
    const names: string[] = []
    for (const file of [...schemaFiles].sort()) {
      const ns = (await import(pathToFileURL(path.join(coreDir, file)).href)) as Record<string, unknown>
      for (const value of Object.values(ns)) {
        try {
          names.push(toDeclaredTable(value as SQLiteTable).name)
        } catch (err) {
          if (err instanceof Error && err.message.startsWith("Declared index")) throw err
        }
      }
    }
    // Lock the 28 declared / 30 terminal shape (28 + migration journal +
    // storage_identity). Update these counts when a declared table or a
    // whitelisted runtime-owned table is added.
    expect(names.length).toBe(28)
    expect(names).toContain("session_operation_receipt")
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseMigration.apply(db)
        const rows = yield* db.all<{ name: string }>(
          sql.raw(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`),
        )
        expect(rows.length).toBe(30)
        expect(rows.map((row) => row.name)).toContain("session_operation_receipt")
        const raw = yield* db.all<{ name: string }>(sql.raw(`SELECT name FROM sqlite_master WHERE type = 'table'`))
        expect(() =>
          assertTableSetParity(
            names,
            raw.map((row) => row.name),
          ),
        ).not.toThrow()
        // A leftover historical temporary table is undeclared drift, not an
        // allowlisted migration artifact.
        yield* db.run(sql.raw(`CREATE TABLE legacy_tmp (id INTEGER)`))
        const stale = yield* db.all<{ name: string }>(sql.raw(`SELECT name FROM sqlite_master WHERE type = 'table'`))
        expect(() =>
          assertTableSetParity(
            names,
            stale.map((row) => row.name),
          ),
        ).toThrow("legacy_tmp")
      }),
    )
  })

  test("expression index column fails closed", () => {
    const probe = sqliteTable("expr_probe", { a: text("a") }, (table) => [
      index("expr_probe_idx").on(sql`lower(${table.a})`),
    ])
    expect(() => toDeclaredTable(probe)).toThrow("expression column")
  })

  test("non-check generate gate refuses TS-only drift without rewriting snapshots or registry", async () => {
    const root = path.resolve(import.meta.dirname, "../../..")
    const sqlDir = path.join(root, "packages/core/migration")
    const tsDir = path.join(root, "packages/core/src/database/migration")
    const registryPath = path.join(root, "packages/core/src/database/migration.gen.ts")
    const sqlNames = (
      await Array.fromAsync(new Bun.Glob("*/migration.sql").scan({ cwd: sqlDir }))
    )
      .map((file) => file.split("/")[0])
      .filter((name) => name !== undefined)
      .sort()
    const tsNames = (await Array.fromAsync(new Bun.Glob("*.ts").scan({ cwd: tsDir })))
      .map((file) => file.replace(/\.ts$/, ""))
      .sort()
    // Lock the destructive scenario: SQL-only snapshots vs full TS chain.
    // Update these counts when a migration is added; the gate must still refuse
    // whenever any TS-only entry exists.
    expect(sqlNames.length).toBe(34)
    expect(tsNames.length).toBe(55)
    expect(tsNames.filter((name) => !new Set(sqlNames).has(name)).length).toBe(21)

    const beforeRegistry = await Bun.file(registryPath).text()
    const beforeStatus = await $`git status --porcelain -- packages/core/src/database/migration.gen.ts packages/core/migration`
      .cwd(root)
      .text()

    // Pure gate only: this never spawns drizzle-kit generate.
    let err: Error | null = null
    try {
      assertGenerateAllowed(sqlNames, tsNames)
    } catch (error) {
      err = error as Error
    }
    expect(err).not.toBeNull()
    expect(err!.message).toContain("TypeScript-only")
    expect(err!.message).toContain("established authoring pattern")
    expect(err!.message).toContain("stale and untrusted")
    expect(err!.message).toContain("duplicate CREATE")
    expect(err!.message).toContain("do not run generate")
    expect(err!.message).not.toContain("Run `bun script/migration.ts`")

    // Same 34/55 shape with synthetic names refuses without any I/O.
    const synthSql = Array.from({ length: 34 }, (_, index) => `2026010100000${String(index).padStart(2, "0")}_sql`)
    const synthTs = [...synthSql, ...Array.from({ length: 21 }, (_, index) => `2026090100000${String(index).padStart(2, "0")}_ts_only`)]
    expect(() => assertGenerateAllowed(synthSql, synthTs)).toThrow("TypeScript-only")

    // Nothing was rewritten: registry bytes and git status are unchanged, and
    // the registry still carries a known TS-only entry the SQL-only rewrite
    // would have dropped.
    expect(await Bun.file(registryPath).text()).toBe(beforeRegistry)
    expect(beforeRegistry).toContain("20260926000000_add_provider_gen_link")
    const afterStatus = await $`git status --porcelain -- packages/core/src/database/migration.gen.ts packages/core/migration`
      .cwd(root)
      .text()
    expect(afterStatus).toBe(beforeStatus)

    // Parity sets still allow generate; --check still tolerates TS-only.
    expect(() => assertGenerateAllowed(sqlNames, sqlNames)).not.toThrow()
    expect(() => assertSqlWrappers(sqlNames, tsNames)).not.toThrow()
  })
})
