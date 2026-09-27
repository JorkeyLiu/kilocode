import { describe, it, expect } from "bun:test"
import { Effect, ManagedRuntime } from "effect"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { Database } from "@opencode-ai/core/database/database"
import { SessionOperationTable, SessionTable } from "@opencode-ai/core/session/sql"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionOperation } from "@opencode-ai/core/session/operation"
import { SessionGeneration } from "@opencode-ai/core/session/generation"
import { createSessionOperationsDeps } from "../../src/private-worker/session-operations-adapter"
import { ObservationController, OBSERVATION_METHODS } from "../../src/private-worker/observation"
import { canonicalDirectory } from "../../src/kilocode/session/canonical-directory"
import { PassThrough } from "stream"
import { JsonRpcPeer } from "../../src/private-worker/peer"
import { ErrorCode } from "../../src/private-worker/json-rpc"

function tmpDb(): { file: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-ops-rec-"))
  const file = path.join(dir, "kilo.db")
  const cleanup = () => {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  }
  return { file, cleanup }
}

async function withRuntime(file: string, fn: (db: Database.Interface["db"]) => Promise<void>): Promise<void> {
  const layer = Database.layerNoLease(file)
  const runtime = ManagedRuntime.make(layer)
  const svc = await runtime.runPromise(Effect.gen(function* () { return yield* Database.Service }))
  try {
    await fn(svc.db)
  } finally {
    await runtime.dispose()
  }
}

async function ensureProject(db: Database.Interface["db"]) {
  await Effect.runPromise(
    db.insert(ProjectTable).values({ id: "proj_rec" as never, worktree: "/tmp/ws" as never, vcs: "git" as never, time_created: 1, time_updated: 1, sandboxes: [] as never } as never).onConflictDoNothing().run().pipe(Effect.orDie),
  )
}

async function insertSession(db: Database.Interface["db"], id: string, dir: string) {
  await Effect.runPromise(
    db.insert(SessionTable).values({ id: id as never, project_id: "proj_rec" as never, slug: `slug-${id}`, directory: canonicalDirectory(dir) as never, title: `title-${id}`, version: "1", parent_id: null as never, time_created: 10, time_updated: 20 } as never).run().pipe(Effect.orDie),
  )
}

describe("observation/operations durable recovery projection (receipt+owner)", () => {
  it("attributable prompt failed projects versioned redacted recovery, no secret leak", async () => {
    const { file, cleanup } = tmpDb()
    try {
      await withRuntime(file, async (db) => {
        const dir = canonicalDirectory("/tmp/ws")
        await ensureProject(db)
        await insertSession(db, "ses_rec_a", dir)
        const sid = "ses_rec_a" as never
        await Effect.runPromise(SessionOperation.put(db, sid, { opId: "prompt:msg_a", opKind: "prompt", outcome: "in-flight", code: "prompt.inflight", message: "prompt accepted", time: 1000 }))
        await Effect.runPromise(SessionGeneration.begin(db, sid, "genA", "msg_a", 2))
        const occ = 2000
        const nxt = 2500
        await Effect.runPromise(SessionGeneration.charge(db, sid, "genA", { layer: "provider", occurrenceTime: occ, nextAt: nxt }))
        await Effect.runPromise(SessionOperation.put(db, sid, { opId: "prompt:msg_a", opKind: "prompt", outcome: "failed", code: "E_FOO", message: "boom", time: 3000, detail: "token=secret-should-scrub", stack: "trace password=xyz" }))
        const deps = createSessionOperationsDeps(db)
        const out = await deps.operations({ directory: dir, sessionId: "ses_rec_a", limit: 1 })
        expect(out.status).toBe("found")
        if (out.status !== "found") throw new Error("expected found")
        const op = out.operations[0]!
        expect(op.outcome).toBe("failed")
        const rec = (op as unknown as Record<string, unknown>).recovery as Record<string, unknown>
        expect(rec).toBeDefined()
        expect(rec.v).toBe(1)
        expect(rec.owner).toBe("generation")
        expect(rec.scope).toBe("ses_rec_a")
        expect(rec.used).toBe(1)
        expect(rec.limit).toBe(2)
        expect(rec.terminated).toBe(false)
        expect(rec.nextAt).toBe(nxt)
        expect(rec.retryOccurrence).toBe(occ)
        expect(rec.layer).toBe("provider")
        expect(rec.closeReason).toBeNull()
        expect(rec.replay).toBe(false)
        // redaction: no genID, detail, stack, request identities on the wire
        const keys = new Set(Object.keys(op))
        expect(keys.has("recovery")).toBe(true)
        for (const forbidden of ["detail", "stack", "opKind", "idempotencyHash", "requestId", "revision", "gen_id", "genID"]) {
          expect(forbidden in op).toBe(false)
          expect(forbidden in rec).toBe(false)
        }
        expect(JSON.stringify(op)).not.toContain("genA")
        expect(JSON.stringify(op)).not.toContain("secret")
      })
    } finally {
      cleanup()
    }
  })

  it("crash ordering: receipt snapshot open then owner closed projects live closed truth, not stale intent", async () => {
    const { file, cleanup } = tmpDb()
    try {
      await withRuntime(file, async (db) => {
        const dir = canonicalDirectory("/tmp/ws")
        await ensureProject(db)
        await insertSession(db, "ses_rec_crash", dir)
        const sid = "ses_rec_crash" as never
        await Effect.runPromise(SessionOperation.put(db, sid, { opId: "prompt:msg_c", opKind: "prompt", outcome: "in-flight", code: "prompt.inflight", message: "prompt accepted", time: 1000 }))
        await Effect.runPromise(SessionGeneration.begin(db, sid, "genC", "msg_c", 3))
        await Effect.runPromise(SessionGeneration.charge(db, sid, "genC", { layer: "broker", occurrenceTime: 2000, nextAt: 2600 }))
        // terminal while owner still open (operation sweep runs before generation sweep)
        await Effect.runPromise(SessionOperation.put(db, sid, { opId: "prompt:msg_c", opKind: "prompt", outcome: "abandoned", code: "prompt.abandoned", message: "prompt abandoned due to runtime restart", time: 3000 }))
        // generation sweep closes the owner afterwards, clearing the pending intent
        await Effect.runPromise(SessionGeneration.close(db, sid, "genC", "crash"))
        const deps = createSessionOperationsDeps(db)
        const out = await deps.operations({ directory: dir, sessionId: "ses_rec_crash", limit: 1 })
        expect(out.status).toBe("found")
        if (out.status !== "found") throw new Error("expected found")
        const rec = (out.operations[0]! as unknown as Record<string, unknown>).recovery as Record<string, unknown>
        expect(rec).toBeDefined()
        expect(rec.terminated).toBe(true)
        expect(rec.closeReason).toBe("crash")
        // live truth: pending intent cleared, not the stale snapshot nextAt
        expect(rec.nextAt).toBeNull()
        expect(rec.used).toBe(1)
        expect(rec.limit).toBe(3)
        expect(rec.retryOccurrence).toBe(2000)
        expect(rec.layer).toBe("broker")
        expect(rec.replay).toBe(false)
      })
    } finally {
      cleanup()
    }
  })

  it("legacy row without receipt and no-member prompt omit recovery (no fake budget)", async () => {
    const { file, cleanup } = tmpDb()
    try {
      await withRuntime(file, async (db) => {
        const dir = canonicalDirectory("/tmp/ws")
        await ensureProject(db)
        await insertSession(db, "ses_rec_leg", dir)
        const sid = "ses_rec_leg" as never
        // legacy direct insert: no receipt row exists
        await Effect.runPromise(
          db.insert(SessionOperationTable).values({ op_id: "prompt:msg_leg" as never, session_id: sid as never, op_kind: "prompt" as never, outcome: "failed" as never, code: "E" as never, message: "m" as never, time: 100 as never, cancel: null as never, detail: null as never, stack: null as never, revision: 1 as never } as never).run().pipe(Effect.orDie),
        )
        // no-member terminal via public put (receipt unknown=no_member)
        await Effect.runPromise(SessionOperation.put(db, sid, { opId: "prompt:msg_nomem", opKind: "prompt", outcome: "in-flight", code: "prompt.inflight", message: "prompt accepted", time: 101 }))
        await Effect.runPromise(SessionOperation.put(db, sid, { opId: "prompt:msg_nomem", opKind: "prompt", outcome: "failed", code: "E", message: "m", time: 102 }))
        const deps = createSessionOperationsDeps(db)
        const leg = await deps.operations({ directory: dir, sessionId: "ses_rec_leg", limit: 2 })
        expect(leg.status).toBe("found")
        if (leg.status !== "found") throw new Error("expected found")
        for (const op of leg.operations) {
          expect("recovery" in op).toBe(false)
        }
      })
    } finally {
      cleanup()
    }
  })

  it("provider terminal with live owner projects recovery; succeeded omits even when attributable", async () => {
    const { file, cleanup } = tmpDb()
    try {
      await withRuntime(file, async (db) => {
        const dir = canonicalDirectory("/tmp/ws")
        await ensureProject(db)
        await insertSession(db, "ses_rec_prov", dir)
        const sid = "ses_rec_prov" as never
        await Effect.runPromise(SessionOperation.put(db, sid, { opId: "prompt:msg_p", opKind: "prompt", outcome: "in-flight", code: "prompt.inflight", message: "prompt accepted", time: 1000 }))
        await Effect.runPromise(SessionGeneration.begin(db, sid, "genP", "msg_p", 2))
        await Effect.runPromise(SessionOperation.putProviderInFlight(db, sid, { opId: "provider:msgA:0", opKind: "provider", outcome: "in-flight", code: "provider.inflight", message: "provider request started", time: 1100 }, "genP"))
        await Effect.runPromise(SessionOperation.put(db, sid, { opId: "provider:msgA:0", opKind: "provider", outcome: "failed", code: "E_PROV", message: "prov boom", time: 1200 }))
        const deps = createSessionOperationsDeps(db)
        const out = await deps.operations({ directory: dir, sessionId: "ses_rec_prov", limit: 1 })
        expect(out.status).toBe("found")
        if (out.status !== "found") throw new Error("expected found")
        expect(out.operations[0]!.opId).toBe("provider:msgA:0")
        const rec = (out.operations[0]! as unknown as Record<string, unknown>).recovery as Record<string, unknown>
        expect(rec).toBeDefined()
        expect(rec.v).toBe(1)
        expect(rec.owner).toBe("generation")
        expect(rec.scope).toBe("ses_rec_prov")
        // succeeded terminal never carries recovery
        await Effect.runPromise(SessionOperation.put(db, sid, { opId: "prompt:msg_s", opKind: "prompt", outcome: "in-flight", code: "prompt.inflight", message: "prompt accepted", time: 1300 }))
        await Effect.runPromise(SessionGeneration.begin(db, sid, "genS", "msg_s", 2))
        await Effect.runPromise(SessionOperation.put(db, sid, { opId: "prompt:msg_s", opKind: "prompt", outcome: "succeeded", code: "C", message: "ok", time: 1400 }))
        const out2 = await deps.operations({ directory: dir, sessionId: "ses_rec_prov", limit: 2 })
        if (out2.status !== "found") throw new Error("expected found")
        const succ = out2.operations.find((o) => o.opId === "prompt:msg_s")!
        expect("recovery" in succ).toBe(false)
      })
    } finally {
      cleanup()
    }
  })

  it("strict validation rejects old stub, malformed v1, and scope mismatch", async () => {
    const { file, cleanup } = tmpDb()
    try {
      await withRuntime(file, async (db) => {
        const dir = canonicalDirectory("/tmp/ws")
        await ensureProject(db)
        await insertSession(db, "ses_rec_strict", dir)
        const deps = createSessionOperationsDeps(db)
        const ctrl = new ObservationController({
          getSnapshot: async () => ({ cursor: 0, snapshot: null }),
          readAfter: async () => ({ type: "deltas", cursor: 0, entries: [] }),
          ack: async () => {},
          operations: deps.operations,
        })
        const good = {
          v: "1.0", status: "found",
          operations: [{ opId: "prompt:msg_x", outcome: "failed", code: "E", message: "m", time: 1, recovery: { v: 1, owner: "generation", scope: "ses_rec_strict", used: 1, limit: 2, terminated: false, nextAt: 5, retryOccurrence: 4, layer: "provider", closeReason: null, replay: false } }],
        }
        const c1 = ctrlWith(good)
        const p1 = pair(c1)
        const res = (await p1.client.request(OBSERVATION_METHODS.OPERATIONS, { v: "1.0", directory: dir, sessionId: "ses_rec_strict", limit: 1 })) as unknown as Record<string, unknown>
        expect((res as { status: string }).status).toBe("found")
        p1.client.dispose(); p1.server.dispose()
        const badList: unknown[] = [
          // old hardcoded stub must be rejected (no fake budget compat)
          { v: "1.0", status: "found", operations: [{ opId: "prompt:msg_x", outcome: "failed", code: "E", message: "m", time: 1, recovery: { budget: 0, nextAt: null, provenance: "terminal" } }] },
          // used exceeds limit
          { v: "1.0", status: "found", operations: [{ opId: "prompt:msg_x", outcome: "failed", code: "E", message: "m", time: 1, recovery: { v: 1, owner: "generation", scope: "ses_rec_strict", used: 3, limit: 2, terminated: false, nextAt: 5, retryOccurrence: 4, layer: "provider", closeReason: null, replay: false } }] },
          // terminated mismatch
          { v: "1.0", status: "found", operations: [{ opId: "prompt:msg_x", outcome: "failed", code: "E", message: "m", time: 1, recovery: { v: 1, owner: "generation", scope: "ses_rec_strict", used: 1, limit: 2, terminated: false, nextAt: null, retryOccurrence: null, layer: null, closeReason: "crash", replay: false } }] },
          // closed with pending nextAt
          { v: "1.0", status: "found", operations: [{ opId: "prompt:msg_x", outcome: "failed", code: "E", message: "m", time: 1, recovery: { v: 1, owner: "generation", scope: "ses_rec_strict", used: 1, limit: 2, terminated: true, nextAt: 5, retryOccurrence: 4, layer: "provider", closeReason: "crash", replay: false } }] },
          // replay must be false (retry intent is never replayable)
          { v: "1.0", status: "found", operations: [{ opId: "prompt:msg_x", outcome: "failed", code: "E", message: "m", time: 1, recovery: { v: 1, owner: "generation", scope: "ses_rec_strict", used: 1, limit: 2, terminated: false, nextAt: 5, retryOccurrence: 4, layer: "provider", closeReason: null, replay: true } }] },
          // recovery on succeeded
          { v: "1.0", status: "found", operations: [{ opId: "prompt:msg_x", outcome: "succeeded", code: "C", message: "ok", time: 1, recovery: { v: 1, owner: "generation", scope: "ses_rec_strict", used: 0, limit: 2, terminated: true, nextAt: null, retryOccurrence: null, layer: null, closeReason: "completed", replay: false } }] },
          // extra key / genID leak
          { v: "1.0", status: "found", operations: [{ opId: "prompt:msg_x", outcome: "failed", code: "E", message: "m", time: 1, recovery: { v: 1, owner: "generation", scope: "ses_rec_strict", used: 1, limit: 2, terminated: false, nextAt: 5, retryOccurrence: 4, layer: "provider", closeReason: null, replay: false, genID: "genA" } }] },
        ]
        for (const fake of badList) {
          const c = ctrlWith(fake)
          const p = pair(c)
          try {
            await p.client.request(OBSERVATION_METHODS.OPERATIONS, { v: "1.0", directory: dir, sessionId: "ses_rec_strict", limit: 1 })
            expect(false).toBe(true)
          } catch (e) {
            expect((e as { code?: number }).code).toBe(ErrorCode.InternalError)
          }
          p.client.dispose(); p.server.dispose()
        }
        void ctrl
      })
    } finally {
      cleanup()
    }
  })
})

function ctrlWith(fake: unknown): ObservationController {
  return new ObservationController({
    getSnapshot: async () => ({ cursor: 0, snapshot: null }),
    readAfter: async () => ({ type: "deltas", cursor: 0, entries: [] }),
    ack: async () => {},
    operations: (async () => fake) as never,
  })
}

function pair(ctrl: ObservationController) {
  const aToB = new PassThrough()
  const bToA = new PassThrough()
  const server = new JsonRpcPeer({ reader: aToB, writer: bToA, onRequest: (m, p) => ctrl.handle(m, p) })
  const client = new JsonRpcPeer({ reader: bToA, writer: aToB })
  return { client, server }
}
