import { describe, expect, test } from "bun:test"
import {
  FD_REVERSE_CAPABILITIES_MAX_COUNT,
  FD_REVERSE_CAPABILITY_MAX_LENGTH,
  FD_PROTOCOL_NAME,
  validateInitialize,
} from "../../../src/kilocode/server/fd-carrier-protocol"

function base(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocol: { name: FD_PROTOCOL_NAME, major: 1, minor: 0 },
    clientInfo: { name: "kilo-vscode", version: "7.4.11" },
    ...overrides,
  }
}

describe("fd initialize reverse capabilities", () => {
  test("missing reverse offer normalizes to empty", () => {
    const out = validateInitialize(base())
    expect(out.reverseCapabilities).toEqual([])
  })

  test("legacy capabilities populated but reverse missing stays empty", () => {
    const out = validateInitialize(base({ capabilities: ["session/cancelQueued", "session/update"] }))
    expect(out.reverseCapabilities).toEqual([])
  })

  test("valid and unknown reverse offers are kept forward-compatible", () => {
    const out = validateInitialize(base({ reverseCapabilities: ["test/echo", "future/method"] }))
    expect([...out.reverseCapabilities]).toEqual(["test/echo", "future/method"])
  })

  test("duplicate entries fail InvalidParams", () => {
    let err: unknown
    try {
      validateInitialize(base({ reverseCapabilities: ["a", "a"] }))
    } catch (e) {
      err = e
    }
    expect(err).toBeDefined()
    expect((err as { code?: number }).code).toBe(-32602)
  })

  test("malformed offers fail InvalidParams", () => {
    const bad: unknown[] = [1, null, "", ["nested"], { m: 1 }]
    for (const entry of bad) {
      let err: unknown
      try {
        validateInitialize(base({ reverseCapabilities: [entry] }))
      } catch (e) {
        err = e
      }
      expect(err).toBeDefined()
      expect((err as { code?: number }).code).toBe(-32602)
    }
    let nonArray: unknown
    try {
      validateInitialize(base({ reverseCapabilities: "test/echo" }))
    } catch (e) {
      nonArray = e
    }
    expect((nonArray as { code?: number }).code).toBe(-32602)
    let nul: unknown
    try {
      validateInitialize(base({ reverseCapabilities: ["a\0b"] }))
    } catch (e) {
      nul = e
    }
    expect((nul as { code?: number }).code).toBe(-32602)
  })

  test("reserved names are rejected", () => {
    for (const name of ["initialize", "$/cancelRequest", "$/progress"]) {
      let err: unknown
      try {
        validateInitialize(base({ reverseCapabilities: [name] }))
      } catch (e) {
        err = e
      }
      expect((err as { code?: number }).code).toBe(-32602)
    }
  })

  test("excessively long entry and too many entries fail", () => {
    let long: unknown
    try {
      validateInitialize(base({ reverseCapabilities: ["x".repeat(FD_REVERSE_CAPABILITY_MAX_LENGTH + 1)] }))
    } catch (e) {
      long = e
    }
    expect((long as { code?: number }).code).toBe(-32602)
    let many: unknown
    try {
      validateInitialize(
        base({
          reverseCapabilities: Array.from({ length: FD_REVERSE_CAPABILITIES_MAX_COUNT + 1 }, (_, i) => `m/${i}`),
        }),
      )
    } catch (e) {
      many = e
    }
    expect((many as { code?: number }).code).toBe(-32602)
  })

  test("protocol validation still enforced in the one-shot call", () => {
    let err: unknown
    try {
      validateInitialize(base({ protocol: { name: FD_PROTOCOL_NAME, major: 2, minor: 0 } }))
    } catch (e) {
      err = e
    }
    expect((err as { code?: number }).code).toBe(-32602)
  })

  test("cross-endpoint contract pins limits (extension mirrors 64/128)", () => {
    // The extension keeps its own constants; both sides pin 64/128 so a
    // drift breaks this test and the vscode contract test together.
    expect(FD_REVERSE_CAPABILITIES_MAX_COUNT).toBe(64)
    expect(FD_REVERSE_CAPABILITY_MAX_LENGTH).toBe(128)
  })
})
