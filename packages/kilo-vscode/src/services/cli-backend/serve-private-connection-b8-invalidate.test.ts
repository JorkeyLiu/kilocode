import { describe, expect, test } from "bun:test"
import { KiloConnectionService } from "./connection-service"

const CHILDREN_REASONS = [
  "children stale observer timeout",
  "children observer timeout cancel throw",
  "children observer timeout exact cancel miss",
  "children observer timeout",
]

describe("B8 connection invalidate sanitizes children reasons", () => {
  test("children timeout reason never emits raw reason or epoch", async () => {
    const warns: unknown[][] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warns.push(args)
    }
    try {
      for (const reason of CHILDREN_REASONS) {
        const svc = new KiloConnectionService({} as never) as unknown as Record<string, unknown>
        const seen: string[] = []
        svc.privatePeer = {
          invalidateOnObserverTimeout: (r: string) => {
            seen.push(r)
          },
        }
        svc.privateAvailable = true
        svc.privateEpoch = 7
        warns.length = 0
        ;(svc as unknown as { invalidatePrivatePeerOnObserverTimeout: (r: string) => void }).invalidatePrivatePeerOnObserverTimeout(reason)
        expect(seen).toEqual([reason])
        const text = warns.map((w) => JSON.stringify(w)).join(" ")
        expect(text.includes(reason)).toBeFalse()
        expect(text.includes("7")).toBeFalse()
        expect(text.includes("invalidates epoch")).toBeFalse()
        expect(text.includes("session/children")).toBeTrue()
        expect(text.includes("invalidated")).toBeTrue()
        try {
          ;(svc as unknown as { dispose: () => void }).dispose()
        } catch {}
      }
    } finally {
      console.warn = origWarn
    }
  })

  test("children dispose throw never emits raw error text", async () => {
    const warns: unknown[][] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warns.push(args)
    }
    try {
      const secret = "ses_child-secret-xyz-opaque"
      const svc = new KiloConnectionService({} as never) as unknown as Record<string, unknown>
      svc.privatePeer = {
        invalidateOnObserverTimeout: () => {
          throw new Error(`boom ${secret}`)
        },
      }
      svc.privateAvailable = true
      svc.privateEpoch = 7
      warns.length = 0
      ;(svc as unknown as { invalidatePrivatePeerOnObserverTimeout: (r: string) => void }).invalidatePrivatePeerOnObserverTimeout("children observer timeout exact cancel miss")
      const text = warns.map((w) => JSON.stringify(w)).join(" ")
      expect(text.includes(secret)).toBeFalse()
      expect(text.includes("boom")).toBeFalse()
      expect(text.includes("session/children")).toBeTrue()
      expect(text.includes("invalidateFailed")).toBeTrue()
      try {
        ;(svc as unknown as { dispose: () => void }).dispose()
      } catch {}
    } finally {
      console.warn = origWarn
    }
  })
})
