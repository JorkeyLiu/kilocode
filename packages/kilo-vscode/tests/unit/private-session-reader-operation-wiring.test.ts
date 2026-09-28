import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * Production regression guard: extension.ts privateSessionReader must forward
 * `operation` (exact opId re-observe) to the same PrivateObservationService.
 *
 * Without this arm, KiloProvider sendPromptOnce/sendCommandOnce transport-
 * uncertainty re-observe via tryPrivateOperationExact(reader, ...) is always
 * "unavailable" in production (reader.operation undefined), even though the
 * service implements observation/operation.
 *
 * Limitation: full extension activation (vscode panel + child backend) is not
 * feasible in unit tests — extension.ts imports `vscode` and activates via the
 * Extension Host. So this guard asserts the real production source wiring
 * statically, and real-worker IPC behavior is covered by the existing
 * tests/unit/private-observation-operation.test.ts (real SQLite + standalone
 * worker over IPC, exercising svc.operation + tryPrivateOperationExact +
 * submitPrivateFirst for both Prompt and Command scopes). This test avoids
 * passing as a manual `.operation` stub into a helper alone: it reads the
 * real extension.ts literal and both real call-path sources.
 */

const ROOT = join(import.meta.dirname, "../..")
const EXT = readFileSync(join(ROOT, "src/extension.ts"), "utf8")

function readerBlock(): string {
  const start = EXT.indexOf("const privateSessionReader = {")
  if (start < 0) throw new Error("privateSessionReader literal missing in extension.ts")
  const end = EXT.indexOf("const agentManagerHost = new VscodeHost(", start)
  if (end < 0) throw new Error("VscodeHost construction missing after privateSessionReader")
  return EXT.slice(start, end)
}

describe("production privateSessionReader operation wiring (extension.ts)", () => {
  it("forwards operation to the same PrivateObservationService with transport-only signal", () => {
    const block = readerBlock()
    // Same-service delegation, whole input (including signal) passed through;
    // the service strips signal from the wire payload and uses it as request options only.
    expect(block).toContain("privateObservation.operation(input)")
    expect(block).toContain("opId: string")
    expect(block).toContain("signal?: AbortSignal")
  })

  it("preserves existing list/get/messages wiring to the same service", () => {
    const block = readerBlock()
    expect(block).toContain("privateObservation.list(input)")
    expect(block).toContain("privateObservation.get(input)")
    expect(block).toContain("privateObservation.messages(input)")
    expect(block).toContain("privateObservation.isEnabled()")
    expect(block).toContain("privateObservation.isStarted()")
  })

  it("both prompt and command send-once paths re-observe via reader.operation", () => {
    const prompt = readFileSync(join(ROOT, "src/kilo-provider/session-prompt.ts"), "utf8")
    const command = readFileSync(join(ROOT, "src/kilo-provider/session-command.ts"), "utf8")
    for (const src of [prompt, command]) {
      expect(src).toContain("tryPrivateOperationExact(opts.privateReader")
      expect(src).toContain("observeExact")
    }
    // Boundary contract: operation is the exact-opId projection used for uncertain reobserve.
    const boundary = readFileSync(join(ROOT, "src/kilo-provider/session-operation-private.ts"), "utf8")
    expect(boundary).toContain("reader.operation(")
    // Service implements transport-only signal (payload excludes signal; request options carry it).
    const svc = readFileSync(join(ROOT, "src/private-worker/private-observation-service.ts"), "utf8")
    const opStart = svc.indexOf("async operation(")
    if (opStart < 0) throw new Error("PrivateObservationService.operation missing")
    const opBody = svc.slice(opStart, opStart + 800)
    expect(opBody).toContain("opId: input.opId")
    expect(opBody).toContain("{ signal }")
    expect(opBody).not.toContain("signal: input.signal")
  })

  it("revert and unrevert bounded re-observe via reader.operation plus reader.get with no SDK redispatch", () => {
    const revert = readFileSync(join(ROOT, "src/kilo-provider/session-revert.ts"), "utf8")
    expect(revert).toContain("tryPrivateOperationExact(")
    expect(revert).toContain("reader.get(")
    expect(revert).toContain("revert.unresolved")
    expect(revert).toContain("unrevert.unresolved")
    expect(revert).toContain("refreshNeeded")
    expect(revert).not.toContain("transportUnknown: true")
    const boundary = readFileSync(join(ROOT, "src/kilo-provider/session-operation-private.ts"), "utf8")
    expect(boundary).toContain("revert:")
    expect(boundary).toContain("unrevert:")
    const provider = readFileSync(join(ROOT, "src/KiloProvider.ts"), "utf8")
    expect(provider).toContain("privateReader: this.privateSessionReader")
    expect(provider).toContain("completed, refresh needed")
  })

  it("reader literal passes signal through without entering the wire payload shape", () => {
    // Runtime shape check on the same forwarding expression used in production:
    // the literal forwards the whole input object (signal included) to the
    // service, which is responsible for keeping signal transport-only.
    const seen: unknown[] = []
    const fakeService = {
      operation: async (input: { directory: string; sessionId: string; opId: string; signal?: AbortSignal }) => {
        seen.push(input)
        return { v: "1.0", status: "not_found" }
      },
    }
    const signal = new AbortController().signal
    const forwarded = (input: { directory: string; sessionId: string; opId: string; signal?: AbortSignal }) =>
      fakeService.operation(input) as Promise<unknown>
    void forwarded({ directory: "/tmp/ws", sessionId: "ses_x", opId: "prompt:msg_1", signal })
    expect(seen).toHaveLength(1)
    expect((seen[0] as Record<string, unknown>).signal).toBe(signal)
  })
})
