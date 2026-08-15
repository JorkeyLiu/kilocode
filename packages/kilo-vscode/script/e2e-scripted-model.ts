/**
 * Run-owned scripted OpenAI-compatible SSE provider for the real-completed
 * E2E scenario. Runs inside the harness process (script/e2e-probe.ts, Node
 * only) — never bundled into the extension.
 *
 * The seeded custom provider (e2e-local/e2e-model via @ai-sdk/openai-compatible)
 * points its baseURL at this loopback HTTP server, so every REAL model request
 * the served backend makes (title generation, the parent turn, and the
 * delegated child turn) lands here.
 *
 * Determinism contract (no response-order coupling): each request is matched
 * purely on its OWN transcript content —
 *   1. the last user message's marker (E2E_TASK_DELEGATE / E2E_CHILD_TASK /
 *      E2E_USER_TOOL / E2E_SKILL / E2E_MCP_TOOL / E2E_PERMISSION_READ /
 *      E2E_QUESTION / E2E_ROLLBACK_EDIT / E2E_ROLLBACK_SUMMARY), and
 *   2. whether that tool was ALREADY invoked in the transcript (an assistant
 *      message carrying a tool_calls entry for the tool).
 * So a marker's first request emits the tool call, and the follow-up request
 * (after the tool result is in the transcript) emits the final text — with no
 * dependence on the arrival ORDER of interleaved title/child/parent requests.
 * Unknown markers and title requests get fixed generic replies.
 *
 * The tool-call SSE chunk shapes mirror the production wire format the CLI's
 * test LLM server emits (packages/opencode/test/lib/llm-server.ts) so the
 * @ai-sdk/openai-compatible client parses them identically.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { realpathSync } from "node:fs"
import type { Socket } from "node:net"
import { join } from "node:path"

/** Markers + fixed replies shared with the harness assertions (script/e2e-probe.ts). */
export const SCRIPTED = {
  taskMarker: "E2E_TASK_DELEGATE",
  childMarker: "E2E_CHILD_TASK",
  userToolMarker: "E2E_USER_TOOL",
  skillMarker: "E2E_SKILL",
  mcpMarker: "E2E_MCP_TOOL",
  permissionMarker: "E2E_PERMISSION_READ",
  questionMarker: "E2E_QUESTION",
  childResult: "E2E delegated result marker",
  taskFinal: "E2E_TASK_COMPLETED",
  userToolFinal: "E2E_USER_TOOL_COMPLETED",
  skillFinal: "E2E_SKILL_COMPLETED",
  mcpFinal: "E2E_MCP_COMPLETED",
  permissionFinal: "E2E_PERMISSION_COMPLETED",
  questionFinal: "E2E_QUESTION_COMPLETED",
  // H-12 rollback: the file-edit turn (write tool) and the follow-up summary
  // turn (plain text, no tool) so the Revert-to-here boundary covers TWO user
  // turns and the real RevertBanner renders its "Redo All" action (count > 1).
  rollbackMarker: "E2E_ROLLBACK_EDIT",
  rollbackSummaryMarker: "E2E_ROLLBACK_SUMMARY",
  rollbackFile: "rollback.txt",
  rollbackOriginal: "E2E_ROLLBACK_ORIGINAL\n",
  rollbackEdited: "E2E_ROLLBACK_EDITED\n",
  rollbackFinal: "E2E_ROLLBACK_EDIT_COMPLETED",
  rollbackSummaryFinal: "E2E_ROLLBACK_SUMMARY_COMPLETED",
  // H-13 real-overflow: the marker prompt whose FIRST model request returns a
  // deliberately large text response whose reported usage crosses the
  // run-owned compaction cap (custom provider model limit.context ×
  // compaction.threshold_percent), deterministically triggering the production
  // internal context-overflow safeguard (compaction part + summary + automatic
  // continuation) on the SAME turn. The follow-up continuation request (last
  // user = the synthetic "Continue if you have next steps" message, or the
  // marker replayed after a compaction part) returns the fixed continuation
  // answer with SMALL reported usage so the post-compaction turn completes
  // cleanly without re-triggering the safeguard.
  overflowMarker: "E2E_OVERFLOW",
  overflowBig: "E2E_OVERFLOW_BIG_RESPONSE",
  compactionSummary: "E2E_COMPACTION_SUMMARY_MARKER",
  continuationAnswer: "E2E_CONTINUATION_ANSWER",
  // The production auto-continuation instruction after a successful auto
  // compaction (compaction.process → experimental.compaction.autocontinue) —
  // matched on the LAST user message so the continuation request is
  // deterministic regardless of the arrival order of interleaved requests.
  continueInstruction: "Continue if you have next steps",
  // Reported usage (input/output) for the large first response: crosses the
  // cap (limit.context × threshold_percent / 100) even though the preflight
  // payload estimate (system + tools + history) stays below it.
  overflowUsage: { input: 45000, output: 8000 } as const,
  skillName: "e2e-skill",
  skillContentMarker: "E2E_SKILL_CONTENT_MARKER",
  userTool: "e2e_marker",
  userToolArtifact: "e2e-custom-called.txt",
  mcpServer: "e2e-fixture",
  mcpTool: "e2e-fixture_e2e_echo",
  mcpLog: "mcp-fixture/calls.log",
  permissionFile: "ask.txt",
  permissionSentinel: "E2E_PERMISSION_SENTINEL",
  // real-restart: the marker prompt whose first request emits a REAL user-tool
  // call (e2e_marker, writing the run-owned artifact file) and whose follow-up
  // (tool already in the transcript) emits the fixed final text. The final
  // text + artifact + session record are the durable facts asserted across the
  // transport reconnect, the exact worker kill, and the true window/extension
  // restart (all against the SAME run-owned XDG scratch).
  restartMarker: "E2E_RESTART_PROMPT",
  restartFinal: "E2E_RESTART_DONE",
  restartToolArg: "restart",
  title: "E2E Title",
  defaultReply: "E2E default reply",
} as const

export interface ScriptedModelHandle {
  port: number
  /** Every request the backend made (url + parsed body) — harness evidence. */
  requests: Array<{ url: string; body: unknown }>
  close(): Promise<void>
}

// --- SSE wire helpers (chat.completion.chunk stream) ----------------------

function sse(chunk: Record<string, unknown>): string {
  return `data: ${JSON.stringify(chunk)}\n\n`
}

function chatChunk(delta: Record<string, unknown>, finish?: string, usage?: { input: number; output: number }): string {
  const choice: Record<string, unknown> = { delta }
  if (finish) choice.finish_reason = finish
  const out: Record<string, unknown> = { id: "chatcmpl-e2e", object: "chat.completion.chunk", choices: [choice] }
  // H-13: report OpenAI-compatible usage on the terminal chunk exactly like the
  // CLI's test LLM server (packages/opencode/test/lib/llm-server.ts) — the
  // @ai-sdk client parses it into the assistant message tokens that the
  // production overflow check counts.
  if (usage) out.usage = { prompt_tokens: usage.input, completion_tokens: usage.output, total_tokens: usage.input + usage.output }
  return sse(out)
}

const DONE = "data: [DONE]\n\n"

function roleLine(): string {
  return chatChunk({ role: "assistant" })
}

function toolStart(callID: string, name: string): string {
  return chatChunk({ tool_calls: [{ index: 0, id: callID, type: "function", function: { name, arguments: "" } }] })
}

function toolArgs(args: unknown): string {
  return chatChunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] })
}

function textLine(text: string): string {
  return chatChunk({ content: text })
}

function finishLine(reason: string, usage?: { input: number; output: number }): string {
  return chatChunk({}, reason, usage)
}

function toolResponse(callID: string, name: string, args: unknown): string {
  return [roleLine(), toolStart(callID, name), toolArgs(args), finishLine("tool_calls"), DONE].join("\n")
}

function textResponse(text: string, usage?: { input: number; output: number }): string {
  return [roleLine(), textLine(text), finishLine("stop", usage), DONE].join("\n")
}

// --- Content-based matching (deterministic, order-independent) -------------

function messagesOf(body: unknown): unknown[] {
  if (!body || typeof body !== "object") return []
  const messages = (body as { messages?: unknown }).messages
  return Array.isArray(messages) ? messages : []
}

function lastUserText(body: unknown): string {
  const messages = messagesOf(body)
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!m || typeof m !== "object") continue
    const msg = m as { role?: unknown; content?: unknown }
    if (msg.role !== "user") continue
    const content = msg.content
    if (typeof content === "string") return content
    if (Array.isArray(content)) {
      return content
        .map((part) => {
          if (typeof part === "string") return part
          if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
            return (part as { text: string }).text
          }
          return ""
        })
        .join("\n")
    }
  }
  return ""
}

function invokedTool(body: unknown, name: string): boolean {
  return messagesOf(body).some((m) => {
    if (!m || typeof m !== "object") return false
    const msg = m as { role?: unknown; tool_calls?: unknown }
    if (msg.role !== "assistant") return false
    if (!Array.isArray(msg.tool_calls)) return false
    return msg.tool_calls.some((tc) => {
      if (!tc || typeof tc !== "object") return false
      const fn = (tc as { function?: unknown }).function
      return fn && typeof fn === "object" && (fn as { name?: unknown }).name === name
    })
  })
}

/**
 * True when the transcript already carries a compaction part (the user message
 * the served backend writes on auto-compaction). H-13: the first overflow
 * marker request (no compaction part yet) must emit the large response; the
 * replayed/continued request after the safeguard has run carries the part and
 * must emit the fixed continuation answer instead — otherwise the safeguard
 * would re-trigger and exhaust the production compaction attempt guard.
 */
function hasCompactionPart(body: unknown): boolean {
  return messagesOf(body).some((m) => {
    if (!m || typeof m !== "object") return false
    const msg = m as { parts?: unknown }
    if (!Array.isArray(msg.parts)) return false
    return msg.parts.some((p) => p && typeof p === "object" && (p as { type?: unknown }).type === "compaction")
  })
}

/** H-13: the compaction summary request's terminal user message (buildPrompt). */
function isCompactionPrompt(text: string): boolean {
  return text.includes("Create a new anchored summary from the conversation history above") ||
    text.includes("Update the anchored summary below using the conversation history above")
}

function isTitleRequest(body: unknown): boolean {
  try {
    return JSON.stringify(body).includes("Generate a title for this conversation")
  } catch {
    return false
  }
}

/**
 * The backend instance realpaths every request directory (FSUtil.resolve →
 * realpathSync), so the run-owned workspace under macOS's `/var → /private/var`
 * symlink resolves to `/private/var/...` in the instance worktree. A real model
 * sees those realpath forms in its environment block and emits them. The
 * harness workspace path (`/var/folders/...`) is the symlink form, so emitting
 * it verbatim would make the write tool's permission pattern and the
 * external-directory containment check miss the worktree (path.relative across
 * the symlink yields `../../../var/...`, never `rollback.txt`) and stall the
 * turn on a pending external_directory ask. Resolve the workspace to its
 * canonical form exactly like the backend does; the unit tests pass a
 * non-existent path, so fall back to the input on resolution failure.
 */
function canonicalWorkspace(workspace: string): string {
  try {
    return realpathSync(workspace)
  } catch {
    return workspace
  }
}

// --- Decision table --------------------------------------------------------

/**
 * Pure decision: the deterministic SSE body for one request. Exported for the
 * focused unit tests; the HTTP server uses it verbatim.
 */
export function decideResponse(body: unknown, workspace: string): string {
  if (isTitleRequest(body)) return textResponse(SCRIPTED.title)
  const text = lastUserText(body)
  // Realpath the workspace once so every emitted file path is in the same
  // canonical form the backend instance uses (see canonicalWorkspace).
  const ws = canonicalWorkspace(workspace)

  if (text.includes(SCRIPTED.taskMarker)) {
    if (invokedTool(body, "task")) return textResponse(SCRIPTED.taskFinal)
    return toolResponse("call_e2e_task_1", "task", {
      description: "E2E read-only reply sub-task",
      // Explicit, closed-scope, read-only instruction: the sub-agent must not
      // use any tool and must reply with a fixed text string, so no permission
      // prompt can ever be triggered inside the delegated child.
      prompt: `${SCRIPTED.childMarker}: Reply with exactly this text and nothing else. Do not use any tools, do not read any files: E2E delegated result marker`,
      subagent_type: "general",
    })
  }
  if (text.includes(SCRIPTED.childMarker)) return textResponse(SCRIPTED.childResult)

  if (text.includes(SCRIPTED.userToolMarker)) {
    if (invokedTool(body, SCRIPTED.userTool)) return textResponse(SCRIPTED.userToolFinal)
    return toolResponse("call_e2e_marker_1", SCRIPTED.userTool, { message: "hello" })
  }
  if (text.includes(SCRIPTED.skillMarker)) {
    if (invokedTool(body, "skill")) return textResponse(SCRIPTED.skillFinal)
    return toolResponse("call_e2e_skill_1", "skill", { name: SCRIPTED.skillName })
  }
  if (text.includes(SCRIPTED.mcpMarker)) {
    if (invokedTool(body, SCRIPTED.mcpTool)) return textResponse(SCRIPTED.mcpFinal)
    return toolResponse("call_e2e_mcp_1", SCRIPTED.mcpTool, { message: "hi" })
  }
  if (text.includes(SCRIPTED.permissionMarker)) {
    if (invokedTool(body, "read")) return textResponse(SCRIPTED.permissionFinal)
    return toolResponse("call_e2e_read_1", "read", { filePath: join(ws, SCRIPTED.permissionFile) })
  }
  if (text.includes(SCRIPTED.questionMarker)) {
    if (invokedTool(body, "question")) return textResponse(SCRIPTED.questionFinal)
    return toolResponse("call_e2e_question_1", "question", {
      questions: [
        {
          question: "Pick an option",
          header: "Pick",
          options: [
            { label: "A", description: "first" },
            { label: "B", description: "second" },
          ],
        },
      ],
    })
  }
  // H-12 rollback: the edit turn emits a REAL `write` tool call against the
  // run-owned tracked file (production tool, absolute path resolved to the
  // workspace, matching the seeded `edit` allow rule "rollback.txt"), and the
  // follow-up request (write already in the transcript) emits the final text.
  if (text.includes(SCRIPTED.rollbackMarker)) {
    if (invokedTool(body, "write")) return textResponse(SCRIPTED.rollbackFinal)
    return toolResponse("call_e2e_rollback_1", "write", {
      filePath: join(ws, SCRIPTED.rollbackFile),
      content: SCRIPTED.rollbackEdited,
    })
  }
  // H-12 rollback: the second turn is a plain-text summary (no tool) so the
  // revert boundary covers two user turns and "Redo All" renders.
  if (text.includes(SCRIPTED.rollbackSummaryMarker)) return textResponse(SCRIPTED.rollbackSummaryFinal)

  // real-restart: first request emits the user-tool call (writes the durable
  // artifact), the follow-up (tool already invoked) emits the fixed final text
  // the harness asserts after every restart boundary.
  const restart = restartOrUndefined(body, text)
  if (restart) return restart

  const overflow = overflowOrContinuation(body, text)
  if (overflow) return overflow

  return textResponse(SCRIPTED.defaultReply)
}

/**
 * real-restart decision branch, extracted to keep decideResponse under the
 * lint complexity cap. Returns the deterministic SSE body for the restart
 * marker request — the user-tool call on first sight, the fixed final text
 * once the tool is in the transcript — or undefined when unrelated.
 */
function restartOrUndefined(body: unknown, text: string): string | undefined {
  if (!text.includes(SCRIPTED.restartMarker)) return undefined
  if (invokedTool(body, SCRIPTED.userTool)) return textResponse(SCRIPTED.restartFinal)
  return toolResponse("call_e2e_restart_1", SCRIPTED.userTool, { message: SCRIPTED.restartToolArg })
}

/**
 * H-13 real-overflow decision branches, extracted to keep decideResponse under
 * the lint complexity cap. Returns the deterministic SSE body for the three
 * production requests the internal context-overflow safeguard generates, or
 * undefined when the request is unrelated:
 *
 *   1. the compaction summary request — the production buildPrompt ("Create a
 *      new anchored summary from the conversation history above." / "Update
 *      the anchored summary below...") is the terminal user message; returns
 *      the fixed summary marker the harness asserts in the panel and in the
 *      served-backend snapshot,
 *   2. the automatic-continuation request — the production
 *      "Continue if you have next steps" instruction is the terminal user
 *      message; returns the fixed continuation answer with SMALL reported
 *      usage so the post-compaction turn completes without re-triggering the
 *      safeguard,
 *   3. the overflow marker prompt — the FIRST request (no compaction part in
 *      the transcript yet) returns the deliberately large response whose
 *      reported usage crosses the run-owned cap (limit.context ×
 *      threshold_percent / 100), deterministically driving the safeguard; a
 *      follow-up carrying a compaction part (a replayed marker after the
 *      safeguard) returns the continuation answer instead, so a replay never
 *      re-triggers the safeguard.
 */
function overflowOrContinuation(body: unknown, text: string): string | undefined {
  if (isCompactionPrompt(text)) return textResponse(SCRIPTED.compactionSummary, { input: 20, output: 5 })
  if (text.includes(SCRIPTED.continueInstruction)) {
    return textResponse(SCRIPTED.continuationAnswer, { input: 100, output: 20 })
  }
  if (!text.includes(SCRIPTED.overflowMarker)) return undefined
  if (hasCompactionPart(body)) return textResponse(SCRIPTED.continuationAnswer, { input: 100, output: 20 })
  const big = `${SCRIPTED.overflowBig} ${"x".repeat(2000)}`
  return textResponse(big, SCRIPTED.overflowUsage)
}

// --- HTTP server -----------------------------------------------------------

function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  return new Promise((resolve) => {
    req.on("data", (c: Buffer) => chunks.push(c))
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    req.on("error", () => resolve(""))
  })
}

export async function createScriptedModel(workspace: string): Promise<ScriptedModelHandle> {
  const requests: Array<{ url: string; body: unknown }> = []
  const sockets = new Set<Socket>()
  const server = createServer(async (req, res: ServerResponse) => {
    const raw = await readBody(req)
    let body: unknown = {}
    try {
      body = raw ? JSON.parse(raw) : {}
    } catch {
      body = { parseError: raw.slice(0, 500) }
    }
    requests.push({ url: req.url ?? "", body })
    if (req.method !== "POST" || !(req.url ?? "").endsWith("/chat/completions")) {
      res.writeHead(404, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: "scripted model: not found" }))
      return
    }
    const out = decideResponse(body, workspace)
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    })
    res.end(out)
  })
  server.on("connection", (socket: Socket) => {
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address !== "object") {
    server.close()
    throw new Error("scripted model: address unavailable")
  }
  return {
    port: address.port,
    requests,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
