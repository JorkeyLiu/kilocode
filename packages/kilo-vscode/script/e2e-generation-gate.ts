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
 * Besides the prompt owner/member + prompt operation receipt, the gate also
 * returns every `provider` operation row for the session (op_id, outcome,
 * time, nullable gen_id link). Harness-side assertions scope the link check
 * to this generation only (gen_id equality + in-window leak check); unrelated
 * sessions, other generations' links, and out-of-window legacy null rows are
 * never required to link.
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
  const cols = raw.query("SELECT name FROM pragma_table_info('session_operation')").all() as Array<
    Record<string, unknown>
  >
  const linked = cols.some((c) => c.name === "gen_id")
  const prows = (
    linked
      ? raw.query(
          "SELECT op_id, session_id, op_kind, outcome, code, message, time, gen_id FROM session_operation WHERE session_id=? AND op_kind='provider' ORDER BY time, op_id",
        ).all(sessionId)
      : raw.query(
          "SELECT op_id, session_id, op_kind, outcome, code, message, time FROM session_operation WHERE session_id=? AND op_kind='provider' ORDER BY time, op_id",
        ).all(sessionId)
  ) as Array<Record<string, unknown>>
  const providers = prows.map((r) => ({
    opId: r.op_id,
    sessionID: r.session_id,
    kind: r.op_kind,
    outcome: r.outcome,
    code: r.code,
    message: r.message,
    time: r.time,
    genID: typeof r.gen_id === "string" ? (r.gen_id as string) : null,
  }))
  const hasReceipt = has("session_operation_receipt")
  const mapReceipt = (r: Record<string, unknown>) => ({
    opId: r.op_id,
    sessionID: r.session_id,
    outcome: r.outcome,
    time: r.time,
    genID: typeof r.gen_id === "string" ? (r.gen_id as string) : null,
    genUnknown: typeof r.gen_unknown === "string" ? (r.gen_unknown as string) : null,
    used: typeof r.owner_used === "number" ? (r.owner_used as number) : null,
    limit: typeof r.owner_limit === "number" ? (r.owner_limit as number) : null,
    layer: typeof r.owner_layer === "string" ? (r.owner_layer as string) : null,
    retryOccurrence: typeof r.owner_retry_occurrence === "number" ? (r.owner_retry_occurrence as number) : null,
    nextAt: typeof r.owner_next_at === "number" ? (r.owner_next_at as number) : null,
    closeReason: typeof r.owner_close_reason === "string" ? (r.owner_close_reason as string) : null,
    replay: r.replay,
  })
  let receiptColumns: Array<string> = []
  let receipt: ReturnType<typeof mapReceipt> | null = null
  let providerReceipts: Array<ReturnType<typeof mapReceipt>> = []
  if (hasReceipt) {
    const rcols = raw.query("SELECT name FROM pragma_table_info('session_operation_receipt')").all() as Array<
      Record<string, unknown>
    >
    receiptColumns = rcols.map((c) => String(c.name))
    const rrow = raw.query(
      "SELECT op_id, session_id, outcome, time, gen_id, gen_unknown, owner_used, owner_limit, owner_layer, owner_retry_occurrence, owner_next_at, owner_close_reason, replay FROM session_operation_receipt WHERE op_id=?",
    ).get(opId) as Record<string, unknown> | undefined
    if (rrow) receipt = mapReceipt(rrow)
    const prrows = raw.query(
      "SELECT op_id, session_id, outcome, time, gen_id, gen_unknown, owner_used, owner_limit, owner_layer, owner_retry_occurrence, owner_next_at, owner_close_reason, replay FROM session_operation_receipt WHERE session_id=?",
    ).all(sessionId) as Array<Record<string, unknown>>
    providerReceipts = prrows.map(mapReceipt)
  }
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
    providers,
    hasProviderGenColumn: linked,
    hasReceiptTable: hasReceipt,
    receiptColumns,
    receipt,
    providerReceipts,
  }
  console.log(JSON.stringify(out))
} finally {
  raw.close()
}
