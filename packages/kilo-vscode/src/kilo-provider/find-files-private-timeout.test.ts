import { describe, expect, test } from "bun:test"
import { attemptFindFilesPrivate, buildFindFilesReq, FIND_FILES_PRIVATE_TIMEOUT_MS } from "./find-files-private"

// Dedicated 3s exact-cancel budget: fast 10ms overrides prove the ownership
// behavior without waiting on the production default, while the default value
// itself is asserted separately so the main matrix stays under default test
// budgets.
describe("find-files private-authority timeout ownership", () => {
  test("production default stays exact 3s", () => {
    expect(FIND_FILES_PRIVATE_TIMEOUT_MS).toBe(3000)
  })

  test("timeout exact-cancels the pending with the op identity", async () => {
    const r = buildFindFilesReq("/tmp", "hello", "file", 50)
    let cancelled: string | undefined
    let cancelledId = 0
    const out = await attemptFindFilesPrivate(
      {
        isPrivateAvailable: () => true,
        privateFindFilesOutcomeWithHandle: () => ({
          id: 7,
          promise: new Promise(() => {}),
          cancel: (msg?: string) => {
            cancelled = msg
            cancelledId = 7
            return true
          },
        }),
      } as never,
      r,
      10,
    )
    expect(out).toEqual({ kind: "unavailable", reason: "timeout" })
    expect(cancelled).toContain(r.opId)
    expect(cancelledId).toBe(7)
  })

  test("stale cancel is contained as timeout unavailable", async () => {
    const r = buildFindFilesReq("/tmp", "hello", "file", 50)
    const out = await attemptFindFilesPrivate(
      {
        isPrivateAvailable: () => true,
        privateFindFilesOutcomeWithHandle: () => ({
          id: 9,
          promise: new Promise(() => {}),
          cancel: () => "stale" as const,
        }),
      } as never,
      r,
      10,
    )
    expect(out).toEqual({ kind: "unavailable", reason: "timeout" })
  })
})
