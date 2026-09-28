import { isAbsolute } from "path"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { SessionDeleteTombstoneTable, SessionOperationTable, SessionTable } from "@opencode-ai/core/session/sql"
import { and, desc, eq } from "drizzle-orm"
import { authoritativeDirectory, samePhysicalDirectory } from "@/kilocode/session/canonical-directory"
import { SessionOperation } from "@opencode-ai/core/session/operation"
import { ErrorCode } from "./json-rpc"
import type { ObservationCreateOperationResult, ObservationDeleteOperationResult, ObservationOperationResult, ObservationOperationsResult } from "./observation"

function invalidParams(msg: string): Error & { code?: number } {
  const err = new Error(msg) as Error & { code?: number }
  err.code = ErrorCode.InvalidParams
  return err
}

function internalError(msg: string): Error & { code?: number } {
  const err = new Error(msg) as Error & { code?: number }
  err.code = ErrorCode.InternalError
  return err
}

function isValidSessionId(v: unknown): boolean {
  return typeof v === "string" && v.length > 0 && v.startsWith("ses") && !v.includes("\0")
}

function parseDirectory(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.includes("\0")) throw invalidParams("directory must be non-empty absolute path")
  if (!isAbsolute(raw)) throw invalidParams("directory must be non-empty absolute path")
  try {
    return authoritativeDirectory(raw)
  } catch (e) {
    throw invalidParams((e as Error).message.includes("directory") ? (e as Error).message : "directory must be non-empty absolute path")
  }
}

function parseSessionId(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.includes("\0") || !raw.startsWith("ses")) throw invalidParams("sessionId must be non-empty session id")
  if (!isValidSessionId(raw)) throw invalidParams("sessionId must be non-empty session id")
  return raw
}

function parseCheckpointOpId(raw: string, kind: "revert" | "unrevert" | "sessionUpdate" | "fork"): string {
  const rest = raw.slice(kind.length + 1)
  const sep = rest.indexOf(":")
  if (sep <= 0 || sep === rest.length - 1) throw invalidParams(`opId must be canonical ${kind}:<sessionId>:<token>`)
  const sid = rest.slice(0, sep)
  const token = rest.slice(sep + 1)
  if (!isValidSessionId(sid)) throw invalidParams(`opId must be canonical ${kind}:<sessionId>:<token>`)
  if (token.length === 0 || token.includes(":") || token.includes("\0")) throw invalidParams(`opId must be canonical ${kind}:<sessionId>:<token>`)
  return raw
}

function parseOpId(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.includes("\0")) throw invalidParams("opId must be non-empty op id")
  if (raw.startsWith("prompt:")) {
    const suffix = raw.slice("prompt:".length)
    if (suffix.length === 0 || !suffix.startsWith("msg") || suffix.includes(":")) throw invalidParams("opId must be canonical prompt:<messageId>")
    return raw
  }
  if (raw.startsWith("revert:")) return parseCheckpointOpId(raw, "revert")
  if (raw.startsWith("unrevert:")) return parseCheckpointOpId(raw, "unrevert")
  if (raw.startsWith("sessionUpdate:")) return parseCheckpointOpId(raw, "sessionUpdate")
  if (raw.startsWith("fork:")) return parseCheckpointOpId(raw, "fork")
  throw invalidParams("opId must be canonical prompt:<messageId> or revert:<sessionId>:<token> or unrevert:<sessionId>:<token> or sessionUpdate:<sessionId>:<token> or fork:<sessionId>:<token>")
}

function parseForkSnapshotId(rawSnap: unknown): { id: string; parent: string; dir: string } | undefined {
  if (typeof rawSnap !== "string" || rawSnap.length === 0) return undefined
  let snap: unknown
  try {
    snap = JSON.parse(rawSnap)
  } catch {
    return undefined
  }
  if (snap === null || typeof snap !== "object" || Array.isArray(snap)) return undefined
  const s = snap as Record<string, unknown>
  const id = s.id
  if (typeof id !== "string" || id.length === 0 || id.includes("\0") || !id.startsWith("ses")) return undefined
  const parentRaw = (s.parent_id ?? s.parentID) as unknown
  if (typeof parentRaw !== "string" || parentRaw.length === 0) return undefined
  const dir = s.directory
  if (typeof dir !== "string" || dir.length === 0 || (dir as string).includes("\0")) return undefined
  return { id, parent: parentRaw, dir }
}

async function attachForkChild(
  db: Database.Interface["db"],
  row: typeof SessionOperationTable.$inferSelect,
  rec: SessionOperation.FailureRecord,
  sessionId: string,
  directory: string,
  out: Record<string, unknown>,
): Promise<void> {
  if (rec.opKind !== "fork" || rec.outcome !== "succeeded") return
  if (typeof rec.opId !== "string" || !rec.opId.startsWith("fork:")) return
  const parsed = parseForkSnapshotId((row as unknown as Record<string, unknown>).result_snapshot)
  if (!parsed) return
  if (parsed.id === sessionId) return
  if (parsed.parent !== sessionId) return
  let sameSnap = false
  try {
    sameSnap = samePhysicalDirectory(parsed.dir, directory)
  } catch {
    return
  }
  if (!sameSnap) return
  const titleMeta = (row as unknown as Record<string, unknown>).title
  if (titleMeta !== null && titleMeta !== undefined && titleMeta !== "" && titleMeta !== parsed.id) return
  const child = await Effect.runPromise(
    db
      .select()
      .from(SessionTable)
      .where(eq(SessionTable.id, parsed.id as never))
      .get()
      .pipe(Effect.orDie),
  ).catch(() => undefined)
  if (!child) return
  const c = child as unknown as Record<string, unknown>
  if ((c.parent_id as unknown) !== sessionId && (c.parentID as unknown) !== sessionId) return
  if (typeof c.parent_id === "string" && c.parent_id !== sessionId) return
  let sameChild = false
  try {
    sameChild = samePhysicalDirectory(c.directory as string, directory)
  } catch {
    return
  }
  if (!sameChild) return
  out.forkedSessionId = parsed.id
}

async function toPanelEntry(
  db: Database.Interface["db"],
  row: typeof SessionOperationTable.$inferSelect,
  sessionId: string,
  directory?: string,
): Promise<Record<string, unknown>> {
  let rec: SessionOperation.FailureRecord
  try {
    rec = SessionOperation.validatedRowToRecord(row)
  } catch (e) {
    throw internalError(e instanceof Error ? e.message : String(e))
  }
  const panel = SessionOperation.toPanelRecord(rec) as Record<string, unknown>
  const allowed = new Set(["opId", "outcome", "code", "message", "cancel"])
  for (const k of Object.keys(panel)) if (!allowed.has(k)) throw internalError("panel projection leaked non-panel field")
  const out: Record<string, unknown> = {
    opId: panel.opId,
    outcome: panel.outcome,
    code: panel.code,
    message: panel.message,
    time: rec.time,
  }
  if (panel.cancel !== undefined) out.cancel = panel.cancel
  if (rec.outcome === "failed" || rec.outcome === "abandoned") {
    let proj: SessionOperation.RecoveryProjection | undefined
    try {
      proj = await Effect.runPromise(SessionOperation.getRecoveryProjection(db, rec.opId, sessionId as never))
    } catch {
      proj = undefined
    }
    if (proj !== undefined) {
      try {
        out.recovery = SessionOperation.validateRecoveryProjection(proj)
      } catch (e) {
        throw internalError(e instanceof Error ? e.message : String(e))
      }
    }
  }
  if (directory !== undefined && rec.opKind === "fork" && rec.outcome === "succeeded") {
    try {
      await attachForkChild(db, row, rec, sessionId, directory, out)
    } catch {
      delete (out as Record<string, unknown>).forkedSessionId
    }
  }
  return out
}

async function checkScope(
  db: Database.Interface["db"],
  directory: string,
  sessionId: string,
): Promise<{ v: "1.0"; status: "not_found" } | { v: "1.0"; status: "scope_mismatch" } | undefined> {
  const row = await Effect.runPromise(db.select().from(SessionTable).where(eq(SessionTable.id, sessionId as never)).get().pipe(Effect.orDie))
  if (!row) return { v: "1.0", status: "not_found" }
  const samePhysical = (() => {
    try {
      return samePhysicalDirectory(row.directory, directory)
    } catch {
      throw internalError("invalid stored directory shape")
    }
  })()
  if (!samePhysical) return { v: "1.0", status: "scope_mismatch" }
  return undefined
}

const CREATE_UUID_STRICT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function parseCreateOpIdStrict(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.includes("\0")) throw invalidParams("opId must be non-empty op id")
  if (!raw.startsWith("create:")) throw invalidParams("opId must be canonical create:<uuid>")
  const token = raw.slice("create:".length)
  if (!CREATE_UUID_STRICT.test(token)) throw invalidParams("opId must be canonical create:<uuid>")
  return raw
}

const DELETE_UUID_STRICT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function parseDeleteOpIdStrict(raw: unknown, sessionId: string): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.includes("\0")) throw invalidParams("opId must be canonical delete:<sessionId>:<uuid>");
  if (!raw.startsWith("delete:")) throw invalidParams("opId must be canonical delete:<sessionId>:<uuid>");
  const rest = raw.slice("delete:".length);
  const sep = rest.indexOf(":");
  if (sep <= 0 || sep === rest.length - 1) throw invalidParams("opId must be canonical delete:<sessionId>:<uuid>");
  const sid = rest.slice(0, sep);
  const token = rest.slice(sep + 1);
  if (!isValidSessionId(sid)) throw invalidParams("opId must be canonical delete:<sessionId>:<uuid>");
  if (!DELETE_UUID_STRICT.test(token)) throw invalidParams("opId must be canonical delete:<sessionId>:<uuid>");
  if (sid !== sessionId) throw invalidParams("opId session binding mismatch");
  return raw;
}

function parseCreateSnapshot(rawSnap: unknown): { id: string; dir: string } | undefined {
  if (typeof rawSnap !== "string" || rawSnap.length === 0) return undefined
  let snap: unknown
  try {
    snap = JSON.parse(rawSnap)
  } catch {
    return undefined
  }
  if (snap === null || typeof snap !== "object" || Array.isArray(snap)) return undefined
  const s = snap as Record<string, unknown>
  const id = s.id
  if (typeof id !== "string" || id.length === 0 || id.includes("\0") || !id.startsWith("ses")) return undefined
  const dir = s.directory
  if (typeof dir !== "string" || dir.length === 0 || (dir as string).includes("\0")) return undefined
  return { id, dir }
}

export function createSessionOperationsDeps(db: Database.Interface["db"]): {
  operations: (input: { directory: string; sessionId: string; limit?: number }) => Promise<ObservationOperationsResult>
  operation: (input: { directory: string; sessionId: string; opId: string }) => Promise<ObservationOperationResult>
  createOperation: (input: { directory: string; opId: string }) => Promise<ObservationCreateOperationResult>
  deleteOperation: (input: { directory: string; sessionId: string; opId: string }) => Promise<ObservationDeleteOperationResult>
} {
  return {
    operations: async (input) => {
      const directory = parseDirectory((input as { directory?: unknown }).directory)
      const sessionId = parseSessionId((input as { sessionId?: unknown }).sessionId)
      const rawLimit = (input as { limit?: unknown }).limit
      const limit = (() => {
        if (rawLimit === undefined) return 1
        if (typeof rawLimit !== "number" || !Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 20) throw invalidParams("limit must be integer 1..20")
        return rawLimit as number
      })()
      const scope = await checkScope(db, directory, sessionId)
      if (scope) return scope as ObservationOperationsResult
      const rows = await Effect.runPromise(
        db.select().from(SessionOperationTable).where(eq(SessionOperationTable.session_id, sessionId as never)).orderBy(desc(SessionOperationTable.time), desc(SessionOperationTable.op_id)).limit(limit).all().pipe(Effect.orDie),
      )
      if (rows.length === 0) return { v: "1.0", status: "found", operations: [] }
      const ops: unknown[] = []
      for (const r of rows) {
        const out = await toPanelEntry(db, r as typeof SessionOperationTable.$inferSelect, sessionId, directory)
        ops.push(out as unknown as ObservationOperationsResult extends { status: "found"; operations: infer U } ? (U extends (infer E)[] ? E : never) : never)
      }
      return { v: "1.0", status: "found", operations: ops as any }
    },
    operation: async (input) => {
      const directory = parseDirectory((input as { directory?: unknown }).directory)
      const sessionId = parseSessionId((input as { sessionId?: unknown }).sessionId)
      const opId = parseOpId((input as { opId?: unknown }).opId)
      const scope = await checkScope(db, directory, sessionId)
      if (scope) return scope as ObservationOperationResult
      const row = await Effect.runPromise(
        db.select().from(SessionOperationTable).where(eq(SessionOperationTable.op_id, opId)).get().pipe(Effect.orDie),
      )
      if (!row) return { v: "1.0", status: "not_found" }
      if ((row as typeof SessionOperationTable.$inferSelect).session_id !== (sessionId as never)) return { v: "1.0", status: "scope_mismatch" }
      const out = await toPanelEntry(db, row as typeof SessionOperationTable.$inferSelect, sessionId, directory)
      if ((out as Record<string, unknown>).opId !== opId) throw internalError("operation returned opId mismatch")
      return { v: "1.0", status: "found", operation: out as any }
    },
    createOperation: async (input) => {
      const directory = parseDirectory((input as { directory?: unknown }).directory)
      const opId = parseCreateOpIdStrict((input as { opId?: unknown }).opId)
      const row = await Effect.runPromise(
        db.select().from(SessionOperationTable).where(eq(SessionOperationTable.op_id, opId)).get().pipe(Effect.orDie),
      )
      if (!row) return { v: "1.0", status: "not_found" }
      const typed = row as typeof SessionOperationTable.$inferSelect
      if ((typed.op_kind as string) !== "create") throw internalError("create-operation returned invalid operation shape")
      if ((typed.outcome as string) !== "succeeded") throw internalError("create-operation returned invalid operation shape")
      const storedDir = (typed as unknown as Record<string, unknown>).directory
      if (typeof storedDir !== "string" || storedDir.length === 0) throw internalError("create-operation returned invalid session shape")
      let sameStored = false
      try {
        sameStored = samePhysicalDirectory(storedDir, directory)
      } catch {
        throw internalError("create-operation returned invalid session shape")
      }
      if (!sameStored) return { v: "1.0", status: "scope_mismatch" }
      const parsed = parseCreateSnapshot((typed as unknown as Record<string, unknown>).result_snapshot)
      if (!parsed) throw internalError("create-operation returned invalid session shape")
      if (parsed.id !== (typed.session_id as unknown as string)) throw internalError("create-operation returned invalid session shape")
      if (!isValidSessionId(parsed.id)) throw internalError("create-operation returned invalid session shape")
      let sameSnap = false
      try {
        sameSnap = samePhysicalDirectory(parsed.dir, directory)
      } catch {
        throw internalError("create-operation returned invalid session shape")
      }
      if (!sameSnap) return { v: "1.0", status: "scope_mismatch" }
      return { v: "1.0", status: "found", createdSessionId: parsed.id }
    },

    deleteOperation: async (input) => {
      const directory = parseDirectory((input as { directory?: unknown }).directory);
      const sessionId = parseSessionId((input as { sessionId?: unknown }).sessionId);
      const opId = parseDeleteOpIdStrict((input as { opId?: unknown }).opId, sessionId);
      // Exact tombstone observation only: PK first, then (session_id, hash) with opId equality.
      // No SessionTable dependency: tombstone survives family hard-delete cascade.
      // No side effects: selects only.
      const byPk = await Effect.runPromise(
        db.select().from(SessionDeleteTombstoneTable).where(eq(SessionDeleteTombstoneTable.op_id, opId)).get().pipe(Effect.orDie),
      );
      let row = byPk as typeof SessionDeleteTombstoneTable.$inferSelect | undefined;
      if (row) {
        if ((row.session_id as unknown as string) !== sessionId) return { v: "1.0", status: "scope_mismatch" } as ObservationDeleteOperationResult;
      } else {
        const hash = SessionOperation.hashIdempotencyKey(opId);
        const byHash = await Effect.runPromise(
          db.select().from(SessionDeleteTombstoneTable).where(and(eq(SessionDeleteTombstoneTable.session_id, sessionId as never), eq(SessionDeleteTombstoneTable.idempotency_hash, hash))).get().pipe(Effect.orDie),
        );
        if (!byHash) return { v: "1.0", status: "not_found" } as ObservationDeleteOperationResult;
        const typed = byHash as typeof SessionDeleteTombstoneTable.$inferSelect;
        if ((typed.op_id as string) !== opId) return { v: "1.0", status: "scope_mismatch" } as ObservationDeleteOperationResult;
        row = typed;
      }
      const storedDir = (row as unknown as Record<string, unknown>).directory;
      if (typeof storedDir !== "string" || storedDir.length === 0) throw internalError("delete-operation returned invalid session shape");
      let sameStored = false;
      try {
        sameStored = samePhysicalDirectory(storedDir, directory);
      } catch {
        throw internalError("delete-operation returned invalid session shape");
      }
      if (!sameStored) return { v: "1.0", status: "scope_mismatch" } as ObservationDeleteOperationResult;
      const outcome = (row as unknown as Record<string, unknown>).outcome;
      const code = (row as unknown as Record<string, unknown>).code;
      const message = (row as unknown as Record<string, unknown>).message;
      if (outcome !== "succeeded") throw internalError("delete-operation returned invalid operation shape");
      if (typeof code !== "string" || code.length === 0) throw internalError("delete-operation returned invalid operation shape");
      if (typeof message !== "string") throw internalError("delete-operation returned invalid operation shape");
      return { v: "1.0", status: "found" } as ObservationDeleteOperationResult;
    },
  }
}
