/**
 * Harness-side (Node) generation owner/member assertions over canonical
 * SQLite via the Bun-only `e2e-generation-gate.ts` helper.
 *
 * Node never loads bun:sqlite — every fact comes from a spawned read-only
 * gate child (`{ readonly: true }`, no lease, no writes, no network). The
 * gate fails closed unless dbPath is the run-owned
 * `<scratch>/xdg-data/kilo/kilo.db`.
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { spawnSync } from "node:child_process"

export interface GateMember {
  genID: string
  promptOpID: string
  sessionID: string
  added: number
}

export interface GateOwner {
  genID: string
  sessionID: string
  occurrence: number
  closedAt: number | null
  reason: string | null
  limit: number
  used: number
  layer: string | null
  nextAt: number | null
}

export interface GateOperation {
  opId: string
  sessionID: string
  kind: string
  outcome: string
  code: string
  message: string
  time: number
}

export interface GateProviderOp {
  opId: string
  sessionID: string
  kind: string
  outcome: string
  code: string
  message: string
  time: number
  genID: string | null
}

export interface GateReceipt {
  opId: string
  sessionID: string
  outcome: string
  time: number
  genID: string | null
  genUnknown: string | null
  used: number | null
  limit: number | null
  layer: string | null
  retryOccurrence: number | null
  nextAt: number | null
  closeReason: string | null
  replay: string
}

export interface GateFacts {
  dbPath: string
  sessionId: string
  opId: string
  session: { exists: boolean; directory: string | null }
  members: GateMember[]
  owners: GateOwner[]
  operation: GateOperation | null
  providers: GateProviderOp[]
  hasProviderGenColumn: boolean
  hasReceiptTable: boolean
  receiptColumns: string[]
  receipt: GateReceipt | null
  providerReceipts: GateReceipt[]
}

const CLOSE = new Set(["completed", "interrupted", "error", "crash"])
const LAYER = new Set(["provider", "incomplete", "broker", "task", "restart"])

export function runGenerationGate(
  root: string,
  scratch: string,
  dbPath: string,
  sessionId: string,
  opId: string,
): GateFacts {
  const gate = join(root, "script", "e2e-generation-gate.ts")
  const spawned = spawnSync("bun", ["run", gate, "--scratch", scratch, "--dbPath", dbPath, "--sessionId", sessionId, "--opId", opId], {
    encoding: "utf8",
    timeout: 30_000,
  })
  if (spawned.status !== 0) {
    throw new Error(`generation gate failed for ${opId}: ${(spawned.stdout ?? "")}\n${(spawned.stderr ?? "").slice(0, 2000)}`)
  }
  const text = (spawned.stdout ?? "").trim()
  if (!text) throw new Error(`generation gate empty output for ${opId}`)
  return JSON.parse(text) as GateFacts
}

function checkMember(m: GateMember, gid: string, opId: string, sessionId: string): string | undefined {
  if (m.genID !== gid) return "member gen_id mismatch owner"
  if (m.promptOpID !== opId) return "member prompt_op_id mismatch"
  if (m.sessionID !== sessionId) return "member session mismatch"
  if (typeof m.added !== "number" || !Number.isFinite(m.added)) return "member added_time invalid"
  return undefined
}

function checkOwnerId(o: GateOwner, sessionId: string): string | undefined {
  if (typeof o.genID !== "string" || o.genID.length === 0 || o.genID.includes(":")) return `owner gen_id invalid ${String(o.genID)}`
  if (o.sessionID !== sessionId) return "owner session mismatch"
  return undefined
}

function checkOwnerTimes(o: GateOwner): string | undefined {
  if (typeof o.occurrence !== "number" || !Number.isFinite(o.occurrence)) return "occurrence_time invalid"
  if (o.closedAt !== null && (typeof o.closedAt !== "number" || !Number.isFinite(o.closedAt))) return "close_time invalid"
  if (o.nextAt !== null && (typeof o.nextAt !== "number" || !Number.isFinite(o.nextAt))) return "retry_next_at invalid"
  return undefined
}

function checkOwnerBudget(o: GateOwner): string | undefined {
  if (o.reason !== null && !CLOSE.has(o.reason)) return `close_reason invalid ${String(o.reason)}`
  if (o.layer !== null && !LAYER.has(o.layer)) return `retry_layer invalid ${String(o.layer)}`
  if (typeof o.limit !== "number" || !Number.isInteger(o.limit) || o.limit < 0) return "retry_limit invalid"
  if (typeof o.used !== "number" || !Number.isInteger(o.used) || o.used < 0 || o.used > o.limit) return "retry_consumed invalid"
  if (o.reason !== null && o.nextAt !== null) return "retry_next_at must be null once closed"
  return undefined
}

function checkOwner(o: GateOwner, sessionId: string): string | undefined {
  return checkOwnerId(o, sessionId) ?? checkOwnerTimes(o) ?? checkOwnerBudget(o)
}

/**
 * noReply:true premise: the prompt operation succeeded but no Runner
 * generation was ever enqueued, so canonical SQLite must carry NO false
 * owner/member rows for the op. The prompt operation row itself (the
 * receipt) must exist with outcome succeeded.
 */
export function assertNoFalseGeneration(root: string, scratch: string, dbPath: string, sessionId: string, opId: string): GateFacts {
  const facts = runGenerationGate(root, scratch, dbPath, sessionId, opId)
  if (!facts.session.exists) throw new Error(`session ${sessionId} missing in canonical DB`)
  if (facts.members.length !== 0) throw new Error(`FALSE owner/member: noReply prompt ${opId} must have no generation members, got ${facts.members.length}`)
  if (facts.owners.length !== 0) throw new Error(`FALSE owner/member: noReply prompt ${opId} must have no generation owner, got ${facts.owners.length}`)
  if (!facts.operation) throw new Error(`prompt operation receipt missing for ${opId}`)
  if (facts.operation.opId !== opId) throw new Error("operation opId mismatch")
  if (facts.operation.outcome !== "succeeded") throw new Error(`prompt operation outcome must be succeeded, got ${facts.operation.outcome}`)
  writeFileSync(join(scratch, "prompt-private-generation-absence.json"), JSON.stringify(facts, null, 2))
  console.log(`[probe] PASS no false owner/member for noReply ${opId} (operation ${facts.operation.outcome})`)
  return facts
}

export interface TerminalProof {
  gid: string
  owner: GateOwner
  members: GateMember[]
  operation: GateOperation | null
  providers: GateProviderOp[]
  receipt: GateReceipt | null
  providerReceipts: GateReceipt[]
}

/**
 * Read-only provider→generation link check for ONE completed generation.
 *
 * Scope is this generation only: every provider row already carrying this
 * gen_id must be well-formed, and no null-link provider attempt may sit
 * inside the owner window [occurrence, closedAt]. Anything else is exempt:
 * other sessions are never selected (gate filters by session), other
 * generations' links stay valid, and null-link rows outside the window are
 * unrelated/legacy and never fail the gate.
 *
 * Returns `{ done: true }` when the link is proven, `{ done: false }` when
 * the gate observed zero provider rows at all (absent — the caller reports
 * the fact instead of fabricating an assertion), or `{ done: false, error }`
 * for a real link violation (the poll loop keeps waiting until the deadline,
 * then throws the last error).
 */
function providerLinkState(facts: GateFacts, owner: GateOwner): { done: boolean; error?: string } {
  if (!facts.hasProviderGenColumn) return { done: false, error: `provider gen link column missing in ${facts.dbPath}` }
  const ops = facts.providers ?? []
  if (ops.length === 0) return { done: false }
  const gid = owner.genID
  const linked = ops.filter((o) => o.genID === gid)
  if (linked.length === 0) {
    return { done: false, error: `REAL BUG: no provider op linked to gen ${gid} among ${ops.length} provider row(s)` }
  }
  const bad = linked.find((o) => o.sessionID !== facts.sessionId || o.kind !== "provider")
  if (bad) return { done: false, error: `REAL BUG: linked provider row identity mismatch ${String(bad.opId)}` }
  const known = new Set(["in-flight", "succeeded", "failed", "ambiguous", "superseded", "abandoned"])
  const unknown = linked.find((o) => !known.has(o.outcome))
  if (unknown) {
    return { done: false, error: `REAL BUG: linked provider row invalid outcome ${String(unknown.opId)}=${String(unknown.outcome)}` }
  }
  const occ = owner.occurrence
  const closed = owner.closedAt
  if (typeof occ === "number" && typeof closed === "number") {
    const leaked = ops.filter(
      (o) => o.genID === null && typeof o.time === "number" && o.time >= occ && o.time <= closed,
    )
    if (leaked.length > 0) {
      return {
        done: false,
        error: `REAL BUG: ${leaked.length} provider attempt(s) without gen link in generation window ${gid}: ${leaked.map((o) => String(o.opId)).join(",")}`,
      }
    }
  }
  const flight = linked.filter((o) => o.outcome === "in-flight")
  if (flight.length > 0) {
    return { done: false, error: `REAL BUG: ${flight.length} linked provider row(s) still in-flight for closed gen ${gid}` }
  }
  if (!linked.some((o) => o.outcome !== "in-flight")) {
    return { done: false, error: `REAL BUG: no terminal provider op linked to closed gen ${gid}` }
  }
  if (owner.reason === "completed" && !linked.some((o) => o.outcome === "succeeded")) {
    return { done: false, error: `REAL BUG: completed gen ${gid} has no linked succeeded provider op` }
  }
  return { done: true }
}

const RECEIPT_EXPECTED_COLS = [
  "op_id",
  "session_id",
  "outcome",
  "time",
  "gen_id",
  "gen_unknown",
  "owner_used",
  "owner_limit",
  "owner_layer",
  "owner_retry_occurrence",
  "owner_next_at",
  "owner_close_reason",
  "replay",
]
const RECEIPT_SECRET_FORBIDDEN = [
  "detail",
  "stack",
  "result_snapshot",
  "sandbox_token_hash",
  "sandbox_source_session_id",
  "sandbox_source_directory",
  "close_time",
  "occurrence_time",
]

function checkReceiptColumns(cols: string[]): string | undefined {
  for (const c of RECEIPT_EXPECTED_COLS) {
    if (!cols.includes(c)) return `REAL BUG: receipt table missing column ${c}`
  }
  const leaked = RECEIPT_SECRET_FORBIDDEN.filter((c) => cols.includes(c))
  if (leaked.length > 0) return `REAL BUG: receipt table leaks secret columns ${leaked.join(",")}`
  return undefined
}

function checkOwnerSnapshotMatch(r: GateReceipt, owner: GateOwner): string | undefined {
  if (r.used === null || r.limit === null) return "REAL BUG: linked receipt owner_used/owner_limit must be set"
  if (!Number.isInteger(r.used) || !Number.isInteger(r.limit) || r.used < 0 || r.limit < 0 || r.used > r.limit) {
    return "REAL BUG: linked receipt owner_used/owner_limit invalid"
  }
  if (owner.reason === "completed" && (r.used !== owner.used || r.limit !== owner.limit)) {
    return `REAL BUG: receipt owner_used/owner_limit ${String(r.used)}/${String(r.limit)} != generation owner ${String(owner.used)}/${String(owner.limit)} at terminal`
  }
  return undefined
}

/**
 * Read-only session_operation_receipt check for ONE run-owned generation.
 *
 * Scope is this generation only: the run-owned prompt op (succeeded, via
 * member) must carry a receipt whose terminal outcome/time matches the
 * operation row, replay is forbidden, gen equals the owner, and owner
 * used/limit matches the generation owner at terminal in the completed
 * happy path; every linked succeeded provider attempt (provider gen link ==
 * owner) must carry the same class of receipt. Unrelated rows — other
 * generations' receipts, null-link legacy rows, explicit gen_unknown rows
 * for other ops — are never required. A missing receipt table is an
 * explicit failure, never a pass.
 */
function checkPromptReceipt(facts: GateFacts, owner: GateOwner): string | undefined {
  const op = facts.operation
  const gid = owner.genID
  const r = facts.receipt
  if (!r) return `REAL BUG: session_operation_receipt missing for run-owned prompt ${facts.opId}`
  if (r.opId !== facts.opId) return "REAL BUG: prompt receipt opId mismatch"
  if (r.sessionID !== facts.sessionId) return "REAL BUG: prompt receipt session mismatch"
  if (!op) return `REAL BUG: prompt operation row missing for receipt match ${facts.opId}`
  if (r.outcome !== op.outcome) {
    return `REAL BUG: prompt receipt outcome ${String(r.outcome)} != operation ${String(op.outcome)}`
  }
  if (r.time !== op.time) {
    return `REAL BUG: prompt receipt time ${String(r.time)} != operation ${String(op.time)}`
  }
  if (r.replay !== "forbidden") return `REAL BUG: prompt receipt replay must be forbidden, got ${String(r.replay)}`
  if (r.genID !== gid || r.genUnknown !== null) {
    return `REAL BUG: prompt receipt gen must equal owner ${gid} via member (no gen_unknown)`
  }
  return checkOwnerSnapshotMatch(r, owner)
}

function checkProviderReceipt(o: GateProviderOp, pr: GateReceipt | undefined, facts: GateFacts, gid: string, owner: GateOwner): string | undefined {
  if (!pr) return `REAL BUG: session_operation_receipt missing for linked succeeded provider ${String(o.opId)}`
  if (pr.sessionID !== facts.sessionId) return `REAL BUG: provider receipt session mismatch ${String(o.opId)}`
  if (pr.outcome !== o.outcome) {
    return `REAL BUG: provider receipt outcome ${String(pr.outcome)} != operation ${String(o.outcome)} for ${String(o.opId)}`
  }
  if (pr.time !== o.time) {
    return `REAL BUG: provider receipt time ${String(pr.time)} != operation ${String(o.time)} for ${String(o.opId)}`
  }
  if (pr.replay !== "forbidden") {
    return `REAL BUG: provider receipt replay must be forbidden for ${String(o.opId)}`
  }
  if (pr.genID !== gid || pr.genUnknown !== null) {
    return `REAL BUG: provider receipt gen must equal owner ${gid} for ${String(o.opId)}`
  }
  const perr = checkOwnerSnapshotMatch(pr, owner)
  if (perr) return `${perr} (provider ${String(o.opId)})`
  return undefined
}

function checkProviderReceipts(facts: GateFacts, owner: GateOwner): string | undefined {
  const gid = owner.genID
  const byOp = new Map((facts.providerReceipts ?? []).map((x) => [x.opId, x]))
  const linked = (facts.providers ?? []).filter((o) => o.genID === gid)
  const succeeded = linked.filter((o) => o.outcome === "succeeded")
  if (owner.reason === "completed" && linked.length > 0 && succeeded.length === 0) {
    return `REAL BUG: completed gen ${gid} has no linked succeeded provider op for receipt proof`
  }
  for (const o of succeeded) {
    const err = checkProviderReceipt(o, byOp.get(o.opId), facts, gid, owner)
    if (err) return err
  }
  return undefined
}

function receiptLinkState(facts: GateFacts, owner: GateOwner): { done: boolean; error?: string } {
  if (!facts.hasReceiptTable) return { done: false, error: `REAL BUG: session_operation_receipt table missing in ${facts.dbPath}` }
  const colErr = checkReceiptColumns(facts.receiptColumns ?? [])
  if (colErr) return { done: false, error: colErr }
  const promptErr = checkPromptReceipt(facts, owner)
  if (promptErr) return { done: false, error: promptErr }
  const providerErr = checkProviderReceipts(facts, owner)
  if (providerErr) return { done: false, error: providerErr }
  return { done: true }
}

/**
 * Real-generation premise: a completed turn enqueued a Runner generation,
 * so canonical SQLite must carry exactly one owner + >=1 members for the op
 * with a terminal close. Polls bounded for the terminal close to land.
 */
function terminalOwner(facts: GateFacts): GateOwner | undefined {
  if (!facts.session.exists) throw new Error(`session ${facts.sessionId} missing in canonical DB`)
  if (facts.members.length === 0 || facts.owners.length !== 1) return undefined
  const owner = facts.owners[0]!
  const gid = owner.genID
  if (facts.members.map((m) => checkMember(m, gid, facts.opId, facts.sessionId)).find(Boolean)) return undefined
  if (checkOwner(owner, facts.sessionId)) return undefined
  if (owner.reason === null || owner.closedAt === null || owner.nextAt !== null) return undefined
  const op = facts.operation
  if (op && op.opId !== facts.opId) throw new Error("operation opId mismatch")
  return owner
}

function absentProviderProof(facts: GateFacts, owner: GateOwner): TerminalProof | undefined {
  if ((facts.providers ?? []).length > 0) return undefined
  const rec = receiptLinkState(facts, owner)
  if (!rec.done) return undefined
  console.log(
    `[probe] provider gen link: no provider op rows in session ${facts.sessionId} for completed gen ${owner.genID} (fixture produced none, no link assertion)`,
  )
  return {
    gid: owner.genID,
    owner,
    members: facts.members,
    operation: facts.operation,
    providers: [],
    receipt: facts.receipt,
    providerReceipts: facts.providerReceipts ?? [],
  }
}

export function assertTerminalGeneration(
  root: string,
  scratch: string,
  dbPath: string,
  sessionId: string,
  opId: string,
  timeoutMs = 30_000,
): TerminalProof {
  const deadline = Date.now() + timeoutMs
  let last: GateFacts | null = null
  let pending: string | undefined
  for (;;) {
    last = runGenerationGate(root, scratch, dbPath, sessionId, opId)
    const owner = terminalOwner(last)
    if (owner) {
      const link = providerLinkState(last, owner)
      const rec = receiptLinkState(last, owner)
      if (link.done && rec.done) {
        return {
          gid: owner.genID,
          owner,
          members: last.members,
          operation: last.operation,
          providers: last.providers ?? [],
          receipt: last.receipt,
          providerReceipts: last.providerReceipts ?? [],
        }
      }
      pending = link.error ?? rec.error
      if (link.done && rec.error) pending = rec.error
    }
    if (Date.now() > deadline) break
    const end = Date.now() + 1000
    while (Date.now() < end) {
      // bounded sleep without timers
    }
  }
  if (last) {
    const owner = terminalOwner(last)
    if (owner) {
      const absent = absentProviderProof(last, owner)
      if (absent) return absent
    }
  }
  if (pending) throw new Error(`${pending}: ${JSON.stringify(last).slice(0, 800)}`)
  throw new Error(`REAL BUG: no terminal owner/member for completed ${opId}: ${JSON.stringify(last).slice(0, 800)}`)
}

/**
 * Real-generation tail for scripted-SSE scenarios: discover every user prompt
 * op from the run's `<prefix>-*.json` snapshots and prove terminal
 * owner/member facts for each through the read-only gate. Requires >=1
 * terminal `completed` owner. Loopback scripted SSE only — the gate itself
 * never touches the network.
 */
export function assertRealSnapGenerations(
  root: string,
  scratch: string,
  dbPath: string,
  prefix: string,
  evidence: string,
): TerminalProof[] {
  const files = readdirSync(scratch).filter((f) => new RegExp(`^${prefix}-\\d+\\.json$`).test(f))
  if (files.length === 0) throw new Error(`no ${prefix}-*.json snapshots for real generation proof`)
  const ops = new Map<string, string>()
  for (const f of files) {
    const snap = JSON.parse(readFileSync(join(scratch, f), "utf8")) as {
      messages?: Record<string, Array<{ id?: string; role?: string }>>
    }
    for (const [sid, msgs] of Object.entries(snap.messages ?? {})) {
      for (const m of msgs ?? []) {
        if (m.role === "user" && typeof m.id === "string" && m.id.startsWith("msg")) ops.set(`prompt:${m.id}`, sid)
      }
    }
  }
  if (ops.size === 0) throw new Error(`no user prompt ops in ${prefix} snapshots for generation proof`)
  const proofs: TerminalProof[] = []
  for (const [opId, sid] of ops) {
    proofs.push(assertTerminalGeneration(root, scratch, dbPath, sid, opId))
  }
  if (!proofs.some((p) => p.owner.reason === "completed")) {
    throw new Error(`no completed owner among ${proofs.length} real generation(s) for ${prefix}`)
  }
  const rows = proofs.map((p) => ({
    opId: p.members[0]!.promptOpID,
    gid: p.gid,
    members: p.members.length,
    reason: p.owner.reason,
    limit: p.owner.limit,
    used: p.owner.used,
    occurrence: p.owner.occurrence,
    closedAt: p.owner.closedAt,
    nextAt: p.owner.nextAt,
    operation: p.operation ? { opId: p.operation.opId, outcome: p.operation.outcome, code: p.operation.code } : null,
    providers: p.providers.length,
    linked: p.providers.filter((o) => o.genID === p.gid).length,
    providerOps: p.providers.map((o) => ({ opId: o.opId, outcome: o.outcome, genID: o.genID })),
    receipt: p.receipt
      ? {
          opId: p.receipt.opId,
          outcome: p.receipt.outcome,
          time: p.receipt.time,
          genID: p.receipt.genID,
          used: p.receipt.used,
          limit: p.receipt.limit,
          replay: p.receipt.replay,
        }
      : null,
    providerReceipts: p.providerReceipts.length,
    providerReceiptOps: p.providerReceipts.map((r) => ({ opId: r.opId, outcome: r.outcome, genID: r.genID })),
  }))
  writeFileSync(join(scratch, evidence), JSON.stringify({ dbPath, prefix, proofs: rows }, null, 2))
  console.log(`[probe] PASS real generations terminal (${prefix}): ${rows.map((e) => `${e.opId}->${e.gid} ${e.reason} ${e.used}/${e.limit}`).join(", ")}`)
  const checked = proofs.filter((p) => p.providers.length > 0)
  if (checked.length === 0) {
    console.log(`[probe] provider gen link: no provider op rows observed for ${prefix} (fixture produced none, no link assertion)`)
  } else {
    console.log(
      `[probe] PASS provider gen link (${prefix}): ${checked.map((p) => `${p.gid} linked ${p.providers.filter((o) => o.genID === p.gid).length}/${p.providers.length}`).join(", ")}`,
    )
  }
  const receiptCounts = proofs.map((p) => ({
    gid: p.gid,
    promptReceipt: p.receipt ? 1 : 0,
    providerReceipts: p.providerReceipts.length,
    linkedSucceeded: p.providers.filter((o) => o.genID === p.gid && o.outcome === "succeeded").length,
  }))
  console.log(
    `[probe] PASS operation receipts (${prefix}): ${receiptCounts.map((r) => `${r.gid} prompt=${r.promptReceipt} providerReceipts=${r.providerReceipts} linkedSucceeded=${r.linkedSucceeded}`).join(", ")}`,
  )
  return proofs
}

export function assertRealCompletedGenerations(root: string, scratch: string, dbPath: string): TerminalProof[] {
  return assertRealSnapGenerations(root, scratch, dbPath, "rc-snap", "real-generation-owners.json")
}
