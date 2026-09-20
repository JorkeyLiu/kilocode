import * as crypto from "node:crypto"
import { Effect } from "effect"
import { eq } from "drizzle-orm"
import { AppRuntime } from "@/effect/app-runtime"
import { Database } from "@opencode-ai/core/database/database"
import { MessageTable, PartTable, SessionTable } from "@opencode-ai/core/session/sql"
import { MessageID, PartID } from "@/session/schema"
import { InstanceStore } from "@/project/instance-store"
import { SessionCreateDispatchService } from "@/kilocode/session/session-create-dispatch"
import { isE2EFixtureEnabled } from "@/kilocode/config/e2e-provider"
import { canonicalDirectory } from "@/kilocode/session/canonical-directory"
import { ErrorCode } from "@/private-worker/json-rpc"

export async function handleE2ERevertSeed(params: unknown): Promise<unknown> {
  if (!isE2EFixtureEnabled()) {
    const err = new Error("e2eRevertSeed requires KILO_E2E_FIXTURE") as Error & { code: number }
    err.code = ErrorCode.InvalidRequest
    throw err
  }
  const p = params as Record<string, unknown>
  if (p.v !== 1) {
    const err = new Error("v must be 1") as Error & { code: number }
    err.code = ErrorCode.InvalidParams
    throw err
  }
  if (typeof p.requestId !== "string" || !p.requestId) {
    const err = new Error("requestId must be non-empty string") as Error & { code: number }
    err.code = ErrorCode.InvalidParams
    throw err
  }
  if (typeof p.opId !== "string" || !p.opId) {
    const err = new Error("opId must be non-empty string") as Error & { code: number }
    err.code = ErrorCode.InvalidParams
    throw err
  }
  if (p.op !== "session/e2eRevertSeed") {
    const err = new Error("op must be session/e2eRevertSeed") as Error & { code: number }
    err.code = ErrorCode.InvalidParams
    throw err
  }
  if (typeof p.idempotencyKey !== "string" || !p.idempotencyKey) {
    const err = new Error("idempotencyKey must be non-empty string") as Error & { code: number }
    err.code = ErrorCode.InvalidParams
    throw err
  }
  const ctx = p.context as Record<string, unknown> | undefined
  if (!ctx || typeof ctx.directory !== "string" || !ctx.directory) {
    const err = new Error("context.directory must be non-empty string") as Error & { code: number }
    err.code = ErrorCode.InvalidParams
    throw err
  }
  const dir = canonicalDirectory(ctx.directory as string)
  const title = typeof (p.payload as Record<string, unknown> | undefined)?.title === "string" ? ((p.payload as Record<string, unknown>).title as string) : `E2E Revert Seed ${String(p.requestId).slice(0, 8)}`
  // Create session via authoritative dispatch so observation/changed is emitted (persisted==snapshot barrier)
  const createToken = crypto.randomUUID()
  const createReq = {
    v: 1 as const,
    requestId: crypto.randomUUID(),
    opId: `create:${createToken}`,
    op: "session/create" as const,
    idempotencyKey: `create:${createToken}`,
    context: { directory: dir, parentSessionId: null },
    payload: { title },
  }
  const createRes = (await AppRuntime.runPromise(
    InstanceStore.Service.use((store) =>
      store.provide(
        { directory: dir },
        Effect.gen(function* () {
          const svc = yield* SessionCreateDispatchService
          return yield* (svc as unknown as { dispatch: (p: unknown) => Effect.Effect<unknown> }).dispatch(createReq)
        }),
      ),
    ),
  )) as unknown as { status: string; data?: { id?: string; session?: { id?: string } } }
  const sid = (createRes as unknown as { data?: { session?: { id?: string }; id?: string } }).data?.session?.id ?? (createRes as unknown as { data?: { id?: string } }).data?.id ?? (createRes as unknown as { sessionId?: string }).sessionId
  if (!sid || typeof sid !== "string") throw new Error("seed create failed to return session id")
  const seeded = (await AppRuntime.runPromise(
    InstanceStore.Service.use((store) =>
      store.provide(
        { directory: dir },
        Effect.gen(function* () {
          const db = (yield* Database.Service).db
          const sessionId = sid as unknown as string
          const now = Date.now()
          const userId = MessageID.ascending()
          const assistantId = MessageID.ascending()
          const partId = PartID.ascending()
          // Direct DB inserts avoid Session.Service event path that would create extra changefeed/revision increments.
          // We need real Message/Part rows for SessionRevertBoundary.resolve, but must keep changefeed at 1 (session/create) so persisted==snapshot barrier holds.
          yield* db
            .insert(MessageTable)
            .values({
              id: userId as unknown as never,
              session_id: sessionId as unknown as never,
              time_created: now,
              time_updated: now,
              data: {
                role: "user",
                agent: "default",
                model: { providerID: "test", modelID: "test" },
                time: { created: now },
              } as unknown as never,
            })
            .run()
            .pipe(Effect.orDie)
          yield* db
            .insert(MessageTable)
            .values({
              id: assistantId as unknown as never,
              session_id: sessionId as unknown as never,
              time_created: now,
              time_updated: now,
              data: {
                role: "assistant",
                parentID: userId,
                mode: "default",
                agent: "default",
                path: { cwd: dir, root: dir },
                cost: 1,
                tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
                modelID: "test",
                providerID: "test",
                time: { created: now, completed: now },
                finish: "stop",
              } as unknown as never,
            })
            .run()
            .pipe(Effect.orDie)
          yield* db
            .insert(PartTable)
            .values({
              id: partId as unknown as never,
              message_id: assistantId as unknown as never,
              session_id: sessionId as unknown as never,
              time_created: now,
              time_updated: now,
              data: {
                type: "text",
                text: "hello e2e revert",
              } as unknown as never,
            })
            .run()
            .pipe(Effect.orDie)
          const session = { id: sessionId }
          return { session, assistant: { id: assistantId }, part: { id: partId } }
        }),
      ),
    ),
  )) as unknown as { session: { id: string }; assistant: { id: string }; part: { id: string } }
  const rev = (await AppRuntime.runPromise(
    InstanceStore.Service.use((store) =>
      store.provide(
        { directory: dir },
        Effect.gen(function* () {
          const db = (yield* Database.Service).db
          const row = yield* db.select({ rev: SessionTable.revision }).from(SessionTable).where(eq(SessionTable.id, seeded.session.id as unknown as never)).get().pipe(Effect.orDie)
          return row ? (row as unknown as { rev: number }).rev : 0
        }),
      ),
    ),
  )) as unknown as number
  return {
    v: 1,
    requestId: p.requestId,
    opId: p.opId,
    op: "session/e2eRevertSeed",
    idempotencyKey: p.idempotencyKey,
    status: "succeeded" as const,
    outcome: { type: "succeeded" as const, time: Date.now() },
    accepted: true as const,
    data: {
      sessionId: seeded.session.id,
      messageId: seeded.assistant.id,
      partId: seeded.part.id,
      session: seeded.session,
      revision: rev,
    },
  }
}
