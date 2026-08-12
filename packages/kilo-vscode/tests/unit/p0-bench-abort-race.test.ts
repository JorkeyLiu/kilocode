import { describe, expect, it } from "bun:test"
import { raceGuardAbort } from "../../script/p0-bench/sample"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Mirrors the run-owned guard's abort promise (rejects with this on breach). */
class GuardAbortError extends Error {
  constructor() {
    super("memory-guard-abort")
    this.name = "GuardAbortError"
  }
}

describe("raceGuardAbort (session-switch waits vs memory-guard abort)", () => {
  it("surfaces the guard breach immediately while the action is still pending", async () => {
    const action = deferred<void>()
    const abort = deferred<never>()
    const outcome = raceGuardAbort(action.promise, abort.promise).then(
      () => "resolved",
      () => "aborted",
    )
    // The guard breach settles the race before the Playwright wait/click
    // timeout; the action promise is never settled.
    abort.reject(new GuardAbortError())
    await expect(outcome).resolves.toBe("aborted")
  })

  it("resolves with the action result when the action wins the race", async () => {
    const action = deferred<string>()
    const abort = deferred<never>()
    const raced = raceGuardAbort(action.promise, abort.promise)
    action.resolve("clicked")
    await expect(raced).resolves.toBe("clicked")
  })

  it("propagates the action's own failure (e.g. a Playwright timeout)", async () => {
    const action = deferred<string>()
    const abort = deferred<never>()
    const raced = raceGuardAbort(action.promise, abort.promise)
    action.reject(new Error("waitFor timeout: 10000ms exceeded"))
    await expect(raced).rejects.toThrow("waitFor timeout")
  })
})
