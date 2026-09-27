import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Identifier } from "../../src/id/id"
import { SessionID, MessageID, PartID } from "../../src/session/schema"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Global } from "@opencode-ai/core/global"
import { Instance } from "../../src/kilocode/instance"
import { provideTestInstance, tmpdir } from "../fixture/fixture"
import { PlanFollowup } from "../../src/kilocode/plan-followup"
import { KiloSessionPrompt } from "../../src/kilocode/session/prompt"
import { makeRuntime } from "../../src/effect/run-service"
import { Question } from "../../src/question"
import { Session } from "../../src/session/session"
import { MessageV2 } from "../../src/session/message-v2"
import * as Log from "@opencode-ai/core/util/log"

Log.init({ print: false })

const session = makeRuntime(Session.Service, Session.defaultLayer)
const store = {
  create: (input?: Parameters<Session.Interface["create"]>[0]) => session.runPromise((svc) => svc.create(input)),
  messages: (input: Parameters<Session.Interface["messages"]>[0]) =>
    session.runPromise((svc) => svc.messages(input)),
  updateMessage: <T extends MessageV2.Info>(msg: T) => session.runPromise((svc) => svc.updateMessage(msg)),
  updatePart: <T extends MessageV2.Part>(part: T) => session.runPromise((svc) => svc.updatePart(part)),
}

const model = {
  providerID: ProviderV2.ID.make("openai"),
  modelID: ModelV2.ID.make("gpt-4"),
}

async function withInstance(fn: () => Promise<void>) {
  await using tmp = await tmpdir({ git: true })
  await provideTestInstance({ directory: tmp.path, fn })
}

async function withGlobalPermission(permission: unknown, fn: () => Promise<void>) {
  const prev = Global.Path.config
  const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "plan-followup-perm-")))
  Global.Path.config = tmp
  try {
    await fs.writeFile(path.join(tmp, "kilo.jsonc"), JSON.stringify({ permission }, null, 2))
    await fn()
  } finally {
    Global.Path.config = prev
    await fs.rm(tmp, { recursive: true, force: true })
  }
}

async function seed(agent = "plan") {
  const created = await store.create({})
  const user = await store.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: created.id,
    time: { created: Date.now() },
    agent,
    model,
  })
  await store.updatePart({
    id: PartID.ascending(),
    messageID: user.id,
    sessionID: created.id,
    type: "text",
    text: "Create a plan",
  })
  const assistant: MessageV2.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    sessionID: created.id,
    time: { created: Date.now() },
    parentID: user.id,
    modelID: model.modelID,
    providerID: model.providerID,
    mode: agent,
    agent,
    path: { cwd: Instance.directory, root: Instance.worktree },
    cost: 0,
    tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    finish: "end_turn",
  }
  await store.updateMessage(assistant)
  await store.updatePart({
    id: PartID.ascending(),
    messageID: assistant.id,
    sessionID: created.id,
    type: "text",
    text: "1. Step one\n2. Step two",
  })
  await store.updatePart({
    id: PartID.ascending(),
    messageID: assistant.id,
    sessionID: created.id,
    type: "tool",
    callID: Identifier.ascending("tool"),
    tool: "plan_exit",
    state: {
      status: "completed",
      input: {},
      output: "Plan is ready. Ending planning turn.",
      title: "plan_exit",
      metadata: {},
      time: { start: Date.now(), end: Date.now() },
    },
  } satisfies MessageV2.ToolPart)
  const messages = await store.messages({ sessionID: created.id })
  return { sessionID: created.id, messages }
}

describe("plan follow-up free-form permission gate", () => {
  test("denied free-form breaks safely with no pending question", () =>
    withInstance(async () => {
      await withGlobalPermission({ question: "deny" }, async () => {
        const seeded = await seed("code")
        const result = await Effect.runPromise(
          Effect.gen(function* () {
            const question = yield* Question.Service
            const action = yield* Effect.promise(() =>
              KiloSessionPrompt.askPlanFollowup({
                sessionID: seeded.sessionID,
                messages: seeded.messages,
                abort: AbortSignal.any([]),
                question,
              }),
            )
            const left = (yield* question.list()).filter((q) => q.sessionID === seeded.sessionID)
            return { action, left }
          }).pipe(Effect.provide(Question.defaultLayer)),
        )
        expect(result.action).toBe("break")
        expect(result.left).toEqual([])
      })
    }))

  test("plan agent explicit question deny still blocks with no pending question", () =>
    withInstance(async () => {
      await withGlobalPermission({ question: "deny" }, async () => {
        const seeded = await seed("plan")
        const result = await Effect.runPromise(
          Effect.gen(function* () {
            const question = yield* Question.Service
            const action = yield* Effect.promise(() =>
              KiloSessionPrompt.askPlanFollowup({
                sessionID: seeded.sessionID,
                messages: seeded.messages,
                abort: AbortSignal.any([]),
                question,
              }),
            )
            const left = (yield* question.list()).filter((q) => q.sessionID === seeded.sessionID)
            return { action, left }
          }).pipe(Effect.provide(Question.defaultLayer)),
        )
        expect(result.action).toBe("break")
        expect(result.left).toEqual([])
      })
    }))

  test("plan agent question allow reaches follow-up with global allow (no shared defaults deny)", () =>
    withInstance(async () => {
      await withGlobalPermission({ question: "allow" }, async () => {
        const seeded = await seed("plan")
        const result = await Effect.runPromise(
          Effect.gen(function* () {
            const question = yield* Question.Service
            const pending = KiloSessionPrompt.askPlanFollowup({
              sessionID: seeded.sessionID,
              messages: seeded.messages,
              abort: AbortSignal.any([]),
              question,
            })
            const item = yield* Effect.gen(function* () {
              for (let i = 0; i < 50; i++) {
                const found = (yield* question.list()).find((entry) => entry.sessionID === seeded.sessionID)
                if (found) return found
                yield* Effect.sleep("10 millis")
              }
              throw new Error("timed out waiting for real plan follow-up question")
            })
            yield* question.reply({ requestID: item.id, answers: [[PlanFollowup.ANSWER_CONTINUE]] })
            const action = yield* Effect.promise(() => pending)
            const left = (yield* question.list()).filter((q) => q.sessionID === seeded.sessionID)
            return { action, left }
          }).pipe(Effect.provide(Question.defaultLayer)),
        )
        // kilocode_change - shared agent defaults no longer carry
        // `{question,'*',deny}`, so the real plan `question:allow` (planGuard)
        // is reachable and the follow-up asks. User-explicit question deny
        // still rejects (covered above); question_tool stays out of this path.
        expect(result.action).toBe("continue")
        expect(result.left).toEqual([])
      })
    }))

  test("child task keeps explicit question deny (isolation unchanged)", async () => {
    const { KiloTask } = await import("../../src/kilocode/tool/task")
    const rules = KiloTask.permissions([])
    expect(rules.some((r) => r.permission === "question" && r.pattern === "*" && r.action === "deny")).toBe(true)
  })

  test("question_tool with no explicit rule defaults to ask and binds exact literal approval", async () => {
    const { evaluate } = await import("../../src/permission/evaluator")
    const ws = "/workspace"
    const sess = "sess_qtool_plan_perm"
    const agent = "code"
    const base = {
      sessionID: sess,
      agent,
      workspaceRoot: ws,
      permissionRequestId: "per_qtool_default",
      operationId: "permission:per_qtool_default",
    }
    const toolReq = { ...base, permission: "question_tool", patterns: ["ask-user"] }
    const noRule = evaluate({
      request: toolReq as never,
      layers: [{ kind: "runtime-ceiling", sourceKind: "runtime-safety", canonicalPath: "runtime:ceiling", ruleset: [] }],
      approvals: [],
      allowEverything: false,
    })
    expect(noRule.result).toBe("ask")
    // Exact session/agent/permission/pattern approval allows; any identity drift stays ask.
    const exact = {
      kind: "session" as const,
      sessionID: sess,
      agent,
      permission: "question_tool",
      patterns: ["ask-user"],
    }
    const allowed = evaluate({
      request: toolReq as never,
      layers: [{ kind: "runtime-ceiling", sourceKind: "runtime-safety", canonicalPath: "runtime:ceiling", ruleset: [] }],
      approvals: [exact as never],
      allowEverything: false,
    })
    expect(allowed.result).toBe("allow")
    const otherPattern = evaluate({
      request: { ...toolReq, patterns: ["ask-user-extra"] } as never,
      layers: [{ kind: "runtime-ceiling", sourceKind: "runtime-safety", canonicalPath: "runtime:ceiling", ruleset: [] }],
      approvals: [exact as never],
      allowEverything: false,
    })
    expect(otherPattern.result).toBe("ask")
    const otherPermission = evaluate({
      request: { ...base, permission: "question", patterns: ["free-form"] } as never,
      layers: [{ kind: "runtime-ceiling", sourceKind: "runtime-safety", canonicalPath: "runtime:ceiling", ruleset: [] }],
      approvals: [exact as never],
      allowEverything: false,
    })
    expect(otherPermission.result).toBe("ask")
  })

  test("projectHardRuleset only drops the mode fallback, broad explicit denies stay as veto", () => {
    const project = (hard: { permission: string; pattern: string; action: "allow" | "deny" | "ask" }[]) =>
      KiloSessionPrompt.projectHardRulesetForFreeformQuestion({
        hard,
        permission: "question",
        patterns: ["free-form"],
      })

    // kilocode_change - auditor regression: only `{permission:'*',pattern:'*',action:'deny'}`
    // may be projected away when the same-document winner allows/asks. Every
    // other matching deny stays so the evaluator's ceiling-a vetoes.
    const broadQuestion = [
      { permission: "question", pattern: "*", action: "deny" as const },
      { permission: "question", pattern: "free-form", action: "allow" as const },
    ]
    expect(project(broadQuestion)).toEqual(broadQuestion)

    const broadPattern = [
      { permission: "*", pattern: "free-form", action: "deny" as const },
      { permission: "question", pattern: "free-form", action: "allow" as const },
    ]
    expect(project(broadPattern)).toEqual(broadPattern)

    const broadGlob = [
      { permission: "question", pattern: "free-*", action: "deny" as const },
      { permission: "question", pattern: "free-form", action: "allow" as const },
    ]
    expect(project(broadGlob)).toEqual(broadGlob)

    // Mixed: fallback is still dropped while the coexisting broad explicit
    // deny is retained for ceiling-a.
    const mixed = [
      { permission: "*", pattern: "*", action: "deny" as const },
      { permission: "question", pattern: "*", action: "deny" as const },
      { permission: "question", pattern: "free-form", action: "allow" as const },
    ]
    expect(project(mixed)).toEqual([
      { permission: "question", pattern: "*", action: "deny" as const },
      { permission: "question", pattern: "free-form", action: "allow" as const },
    ])

    // Fallback-only guard: same-document winner allows, so the mode fallback
    // is projected away.
    const guard = [
      { permission: "*", pattern: "*", action: "deny" as const },
      { permission: "question", pattern: "*", action: "allow" as const },
    ]
    const narrowed = project(guard)
    expect(narrowed?.some((r) => r.action === "deny" && r.permission === "*" && r.pattern === "*")).toBe(false)

    // Winner-deny guards pass through untouched (hard veto kept).
    const explicit = [
      { permission: "*", pattern: "*", action: "deny" as const },
      { permission: "question", pattern: "*", action: "deny" as const },
    ]
    expect(project(explicit)).toEqual(explicit)

    const targeted = [
      { permission: "*", pattern: "*", action: "deny" as const },
      { permission: "question", pattern: "*", action: "allow" as const },
      { permission: "question", pattern: "free-form", action: "deny" as const },
    ]
    expect(project(targeted)).toEqual(targeted)

    // Other permissions never enter this path.
    expect(
      KiloSessionPrompt.projectHardRulesetForFreeformQuestion({
        hard: guard,
        permission: "question_tool",
        patterns: ["ask-user"],
      }),
    ).toEqual(guard)
    expect(
      KiloSessionPrompt.projectHardRulesetForFreeformQuestion({
        hard: guard,
        permission: "edit",
        patterns: ["free-form"],
      }),
    ).toEqual(guard)
  })

  test("allowed free-form still asks and reject leaves no pending question", () =>
    withInstance(async () => {
      await withGlobalPermission({ question: "allow" }, async () => {
        const seeded = await seed("code")
        const result = await Effect.runPromise(
          Effect.gen(function* () {
            const question = yield* Question.Service
            const pending = KiloSessionPrompt.askPlanFollowup({
              sessionID: seeded.sessionID,
              messages: seeded.messages,
              abort: AbortSignal.any([]),
              question,
            })
            const item = yield* Effect.gen(function* () {
              for (let i = 0; i < 50; i++) {
                const found = (yield* question.list()).find((entry) => entry.sessionID === seeded.sessionID)
                if (found) return found
                yield* Effect.sleep("10 millis")
              }
              throw new Error("timed out waiting for gated plan follow-up question")
            })
            yield* question.reply({ requestID: item.id, answers: [[PlanFollowup.ANSWER_CONTINUE]] })
            const action = yield* Effect.promise(() => pending)
            const left = (yield* question.list()).filter((q) => q.sessionID === seeded.sessionID)
            return { action, left }
          }).pipe(Effect.provide(Question.defaultLayer)),
        )
        expect(result.action).toBe("continue")
        expect(result.left).toEqual([])
      })
    }))

  test("rejected follow-up leaves no pending question", () =>
    withInstance(async () => {
      await withGlobalPermission({ question: "allow" }, async () => {
        const seeded = await seed("code")
        const result = await Effect.runPromise(
          Effect.gen(function* () {
            const question = yield* Question.Service
            const pending = KiloSessionPrompt.askPlanFollowup({
              sessionID: seeded.sessionID,
              messages: seeded.messages,
              abort: AbortSignal.any([]),
              question,
            })
            const item = yield* Effect.gen(function* () {
              for (let i = 0; i < 50; i++) {
                const found = (yield* question.list()).find((entry) => entry.sessionID === seeded.sessionID)
                if (found) return found
                yield* Effect.sleep("10 millis")
              }
              throw new Error("timed out waiting for gated plan follow-up question")
            })
            yield* question.reject(item.id)
            const action = yield* Effect.promise(() => pending)
            const left = (yield* question.list()).filter((q) => q.sessionID === seeded.sessionID)
            return { action, left }
          }).pipe(Effect.provide(Question.defaultLayer)),
        )
        expect(result.action).toBe("break")
        expect(result.left).toEqual([])
      })
    }))

  test("aborted gate breaks safely with no pending question", () =>
    withInstance(async () => {
      await withGlobalPermission({ question: "allow" }, async () => {
        const seeded = await seed("code")
        const ctl = new AbortController()
        ctl.abort()
        const result = await Effect.runPromise(
          Effect.gen(function* () {
            const question = yield* Question.Service
            const action = yield* Effect.promise(() =>
              KiloSessionPrompt.askPlanFollowup({
                sessionID: seeded.sessionID,
                messages: seeded.messages,
                abort: ctl.signal,
                question,
              }),
            )
            const left = (yield* question.list()).filter((q) => q.sessionID === seeded.sessionID)
            return { action, left }
          }).pipe(Effect.provide(Question.defaultLayer)),
        )
        expect(result.action).toBe("break")
        expect(result.left).toEqual([])
      })
    }))

  test("aborted permission gate leaves Permission.list and Question.list empty", () =>
    withInstance(async () => {
      await withGlobalPermission({}, async () => {
        const seeded = await seed("code")
        const ctl = new AbortController()
        const { AppRuntime } = await import("../../src/effect/app-runtime")
        const { Permission } = await import("../../src/permission")
        const boundList = () =>
          Instance.bind(() =>
            AppRuntime.runPromise(
              Effect.gen(function* () {
                const perm = yield* Permission.Service
                return yield* perm.list()
              }),
            ),
          )()
        const result = await Effect.runPromise(
          Effect.gen(function* () {
            const question = yield* Question.Service
            const pending = KiloSessionPrompt.askPlanFollowup({
              sessionID: seeded.sessionID,
              messages: seeded.messages,
              abort: ctl.signal,
              question,
            })
            yield* Effect.gen(function* () {
              for (let i = 0; i < 50; i++) {
                const list = yield* Effect.promise(() => boundList())
                if (list.some((r) => String(r.sessionID) === String(seeded.sessionID))) return list
                yield* Effect.sleep("10 millis")
              }
              throw new Error("timed out waiting for permission gate pending")
            })
            ctl.abort()
            const action = yield* Effect.promise(() => pending)
            const qleft = (yield* question.list()).filter((q) => q.sessionID === seeded.sessionID)
            const pleft = (yield* Effect.promise(() => boundList())).filter(
              (r) => String(r.sessionID) === String(seeded.sessionID),
            )
            return { action, qleft, pleft }
          }).pipe(Effect.provide(Question.defaultLayer)),
        )
        expect(result.action).toBe("break")
        expect(result.qleft).toEqual([])
        expect(result.pleft).toEqual([])
      })
    }))
})
