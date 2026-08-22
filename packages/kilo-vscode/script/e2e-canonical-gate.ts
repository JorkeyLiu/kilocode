#!/usr/bin/env bun
/**
 * Bun-only helper for the real-restart E2E harness. Performs read-only SQLite
 * gate queries via bun:sqlite and returns structured JSON to the Node parent.
 *
 * This file MUST run under Bun (it imports bun:sqlite); the Node harness spawns
 * it as a child via `bun run script/e2e-canonical-gate.ts --dbPath ...` with
 * an argument array (no shell interpolation). Output is strictly JSON on
 * stdout; errors go to stderr with non-zero exit.
 *
 * Modes:
 *   --init --dbPath <path>                         create minimal SQLite file if absent
 *   --dbPath <path> --dataRoot <path>              read canonical gate evidence as JSON
 */

import { Database } from "bun:sqlite"
import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"

function fail(msg: string): never {
  console.error(msg)
  process.exit(1)
}

const args = process.argv.slice(2)
let dbPath: string | undefined
let dataRoot: string | undefined
let init = false

for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === "--init") init = true
  else if (a === "--dbPath") dbPath = args[++i]
  else if (a === "--dataRoot") dataRoot = args[++i]
  else if (a === "--help" || a === "-h") {
    console.log("usage: bun run e2e-canonical-gate.ts --dbPath <path> [--dataRoot <path>] [--init]")
    process.exit(0)
  } else {
    fail(`unknown arg: ${a}`)
  }
}

if (!dbPath) fail("--dbPath is required")

if (init) {
  if (!existsSync(dbPath)) {
    const db = new Database(dbPath, { create: true })
    db.close()
  }
  console.log(JSON.stringify({ ok: true, dbPath }))
  process.exit(0)
}

if (!dataRoot) fail("--dataRoot is required for gate read")
if (!existsSync(dbPath)) fail(`kilo.db missing at ${dbPath}`)

const raw = new Database(dbPath, { readonly: true })
try {
  const ident = raw.query("SELECT uuid, schema_version, created_at, cutover_archive_id FROM storage_identity WHERE id = 1").get() as
    | Record<string, unknown>
    | undefined
  if (!ident) fail("storage_identity missing")
  const av = raw.query("PRAGMA auto_vacuum").get() as Record<string, unknown> | undefined
  const autoVacuum = Number((av as Record<string, unknown>)?.auto_vacuum ?? (av as unknown as number) ?? 0)
  const zeroState: Record<string, unknown> = {}
  const zeroTables = [
    "session",
    "message",
    "part",
    "todo",
    "session_message",
    "session_input",
    "session_context_epoch",
    "session_share",
    "event",
    "event_sequence",
    "session_changefeed",
    "retention_obligation",
  ]
  for (const tbl of zeroTables) {
    try {
      const row = raw.query(`SELECT count(*) as c FROM "${tbl}"`).get() as Record<string, unknown> | undefined
      zeroState[tbl] = Number((row as Record<string, unknown>)?.c ?? 0)
    } catch (e: unknown) {
      const msg = String((e as Error)?.message ?? "")
      if (msg.includes("no such table") && (tbl === "event" || tbl === "event_sequence")) zeroState[tbl] = 0
      else throw e
    }
  }
  const scsCount = raw.query(`SELECT count(*) as c FROM "session_changefeed_state"`).get() as Record<string, unknown>
  zeroState.session_changefeed_state_count = Number((scsCount as Record<string, unknown>)?.c ?? 0)
  const scsRow = raw.query("SELECT latest_seq, retained_rows, retained_bytes FROM session_changefeed_state WHERE id = 1").get() as
    | Record<string, unknown>
    | undefined
  zeroState.session_changefeed_state = scsRow ?? null
  const identCount = raw.query(`SELECT count(*) as c FROM "storage_identity"`).get() as Record<string, unknown>
  zeroState.storage_identity_count = Number((identCount as Record<string, unknown>)?.c ?? 0)
  const family: Record<string, unknown> = {}
  for (const k of ["session_diff", "session_diff_base", "session_share"]) {
    const dir = join(dataRoot, "storage", k)
    const entries = existsSync(dir) ? readdirSync(dir) : []
    family[k] = entries.length
  }
  const out = {
    dbPath,
    dataRoot,
    collectedAt: new Date().toISOString(),
    identity: ident,
    autoVacuum,
    zeroState,
    family,
  }
  console.log(JSON.stringify(out))
} finally {
  raw.close()
}
