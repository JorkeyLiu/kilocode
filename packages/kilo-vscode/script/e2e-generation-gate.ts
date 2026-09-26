#!/usr/bin/env bun
/**
 * Bun-only read-only generation owner/member probe for E2E.
 * Queries canonical SQLite via bun:sqlite with `{ readonly: true }` and
 * returns structured JSON to the Node parent. Never writes, never leases,
 * never touches the network.
 *
 * This file MUST run under Bun (it imports bun:sqlite); the Node harness
 * spawns it as a child via `bun run script/e2e-generation-gate.ts ...`
 * with an argument array (no shell interpolation). Output is strictly JSON
 * on stdout; errors go to stderr with non-zero exit.
 *
 * Modes:
 *   --scratch <dir> --dbPath <path> --sessionId <ses> --opId <prompt:msg>
 *     read one prompt op's generation facts as JSON.
 *
 * Isolation: dbPath must equal <scratch>/xdg-data/kilo/kilo.db exactly
 * (resolved). Anything else fails closed so a run can never observe the
 * user's real HOME/XDG data.
 */

import { Database } from "bun:sqlite"
import { existsSync } from "node:fs"
import { join, resolve } from "node:path"

function fail(msg: string): never {
  console.error(msg)
  process.exit(1)
}

const args = process.argv.slice(2)
let scratch: string | undefined
let dbPath: string | undefined
let sessionId: string | undefined
let opId: string | undefined

for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === "--scratch") scratch = args[++i]
  else if (a === "--dbPath") dbPath = args[++i]
  else if (a === "--sessionId") sessionId = args[++i]
  else if (a === "--opId") opId = args[++i]
  else if (a === "--help" || a === "-h") {
    console.log("usage: bun run e2e-generation-gate.ts --scratch <dir> --dbPath <path> --sessionId <ses> --opId <prompt:msg>")
    process.exit(0)
  } else {
    fail(`unknown arg: ${a}`)
  }
}

if (!scratch) fail("--scratch is required (run-owned isolation root)")
if (!dbPath) fail("--dbPath is required")
if (!sessionId) fail("--sessionId is required")
if (!opId) fail("--opId is required")
if (!sessionId.startsWith("ses")) fail(`sessionId must be ses*, got ${sessionId}`)
if (!opId.startsWith("prompt:msg")) fail(`opId must be prompt:msg*, got ${opId}`)

const expected = join(resolve(scratch), "xdg-data", "kilo", "kilo.db")
if (resolve(dbPath) !== expected) fail(`dbPath must be the run-owned canonical DB ${expected}, got ${dbPath}`)
if (!existsSync(dbPath)) fail(`kilo.db missing at ${dbPath}`)

const raw = new Database(dbPath, { readonly: true })
try {
  const has = (tbl: string): boolean => {
    const row = raw.query("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(tbl) as
      | Record<string, unknown>
      | undefined
    return !!row
  }
  for (const tbl of ["session", "session_generation_owner", "session_generation_member", "session_operation"]) {
    if (!has(tbl)) fail(`required table missing: ${tbl}`)
  }
  const srow = raw.query("SELECT id, directory FROM session WHERE id=?").get(sessionId) as
    | Record<string, unknown>
    | undefined
  const mrows = raw.query(
    "SELECT gen_id, prompt_op_id, session_id, added_time FROM session_generation_member WHERE prompt_op_id=? ORDER BY gen_id",
  ).all(opId) as Array<Record<string, unknown>>
  const members = mrows
    .filter((m) => m.session_id === sessionId)
    .map((m) => ({ genID: m.gen_id, promptOpID: m.prompt_op_id, sessionID: m.session_id, added: m.added_time }))
  const gids = [...new Set(members.map((m) => m.genID as string))]
  const owners = gids.map((gid) => {
    const orow = raw.query(
      "SELECT gen_id, session_id, occurrence_time, close_time, close_reason, retry_limit, retry_consumed, retry_layer, retry_next_at FROM session_generation_owner WHERE gen_id=?",
    ).get(gid) as Record<string, unknown> | undefined
    if (!orow) fail(`member without owner for gen ${gid}`)
    return {
      genID: orow.gen_id,
      sessionID: orow.session_id,
      occurrence: orow.occurrence_time,
      closedAt: (orow.close_time as number | null | undefined) ?? null,
      reason: (orow.close_reason as string | null | undefined) ?? null,
      limit: orow.retry_limit,
      used: orow.retry_consumed,
      layer: (orow.retry_layer as string | null | undefined) ?? null,
      nextAt: (orow.retry_next_at as number | null | undefined) ?? null,
    }
  })
  const orow = raw.query(
    "SELECT op_id, session_id, op_kind, outcome, code, message, time FROM session_operation WHERE op_id=?",
  ).get(opId) as Record<string, unknown> | undefined
  const out = {
    dbPath,
    sessionId,
    opId,
    session: { exists: !!srow, directory: (srow?.directory as string | undefined) ?? null },
    members,
    owners,
    operation: orow
      ? {
          opId: orow.op_id,
          sessionID: orow.session_id,
          kind: orow.op_kind,
          outcome: orow.outcome,
          code: orow.code,
          message: orow.message,
          time: orow.time,
        }
      : null,
  }
  console.log(JSON.stringify(out))
} finally {
  raw.close()
}
