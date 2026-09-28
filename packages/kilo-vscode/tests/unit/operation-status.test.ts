import { describe, expect, it } from "bun:test"
import { isRuntimeRestartAbandoned, operationRecoveryText, operationStatusText, operationStatusTone, RUNTIME_RESTART_TEXT } from "../../webview-ui/agent-manager/operation-status-helpers"
import type { PanelOperation } from "../../src/types/messages/agent-manager"

function op(over: Partial<PanelOperation> & Pick<PanelOperation, "outcome" | "code" | "message" | "opId">): PanelOperation {
  return { time: 1, ...over } as PanelOperation
}

describe("OperationStatus mapping", () => {
  it("in-flight shows Running and running tone", () => {
    const o = op({ opId: "o1", outcome: "in-flight", code: "C", message: "m" })
    expect(operationStatusText(o)).toBe("Running")
    expect(operationStatusTone(o)).toBe("running")
  })

  it("failed shows code and message with error tone", () => {
    const o = op({ opId: "o1", outcome: "failed", code: "E_FOO", message: "boom" })
    expect(operationStatusText(o)).toBe("Failed · E_FOO: boom")
    expect(operationStatusTone(o)).toBe("error")
  })

  it("abandoned shows Cancelled with source and cancelled tone", () => {
    const o = op({ opId: "o1", outcome: "abandoned", code: "C", message: "m", cancel: { source: "user_stop" } })
    expect(operationStatusText(o)).toBe("Cancelled · user_stop")
    expect(operationStatusTone(o)).toBe("cancelled")
  })

  it("abandoned without source shows Cancelled", () => {
    const o = op({ opId: "o1", outcome: "abandoned", code: "C", message: "m" })
    expect(operationStatusText(o)).toBe("Cancelled")
  })

  it("succeeded is hidden (undefined text, neutral tone)", () => {
    const o = op({ opId: "o1", outcome: "succeeded", code: "C", message: "m" })
    expect(operationStatusText(o)).toBeUndefined()
    // component renders Show when text(), so succeeded yields no DOM
  })

  it("succeeded hidden even with detail/stack present (projection never exposes them)", () => {
    const o = {
      opId: "o1",
      outcome: "succeeded",
      code: "C",
      message: "m",
      time: 1,
      detail: "secret detail",
      stack: "trace",
    } as unknown as PanelOperation
    expect(operationStatusText(o)).toBeUndefined()
    // ensure text does not leak detail/stack
    const text = operationStatusText(op({ opId: "o2", outcome: "failed", code: "E", message: "boom" }) as PanelOperation)
    expect(text).not.toContain("secret")
    expect(text).not.toContain("trace")
  })

  it("never exposes detail/stack even if present on failed op", () => {
    const o = {
      opId: "o1",
      outcome: "failed",
      code: "E",
      message: "boom",
      time: 1,
      detail: "sensitive detail",
      stack: "sensitive stack",
    } as unknown as PanelOperation
    const txt = operationStatusText(o)
    expect(txt).toBe("Failed · E: boom")
    expect(txt).not.toContain("sensitive")
    expect(txt).not.toContain("detail")
    expect(txt).not.toContain("stack")
  })

  it("ambiguous and superseded map correctly, undefined op yields undefined", () => {
    expect(operationStatusText(op({ opId: "o1", outcome: "ambiguous", code: "C", message: "m" }))).toBe("Ambiguous")
    expect(operationStatusText(op({ opId: "o1", outcome: "superseded", code: "C", message: "m" }))).toBe("Superseded")
    expect(operationStatusText(undefined)).toBeUndefined()
    expect(operationStatusTone(undefined)).toBe("neutral")
  })

  it("operation-status display unchanged with recovery present; recovery text is concise owner status", () => {
    const recOpen = { v: 1, owner: "generation", scope: "ses_a", used: 1, limit: 2, terminated: false, nextAt: 5, retryOccurrence: 4, layer: "provider", closeReason: null, replay: false } as const
    const recClosed = { ...recOpen, used: 2, terminated: true, nextAt: null, closeReason: "crash" } as const
    const failedNoRec = op({ opId: "o1", outcome: "failed", code: "E_FOO", message: "boom" })
    const failedWithRec = op({ opId: "o1", outcome: "failed", code: "E_FOO", message: "boom", recovery: recOpen as never })
    expect(operationStatusText(failedWithRec)).toBe(operationStatusText(failedNoRec))
    expect(operationStatusTone(failedWithRec)).toBe(operationStatusTone(failedNoRec))
    expect(operationRecoveryText(failedWithRec)).toBe("retries 1/2")
    expect(operationRecoveryText(failedNoRec)).toBeUndefined()

    const abandonedNoRec = op({ opId: "o2", outcome: "abandoned", code: "C", message: "m", cancel: { source: "timeout" } })
    const abandonedWithRec = op({ opId: "o2", outcome: "abandoned", code: "C", message: "m", cancel: { source: "timeout" }, recovery: recClosed as never })
    expect(operationStatusText(abandonedWithRec)).toBe(operationStatusText(abandonedNoRec))
    expect(operationStatusTone(abandonedWithRec)).toBe(operationStatusTone(abandonedNoRec))
    expect(operationRecoveryText(abandonedWithRec)).toBe("retries 2/2 · closed")

    const inflightNoRec = op({ opId: "o3", outcome: "in-flight", code: "C", message: "m" })
    const inflightWithRec = { ...inflightNoRec, recovery: recOpen } as unknown as PanelOperation
    // in-flight with recovery is invalid panel fact but helper must ignore recovery for display
    expect(operationStatusText(inflightWithRec)).toBe("Running")
    expect(operationStatusTone(inflightWithRec)).toBe("running")
    expect(operationRecoveryText(inflightWithRec)).toBeUndefined()

    const succeededNoRec = op({ opId: "o4", outcome: "succeeded", code: "C", message: "m" })
    const succeededWithRec = { ...succeededNoRec, recovery: recClosed } as unknown as PanelOperation
    expect(operationStatusText(succeededWithRec)).toBeUndefined()
    expect(operationStatusTone(succeededWithRec)).toBe("neutral")
    expect(operationRecoveryText(succeededWithRec)).toBeUndefined()
  })

  it("recovery text never leaks layer/timestamps/diagnostics", () => {
    const rec = { v: 1, owner: "generation", scope: "ses_a", used: 1, limit: 2, terminated: false, nextAt: 555, retryOccurrence: 444, layer: "broker", closeReason: null, replay: false } as const
    const txt = operationRecoveryText(op({ opId: "o1", outcome: "failed", code: "E", message: "m", recovery: rec as never }))
    expect(txt).toBe("retries 1/2")
    expect(txt).not.toContain("broker")
    expect(txt).not.toContain("555")
    expect(txt).not.toContain("444")
  })

  it("runtime-restart crash abandoned shows fixed restart text with neutral tone", () => {
    const prompt = op({ opId: "prompt:msg_a", outcome: "abandoned", code: "prompt.abandoned", message: "prompt abandoned due to runtime restart" })
    expect(isRuntimeRestartAbandoned(prompt)).toBe(true)
    expect(operationStatusText(prompt)).toBe(RUNTIME_RESTART_TEXT)
    expect(operationStatusText(prompt)).toBe("Stopped after runtime restart")
    expect(operationStatusTone(prompt)).toBe("neutral")
    const provider = op({ opId: "provider:msg_a:0", outcome: "abandoned", code: "provider.abandoned", message: "Provider attempt abandoned after runtime restart" })
    expect(isRuntimeRestartAbandoned(provider)).toBe(true)
    expect(operationStatusText(provider)).toBe("Stopped after runtime restart")
    expect(operationStatusTone(provider)).toBe("neutral")
  })

  it("generic cancellation and scope shutdown stay Cancelled with cancelled tone", () => {
    const user = op({ opId: "o1", outcome: "abandoned", code: "prompt.abandoned", message: "prompt abandoned", cancel: { source: "user_stop" } })
    expect(isRuntimeRestartAbandoned(user)).toBe(false)
    expect(operationStatusText(user)).toBe("Cancelled · user_stop")
    expect(operationStatusTone(user)).toBe("cancelled")
    const shutdown = op({ opId: "o2", outcome: "abandoned", code: "prompt.abandoned", message: "prompt abandoned due to scope shutdown" })
    expect(isRuntimeRestartAbandoned(shutdown)).toBe(false)
    expect(operationStatusText(shutdown)).toBe("Cancelled")
    expect(operationStatusTone(shutdown)).toBe("cancelled")
    const live = op({ opId: "provider:m:0", outcome: "abandoned", code: "provider.abandoned", message: "provider request abandoned", cancel: { source: "user_stop" } })
    expect(isRuntimeRestartAbandoned(live)).toBe(false)
    expect(operationStatusText(live)).toBe("Cancelled · user_stop")
    expect(operationStatusTone(live)).toBe("cancelled")
  })

  it("crash decision ignores recovery absence and never implies owner; malicious near-miss stays Cancelled", () => {
    const crashNoRecovery = op({ opId: "prompt:msg_a", outcome: "abandoned", code: "prompt.abandoned", message: "prompt abandoned due to runtime restart" })
    expect(operationRecoveryText(crashNoRecovery)).toBeUndefined()
    expect(operationStatusText(crashNoRecovery)).toBe("Stopped after runtime restart")
    const manualNoRecovery = op({ opId: "prompt:msg_b", outcome: "abandoned", code: "prompt.abandoned", message: "prompt abandoned" })
    expect(operationRecoveryText(manualNoRecovery)).toBeUndefined()
    expect(operationStatusText(manualNoRecovery)).toBe("Cancelled")
    const evil = [
      "prompt abandoned due to runtime restart ",
      " prompt abandoned due to runtime restart",
      "PROMPT ABANDONED DUE TO RUNTIME RESTART",
      "prompt abandoned due to runtime restart\ninjected",
      "Provider attempt abandoned after runtime restart!",
    ]
    for (const message of evil) {
      const code = message.startsWith("Provider") ? "provider.abandoned" : "prompt.abandoned"
      const o = op({ opId: "o9", outcome: "abandoned", code, message })
      expect(isRuntimeRestartAbandoned(o)).toBe(false)
      expect(operationStatusText(o)).toBe("Cancelled")
      expect(operationStatusTone(o)).toBe("cancelled")
    }
    const swapped = op({ opId: "o10", outcome: "abandoned", code: "prompt.abandoned", message: "Provider attempt abandoned after runtime restart" })
    expect(isRuntimeRestartAbandoned(swapped)).toBe(false)
    expect(operationStatusText(swapped)).toBe("Cancelled")
  })

  it("crash text is closed and crash cancel source never leaks into title", () => {
    const crashWithCancel = op({ opId: "prompt:msg_a", outcome: "abandoned", code: "prompt.abandoned", message: "prompt abandoned due to runtime restart", cancel: { source: "user_stop" } })
    expect(operationStatusText(crashWithCancel)).toBe("Stopped after runtime restart")
    expect(operationStatusText(crashWithCancel)).not.toContain("user_stop")
    expect(operationStatusText(crashWithCancel)).not.toContain("prompt abandoned due to")
  })
})
