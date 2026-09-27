import { describe, expect, test } from "bun:test"
import { PassThrough } from "node:stream"
import { Deferred, Duration, Effect, Exit, Layer, Option } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { SessionOperationTable, SessionTable } from "@opencode-ai/core/session/sql"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionOperation } from "@opencode-ai/core/session/operation"
import { SessionGeneration } from "@opencode-ai/core/session/generation"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceStore } from "@/project/instance-store"
import { GenerationGate } from "@/kilocode/server/generation-gate"
import { ControlLease } from "@/kilocode/server/control-lease"
import { SessionPromptDispatchService, layer as DispatchLayer } from "@/kilocode/session/session-prompt-dispatch"
import { KiloSessionPrompt } from "@/kilocode/session/prompt"
import { JsonRpcPeer } from "../../src/private-worker/peer"
import * as PrivatePeer from "../../src/kilocode/server/private-peer-registry"
import * as Broker from "../../src/kilocode/server/provider-http-execute-broker"
import { make as makeExecutor } from "../../src/kilocode/provider/canonical-request-executor"
import { HttpBody, HttpClientRequest } from "effect/unstable/http"

const SID = "ses_abc12300000000000001"
const MID = "msg_abc12300000000000001"
const DIR = "/tmp/ws"

const record = () => ({
  name: "Acme",
  endpoint: "https://api.example.com/v1",
  protocol: "openai/completions" as const,
  models: { m1: { name: "M1" } },
  credential: "secret:kilo.credentials.global.provider.acme",
})
const providerBody = JSON.stringify({ model: "m1", messages: [{ role: "user", content: "hi" }] })

function base() {
  return {
    v: 1,
    requestId: "req-loss-1",
    opId: `prompt:${MID}`,
    op: "session/prompt",
    idempotencyKey: `prompt:${MID}`,
    context: { directory: DIR, sessionId: SID, parentSessionId: null },
    payload: { messageId: MID, parts: [{ type: "text", text: "hi" }] },
  }
}

function pairWithHandler(
  handler: (method: string, params: unknown, ctx: import("../../src/private-worker/peer").RequestContext) => unknown | Promise<unknown>,
) {
  const aToB = new PassThrough()
  const bToA = new PassThrough()
  const a = new JsonRpcPeer({ reader: bToA, writer: aToB })
  const b = new JsonRpcPeer({ reader: aToB, writer: bToA, onRequest: handler as never })
  return { a, b, aToB, bToA }
}

const ensureSession = (db: any) =>
  Effect.gen(function* () {
    yield* db
      .insert(ProjectTable)
      .values({ id: "proj-test" as any, worktree: DIR as any, vcs: "git", time_created: Date.now(), time_updated: Date.now(), sandboxes: [] as any } as any)
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({ id: SID as any, project_id: "proj-test" as any, slug: "test", directory: DIR, title: "t", version: "1", revision: 0, time_created: Date.now(), time_updated: Date.now() } as any)
      .run()
      .pipe(Effect.orDie)
  })

function fakeStore() {
  const fakeCtx = { directory: DIR, worktree: DIR, project: { id: "proj-test" } }
  return Layer.succeed(InstanceStore.Service, {
    load: () => Effect.succeed(fakeCtx),
    reload: () => Effect.succeed(fakeCtx),
    dispose: () => Effect.void,
    disposeSafe: () => Effect.void,
    disposeDirectory: () => Effect.void,
    disposeAll: () => Effect.void,
    provide: (_i: unknown, e: Effect.Effect<unknown>) => e as Effect.Effect<unknown>,
    snapshot: () => Effect.succeed(Option.none()),
    directories: () => Effect.succeed([]),
  } as any)
}

describe("session-prompt-dispatch provider loss", () => {
  test("in-flight peer close post-metadata: run exits failed, terminal receipt, single attempt, not abandoned", async () => {
    let releaseHost!: () => void
    const hostGate = new Promise<void>((r) => (releaseHost = r))
    const { a, b, aToB, bToA } = pairWithHandler(async (_m, _p, ctx) => {
      ctx.emit({ seq: 0, status: 200, headers: {} })
      ctx.emit({ seq: 1, bytes: Buffer.from("part1").toString("base64") })
      await hostGate
      return { seq: 1, chunks: 1, bytes: 5 }
    })
    const note = {
      promptCalls: 0,
      brokerAttempts: 0,
      published: [] as Array<{ type: unknown; event: unknown }>,
      pullHeld: await Effect.runPromise(Deferred.make<void>()),
    }
    try {
      a.markInitialized()
      const prog = Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* ensureSession(db)
        const svc = yield* SessionPromptDispatchService
        const result = (yield* svc.dispatch(base())) as { status: string; accepted: boolean }
        expect(result.status).toBe("succeeded")
        expect(result.accepted).toBe(true)
        // wait until the stub generation holds its stream pull post-metadata
        yield* Deferred.await(note.pullHeld).pipe(
          Effect.timeoutOrElse({
            duration: "5 seconds",
            orElse: () => Effect.die(new Error("generation never reached pull-held")),
          }),
        )
        // in-flight FD peer close (CLI-side transport loss): call.done rejects
        a.dispose()
        // bounded poll for the terminal receipt
        const deadline = Date.now() + 5000
        let row: any = undefined
        for (;;) {
          row = yield* db.select().from(SessionOperationTable).where(eq(SessionOperationTable.op_id, `prompt:${MID}`)).get().pipe(Effect.orDie)
          const outcome = (row as any)?.outcome
          if (outcome === "failed" || outcome === "abandoned" || outcome === "succeeded") break
          if (Date.now() > deadline) break
          yield* Effect.sleep(Duration.millis(50))
        }
        releaseHost()
        return row as any
      })

      const dbLayer = Database.layerNoLease(":memory:")
      const sessionLayer = Layer.succeed(Session.Service, {
        get: () => Effect.succeed({ directory: DIR, id: SID }),
      } as any)
      const promptLayer = Layer.succeed(SessionPrompt.Service, {
        prompt: () =>
          Effect.gen(function* () {
            note.promptCalls++
            const peer = yield* PrivatePeer.Service
            const inner = yield* Broker.Service
            const lease = yield* peer.install(a)
            yield* lease.negotiate(["provider/httpExecute"])
            const counting: Broker.Broker = {
              stream: (input) =>
                Effect.gen(function* () {
                  note.brokerAttempts++
                  return yield* inner.stream(input)
                }),
              execute: (input) => inner.execute(input),
            }
            const executor = makeExecutor({ providerId: "acme", modelId: "m1", record: record() }, counting)
            const request = HttpClientRequest.post("https://api.example.com/v1/chat/completions").pipe(
              HttpClientRequest.setBody(HttpBody.text(providerBody, "application/json")),
            )
            // singleAttempt equivalent: one broker stream, consume via web pull
            const response = yield* executor.execute(request)
            const reader = (response as unknown as { source: Response }).source.body!.getReader()
            const first = yield* Effect.promise(() => reader.read())
            if (first.done) return { id: "dummy" } as any
            // signal pull-held: metadata + first chunk consumed, stream open
            yield* Deferred.succeed(note.pullHeld, void 0)
            // second pull hangs until the broker queue fails on peer close
            const second = yield* Effect.promise(() => reader.read())
            if (!second.done) return { id: "dummy" } as any
            return { id: "dummy" } as any
          }),
        cancel: () => Effect.void,
        loop: () => Effect.die(new Error("unused")),
        shell: () => Effect.die(new Error("unused")),
        resolvePromptParts: () => Effect.succeed([] as never),
      } as any)
      const eventsLayer = Layer.succeed(EventV2Bridge.Service, {
        publish: (type: unknown, event: unknown) => {
          note.published.push({ type, event })
          return Effect.void
        },
      } as any)
      const peerInfra = Broker.layer.pipe(Layer.provideMerge(PrivatePeer.defaultLayer))
      const deps = Layer.mergeAll(dbLayer, sessionLayer, promptLayer, eventsLayer, fakeStore(), Layer.succeed(GenerationGate.Service, GenerationGate.noop), Layer.succeed(ControlLease.Service, ControlLease.noop))
      const full = Layer.provide(DispatchLayer, deps)
      const all = Layer.mergeAll(full, deps, peerInfra)

      const row = await Effect.runPromise(
        prog.pipe(
          Effect.provide(all),
          Effect.scoped,
          Effect.timeoutOrElse({
            duration: "15 seconds",
            orElse: () => Effect.die(new Error("dispatch provider-loss flow timed out")),
          }),
          Effect.catchCause((cause) => Effect.die(cause)),
        ) as unknown as Effect.Effect<any, never, never>,
      )
      expect(row).toBeDefined()
      // terminal failed: actual provider stream loss, never user-abort shaped
      expect(row.outcome).toBe("failed")
      expect(row.code).toBe("prompt.failed")
      // receipt: durable terminal record present
      expect(typeof row.message).toBe("string")
      expect((row.message as string).length).toBeGreaterThan(0)
      // exactly one generation, exactly one broker attempt: no retry/replay/resubmit
      expect(note.promptCalls).toBe(1)
      expect(note.brokerAttempts).toBe(1)
      // failure surfaced as session.error, never swallowed as cancel
      const errors = note.published.filter((p) => String(p.type) === "session.error")
      expect(errors.length).toBe(1)
    } finally {
      try {
        a.dispose()
      } catch {}
      try {
        b.dispose()
      } catch {}
      try {
        aToB.destroy()
      } catch {}
      try {
        bToA.destroy()
      } catch {}
    }
  })

  test("resolveCloseReason: broker-error exit closes owner as error, interrupt as interrupted", async () => {
    const interruptedExit = await Effect.runPromiseExit(Effect.interrupt)
    const reasons = await Effect.runPromise(
      Effect.gen(function* () {
        const brokerErr = new Broker.ProviderHttpProtocolError({ message: "Peer closed" })
        const failedExit = Exit.fail(brokerErr) as Exit.Exit<unknown, unknown>
        const map = new Map<string, never>()
        const forFailed = KiloSessionPrompt.resolveCloseReason({ sessionID: SID, closeReasons: map as any, exit: failedExit })
        const forInterrupted = KiloSessionPrompt.resolveCloseReason({ sessionID: SID, closeReasons: map as any, exit: interruptedExit })
        return { forFailed, forInterrupted }
      }),
    )
    // actual provider stream loss resolves to error (owner close reason error),
    // never to interrupted/abandoned user-stop semantics
    expect(reasons.forFailed).toBe("error")
    expect(reasons.forInterrupted).toBe("interrupted")
  })

  test("owner row closes on failed generation exit (SessionGeneration.close terminal)", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* ensureSession(db)
        // accepted prompt row first, mirroring the dispatch prelude
        yield* SessionOperation.ensurePromptInFlight(db, SID as never, `prompt:${MID}`)
        const gen = "gen_loss_01"
        const created = yield* SessionGeneration.begin(db, SID as never, gen, MID, 2)
        expect(created.created).toBe(true)
        const closed = yield* SessionGeneration.close(db, SID as never, gen, "error")
        expect(closed.applied).toBe(true)
        const owner = yield* SessionGeneration.getOwner(db, gen)
        expect(owner?.reason).toBe("error")
        expect(owner?.closedAt).toBeDefined()
      }).pipe(
        Effect.provide(Database.layerNoLease(":memory:")),
        Effect.scoped,
        Effect.catchCause((cause) => Effect.die(cause)),
      ) as unknown as Effect.Effect<void, never, never>,
    )
  })
})
