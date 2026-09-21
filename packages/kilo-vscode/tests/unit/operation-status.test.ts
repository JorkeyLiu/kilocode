import { describe, expect, it } from "bun:test"
import { operationStatusText, operationStatusTone } from "../../webview-ui/agent-manager/operation-status-helpers"
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
})
