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

export interface GateFacts {
  dbPath: string
  sessionId: string
  opId: string
  session: { exists: boolean; directory: string | null }
  members: GateMember[]
  owners: GateOwner[]
  operation: GateOperation | null
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
}

/**
 * Real-generation premise: a completed turn enqueued a Runner generation,
 * so canonical SQLite must carry exactly one owner + >=1 members for the op
 * with a terminal close. Polls bounded for the terminal close to land.
 */
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
  for (;;) {
    last = runGenerationGate(root, scratch, dbPath, sessionId, opId)
    if (!last.session.exists) throw new Error(`session ${sessionId} missing in canonical DB`)
    if (last.members.length > 0 && last.owners.length === 1) {
      const owner = last.owners[0]!
      const gid = owner.genID
      const memberErr = last.members.map((m) => checkMember(m, gid, opId, sessionId)).find(Boolean)
      const ownerErr = checkOwner(owner, sessionId)
      if (!memberErr && !ownerErr && owner.reason !== null && owner.closedAt !== null && owner.nextAt === null) {
        const op = last.operation
        if (op && op.opId !== opId) throw new Error("operation opId mismatch")
        return { gid, owner, members: last.members, operation: op }
      }
    }
    if (Date.now() > deadline) break
    const end = Date.now() + 1000
    while (Date.now() < end) {
      // bounded sleep without timers
    }
  }
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
  }))
  writeFileSync(join(scratch, evidence), JSON.stringify({ dbPath, prefix, proofs: rows }, null, 2))
  console.log(`[probe] PASS real generations terminal (${prefix}): ${rows.map((e) => `${e.opId}->${e.gid} ${e.reason} ${e.used}/${e.limit}`).join(", ")}`)
  return proofs
}

export function assertRealCompletedGenerations(root: string, scratch: string, dbPath: string): TerminalProof[] {
  return assertRealSnapGenerations(root, scratch, dbPath, "rc-snap", "real-generation-owners.json")
}
