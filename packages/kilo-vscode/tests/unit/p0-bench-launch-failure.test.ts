import { describe, expect, it } from "bun:test"
import { blockedSampleForFailure, launchFailureSignal } from "../../script/p0-bench/sample"
import type { Condition, SampleEnv } from "../../script/p0-bench/types"

/**
 * Regression tests for the P0 harness launch-failure handling:
 *   - vscodeRun is observed at creation (launchFailureSignal), so an early
 *     runTests rejection (e.g. the extension host fails to launch because a
 *     seeded config is invalid) can never become an unhandled rejection that
 *     crashes the probe before the campaign finish and cleanup.
 *   - the launch failure wins the drive race (fail-fast bounded blocked
 *     sample) instead of waiting out the CDP/ready timeouts.
 *   - a lifecycle launch failure yields at least one bounded blocked sample
 *     even when no normal sample exists (blockedSampleForFailure).
 */

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const env: SampleEnv = {
  os: "darwin",
  arch: "arm64",
  node: "v22.0.0",
  vscode: "1.90.0",
  extension: "0.1.0",
  gitHead: "abc1234",
  gitCommit: "abc1234".padEnd(40, "0"),
  gitDirty: true,
  backendCli: "/ws/packages/kilo-vscode/bin/kilo",
}

const condition: Condition = {
  id: "custom-provider",
  configSeeded: true,
  agents: 0,
  providers: 1,
  mcp: null,
  note: "seeded custom provider fixture",
}

describe("launchFailureSignal (vscodeRun observed at creation)", () => {
  it("rejects with the launch error when runTests rejects", async () => {
    const launch = deferred<number>()
    const signal = launchFailureSignal(launch.promise)
    launch.reject(new Error("TestRunFailedError: test run failed"))
    await expect(signal).rejects.toThrow("TestRunFailedError")
  })

  it("never settles when the launch resolves (the drive decides)", async () => {
    const launch = deferred<number>()
    const signal = launchFailureSignal(launch.promise)
    let settled = false
    void signal.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )
    launch.resolve(0)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(settled).toBe(false)
  })

  it("launch failure wins the drive race over a pending drive (fail-fast bounded path)", async () => {
    const launch = deferred<number>()
    const drive = new Promise<never>(() => {}) // pending drive that would wait out the CDP timeout
    const raced = Promise.race([drive, launchFailureSignal(launch.promise)])
    launch.reject(new Error("launch failed"))
    await expect(raced).rejects.toThrow("launch failed")
  })

  it("drive wins the race on a successful launch", async () => {
    const launch = deferred<number>()
    const drive = deferred<string>()
    const raced = Promise.race([drive.promise, launchFailureSignal(launch.promise)])
    launch.resolve(0)
    drive.resolve("done")
    await expect(raced).resolves.toBe("done")
  })

  it("a late launch rejection after the drive settled is still observed (no unhandled rejection)", async () => {
    const launch = deferred<number>()
    const drive = deferred<string>()
    const raced = Promise.race([drive.promise, launchFailureSignal(launch.promise)])
    drive.resolve("done")
    await expect(raced).resolves.toBe("done")
    // The launch rejects AFTER the race settled; the race already attached a
    // handler, so this must not surface as an unhandled rejection.
    launch.reject(new Error("late launch failure"))
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
})

describe("blockedSampleForFailure (no-sample fallback)", () => {
  it("produces one bounded blocked sample when no normal sample exists", () => {
    const out = blockedSampleForFailure(
      new Error("runTests rejected: extension host failed to launch"),
      1,
      "custom-provider",
      condition,
      1,
      1000,
      env,
    )
    expect(out.sample.ok).toBe(false)
    expect(out.sample.blocked).not.toBeNull()
    expect(out.sample.blocked?.reason).toBe("runTests rejected: extension host failed to launch")
    expect(out.sample.failures.length).toBe(1)
    expect(out.sample.phase).toBe("warmup")
    expect(out.sample.key).toEqual({})
    expect(out.sample.stages).toEqual([])
    expect(out.reason).toBe("runTests rejected: extension host failed to launch")
  })

  it("keeps a MEASURED blocked sample measured (never hardcoded to warmup)", () => {
    const out = blockedSampleForFailure(new Error("boom"), 4, "custom-provider", condition, 1, 1000, env)
    expect(out.sample.phase).toBe("measured")
  })

  it("bounds a very long launch error reason/detail", () => {
    const out = blockedSampleForFailure(new Error("E".repeat(10_000)), 1, "custom-provider", condition, 1, 1000, env)
    expect(out.sample.blocked?.reason.length).toBeLessThanOrEqual(200 + 1) // boundBlockedReason cap + ellipsis
    expect(out.sample.failures[0]?.length).toBeLessThanOrEqual(200 + 1) // boundFailure cap + ellipsis
  })
})
