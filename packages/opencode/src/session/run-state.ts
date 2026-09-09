import { InstanceState } from "@/effect/instance-state"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Runner } from "@/effect/runner"
import { BackgroundJob } from "@/background/job"
import { Effect, Latch, Layer, Scope, Context, SynchronizedRef } from "effect"
import { BusyError } from "./schema"
import { SessionID } from "./schema"
import { SessionStatus } from "./status"
import * as Ownership from "@/retention/ownership"

export type RunCancelResult = {
  readonly sessionID: SessionID
  readonly generationID?: string
  readonly wasBusy: boolean
  readonly interruptRequested: boolean
}

export interface Interface {
  readonly activeGeneration: (sessionID: SessionID) => Effect.Effect<string | undefined>
  readonly assertNotBusy: (sessionID: SessionID) => Effect.Effect<void, BusyError>
  readonly cancel: (sessionID: SessionID) => Effect.Effect<RunCancelResult>
  readonly ensureRunning: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<SessionV1.WithParts>,
    work: Runner.WorkInput<SessionV1.WithParts, never>,
  ) => Effect.Effect<SessionV1.WithParts>
  readonly startShell: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<SessionV1.WithParts>,
    work: Effect.Effect<SessionV1.WithParts>,
    ready?: Latch.Latch,
  ) => Effect.Effect<SessionV1.WithParts, BusyError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionRunState") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const background = yield* BackgroundJob.Service
    const status = yield* SessionStatus.Service
    const ownership = yield* Ownership.Service

    const state = yield* InstanceState.make(
      Effect.fn("SessionRunState.state")(function* () {
        const scope = yield* Scope.Scope
        const runners = new Map<SessionID, Runner.Runner<SessionV1.WithParts>>()
        yield* Effect.addFinalizer(
          Effect.fnUntraced(function* () {
            yield* Effect.forEach(runners.values(), (runner) => runner.cancel, {
              concurrency: "unbounded",
              discard: true,
            })
            runners.clear()
          }),
        )
        return { runners, scope }
      }),
    )

    const createGate = yield* SynchronizedRef.make(0)

    const runnerFor = Effect.fn("SessionRunState.runnerFor")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<SessionV1.WithParts>,
    ) {
      return yield* SynchronizedRef.modifyEffect(createGate, () =>
        Effect.gen(function* () {
          const data = yield* InstanceState.get(state)
          const existing = data.runners.get(sessionID)
          if (existing) return [existing, 0] as const
          const next = Runner.make<SessionV1.WithParts>(data.scope, {
            onIdle: status.set(sessionID, { type: "idle" }),
            onBusy: status.set(sessionID, { type: "busy" }),
            onInterrupt,
          })
          data.runners.set(sessionID, next)
          return [next, 0] as const
        }),
      )
    })

    const activeGeneration: Interface["activeGeneration"] = (sessionID) =>
      Effect.gen(function* () {
        const data = yield* InstanceState.get(state)
        return data.runners.get(sessionID)?.generationID
      })

    const assertNotBusy: Interface["assertNotBusy"] = (sessionID) =>
      Effect.gen(function* () {
        const data = yield* InstanceState.get(state)
        if (data.runners.get(sessionID)?.busy) yield* busyError(sessionID)
      })

    const cancel: Interface["cancel"] = (sessionID) =>
      Effect.gen(function* () {
        const data = yield* InstanceState.get(state)
        const current = data.runners.get(sessionID)
        let generationID: string | undefined
        let wasBusy = false
        let interruptRequested = false
        if (current) {
          const snap = yield* current.cancel
          generationID = snap.generationID
          wasBusy = snap.wasBusy
          interruptRequested = snap.interruptRequested
        }
        yield* cancelBackgroundJobs(background, sessionID)
        return { sessionID, generationID, wasBusy, interruptRequested } as RunCancelResult
      })

    const ensureRunning: Interface["ensureRunning"] = (sessionID, onInterrupt, work) =>
      Effect.gen(function* () {
        const release = yield* ownership.acquireActive(sessionID)
        const runner = yield* runnerFor(sessionID, onInterrupt)
        return yield* runner.ensureRunning(work).pipe(Effect.ensuring(release))
      })

    const startShell: Interface["startShell"] = (sessionID, onInterrupt, work, ready) =>
      Effect.gen(function* () {
        const release = yield* ownership.acquireActive(sessionID)
        const runner = yield* runnerFor(sessionID, onInterrupt)
        return yield* runner.startShell(work, ready).pipe(
          Effect.catchTag("RunnerBusy", () => Effect.fail(busyError(sessionID))),
          Effect.ensuring(release),
        )
      })

    return Service.of({ activeGeneration, assertNotBusy, cancel, ensureRunning, startShell })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(BackgroundJob.defaultLayer),
  Layer.provide(SessionStatus.defaultLayer),
  Layer.provide(Ownership.layer),
)

const cancelBackgroundJobs = Effect.fn("SessionRunState.cancelBackgroundJobs")(function* (
  background: BackgroundJob.Interface,
  sessionID: SessionID,
) {
  const jobs = yield* background.list()
  const pending = new Set<string>([sessionID])
  const cancelled = new Set<string>()
  const matches = (job: BackgroundJob.Info) => {
    if (job.status !== "running") return false
    if (cancelled.has(job.id)) return false
    if (pending.has(job.id)) return true
    if (typeof job.metadata?.sessionId === "string" && pending.has(job.metadata.sessionId)) return true
    return typeof job.metadata?.parentSessionId === "string" && pending.has(job.metadata.parentSessionId)
  }
  let batch = jobs.filter(matches)
  while (batch.length > 0) {
    yield* Effect.forEach(
      batch,
      (job) =>
        background.cancel(job.id).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              cancelled.add(job.id)
              pending.add(job.id)
              if (typeof job.metadata?.sessionId === "string") pending.add(job.metadata.sessionId)
            }),
          ),
        ),
      { concurrency: "unbounded", discard: true },
    )
    batch = jobs.filter(matches)
  }
})

function busyError(sessionID: SessionID) {
  return new BusyError({ sessionID })
}

export * as SessionRunState from "./run-state"
