import { describe, expect, it } from "bun:test"
import { decideResponse, SCRIPTED } from "../../script/e2e-scripted-model"

/** OpenAI-style request body with the given last user message and prior transcript. */
function body(lastUser: string, prior: unknown[] = []): Record<string, unknown> {
  return {
    model: "e2e-model",
    messages: [
      { role: "system", content: "system" },
      ...prior,
      { role: "user", content: lastUser },
    ],
  }
}

/** Assistant tool-call entry already present in the transcript (the tool ran). */
function invoked(tool: string, args: unknown = {}): unknown {
  return {
    role: "assistant",
    content: null,
    tool_calls: [{ id: "call_prior", type: "function", function: { name: tool, arguments: JSON.stringify(args) } }],
  }
}

const WS = "/tmp/e2e-workspace"

describe("scripted model decision (no response-order coupling)", () => {
  it("answers title requests with a fixed title", () => {
    const out = decideResponse(
      body("hello", [{ role: "user", content: "Generate a title for this conversation" }]),
      WS,
    )
    expect(out).toContain('"content":"E2E Title"')
    expect(out).toContain('"finish_reason":"stop"')
    expect(out).toContain("data: [DONE]")
  })

  it("H-2: first task marker request emits a real task tool call; the follow-up emits the final text", () => {
    const first = decideResponse(body(`${SCRIPTED.taskMarker}: delegate`), WS)
    expect(first).toContain('"name":"task"')
    expect(first).toContain(SCRIPTED.childMarker)
    expect(first).toContain('"finish_reason":"tool_calls"')
    // The follow-up request carries the assistant tool call in the transcript.
    const follow = decideResponse(body(`${SCRIPTED.taskMarker}: delegate`, [invoked("task")]), WS)
    expect(follow).toContain(`"content":"${SCRIPTED.taskFinal}"`)
    expect(follow).toContain('"finish_reason":"stop"')
  })

  it("H-2: the child session prompt returns the delegated result text", () => {
    const out = decideResponse(body(`${SCRIPTED.childMarker}: produce the marker`), WS)
    expect(out).toContain(`"content":"${SCRIPTED.childResult}"`)
  })

  it("H-3: user tool marker emits the e2e_marker tool call, then the final text", () => {
    const first = decideResponse(body(`${SCRIPTED.userToolMarker}: call`), WS)
    expect(first).toContain(`"name":"${SCRIPTED.userTool}"`)
    const follow = decideResponse(body(`${SCRIPTED.userToolMarker}: call`, [invoked(SCRIPTED.userTool)]), WS)
    expect(follow).toContain(`"content":"${SCRIPTED.userToolFinal}"`)
  })

  it("H-4: skill marker emits the skill tool call with the seeded skill name", () => {
    const first = decideResponse(body(`${SCRIPTED.skillMarker}: load`), WS)
    expect(first).toContain('"name":"skill"')
    expect(first).toContain(SCRIPTED.skillName)
  })

  it("H-5: MCP marker emits the e2e-fixture_e2e_echo tool call", () => {
    const first = decideResponse(body(`${SCRIPTED.mcpMarker}: call`), WS)
    expect(first).toContain(`"name":"${SCRIPTED.mcpTool}"`)
  })

  it("H-6: permission marker emits a read tool call for the run-owned ask.txt", () => {
    const first = decideResponse(body(`${SCRIPTED.permissionMarker}: read`), WS)
    expect(first).toContain('"name":"read"')
    expect(first).toContain(`${WS}/ask.txt`)
  })

  it("H-6: question marker emits the question tool call with the fixed options", () => {
    const first = decideResponse(body(`${SCRIPTED.questionMarker}: ask`), WS)
    expect(first).toContain('"name":"question"')
    expect(first).toContain("Pick an option")
    expect(first).toContain("second")
  })

  it("H-12: edit marker emits a real write tool call for the tracked file, then the final text", () => {
    const first = decideResponse(body(`${SCRIPTED.rollbackMarker}: edit the file`), WS)
    expect(first).toContain('"name":"write"')
    // The write args carry the edited content and the run-owned absolute path
    // (both unescaped in the SSE payload; JSON escaping of the newline is an
    // implementation detail of the chunk serialization, not asserted here).
    expect(first).toContain("E2E_ROLLBACK_EDITED")
    expect(first).toContain(`${WS}/${SCRIPTED.rollbackFile}`)
    expect(first).toContain('"finish_reason":"tool_calls"')
    const follow = decideResponse(body(`${SCRIPTED.rollbackMarker}: edit the file`, [invoked("write")]), WS)
    expect(follow).toContain(`"content":"${SCRIPTED.rollbackFinal}"`)
    expect(follow).toContain('"finish_reason":"stop"')
  })

  it("H-12: the follow-up summary turn returns plain text (no tool)", () => {
    const out = decideResponse(body(`${SCRIPTED.rollbackSummaryMarker}: summarize`), WS)
    expect(out).toContain(`"content":"${SCRIPTED.rollbackSummaryFinal}"`)
    expect(out).not.toContain('"name":"write"')
  })

  it("H-13: the overflow marker's FIRST request returns the large response with usage crossing the cap", () => {
    const out = decideResponse(body(`${SCRIPTED.overflowMarker}: produce a very long answer`), WS)
    expect(out).toContain(SCRIPTED.overflowBig)
    // The reported usage (input+output = 53000) crosses the run-owned cap
    // (limit.context 60000 × threshold_percent 50 = 30000) so the production
    // step-finish overflow check fires.
    expect(out).toContain('"prompt_tokens":45000')
    expect(out).toContain('"completion_tokens":8000')
    expect(out).toContain('"finish_reason":"stop"')
  })

  it("H-13: the compaction summary prompt returns the fixed summary marker", () => {
    const out = decideResponse(
      body("Create a new anchored summary from the conversation history above.\n\nOutput exactly the Markdown structure"),
      WS,
    )
    expect(out).toContain(`"content":"${SCRIPTED.compactionSummary}"`)
  })

  it("H-13: the automatic-continuation instruction returns the fixed continuation answer", () => {
    const out = decideResponse(body(SCRIPTED.continueInstruction), WS)
    expect(out).toContain(`"content":"${SCRIPTED.continuationAnswer}"`)
    expect(out).toContain('"prompt_tokens":100')
  })

  it("H-13: a replayed overflow marker carrying a compaction part returns the continuation (no re-trigger)", () => {
    const withCompaction = body(`${SCRIPTED.overflowMarker}: produce a very long answer`, [
      { role: "assistant", content: "E2E_OVERFLOW_BIG_RESPONSE" },
      {
        role: "user",
        content: null,
        parts: [{ id: "p-c", sessionID: "s", messageID: "m", type: "compaction", auto: true }],
      },
    ])
    const out = decideResponse(withCompaction, WS)
    expect(out).toContain(`"content":"${SCRIPTED.continuationAnswer}"`)
    expect(out).not.toContain(SCRIPTED.overflowBig)
  })

  it("H-13: non-overflow turns keep their small usage and never trip the cap", () => {
    const out = decideResponse(body(`${SCRIPTED.userToolMarker}: call`), WS)
    expect(out).toContain('"name":"e2e_marker"')
  })

  it("answers unknown prompts with the generic default reply", () => {
    const out = decideResponse(body("completely unrelated"), WS)
    expect(out).toContain(`"content":"${SCRIPTED.defaultReply}"`)
  })

  it("matches the LAST user message only (sequential phases in one session)", () => {
    // Phase 2's request still carries phase 1's marker in earlier messages, but
    // the decision must key on the LAST user message.
    const out = decideResponse(
      body(`${SCRIPTED.userToolMarker}: call`, [
        { role: "user", content: `${SCRIPTED.taskMarker}: delegate` },
        { role: "assistant", content: "E2E_TASK_COMPLETED" },
      ]),
      WS,
    )
    expect(out).toContain(`"name":"${SCRIPTED.userTool}"`)
    expect(out).not.toContain('"name":"task"')
  })

  it("real-restart: first request emits the user-tool call, the follow-up emits the final text", () => {
    const first = decideResponse(body(`${SCRIPTED.restartMarker}: call the user tool`), WS)
    expect(first).toContain(`"name":"${SCRIPTED.userTool}"`)
    expect(first).toContain(SCRIPTED.restartToolArg)
    expect(first).toContain('"finish_reason":"tool_calls"')
    // The follow-up request carries the assistant tool call in the transcript.
    const follow = decideResponse(body(`${SCRIPTED.restartMarker}: call the user tool`, [invoked(SCRIPTED.userTool)]), WS)
    expect(follow).toContain(`"content":"${SCRIPTED.restartFinal}"`)
    expect(follow).toContain('"finish_reason":"stop"')
  })
})
