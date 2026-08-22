import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import * as Changefeed from "@opencode-ai/core/retention/changefeed"
import { ErrorCode } from "./json-rpc"
import type { ObservationDeps, ObservationEntry, ObservationReadBackendResult } from "./observation"

function invalidParams(msg: string): Error & { code?: number } {
  const err = new Error(msg) as Error & { code?: number }
  err.code = ErrorCode.InvalidParams
  return err
}

/**
 * Bridge canonical Changefeed Effects to Promise-based ObservationDeps.
 * Derived changefeed only — not authoritative history (ADR-0005).
 * Keeps parity with packages/opencode/src/private-worker/changefeed-adapter.ts
 */
export function createChangefeedDeps(db: Database.Interface["db"]): ObservationDeps {
  return {
    getSnapshot: async () => {
      const cursor = await Effect.runPromise(Changefeed.currentCursor(db))
      return { cursor, snapshot: null }
    },
    readAfter: async (cursor: number): Promise<ObservationReadBackendResult> => {
      const res = await Effect.runPromise(Changefeed.readAfter(db, cursor))
      if (res.type === "rehydrate") return { type: "rehydrate", cursor: res.cursor, reason: res.reason }
      const entries: ObservationEntry[] = res.entries.map((e: Changefeed.Entry) => ({
        seq: e.seq,
        session_id: e.session_id,
        revision: e.revision,
        kind: e.kind as ObservationEntry["kind"],
        time: e.time,
      }))
      return { type: "deltas", cursor: res.cursor, entries }
    },
    ack: async (cursor: number) => {
      try {
        await Effect.runPromise(Changefeed.ack(db, cursor))
      } catch (e: unknown) {
        if (e instanceof Changefeed.CursorAheadError) throw invalidParams(e.message)
        if (e instanceof Error && (e as { code?: number }).code === ErrorCode.InvalidParams) throw e
        const msg = e instanceof Error ? e.message : String(e)
        if (msg.includes("ahead") || msg.includes("CursorAhead")) throw invalidParams(msg)
        throw e
      }
    },
  }
}
