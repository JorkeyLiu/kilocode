import { afterEach, describe, expect, mock, test } from "bun:test"

const errors: Array<{ message: string; err: unknown }> = []

void mock.module("@opencode-ai/core/util/log", () => ({
  create: () => ({
    debug() {},
    info() {},
    warn() {},
    error(message: string, extra?: { err?: unknown }) {
      errors.push({ message, err: extra?.err })
    },
  }),
}))

const { createShutdownCoordinator, defaultTimer, startSignalShutdown } = await import("../../src/kilocode/shutdown-coordinator")
const { startParentWatchdog } = await import("../../src/kilocode/parent-watchdog")

async function until(fn: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error("condition not met in time")
    await Bun.sleep(5)
  }
}

describe("createShutdownCoordinator", () => {
  afterEach(() => {
    delete process.env["KILO_PARENT_PID"]
  })

  test("normal completion clears the deadline: disposal settles in order, no hard-stop", async () => {
    const order: string[] = []
    let hardStopped = 0
    let completed = 0
    const coordinator = createShutdownCoordinator({
      graceMs: 50,
      shutdown: async () => {
        order.push("shutdown-start")
        await Bun.sleep(10)
        order.push("shutdown-end")
      },
      hardStop: () => {
        hardStopped += 1
      },
      onComplete: () => {
        completed += 1
        order.push("complete")
      },
    })
    coordinator.begin()
    await until(() => completed === 1)
    // Completion runs strictly after disposal settles, preserving dispose-then-stop order.
    expect(order).toEqual(["shutdown-start", "shutdown-end", "complete"])
    // Deadline cleared on completion: well past grace, the hard-stop never fires.
    await Bun.sleep(80)
    expect(hardStopped).toBe(0)
    expect(completed).toBe(1)
  })

  test("hung disposal cannot outlive the grace period: hard-stop fires while shutdown is blocked", async () => {
    let release: (() => void) | undefined
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    let hardStopped = 0
    const coordinator = createShutdownCoordinator({
      graceMs: 50,
      shutdown: () => blocked,
      hardStop: () => {
        hardStopped += 1
      },
      onComplete: () => {},
    })
    coordinator.begin()
    await until(() => hardStopped === 1)
    expect(hardStopped).toBe(1)
    release?.()
  })

  test("rejected shutdown clears the deadline: error handled and logged, no hard-stop, completion once", async () => {
    errors.length = 0
    let hardStopped = 0
    let completed = 0
    const coordinator = createShutdownCoordinator({
      graceMs: 50,
      shutdown: async () => {
        throw new Error("disposal failed")
      },
      hardStop: () => {
        hardStopped += 1
      },
      onComplete: () => {
        completed += 1
      },
    })
    coordinator.begin()
    await until(() => completed === 1)
    // The rejection is consumed by the coordinator's handler — never an
    // unhandled rejection — and the failure is logged with the error detail.
    expect(errors).toHaveLength(1)
    expect(errors[0]?.message).toBe("graceful shutdown failed")
    expect(String(errors[0]?.err)).toContain("disposal failed")
    // Deadline cleared on rejection: well past grace, the hard-stop never fires.
    await Bun.sleep(80)
    expect(hardStopped).toBe(0)
    expect(completed).toBe(1)
  })

  test("orphan detection drives shutdown through the coordinator", async () => {
    // Spawn a real process, kill it, and reap it so its PID is dead — the same
    // pattern the parent-watchdog test uses to produce a guaranteed orphan.
    const child = Bun.spawn([process.execPath, "-e", "await Bun.sleep(30000)"], {
      stdout: "ignore",
      stderr: "ignore",
    })
    const pid = child.pid
    child.kill("SIGKILL")
    await child.exited
    process.env["KILO_PARENT_PID"] = String(pid)

    let began = false
    const coordinator = createShutdownCoordinator({
      graceMs: 5000,
      shutdown: async () => {
        began = true
      },
      hardStop: () => {},
      onComplete: () => {},
    })
    const stop = startParentWatchdog(() => coordinator.begin(), 10)
    try {
      await until(() => began)
      expect(began).toBe(true)
    } finally {
      stop()
    }
  })

  test("repeated begin calls are idempotent: one disposal, one completion, no parallel shutdown", async () => {
    let shutdowns = 0
    let hardStopped = 0
    let completed = 0
    let release: (() => void) | undefined
    const coordinator = createShutdownCoordinator({
      graceMs: 100,
      shutdown: () => {
        shutdowns += 1
        return new Promise<void>((resolve) => {
          release = resolve
        })
      },
      hardStop: () => {
        hardStopped += 1
      },
      onComplete: () => {
        completed += 1
      },
    })
    coordinator.begin()
    coordinator.begin()
    coordinator.begin()
    // shutdown() is dispatched on a microtask; wait for it, then confirm it ran exactly once.
    await until(() => shutdowns === 1)
    expect(shutdowns).toBe(1)
    release?.()
    await until(() => completed === 1)
    expect(completed).toBe(1)
    expect(hardStopped).toBe(0)
  })

  test("deadline timer stays process-owning (referenced, never unref'd)", () => {
    let ref: (() => boolean) | undefined
    let clear: (() => void) | undefined
    const coordinator = createShutdownCoordinator({
      graceMs: 50,
      shutdown: () => new Promise<void>(() => {}),
      setTimer: (cb, ms) => {
        const timer = defaultTimer(cb, ms)
        ref = timer.hasRef
        clear = timer.clear
        return timer
      },
      hardStop: () => {},
      onComplete: () => {},
    })
    coordinator.begin()
    expect(ref?.()).toBe(true)
    clear?.()
  })

  test("signal wiring registers SIGTERM/SIGINT/SIGHUP and the disposer removes them (no residue)", () => {
    const count = (sig: NodeJS.Signals) => process.listenerCount(sig)
    const before = { term: count("SIGTERM"), int: count("SIGINT"), hup: count("SIGHUP") }
    let began = 0
    const stop = startSignalShutdown(() => {
      began += 1
    })
    try {
      expect(count("SIGTERM")).toBe(before.term + 1)
      expect(count("SIGINT")).toBe(before.int + 1)
      expect(count("SIGHUP")).toBe(before.hup + 1)
      // The wired handler is the last registered listener; invoke it directly —
      // never signal the test runner itself.
      process.listeners("SIGTERM").at(-1)?.("SIGTERM")
      process.listeners("SIGINT").at(-1)?.("SIGINT")
      process.listeners("SIGHUP").at(-1)?.("SIGHUP")
      expect(began).toBe(3)
    } finally {
      stop()
      expect(count("SIGTERM")).toBe(before.term)
      expect(count("SIGINT")).toBe(before.int)
      expect(count("SIGHUP")).toBe(before.hup)
    }
  })

  test("signal disposer is idempotent: repeated disposal leaves no residue", () => {
    const count = (sig: NodeJS.Signals) => process.listenerCount(sig)
    const before = { term: count("SIGTERM"), int: count("SIGINT"), hup: count("SIGHUP") }
    const stop = startSignalShutdown(() => {})
    stop()
    stop()
    expect(count("SIGTERM")).toBe(before.term)
    expect(count("SIGINT")).toBe(before.int)
    expect(count("SIGHUP")).toBe(before.hup)
  })

  test("signal wiring drives shutdown through the idempotent coordinator", async () => {
    let began = 0
    let completed = 0
    const coordinator = createShutdownCoordinator({
      graceMs: 5000,
      shutdown: async () => {
        began += 1
      },
      hardStop: () => {},
      onComplete: () => {
        completed += 1
      },
    })
    const stop = startSignalShutdown(() => coordinator.begin())
    try {
      const onSignal = process.listeners("SIGTERM").at(-1)
      onSignal?.("SIGTERM")
      onSignal?.("SIGTERM") // repeated signal — begin() is idempotent
      await until(() => began === 1 && completed === 1)
      expect(began).toBe(1)
      expect(completed).toBe(1)
    } finally {
      stop()
    }
  })
})
