/**
 * Focused service-level P0 tests for the backend `question_wait` span
 * (src/question/index.ts): `ask` emits a p0.start with the question id, a
 * normal `reply` emits the matching p0.end with duration, and `reject` leaves
 * an unmatched p0.start (the instrument contract's failure signal — no
 * fabricated end on failure/interruption paths).
 *
 * Benchmark-style file: `./capture` + `./environment` must be the first
 * imports so the module-load-time KILO_P0_PERF flag is on for instrument.ts
 * and the p0 stderr tee is installed before any kilo module evaluates.
 */

import "./capture"
import "./environment"
import { afterAll, describe, expect } from "bun:test"
import * as Log from "@opencode-ai/core/util/log"
import { Cause, Effect, Fiber, Layer } from "effect"
import { Question } from "../../src/question"
import { QuestionID } from "../../src/question/schema"
import { Permission } from "../../src/permission"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { SessionID } from "../../src/session/schema"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { captured, installCapture } from "./capture"
import { registerBenchmarkEnv } from "./environment"
import * as P0 from "./p0-records"

await Log.init({ print: true })
installCapture()

// Lightweight capture handle over the shared p0 stderr tee (no server graph —
// the wait-span records fire at test time, so no module-load ordering concerns).
const capture = {
  mark: () => captured().length,
  slice: (from: number) =>
    captured()
      .slice(from)
      .map((line) => P0.parseP0Line(line))
      .filter((rec): rec is P0.P0Record => rec !== undefined),
}

afterAll(async () => {
  await disposeAllInstances()
})

// Last hook: once every benchmark file has finished, restore the pre-load env
// and remove the run root so later files never inherit removed runRoot paths.
afterAll(registerBenchmarkEnv())

const it = testEffect(
  Layer.mergeAll(
    Question.layer.pipe(Layer.provideMerge(EventV2Bridge.defaultLayer)),
    CrossSpawnSpawner.defaultLayer,
  ),
)

const itPerm = testEffect(
  Layer.mergeAll(Permission.defaultLayer, CrossSpawnSpawner.defaultLayer),
)

const questions: ReadonlyArray<Question.Info> = [
  {
    question: "Continue?",
    header: "Continue",
    options: [
      { label: "yes", description: "Proceed" },
      { label: "no", description: "Stop" },
    ],
  },
]

const askEffect = Effect.fn("WaitSpansTest.ask")(function* (sessionID: SessionID) {
  const question = yield* Question.Service
  return yield* question.ask({ sessionID, questions })
})

const replyEffect = Effect.fn("WaitSpansTest.reply")(function* (requestID: QuestionID) {
  const question = yield* Question.Service
  yield* question.reply({ requestID, answers: [["yes"]] })
})

const rejectEffect = Effect.fn("WaitSpansTest.reject")(function* (requestID: QuestionID) {
  const question = yield* Question.Service
  yield* question.reject(requestID)
})

/** Wait until a question is pending; returns the first pending request. */
const waitForPending = Effect.fn("WaitSpansTest.waitForPending")(function* () {
  const question = yield* Question.Service
  for (let i = 0; i < 200; i++) {
    const pending = yield* question.list()
    if (pending.length > 0) return pending[0]!
    yield* Effect.sleep("10 millis")
  }
  return yield* Effect.fail(new Error("no pending question"))
})

describe("backend question_wait span", () => {
  it.instance(
    "ask emits question_wait p0.start; reply emits the matching p0.end with duration",
    () =>
      Effect.gen(function* () {
        const from = capture.mark()
        const fiber = yield* Effect.forkScoped(askEffect(SessionID.make("ses_wait")))
        const pending = yield* waitForPending()
        const id = String(pending.id)

        // The p0.start is emitted before the await, so it is already captured
        // by the time the question is visible as pending.
        const start = P0.stageRecords(capture.slice(from), "question_wait").find(
          (rec) => rec.event === "p0.start" && rec.id === id,
        )
        expect(start).toBeDefined()
        expect(start!.meta?.sessionID).toBe("ses_wait")

        yield* replyEffect(pending.id)
        const answers = yield* Fiber.join(fiber)
        expect(answers).toEqual([["yes"]])

        const end = P0.stageRecords(capture.slice(from), "question_wait").find(
          (rec) => rec.event === "p0.end" && rec.id === id,
        )
        expect(end).toBeDefined()
        expect(end!.duration).toBeGreaterThanOrEqual(0)
        expect(P0.stageSpans(capture.slice(from), "question_wait")).toEqual({ spans: 1, unmatchedStarts: 0 })
      }),
  )

  it.instance(
    "reject leaves an unmatched question_wait p0.start (no fabricated p0.end)",
    () =>
      Effect.gen(function* () {
        const from = capture.mark()
        const fiber = yield* Effect.forkScoped(askEffect(SessionID.make("ses_reject")))
        const pending = yield* waitForPending()
        const id = String(pending.id)
        expect(
          P0.stageRecords(capture.slice(from), "question_wait").some(
            (rec) => rec.event === "p0.start" && rec.id === id,
          ),
        ).toBe(true)

        yield* rejectEffect(pending.id)
        const exit = yield* Fiber.await(fiber)
        expect(exit._tag).toBe("Failure")
        if (exit._tag === "Failure") {
          expect(Cause.squash(exit.cause)).toBeInstanceOf(Question.RejectedError)
        }

        const slice = capture.slice(from)
        // The instrument contract: failure/interruption never synthesizes an
        // end record — the lone start IS the failure signal.
        expect(
          P0.stageRecords(slice, "question_wait").some((rec) => rec.event === "p0.end" && rec.id === id),
        ).toBe(false)
        expect(P0.stageSpans(slice, "question_wait").unmatchedStarts).toBeGreaterThanOrEqual(1)
      }),
  )
})

const askPermission = Effect.fn("WaitSpansTest.askPermission")(function* (sessionID: SessionID) {
  const permission = yield* Permission.Service
  return yield* permission.ask({
    sessionID,
    permission: "read",
    patterns: ["*"],
    always: [],
    ruleset: [],
    metadata: {},
  })
})

/** Wait until a permission request is pending; returns the first pending request. */
const waitForPermissionPending = Effect.fn("WaitSpansTest.waitForPermissionPending")(function* () {
  const permission = yield* Permission.Service
  for (let i = 0; i < 200; i++) {
    const pending = yield* permission.list()
    if (pending.length > 0) return pending[0]!
    yield* Effect.sleep("10 millis")
  }
  return yield* Effect.fail(new Error("no pending permission request"))
})

describe("backend permission_wait span", () => {
  itPerm.instance(
    "ask emits permission_wait p0.start; reply emits the matching p0.end with duration",
    () =>
      Effect.gen(function* () {
        const from = capture.mark()
        const permission = yield* Permission.Service
        const fiber = yield* Effect.forkScoped(askPermission(SessionID.make("ses_perm")))
        const req = yield* waitForPermissionPending()
        const id = String(req.id)

        const start = P0.stageRecords(capture.slice(from), "permission_wait").find(
          (rec) => rec.event === "p0.start" && rec.id === id,
        )
        expect(start).toBeDefined()
        expect(start!.meta?.sessionID).toBe("ses_perm")
        expect(start!.meta?.permission).toBe("read")

        yield* permission.reply({ requestID: req.id, reply: "once" })
        yield* Fiber.join(fiber)

        const end = P0.stageRecords(capture.slice(from), "permission_wait").find(
          (rec) => rec.event === "p0.end" && rec.id === id,
        )
        expect(end).toBeDefined()
        expect(end!.duration).toBeGreaterThanOrEqual(0)
        expect(P0.stageSpans(capture.slice(from), "permission_wait")).toEqual({ spans: 1, unmatchedStarts: 0 })
      }),
  )

  itPerm.instance(
    "reject leaves an unmatched permission_wait p0.start (no fabricated p0.end)",
    () =>
      Effect.gen(function* () {
        const from = capture.mark()
        const permission = yield* Permission.Service
        const fiber = yield* Effect.forkScoped(askPermission(SessionID.make("ses_perm")))
        const req = yield* waitForPermissionPending()
        const id = String(req.id)
        expect(
          P0.stageRecords(capture.slice(from), "permission_wait").some(
            (rec) => rec.event === "p0.start" && rec.id === id,
          ),
        ).toBe(true)

        yield* permission.reply({ requestID: req.id, reply: "reject" })
        const exit = yield* Fiber.await(fiber)
        expect(exit._tag).toBe("Failure")

        const slice = capture.slice(from)
        // The instrument contract: failure/interruption never synthesizes an
        // end record — the lone start IS the failure signal.
        expect(
          P0.stageRecords(slice, "permission_wait").some((rec) => rec.event === "p0.end" && rec.id === id),
        ).toBe(false)
        expect(P0.stageSpans(slice, "permission_wait").unmatchedStarts).toBeGreaterThanOrEqual(1)
      }),
  )
})
