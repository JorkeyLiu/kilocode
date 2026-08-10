/**
 * P0 harness baseline fixture (H-1..H-13).
 *
 * A focused, machine-readable baseline entry that exercises the existing
 * production harness wiring with real fixtures and records explicit
 * unsupported gaps. It is NOT a target-surface parity suite: every entry
 * carries `parity: "unproven"` and the CLI tests never claim parity for the
 * orchestration panel target surface (specs/vscode-orchestrator §6).
 *
 * Locks respected (no challenge):
 * - LOCK-005: the internal context-overflow safeguard is exercised as an
 *   invisible reliability mechanism (H-13), not a context-management product.
 * - LOCK-007: SessionRevert + Snapshot semantics are exercised through the
 *   real revert/unrevert rollback path (H-12); ADR-0001 storage rewriting is
 *   out of scope.
 * - LOCK-008 / LOCK-PERF-5: every core harness capability is either executed
 *   through real production services/fixtures or recorded as an explicit gap
 *   with references to existing coverage. No core service is mocked; only the
 *   established side layers (empty MCP client registry, no-op LSP, no-op
 *   session summary) from the existing session-loop tests are reused.
 *
 * Output: a structured JSON summary (status + evidence per H id) is printed
 * at the end of the file via afterAll (`bun test --print` or `--verbose`
 * shows it; it is also shown in the FAILURES section on any failure). The
 * report's `outcome` and each lock's `respected` derive from the actual
 * check results — a failed run reports `outcome: "fail"` with the failing
 * checks listed and no lock marked respected.
 *
 * Run: `bun test test/kilocode/p0-harness-baseline.test.ts` from
 * packages/opencode/.
 */

import { afterAll, describe, expect } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { NodeFileSystem } from "@effect/platform-node"
import { Database } from "@opencode-ai/core/database/database"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import * as Log from "@opencode-ai/core/util/log"
import fs from "fs/promises"
import path from "path"

import { Session } from "@/session/session"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { SessionPrompt } from "@/session/prompt"
import { SessionRevert } from "@/session/revert"
import { Snapshot } from "@/snapshot"
import { SessionCompaction } from "@/session/compaction"
import { SessionProcessor } from "@/session/processor"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { SystemPrompt } from "@/session/system"
import { Instruction } from "@/session/instruction"
import { Todo } from "@/session/todo"
import { LLM } from "@/session/llm"
import { isOverflow, usable } from "@/session/overflow"
import { KiloSessionOverflow } from "@/kilocode/session/overflow"
import { Agent as AgentSvc } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Config } from "@/config/config"
import { Provider as ProviderSvc } from "@/provider/provider"
import { Env } from "@/env"
import { Auth } from "@/auth"
import { Command } from "@/command"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { Question } from "@/question"
import { Image } from "@/image/image"
import { Skill } from "@/skill"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { TaskTool, type TaskPromptOps } from "@/tool/task"
import { Git } from "@/git"
import { LSP } from "@/lsp/lsp"
import { MCP } from "@/mcp"
import { Reference } from "@/reference/reference"
import { RepositoryCache } from "@/reference/repository-cache"
import { Ripgrep } from "@opencode-ai/core/filesystem/ripgrep"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Format } from "@/format"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Bus } from "@/bus"
import { Storage } from "@/storage/storage"
import { InstanceStore } from "@/project/instance-store"
import { GenerationGate } from "@/kilocode/server/generation-gate"
import type { Provider } from "@/provider/provider"
import { MemoryService } from "@kilocode/kilo-memory/effect/service"

import { provideTmpdirServer, testInstanceStoreLayer } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"

void Log.init({ print: false })

// ---------------------------------------------------------------------------
// Report model (machine-readable output)
// ---------------------------------------------------------------------------

type Check = { name: string; ok: boolean; error?: string }

type HarnessEntry = {
  id: string
  capability: string
  status: "executed" | "gap"
  /** Baseline results never claim target-surface parity (spec §6). */
  parity: "unproven"
  checks: Check[]
  /** Production services exercised by the entry. */
  services: string[]
  /** Run-scoped evidence paths (fixture dir, files) and repo-relative refs. */
  evidence?: string[]
  /** Why a full-flow baseline entry is not safely bounded here. */
  gapReason?: string
  /** Existing tests that already cover the full flow for gap entries. */
  references?: string[]
}

const entries: HarnessEntry[] = []

const record = (entry: HarnessEntry) => {
  entries.push(entry)
}

const run = <R>(name: string, body: Effect.Effect<unknown, unknown, R> | (() => Effect.Effect<unknown, unknown, R>)) =>
  Effect.gen(function* () {
    const exit = yield* Effect.suspend(() => (typeof body === "function" ? body() : body)).pipe(Effect.exit)
    if (Exit.isSuccess(exit)) return { name, ok: true as const }
    const error = Cause.prettyErrors(exit.cause).join("; ") || String(exit.cause)
    return { name, ok: false as const, error }
  })

/** Final per-test assertion: every recorded check must have passed. */
const assertChecks = (checks: Check[]) => {
  const failed = checks.filter((c) => !c.ok)
  expect(failed).toEqual([])
}

// ---------------------------------------------------------------------------
// Shared session-loop layer (production wiring, no core-service mocks)
// ---------------------------------------------------------------------------

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const mcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    tools: () => Effect.succeed({}),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unexpected MCP auth in P0 baseline"),
    authenticate: () => Effect.die("unexpected MCP auth in P0 baseline"),
    finishAuth: () => Effect.die("unexpected MCP auth in P0 baseline"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(undefined),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

const status = Layer.mergeAll(SessionStatus.defaultLayer, Bus.layer)
const runLayer = SessionRunState.layer.pipe(Layer.provide(status))
const infra = Layer.mergeAll(NodeFileSystem.layer, CrossSpawnSpawner.defaultLayer)

// LOCK-008 / LOCK-PERF-5: identical wiring to the existing session-loop
// tests (test/session/snapshot-tool-race.test.ts,
// test/kilocode/session-prompt-compaction-safety.test.ts). Background
// subagents are enabled so H-8 exercises the real TaskTool + BackgroundJob
// path instead of a disabled-feature rejection.
const flags = RuntimeFlags.layer({ experimentalBackgroundSubagents: true })

function makeHttp() {
  const deps = Layer.mergeAll(
    Session.defaultLayer,
    BackgroundJob.defaultLayer,
    Snapshot.defaultLayer,
    LLM.defaultLayer,
    Env.defaultLayer,
    AgentSvc.defaultLayer,
    Command.defaultLayer,
    Permission.defaultLayer,
    Plugin.defaultLayer,
    Config.defaultLayer,
    flags,
    ProviderSvc.defaultLayer,
    lsp,
    mcp,
    FSUtil.defaultLayer,
    Reference.defaultLayer,
    EventV2Bridge.defaultLayer,
    Database.defaultLayer,
    status,
    MemoryService.layer,
  ).pipe(Layer.provideMerge(infra))
  const question = Question.layer.pipe(Layer.provideMerge(deps))
  const todo = Todo.layer.pipe(Layer.provideMerge(deps))
  const registry = ToolRegistry.layer.pipe(
    Layer.provide(Skill.defaultLayer),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(CrossSpawnSpawner.defaultLayer),
    Layer.provide(RepositoryCache.defaultLayer),
    Layer.provide(Ripgrep.defaultLayer),
    Layer.provide(Format.defaultLayer),
    Layer.provide(Git.defaultLayer),
    Layer.provide(Reference.defaultLayer),
    Layer.provide(Command.defaultLayer),
    Layer.provide(Auth.defaultLayer),
    Layer.provideMerge(todo),
    Layer.provideMerge(question),
    Layer.provideMerge(deps),
  )
  const trunc = Truncate.layer.pipe(Layer.provideMerge(deps))
  const proc = SessionProcessor.layer.pipe(
    Layer.provide(summary),
    Layer.provide(Image.defaultLayer),
    Layer.provide(flags),
    Layer.provideMerge(deps),
  )
  const compact = SessionCompaction.layer.pipe(Layer.provide(flags), Layer.provideMerge(proc), Layer.provideMerge(deps))
  return Layer.mergeAll(
    TestLLMServer.layer,
    testInstanceStoreLayer, // InstanceStore.Service for H-10 instance-reload persistence checks
    SessionPrompt.layer.pipe(
      Layer.provideMerge(SessionRevert.defaultLayer),
      Layer.provideMerge(GenerationGate.defaultLayer),
      Layer.provide(Image.defaultLayer),
      Layer.provide(summary),
      Layer.provide(Reference.defaultLayer),
      Layer.provideMerge(runLayer),
      Layer.provideMerge(compact),
      Layer.provideMerge(proc),
      Layer.provideMerge(registry),
      Layer.provideMerge(trunc),
      Layer.provideMerge(question),
      Layer.provide(Instruction.defaultLayer),
      Layer.provide(SystemPrompt.defaultLayer),
      Layer.provide(flags),
      Layer.provideMerge(deps),
    ),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        summary,
        deps,
        Config.defaultLayer,
        flags,
        BackgroundJob.defaultLayer,
        Bus.layer,
        infra,
        Storage.defaultLayer,
        Reference.defaultLayer,
      ),
    ),
  )
}

const it = testEffect(makeHttp())

// ---------------------------------------------------------------------------
// Shared fixtures: custom provider + custom agent config
// ---------------------------------------------------------------------------

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

function config(url: string) {
  return {
    agent: {
      myagent: {
        model: "test/test-model",
        description: "P0 baseline custom agent",
        temperature: 0.1,
      },
    },
    provider: {
      test: {
        name: "Test",
        id: "test",
        env: [],
        npm: "@ai-sdk/openai-compatible",
        models: {
          "test-model": {
            id: "test-model",
            name: "Test Model",
            attachment: false,
            reasoning: false,
            temperature: false,
            tool_call: true,
            release_date: "2025-01-01",
            limit: { context: 100000, output: 10000 },
            cost: { input: 0, output: 0 },
            options: {},
          },
        },
        options: { apiKey: "test-key", baseURL: url },
      },
    },
  }
}

function overflowConfig(url: string) {
  return {
    ...config(url),
    compaction: { auto: true, threshold_percent: 70, tail_turns: 0, preserve_recent_tokens: 0 },
  }
}

// ---------------------------------------------------------------------------
// Message helpers (real Session.Service writes; shapes from existing tests)
// ---------------------------------------------------------------------------

const userMsg = Effect.fn("p0.user")(function* (sessionID: SessionID, text: string) {
  const sessions = yield* Session.Service
  const msg = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "code",
    model: ref,
    time: { created: Date.now() },
    tools: {},
  } satisfies MessageV2.User)
  yield* sessions.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID,
    type: "text",
    text,
  } satisfies MessageV2.TextPart)
  return msg
})

const assistantMsg = Effect.fn("p0.assistant")(function* (
  sessionID: SessionID,
  parentID: MessageID,
  input?: { text?: string },
) {
  const sessions = yield* Session.Service
  const msg = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    role: "assistant",
    parentID,
    sessionID,
    mode: "code",
    agent: "code",
    path: { cwd: "/tmp", root: "/tmp" },
    cost: 0,
    tokens,
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now() },
    finish: "end_turn",
  } satisfies MessageV2.Assistant)
  yield* sessions.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID,
    type: "text",
    text: input?.text ?? "done",
  } satisfies MessageV2.TextPart)
  return msg
})

const toolPartMsg = Effect.fn("p0.assistantTool")(function* (
  sessionID: SessionID,
  parentID: MessageID,
  output: string,
) {
  const sessions = yield* Session.Service
  const msg = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    role: "assistant",
    parentID,
    sessionID,
    mode: "code",
    agent: "code",
    path: { cwd: "/tmp", root: "/tmp" },
    cost: 0,
    tokens,
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now() },
    finish: "end_turn",
  } satisfies MessageV2.Assistant)
  yield* sessions.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID,
    type: "tool",
    tool: "bash",
    callID: "call-1",
    state: {
      status: "completed" as const,
      input: {},
      output,
      title: "",
      metadata: {},
      time: { start: 0, end: 1 },
    },
  } satisfies MessageV2.ToolPart)
  return msg
})

const readFile = (file: string) => Effect.promise(() => fs.readFile(file, "utf-8"))
const writeFile = (file: string, text: string) => Effect.promise(() => fs.writeFile(file, text))

// ---------------------------------------------------------------------------
// Gap entries (recorded statically; full flows already covered elsewhere)
// ---------------------------------------------------------------------------

const GAPS: Omit<HarnessEntry, "checks">[] = [
  {
    id: "H-3",
    capability: "Extensible tools (user-defined tool invocable in a session)",
    status: "gap",
    parity: "unproven",
    services: [],
    gapReason:
      "A user-defined tool requires plugin/tool-file loading; the plugin install path is a network dependency not safely bounded in a baseline fixture. The real ToolRegistry execution path is smoke-covered by H-11's bash tool through the session loop.",
    references: ["test/tool/registry.test.ts", "test/tool/tool-define.test.ts", "test/tool/truncation.test.ts"],
  },
  {
    id: "H-4",
    capability: "Skills (load and run per session)",
    status: "gap",
    parity: "unproven",
    services: [],
    gapReason:
      "Full skill discovery/load/run with real skill files is covered by the existing skill suites; re-executing it here would duplicate them. No skill fixture is added in P0.",
    references: [
      "test/skill/skill.test.ts",
      "test/tool/skill.test.ts",
      "test/kilocode/agent-skill-permissions.test.ts",
    ],
  },
  {
    id: "H-5",
    capability: "MCP (servers configured and used per session)",
    status: "gap",
    parity: "unproven",
    services: ["MCP.Service"],
    gapReason:
      "MCP tool invocation needs a configured MCP server endpoint; the session-loop layer intentionally provides an empty MCP client registry (established convention in the existing session-loop tests). Full MCP config/migration/auth coverage exists separately.",
    references: [
      "test/kilocode/mcp-migrator.test.ts",
      "test/kilocode/mcp-oauth-callback.test.ts",
      "test/kilocode/server/mcp-auth-write-intent.test.ts",
      "test/kilocode/cli/cmd/mcp.test.ts",
    ],
  },
  {
    id: "H-6",
    capability: "Permission/question flows resolve through the permission flow",
    status: "gap",
    parity: "unproven",
    services: ["Permission.Service", "Question.Service"],
    gapReason:
      "The full ask -> user reply -> tool-continue chain through a live session loop is covered by the existing permission/question suites; the baseline does not re-drive interactive permission prompts to keep the run deterministic and bounded.",
    references: [
      "test/permission/next.test.ts",
      "test/question/question.test.ts",
      "test/kilocode/session-prompt-permission-refresh.test.ts",
      "test/kilocode/question-cancel.test.ts",
    ],
  },
]

// ---------------------------------------------------------------------------
// H-1 / H-9 / H-10 / H-11: lifecycle + persistence + custom agent/provider
// ---------------------------------------------------------------------------

describe("P0 harness baseline", () => {
  it.live("H-1/H-9/H-10/H-11 lifecycle, persistence, custom agent + custom provider model", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ dir, llm }) {
        const checks: Check[] = []
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service
        const agents = yield* AgentSvc.Service

        let sessionID: SessionID | undefined

        checks.push(
          yield* run("H-1 custom agent resolves from config", () =>
            Effect.gen(function* () {
              const custom = yield* agents.get("myagent")
              expect(custom).toBeDefined()
              expect(custom?.description).toBe("P0 baseline custom agent")
              expect(String(custom?.model?.providerID)).toBe("test")
              expect(String(custom?.model?.modelID)).toBe("test-model")
            }),
          ),
        )

        checks.push(
          yield* run("H-11 session created with allow-all permission", () =>
            Effect.gen(function* () {
              const session = yield* sessions.create({
                title: "P0 lifecycle",
                permission: [{ permission: "*", pattern: "*", action: "allow" }],
              })
              sessionID = session.id
              expect(session.id).toBeDefined()
            }),
          ),
        )

        checks.push(
          yield* run("H-11 prompt loop runs under the custom agent through the real LLM server", () =>
            Effect.gen(function* () {
              if (!sessionID) return yield* Effect.fail(new Error("missing session"))
              const command = `echo 'p0 baseline' > ${path.join(dir, "lifecycle.txt")}`
              yield* llm.toolMatch((hit) => JSON.stringify(hit.body).includes("create the file"), "bash", {
                command,
                description: "create test file",
              })
              yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("bash"), "done")
              yield* prompt.prompt({
                sessionID,
                agent: "myagent",
                noReply: true,
                parts: [{ type: "text", text: "create the file" }],
              })
              const result = yield* prompt.loop({ sessionID })
              expect(result.info.role).toBe("assistant")
            }),
          ),
        )

        checks.push(
          yield* run("H-11 real tool execution completed inside the loop", () =>
            Effect.gen(function* () {
              if (!sessionID) return yield* Effect.fail(new Error("missing session"))
              const exists = yield* Effect.promise(() =>
                fs
                  .access(path.join(dir, "lifecycle.txt"))
                  .then(() => true)
                  .catch(() => false),
              )
              expect(exists).toBe(true)
              const allMsgs = yield* MessageV2.filterCompactedEffect(sessionID)
              const tool = allMsgs
                .flatMap((m) => m.parts)
                .find((p): p is MessageV2.ToolPart => p.type === "tool" && p.tool === "bash")
              expect(tool?.state.status).toBe("completed")
            }),
          ),
        )

        checks.push(
          yield* run("H-11 session status returns to idle after the loop (busy -> idle)", () =>
            pollWithTimeout(
              Effect.gen(function* () {
                if (!sessionID) return
                const s = yield* (yield* SessionStatus.Service).get(sessionID)
                return s.type === "idle" ? true : undefined
              }),
              "session never returned to idle after the loop",
            ),
          ),
        )

        checks.push(
          yield* run("H-9 requests hit the custom provider endpoint with the custom provider model", () =>
            Effect.gen(function* () {
              const hits = yield* llm.hits
              const seen = hits.filter((h) => !JSON.stringify(h.body).includes("Generate a title"))
              expect(seen.length).toBeGreaterThan(0)
              const model = seen.find((h) => (h.body as Record<string, unknown>).model === "test-model")
              expect(model).toBeDefined()
              // The provider record is the user-defined config block whose
              // baseURL points at the loopback TestLLMServer — no preset
              // provider was involved.
              const host = new URL(hits[0]?.url.href ?? "").hostname
              expect(["localhost", "127.0.0.1"]).toContain(host)
            }),
          ),
        )

        checks.push(
          yield* run("H-10 session + messages survive an instance lifecycle boundary (reload)", () =>
            Effect.gen(function* () {
              if (!sessionID) return yield* Effect.fail(new Error("missing session"))
              // InstanceStore is provided by the fixture layer for the test.
              yield* InstanceStore.Service.use((store) => store.reload({ directory: dir }))
              const revived = yield* sessions.get(sessionID)
              expect(revived.id).toBe(sessionID)
              const allMsgs = yield* MessageV2.filterCompactedEffect(sessionID)
              expect(allMsgs.length).toBeGreaterThan(0)
              const tool = allMsgs
                .flatMap((m) => m.parts)
                .find((p): p is MessageV2.ToolPart => p.type === "tool" && p.tool === "bash")
              expect(tool?.state.status).toBe("completed")
            }),
          ),
        )

        checks.push(
          yield* run("H-11 session remove cleans up after the reloaded instance", () =>
            Effect.gen(function* () {
              if (!sessionID) return yield* Effect.fail(new Error("missing session"))
              yield* sessions.remove(sessionID)
              const gone = yield* sessions.get(sessionID).pipe(Effect.exit)
              expect(Exit.isFailure(gone)).toBe(true)
            }),
          ),
        )

        record({
          id: "H-1",
          capability: "Custom agents (user-defined agent honored by the harness)",
          status: "executed",
          parity: "unproven",
          checks: checks.filter((c) => c.name.startsWith("H-1")),
          services: ["Agent.Service", "Config.Service", "Session.Service"],
          evidence: [`fixture dir: ${dir}`, "opencode.json agent.myagent (model test/test-model)"],
        })
        record({
          id: "H-9",
          capability: "User-selected custom-provider models",
          status: "executed",
          parity: "unproven",
          checks: checks.filter((c) => c.name.startsWith("H-9")),
          services: ["Provider.Service", "LLM", "Config.Service"],
          evidence: [
            `fixture dir: ${dir}`,
            "opencode.json provider.test.baseURL -> TestLLMServer loopback",
            "LLM request body.model === test-model (custom provider model id)",
          ],
        })
        record({
          id: "H-10",
          capability: "Persistence (sessions survive the instance lifecycle boundary)",
          status: "executed",
          parity: "unproven",
          checks: checks.filter((c) => c.name.startsWith("H-10")),
          services: ["InstanceStore.Service", "Session.Service", "Database.Service"],
          evidence: [
            `fixture dir: ${dir}`,
            "instance reload (dispose + reboot) preserves session + completed tool part",
          ],
        })
        record({
          id: "H-11",
          capability: "Lifecycle correctness (create/prompt/tool/complete/idle/cleanup)",
          status: "executed",
          parity: "unproven",
          checks: checks.filter((c) => c.name.startsWith("H-11")),
          services: ["Session.Service", "SessionPrompt.Service", "ToolRegistry", "SessionStatus.Service"],
          evidence: [`fixture dir: ${dir}`, "lifecycle.txt created by the bash tool inside the loop"],
        })

        assertChecks(checks)
      }),
      { git: true, config: config },
    ),
    // Heavy live integration boot (git repo, LLM server, bash tool, snapshots);
    // the default 5s per-test budget flakes under load (same convention as
    // session-prompt-queue.test.ts).
    { timeout: 30_000 },
  )

  // -------------------------------------------------------------------------
  // H-12: SessionRevert + Snapshot rollback (LOCK-007)
  // -------------------------------------------------------------------------

  it.live("H-12 SessionRevert + Snapshot rollback restores and unreverts file state", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ dir }) {
        const checks: Check[] = []
        const sessions = yield* Session.Service
        const revert = yield* SessionRevert.Service
        const snapshot = yield* Snapshot.Service

        // LOCK-007: the step-start/step-finish/patch parts below mirror what
        // the production SessionProcessor writes on each turn
        // (src/session/processor.ts: step-start with the before-snapshot on
        // stream open, step-finish with reason/snapshot/tokens/cost on close,
        // and a patch part from snapshot.patch when files changed). They are
        // authored here directly — no live LLM loop — so revert/unrevert runs
        // against processor-equivalent persisted state with deterministic
        // file snapshots.
        const turn = Effect.fn("p0.turn")(function* (sessionID: SessionID, file: string, next: string) {
          const u = yield* userMsg(sessionID, `${file}:${next}`)
          const a = yield* assistantMsg(sessionID, u.id)
          const before = yield* snapshot.track()
          if (!before) return yield* Effect.fail(new Error("expected snapshot before"))
          yield* writeFile(path.join(dir, file), next)
          const after = yield* snapshot.track()
          if (!after) return yield* Effect.fail(new Error("expected snapshot after"))
          const patch = yield* snapshot.patch(before)
          yield* sessions.updatePart({
            id: PartID.ascending(),
            messageID: a.id,
            sessionID,
            type: "step-start",
            snapshot: before,
          })
          yield* sessions.updatePart({
            id: PartID.ascending(),
            messageID: a.id,
            sessionID,
            type: "step-finish",
            reason: "stop",
            snapshot: after,
            cost: 0,
            tokens,
          })
          yield* sessions.updatePart({
            id: PartID.ascending(),
            messageID: a.id,
            sessionID,
            type: "patch",
            hash: patch.hash,
            files: patch.files,
          })
          return u.id
        })

        let sid: SessionID | undefined

        checks.push(
          yield* run("H-12 snapshot tracks real file changes across turns", () =>
            Effect.gen(function* () {
              yield* writeFile(path.join(dir, "a.txt"), "a0")
              const session = yield* sessions.create({})
              sid = session.id
              const first = yield* turn(sid, "a.txt", "a1")
              yield* turn(sid, "a.txt", "a2")
              expect(yield* readFile(path.join(dir, "a.txt"))).toBe("a2")
              expect(first).toBeDefined()
            }),
          ),
        )

        checks.push(
          yield* run("H-12 revert restores the file to the pre-turn state (SessionRevert + Snapshot)", () =>
            Effect.gen(function* () {
              if (!sid) return yield* Effect.fail(new Error("missing session"))
              const msgs = yield* sessions.messages({ sessionID: sid })
              const firstUser = msgs.find((m) => m.info.role === "user")?.info.id
              if (!firstUser) return yield* Effect.fail(new Error("missing first user message"))
              yield* revert.revert({ sessionID: sid, messageID: firstUser })
              expect((yield* sessions.get(sid)).revert?.messageID).toBe(firstUser)
              expect(yield* readFile(path.join(dir, "a.txt"))).toBe("a0")
            }),
          ),
        )

        checks.push(
          yield* run("H-12 unrevert restores the forward state and clears revert metadata", () =>
            Effect.gen(function* () {
              if (!sid) return yield* Effect.fail(new Error("missing session"))
              yield* revert.unrevert({ sessionID: sid })
              expect((yield* sessions.get(sid)).revert).toBeUndefined()
              expect(yield* readFile(path.join(dir, "a.txt"))).toBe("a2")
            }),
          ),
        )

        checks.push(
          yield* run("H-12 lifecycle stays correct after rollback (session removable)", () =>
            Effect.gen(function* () {
              if (!sid) return yield* Effect.fail(new Error("missing session"))
              yield* sessions.remove(sid)
              const gone = yield* sessions.get(sid).pipe(Effect.exit)
              expect(Exit.isFailure(gone)).toBe(true)
            }),
          ),
        )

        record({
          id: "H-12",
          capability: "Checkpoint rollback (SessionRevert + Snapshot, LOCK-007)",
          status: "executed",
          parity: "unproven",
          checks,
          services: ["SessionRevert.Service", "Snapshot.Service", "Session.Service", "Git"],
          evidence: [`fixture dir: ${dir}`, "a.txt: a0 -> a1 -> a2, revert -> a0, unrevert -> a2"],
        })

        assertChecks(checks)
      }),
      { git: true, config: config },
    ),
    // Heavy live integration boot (git repo, LLM server, bash tool, snapshots);
    // the default 5s per-test budget flakes under load (same convention as
    // session-prompt-queue.test.ts).
    { timeout: 30_000 },
  )

  // -------------------------------------------------------------------------
  // H-2 / H-7 / H-8: delegation, parent-child sessions, background execution
  // -------------------------------------------------------------------------

  it.live("H-2/H-7/H-8 delegation, parent-child hierarchy, and background execution", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ dir }) {
        const checks: Check[] = []
        const sessions = yield* Session.Service
        const jobs = yield* BackgroundJob.Service
        const tool = yield* TaskTool
        const def = yield* tool.init()

        const seed = Effect.gen(function* () {
          const chat = yield* sessions.create({ title: "P0 parent" })
          const user = yield* sessions.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: chat.id,
            agent: "build",
            model: ref,
            time: { created: Date.now() },
          })
          const assistant: SessionV1.Assistant = {
            id: MessageID.ascending(),
            role: "assistant",
            parentID: user.id,
            sessionID: chat.id,
            mode: "build",
            agent: "build",
            cost: 0,
            path: { cwd: dir, root: dir },
            tokens,
            modelID: ref.modelID,
            providerID: ref.providerID,
            variant: "xhigh",
            time: { created: Date.now() },
          }
          yield* sessions.updateMessage(assistant)
          return { chat, assistant }
        })

        // The child prompt loop is stubbed via TaskPromptOps (same side layer
        // as test/tool/task.test.ts): `prompt` synthesizes one assistant text
        // part instead of running a nested LLM loop. The TaskTool delegation
        // / BackgroundJob wiring under test is real production code; the
        // child's own loop is not executed. Disclosed in H-2/H-8 evidence.
        const stubOps = (text: string): TaskPromptOps => ({
          cancel: () => Effect.void,
          resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
          prompt: (input) =>
            Effect.sync(() => {
              const id = MessageID.ascending()
              return {
                info: {
                  id,
                  role: "assistant" as const,
                  parentID: input.messageID ?? MessageID.ascending(),
                  sessionID: input.sessionID,
                  mode: input.agent ?? "general",
                  agent: input.agent ?? "general",
                  cost: 0,
                  path: { cwd: dir, root: dir },
                  tokens,
                  modelID: input.model?.modelID ?? ref.modelID,
                  providerID: input.model?.providerID ?? ref.providerID,
                  time: { created: Date.now() },
                  finish: "stop" as const,
                },
                parts: [
                  { id: PartID.ascending(), messageID: id, sessionID: input.sessionID, type: "text" as const, text },
                ],
              }
            }),
        })

        const ctx = (sessionID: SessionID, messageID: MessageID, promptOps: TaskPromptOps) => ({
          sessionID,
          messageID,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        })

        let parentID: SessionID | undefined

        checks.push(
          yield* run("H-2 foreground delegation creates a real child session and flows the result back", () =>
            Effect.gen(function* () {
              const { chat, assistant } = yield* seed
              parentID = chat.id
              const result = yield* def.execute(
                { description: "inspect bug", prompt: "look into the cache key path", subagent_type: "general" },
                ctx(chat.id, assistant.id, stubOps("delegated result")),
              )
              const child = yield* sessions.get(result.metadata.sessionId)
              expect(child.id).toBe(result.metadata.sessionId)
              expect(child.parentID).toBe(chat.id)
              expect(result.output).toContain(`<task id="${child.id}" state="completed">`)
              expect(result.output).toContain("delegated result")
            }),
          ),
        )

        checks.push(
          yield* run("H-7 parent/child relation is first-class and queryable", () =>
            Effect.gen(function* () {
              if (!parentID) return yield* Effect.fail(new Error("missing parent session"))
              const kids = yield* sessions.children(parentID)
              expect(kids.length).toBeGreaterThan(0)
              for (const kid of kids) expect(kid.parentID).toBe(parentID)
            }),
          ),
        )

        checks.push(
          yield* run("H-8 background execution runs through the real BackgroundJob service", () =>
            Effect.gen(function* () {
              if (!parentID) return yield* Effect.fail(new Error("missing parent session"))
              const parent = yield* sessions.get(parentID)
              const aMsg = (yield* sessions.messages({ sessionID: parentID })).find((m) => m.info.role === "assistant")
                ?.info.id
              if (!aMsg) return yield* Effect.fail(new Error("missing parent assistant message"))
              const started = yield* def.execute(
                {
                  description: "background probe",
                  prompt: "run in the background",
                  subagent_type: "general",
                  background: true,
                },
                ctx(parentID, aMsg, stubOps("background done")),
              )
              expect(started.metadata.background).toBe(true)
              const job = yield* jobs.get(started.metadata.sessionId)
              expect(job).toBeDefined()
              // The parent session remains readable while the background child runs.
              expect((yield* sessions.get(parentID)).id).toBe(parentID)
              const waited = yield* jobs.wait({ id: started.metadata.sessionId, timeout: 5_000 })
              expect(waited.info?.status).toBe("completed")
              expect(waited.info?.output).toContain("background done")
            }),
          ),
        )

        checks.push(
          yield* run("H-11/H-8 cleanup: removing the parent removes child sessions", () =>
            Effect.gen(function* () {
              if (!parentID) return yield* Effect.fail(new Error("missing parent session"))
              yield* sessions.remove(parentID)
              const kids = yield* sessions.children(parentID)
              expect(kids.length).toBe(0)
            }),
          ),
        )

        record({
          id: "H-2",
          capability: "Sub-task delegation (child session with defined task, result flows back)",
          status: "executed",
          parity: "unproven",
          checks: checks.filter((c) => c.name.startsWith("H-2")),
          services: ["TaskTool", "Session.Service", "Agent.Service", "Config.Service"],
          evidence: [
            `fixture dir: ${dir}`,
            'foreground execute returns <task state="completed"> with delegated result',
            "child prompt loop stubbed: TaskPromptOps.prompt synthesizes a single assistant text part (no nested LLM loop); TaskTool delegation/result wiring is real",
          ],
        })
        record({
          id: "H-7",
          capability: "Parent-child sessions (first-class, persisted relation)",
          status: "executed",
          parity: "unproven",
          checks: checks.filter((c) => c.name.startsWith("H-7") || c.name.startsWith("H-11/H-8 cleanup")),
          services: ["Session.Service", "TaskTool"],
          evidence: [`fixture dir: ${dir}`, "Session.children(parent) returns the delegated child with parentID set"],
        })
        record({
          id: "H-8",
          capability: "Background/parallel execution",
          status: "executed",
          parity: "unproven",
          checks: checks.filter((c) => c.name.startsWith("H-8")),
          services: ["BackgroundJob.Service", "TaskTool", "Session.Service"],
          evidence: [
            `fixture dir: ${dir}`,
            "background:true child session runs to completion via BackgroundJob while the parent stays readable",
            "child prompt loop stubbed (TaskPromptOps, shared with H-2): synthesized text part, no nested LLM loop",
            "concurrent multi-session + panel control target-surface parity remains unproven; see references",
          ],
          references: [
            "test/tool/task.test.ts (background task lifecycle suite)",
            "test/kilocode/background-process.test.ts",
          ],
        })

        assertChecks(checks)
      }),
      { git: true, config: config },
    ),
    // Heavy live integration boot (git repo, LLM server, bash tool, snapshots);
    // the default 5s per-test budget flakes under load (same convention as
    // session-prompt-queue.test.ts).
    { timeout: 30_000 },
  )

  // -------------------------------------------------------------------------
  // H-13: internal context-overflow safeguard (LOCK-005)
  // -------------------------------------------------------------------------

  it.live("H-13 internal context-overflow safeguard: detection, mid-session compaction, safety pass", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ dir, llm }) {
        const checks: Check[] = []
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service
        const comp = yield* SessionCompaction.Service
        const cfgService = yield* Config.Service
        const cfg = yield* cfgService.get()

        const mdl = {
          id: "test-model",
          providerID: "test",
          name: "Test",
          limit: { context: 200_000, output: 32_000 },
          cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          capabilities: {
            toolcall: true,
            attachment: false,
            reasoning: false,
            temperature: true,
            input: { text: true, image: false, audio: false, video: false },
            output: { text: true, image: false, audio: false, video: false },
          },
          api: { npm: "@ai-sdk/openai-compatible" },
          options: {},
        } as Provider.Model

        const tok = (input: number) => ({ input, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })

        checks.push(
          yield* run("H-13 overflow detection fires at the real configured threshold boundary", () =>
            Effect.gen(function* () {
              const cap = KiloSessionOverflow.limit({ cfg, model: mdl, usable: usable({ cfg, model: mdl }) })
              expect(cap).toBeGreaterThan(0)
              expect(isOverflow({ cfg, model: mdl, tokens: tok(cap - 1) })).toBe(false)
              expect(isOverflow({ cfg, model: mdl, tokens: tok(cap) })).toBe(true)
            }),
          ),
        )

        checks.push(
          yield* run("H-13 SessionCompaction service makes the same decision with the real Config service", () =>
            Effect.gen(function* () {
              const cap = KiloSessionOverflow.limit({ cfg, model: mdl, usable: usable({ cfg, model: mdl }) })
              expect(yield* comp.isOverflow({ tokens: tok(cap), model: mdl })).toBe(true)
              expect(yield* comp.isOverflow({ tokens: tok(cap - 1), model: mdl })).toBe(false)
            }),
          ),
        )

        checks.push(
          yield* run("H-13 payload measurement normalizes encoded media and flags oversized context", () =>
            Effect.gen(function* () {
              const usage = KiloSessionOverflow.measure({
                messages: [
                  { role: "user", content: [{ type: "image", image: `data:image/png;base64,${"x".repeat(600_000)}` }] },
                ],
                tools: {},
              })
              expect(usage.normalized).toBeLessThan(100)
              expect(usage.raw).toBeGreaterThan(100_000)
              const should = KiloSessionOverflow.shouldCompact({
                cfg,
                model: mdl,
                usable: usable({ cfg, model: mdl }),
                messages: [{ role: "user" as const, content: "x".repeat(600_000) }],
                tools: {},
              })
              expect(should).toBe(true)
            }),
          ),
        )

        checks.push(
          yield* run("H-13 overflow fires mid-session: compaction runs and the session continues", () =>
            Effect.gen(function* () {
              const chat = yield* sessions.create({
                title: "P0 overflow",
                permission: [{ permission: "*", pattern: "*", action: "allow" }],
              })
              const old = yield* userMsg(chat.id, "x".repeat(240_000))
              yield* assistantMsg(chat.id, old.id, { text: "old answer" })
              yield* userMsg(chat.id, "continue after overflow")
              yield* llm.text("compacted history")
              yield* llm.text("final answer")
              const result = yield* prompt.loop({ sessionID: chat.id })
              // Guard compaction + continuation behavior (the compaction
              // summary pass and the continuation answer both happened) rather
              // than a brittle exact call count that can shift with chunking
              // or safety-pass round trips.
              expect(yield* llm.calls).toBeGreaterThanOrEqual(2)
              expect(result.parts.some((p) => p.type === "text" && p.text === "final answer")).toBe(true)
              const msgs = yield* sessions.messages({ sessionID: chat.id })
              expect(msgs.some((m) => m.info.role === "assistant" && m.info.summary === true)).toBe(true)
              const marker = msgs.flatMap((m) => m.parts).find((p) => p.type === "compaction")
              expect(marker?.type).toBe("compaction")
              yield* sessions.remove(chat.id)
            }),
          ),
        )

        checks.push(
          yield* run("H-13 post-compaction safety pass prunes oversized tool outputs on a real session", () =>
            Effect.gen(function* () {
              const s = yield* sessions.create({})
              const u1 = yield* userMsg(s.id, "first question")
              yield* toolPartMsg(s.id, u1.id, "x".repeat(400_000))
              const u2 = yield* userMsg(s.id, "second question")
              yield* assistantMsg(s.id, u2.id, { text: "second answer" })
              const u3 = yield* userMsg(s.id, "third question")
              yield* assistantMsg(s.id, u3.id, { text: "third answer" })
              yield* comp.prune({ sessionID: s.id, reason: "post-compaction" })
              const after = yield* sessions.messages({ sessionID: s.id })
              const tool = after
                .flatMap((m) => m.parts)
                .find((p): p is MessageV2.ToolPart => p.type === "tool" && p.tool === "bash")
              const compacted = tool && tool.state.status === "completed" ? (tool.state.time.compacted ?? 0) : 0
              expect(compacted).toBeGreaterThan(0)
              yield* sessions.remove(s.id)
            }),
          ),
        )

        record({
          id: "H-13",
          capability: "Internal context-overflow safeguard (LOCK-005, invisible reliability)",
          status: "executed",
          parity: "unproven",
          checks,
          services: [
            "KiloSessionOverflow",
            "SessionCompaction.Service",
            "Config.Service",
            "SessionPrompt.Service",
            "Session.Service",
          ],
          evidence: [
            `fixture dir: ${dir}`,
            "real config threshold 70% drives isOverflow/shouldCompact boundaries",
            "mid-session loop: >=2 LLM calls (compaction + continuation), compaction marker + summary present",
            "post-compaction prune marks the oversized tool output compacted",
          ],
        })

        assertChecks(checks)
      }),
      { git: true, config: overflowConfig },
    ),
    // Heavy live integration boot (git repo, LLM server, overflow compaction);
    // the default 5s per-test budget flakes under load (same convention as
    // session-prompt-queue.test.ts).
    { timeout: 30_000 },
  )
})

// ---------------------------------------------------------------------------
// Machine-readable JSON summary (all H ids + lock trace)
// ---------------------------------------------------------------------------

afterAll(() => {
  // The report's outcome and each lock's `respected` derive from the actual
  // check results: a failed run reports `outcome: "fail"`, lists the failing
  // checks, and marks every lock not respected — never unconditional
  // compliance on a failed run.
  const failedChecks = entries.flatMap((entry) => entry.checks.filter((check) => !check.ok))
  const outcome: "pass" | "fail" = failedChecks.length === 0 ? "pass" : "fail"
  const respected = outcome === "pass"
  const report = {
    kind: "p0-harness-baseline",
    version: 1,
    scope: "CLI harness baseline fixture — NOT target-surface parity (specs/vscode-orchestrator §6)",
    outcome,
    failedChecks: failedChecks.map((c) => ({ name: c.name, error: c.error ?? null })),
    locks: [
      {
        id: "LOCK-005",
        respected,
        evidence:
          "H-13 exercises the internal overflow safeguard as invisible reliability; no context-management product surface is claimed.",
      },
      {
        id: "LOCK-007",
        respected,
        evidence:
          "H-12 exercises SessionRevert + Snapshot revert/unrevert semantics; ADR-0001 storage rewriting is out of scope.",
      },
      {
        id: "LOCK-008",
        respected,
        evidence:
          "All harness capabilities are either executed (H-1, H-2, H-7, H-8, H-9, H-10, H-11, H-12, H-13) or recorded as explicit gaps with references (H-3, H-4, H-5, H-6).",
      },
      {
        id: "LOCK-PERF-5",
        respected,
        evidence:
          "Real production services/fixtures only; no core-service mocks, no network dependency, deterministic cleanup.",
      },
    ],
    entries: [...GAPS.map((g) => ({ ...g, checks: [] })), ...entries],
  }
  console.log("\n--- P0_HARNESS_BASELINE_JSON ---")
  console.log(JSON.stringify(report, null, 2))
  console.log("--- END P0_HARNESS_BASELINE_JSON ---\n")
})
