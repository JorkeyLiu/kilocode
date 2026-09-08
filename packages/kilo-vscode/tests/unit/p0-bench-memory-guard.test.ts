import { describe, expect, it } from "bun:test"
import {
  MemoryGuardUnavailableError,
  boundCommand,
  buildOwnedTree,
  checkBreach,
  exactTerminateBackend,
  memoryGuardConfig,
  memoryGuardPlatformNote,
  parseLstartLine,
  parsePsRows,
  startMemoryGuard,
  verifyBackendRow,
  type BackendRoot,
  type BackendVerification,
  type MemoryGuardConfig,
  type MemoryGuardDeps,
  type ProcessRow,
} from "../../script/p0-bench/memory-guard"
import type { GuardBreach } from "../../script/p0-bench/types"

const GIB = 1024 * 1024 * 1024

/** Raw ps `lstart` identity used by the default test rows. */
const START = "Tue Aug 11 13:15:12 2026"

/** Injected deps harness: scripted ps stdout, controllable clock, fake timers. */
function fakeDeps(opts: { platform?: NodeJS.Platform; onBreach?: (b: GuardBreach) => void } = {}) {
  let stdout = ""
  let now = 0
  const psCalls: string[][] = []
  let intervalCallback: (() => void) | null = null
  let clearCount = 0
  const deps: MemoryGuardDeps = {
    ps: (args) => {
      psCalls.push(args)
      return stdout
    },
    now: () => now,
    setInterval: (fn) => {
      intervalCallback = fn
      return { fake: true }
    },
    clearInterval: () => {
      clearCount++
    },
    platform: opts.platform ?? "darwin",
    onBreach: opts.onBreach,
  }
  return {
    deps,
    setStdout: (s: string) => {
      stdout = s
    },
    setNow: (n: number) => {
      now = n
    },
    psCalls,
    get intervalCallback() {
      return intervalCallback
    },
    get clearCount() {
      return clearCount
    },
  }
}

/** Default cfg at the locked default safety rails. */
function defaultCfg(overrides: Partial<MemoryGuardConfig> = {}): MemoryGuardConfig {
  return {
    enabled: true,
    pollMs: 1000,
    maxProcessRssBytes: 4 * GIB,
    maxAggregateRssBytes: 6 * GIB,
    maxProcessVszBytes: 64 * GIB,
    ...overrides,
  }
}

function ownedRow(pid: number, ppid: number, rssKb: number, vszKb: number, args: string, start = START): ProcessRow {
  return { pid, ppid, rssKb, vszKb, start, args }
}

/** Render rows as real `ps -axo lstart=,pid=,ppid=,rss=,vsz=,args=` lines. */
function psLines(rows: ProcessRow[]): string {
  return rows.map((r) => `${r.start} ${r.pid} ${r.ppid} ${r.rssKb} ${r.vszKb} ${r.args}`).join("\n")
}

const USER_DATA = "/var/folders/kilo-p0-abc/user-data"

describe("memory guard ps parsing", () => {
  it("parses real `ps -axo lstart=,pid=,ppid=,rss=,vsz=,args=` output", () => {
    const stdout = [
      "Tue Aug 11 13:15:12 2026         1     0  15712 426852672 /sbin/launchd",
      "Tue Aug 11 13:16:05 2026       466     1   3872 426916672 /System/Library/Frameworks/Security.framework/Versions/A/XPCServices/com.apple.CodeSigningHelper.xpc/Contents/MacOS/com.apple.CodeSigningHelper",
      "Tue Aug 11 13:16:05 2026       703   611  60160 461072032 /Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper.app/Contents/MacOS/Code Helper --type=gpu-process --user-data-dir=/Users/u/Library/Application Support/Code --gpu-preferences=ABC",
    ].join("\n")
    const rows = parsePsRows(stdout)
    expect(rows).toEqual([
      { pid: 1, ppid: 0, rssKb: 15712, vszKb: 426852672, start: "Tue Aug 11 13:15:12 2026", args: "/sbin/launchd" },
      {
        pid: 466,
        ppid: 1,
        rssKb: 3872,
        vszKb: 426916672,
        start: "Tue Aug 11 13:16:05 2026",
        args: "/System/Library/Frameworks/Security.framework/Versions/A/XPCServices/com.apple.CodeSigningHelper.xpc/Contents/MacOS/com.apple.CodeSigningHelper",
      },
      {
        pid: 703,
        ppid: 611,
        rssKb: 60160,
        vszKb: 461072032,
        start: "Tue Aug 11 13:16:05 2026",
        args: "/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper.app/Contents/MacOS/Code Helper --type=gpu-process --user-data-dir=/Users/u/Library/Application Support/Code --gpu-preferences=ABC",
      },
    ])
  })

  it("parses space-padded single-digit and double-digit days into exact raw start+args", () => {
    const stdout = [
      "Tue Sep  8 14:01:56 2026       123     1  15712 426852672 /sbin/launchd --flag with spaces",
      "Tue Sep 18 14:01:56 2026       124     1  15712 426852672 /sbin/launchd --flag with spaces",
      "garbage line here",
      "",
      "Tue Sep  8 14:01:56",
    ].join("\n")
    const rows = parsePsRows(stdout)
    expect(rows).toEqual([
      {
        pid: 123,
        ppid: 1,
        rssKb: 15712,
        vszKb: 426852672,
        start: "Tue Sep  8 14:01:56 2026",
        args: "/sbin/launchd --flag with spaces",
      },
      {
        pid: 124,
        ppid: 1,
        rssKb: 15712,
        vszKb: 426852672,
        start: "Tue Sep 18 14:01:56 2026",
        args: "/sbin/launchd --flag with spaces",
      },
    ])
    expect(parseLstartLine("Tue Sep  8 14:01:56 2026     /var/folders/kilo-p0-cli-abc/kilo serve --port 0")).toEqual({
      start: "Tue Sep  8 14:01:56 2026",
      rest: "/var/folders/kilo-p0-cli-abc/kilo serve --port 0",
    })
    expect(parseLstartLine("Tue Sep 18 14:01:56 2026     /var/folders/kilo-p0-cli-abc/kilo serve --port 0")).toEqual({
      start: "Tue Sep 18 14:01:56 2026",
      rest: "/var/folders/kilo-p0-cli-abc/kilo serve --port 0",
    })
    expect(parseLstartLine("Tue Sep  8 14:01:56")).toBeNull()
  })

  it("skips header, empty, and malformed lines without crashing", () => {
    const rows = parsePsRows(
      [
        "PID  PPID   RSS      VSZ COMMAND",
        "",
        "   garbage line here",
        "Tue Aug 11 13:15:12 2026         1     0  15712 426852672 /sbin/launchd",
        "   x     y      z       w /broken",
        "Tue Aug 11 13:15:12 2026       703   611  not-a-number 461072032 /bin/odd",
        "",
      ].join("\n"),
    )
    expect(rows).toEqual([
      { pid: 1, ppid: 0, rssKb: 15712, vszKb: 426852672, start: "Tue Aug 11 13:15:12 2026", args: "/sbin/launchd" },
    ])
  })

  it("parses a single-process `ps -p <pid> -o lstart=,args=` line with spaces in args", () => {
    const line = "Tue Aug 11 14:00:00 2026     /var/folders/kilo-p0-cli-abc/kilo serve --port 0 --print-logs"
    expect(parseLstartLine(line)).toEqual({
      start: "Tue Aug 11 14:00:00 2026",
      rest: "/var/folders/kilo-p0-cli-abc/kilo serve --port 0 --print-logs",
    })
    expect(parseLstartLine("")).toBeNull()
    expect(parseLstartLine("no lstart here")).toBeNull()
  })
})

describe("memory guard owned process tree (ownership safety)", () => {
  it("seeds only from the exact userData arg and recursively includes descendants by PPID", () => {
    const rows = [
      // Unrelated system processes — never owned.
      ownedRow(1, 0, 100, 100, "/sbin/launchd"),
      // Ancestor of the owned root — never walked upward.
      ownedRow(30, 0, 700, 700, "/usr/libexec/SomeParent"),
      // Unrelated VS Code with a DIFFERENT userData — name match must not own it.
      ownedRow(60, 1, 300, 300, "/Applications/Code --user-data-dir=/Users/u/Library/Application Support/Code"),
      // Owned root: Code main with our exact unique userData.
      ownedRow(100, 30, 1000, 1000, `/Applications/Code --user-data-dir=${USER_DATA}`),
      // Owned child (no userData in args).
      ownedRow(101, 100, 400, 400, "Code Helper --type=renderer"),
      // Owned grandchild: backend kilo serve (no userData in args, descendant).
      ownedRow(102, 101, 500, 500, "/ext/bin/kilo serve --port 0"),
    ]
    const tree = buildOwnedTree(rows, USER_DATA)
    expect([...tree.pids].sort()).toEqual([100, 101, 102])
    expect(tree.rootPids).toEqual([100])
    expect(tree.aggregateRssKb).toBe(1000 + 400 + 500)
    expect(tree.maxRss?.pid).toBe(100)
    expect(tree.maxVsz?.pid).toBe(100)
  })

  it("returns an empty tree when nothing owns the userData", () => {
    const tree = buildOwnedTree([ownedRow(1, 0, 100, 100, "/sbin/launchd")], USER_DATA)
    expect(tree.pids.size).toBe(0)
    expect(tree.aggregateRssKb).toBe(0)
    expect(tree.maxRss).toBeNull()
  })
})

describe("memory guard threshold detection (engineering safety rails)", () => {
  const cfg = defaultCfg()

  it("breaches max-process-rss when any owned process RSS >= 4 GiB", () => {
    const tree = buildOwnedTree(
      [
        ownedRow(100, 30, 2 * 1024 * 1024, 10 * 1024 * 1024, `/Code --user-data-dir=${USER_DATA}`),
        ownedRow(101, 100, 4 * 1024 * 1024, 20 * 1024 * 1024, "Code Helper --type=renderer"),
      ],
      USER_DATA,
    )
    const b = checkBreach(tree, cfg, true, 1000, 500)
    expect(b?.reason).toBe("max-process-rss")
    expect(b?.pid).toBe(101)
    expect(b?.maxProcessRss).toBe(4 * GIB)
    expect(b?.command.length).toBeGreaterThan(0)
  })

  it("breaches aggregate-rss when the owned tree sums to >= 6 GiB with no single process over 4 GiB", () => {
    const tree = buildOwnedTree(
      [
        ownedRow(100, 30, 2 * 1024 * 1024, 8 * 1024 * 1024, `/Code --user-data-dir=${USER_DATA}`),
        ownedRow(101, 100, 2 * 1024 * 1024, 8 * 1024 * 1024, "Code Helper --type=renderer"),
        ownedRow(102, 101, 2 * 1024 * 1024, 8 * 1024 * 1024, "/ext/bin/kilo serve --port 0"),
      ],
      USER_DATA,
    )
    const b = checkBreach(tree, cfg, true, 1000, 500)
    expect(b?.reason).toBe("aggregate-rss")
    expect(b?.aggregateRss).toBe(6 * GIB)
  })

  it("breaches max-process-vsz only when the VSZ rail is active (linux)", () => {
    const rows = [
      ownedRow(100, 30, 1000, 70 * 1024 * 1024, `/Code --user-data-dir=${USER_DATA}`),
      ownedRow(101, 100, 500, 500, "Code Helper --type=renderer"),
    ]
    const active = checkBreach(buildOwnedTree(rows, USER_DATA), cfg, true, 1, 0)
    expect(active?.reason).toBe("max-process-vsz")
    const inactive = checkBreach(buildOwnedTree(rows, USER_DATA), cfg, false, 1, 0)
    expect(inactive).toBeNull()
  })

  it("returns null when every rail is under its limit", () => {
    const tree = buildOwnedTree(
      [
        ownedRow(100, 30, 3 * 1024 * 1024, 8 * 1024 * 1024, `/Code --user-data-dir=${USER_DATA}`),
        ownedRow(101, 100, 2 * 1024 * 1024, 8 * 1024 * 1024, "Code Helper --type=renderer"),
      ],
      USER_DATA,
    )
    expect(checkBreach(tree, cfg, true, 1, 0)).toBeNull()
  })

  it("evaluates max-process-rss before aggregate-rss when both are crossed", () => {
    const tree = buildOwnedTree(
      [
        ownedRow(100, 30, 6 * 1024 * 1024, 8 * 1024 * 1024, `/Code --user-data-dir=${USER_DATA}`),
        ownedRow(101, 100, 6 * 1024 * 1024, 8 * 1024 * 1024, "Code Helper --type=renderer"),
      ],
      USER_DATA,
    )
    expect(checkBreach(tree, cfg, true, 1, 0)?.reason).toBe("max-process-rss")
  })
})

describe("memory guard platform semantics", () => {
  it("supports darwin and linux; the VSZ rail is inert on darwin (fixed ~400 GB baseline)", () => {
    expect(memoryGuardPlatformNote("darwin").supported).toBe(true)
    expect(memoryGuardPlatformNote("darwin").vszRailNote).toContain("400 GB")
    expect(memoryGuardPlatformNote("linux").supported).toBe(true)
    expect(memoryGuardPlatformNote("linux").vszRailNote).toBeNull()
  })

  it("marks unsupported platforms so the benchmark fails before launch", () => {
    expect(memoryGuardPlatformNote("win32").supported).toBe(false)
  })
})

describe("memory guard config (env rails, validated)", () => {
  it("uses the locked default rails and cadence", () => {
    const cfg = memoryGuardConfig({})
    expect(cfg.enabled).toBe(true)
    expect(cfg.pollMs).toBe(1000)
    expect(cfg.maxProcessRssBytes).toBe(4 * GIB)
    expect(cfg.maxAggregateRssBytes).toBe(6 * GIB)
    expect(cfg.maxProcessVszBytes).toBe(64 * GIB)
  })

  it("honors clearly named KILO_P0_MEMORY_GUARD_* overrides (MB units)", () => {
    const cfg = memoryGuardConfig({
      KILO_P0_MEMORY_GUARD_POLL_MS: "250",
      KILO_P0_MEMORY_GUARD_MAX_PROCESS_RSS_MB: "8192",
      KILO_P0_MEMORY_GUARD_AGGREGATE_RSS_MB: "12288",
      KILO_P0_MEMORY_GUARD_MAX_PROCESS_VSZ_MB: "131072",
    })
    expect(cfg.pollMs).toBe(250)
    expect(cfg.maxProcessRssBytes).toBe(8 * GIB)
    expect(cfg.maxAggregateRssBytes).toBe(12 * GIB)
    expect(cfg.maxProcessVszBytes).toBe(128 * GIB)
  })

  it("disables explicitly via KILO_P0_MEMORY_GUARD=0|false", () => {
    expect(memoryGuardConfig({ KILO_P0_MEMORY_GUARD: "0" }).enabled).toBe(false)
    expect(memoryGuardConfig({ KILO_P0_MEMORY_GUARD: "false" }).enabled).toBe(false)
    expect(memoryGuardConfig({ KILO_P0_MEMORY_GUARD: "1" }).enabled).toBe(true)
  })

  it("rejects non-positive-integer rail values (fails safely before launch)", () => {
    for (const bad of ["abc", "0", "-5", "1.5"]) {
      expect(() => memoryGuardConfig({ KILO_P0_MEMORY_GUARD_MAX_PROCESS_RSS_MB: bad })).toThrow(
        MemoryGuardUnavailableError,
      )
    }
  })
})

describe("memory guard runtime (injected ps/clock/timers)", () => {
  it("runs an immediate first poll and polls on the configured cadence", () => {
    const f = fakeDeps()
    const guard = startMemoryGuard(USER_DATA, defaultCfg({ pollMs: 500 }), f.deps)
    expect(f.psCalls.length).toBe(1)
    expect(f.intervalCallback).not.toBeNull()
    f.setNow(500)
    f.intervalCallback!()
    expect(f.psCalls.length).toBe(2)
    guard.stop()
  })

  it("detects a breach from injected ps data and stops polling", async () => {
    const f = fakeDeps()
    let sawBreach: GuardBreach | null = null
    f.setStdout(
      psLines([
        ownedRow(100, 30, 1000, 1000, `/Code --user-data-dir=${USER_DATA}`),
        ownedRow(101, 100, 4 * 1024 * 1024, 1000, "Code Helper --type=renderer"),
      ]),
    )
    const guard = startMemoryGuard(USER_DATA, defaultCfg(), { ...f.deps, onBreach: (b) => (sawBreach = b) })
    const breach = await guard.breached
    expect(breach?.reason).toBe("max-process-rss")
    expect(sawBreach?.reason).toBe("max-process-rss")
    // Polling stopped: the interval was cleared and further pollOnce is a no-op.
    expect(f.clearCount).toBe(1)
    const before = f.psCalls.length
    guard.pollOnce()
    expect(f.psCalls.length).toBe(before)
    // Bounded result carries the breach evidence.
    expect(guard.result().breach?.reason).toBe("max-process-rss")
    expect(guard.result().pollCount).toBe(1)
  })

  it("aborts with the memory-guard classification on a runaway aggregate", async () => {
    const f = fakeDeps()
    f.setStdout(
      psLines([
        ownedRow(100, 30, 3 * 1024 * 1024, 8 * 1024 * 1024, `/Code --user-data-dir=${USER_DATA}`),
        ownedRow(101, 100, 3 * 1024 * 1024, 8 * 1024 * 1024, "Code Helper --type=renderer"),
      ]),
    )
    const guard = startMemoryGuard(USER_DATA, defaultCfg(), f.deps)
    const breach = await guard.breached
    expect(breach?.reason).toBe("aggregate-rss")
  })

  it("never includes unrelated name-matched processes in the monitored tree", async () => {
    const f = fakeDeps()
    f.setStdout(
      psLines([
        // The user's production VS Code — a different userData dir.
        ownedRow(
          60,
          1,
          50 * 1024 * 1024,
          1000,
          "/Applications/Code --user-data-dir=/Users/u/Library/Application Support/Code",
        ),
        ownedRow(61, 60, 50 * 1024 * 1024, 1000, "Code Helper --type=renderer"),
        // Our owned process stays tiny.
        ownedRow(100, 30, 1000, 1000, `/Code --user-data-dir=${USER_DATA}`),
        ownedRow(101, 100, 1000, 1000, "Code Helper --type=renderer"),
      ]),
    )
    const guard = startMemoryGuard(USER_DATA, defaultCfg(), f.deps)
    const result = guard.result()
    // Only the two owned processes are counted; the 100 GiB unrelated tree is ignored.
    expect(result.maxOwnedCount).toBe(2)
    expect(result.maxAggregateRss).toBe(2 * 1000 * 1024)
    expect(result.breach).toBeNull()
    guard.stop()
  })

  it("bounds the retained time series and command bytes", async () => {
    const f = fakeDeps()
    f.setStdout(`${START} 100 30 1000 1000 /Code --user-data-dir=${USER_DATA}\n`)
    const guard = startMemoryGuard(USER_DATA, defaultCfg(), f.deps)
    for (let i = 0; i < 400; i++) {
      f.setNow(i + 1)
      guard.pollOnce()
    }
    const result = guard.result()
    expect(result.series.length).toBeLessThanOrEqual(360)
    // The head of the series was dropped: only the newest observations remain.
    expect(result.series[0]!.t).toBe(400 - 360 + 1)
    guard.stop()
  })

  it("bounds long command strings to 200 bytes with an ellipsis", () => {
    const short = boundCommand("/bin/ls")
    expect(short).toBe("/bin/ls")
    const long = boundCommand("x".repeat(1000))
    expect(long.length).toBeLessThanOrEqual(201)
    expect(long.endsWith("…")).toBe(true)
    expect(long.startsWith("x".repeat(200))).toBe(true)
  })

  it("bounds multibyte command strings by UTF-8 byte length, not char length", () => {
    // 150 CJK chars = 450 UTF-8 bytes: the pre-fix char-length early return
    // (150 ≤ 200) would have passed 450 bytes through uncapped.
    const cjk = "汉".repeat(150)
    const bound = boundCommand(cjk)
    expect(bound).not.toBe(cjk)
    expect(bound.endsWith("…")).toBe(true)
    // Content is capped at 200 bytes on a code point boundary + the ellipsis;
    // no split sequence decodes to replacement characters.
    const body = bound.slice(0, -1)
    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(200)
    expect(Buffer.from(bound, "utf8").toString("utf8")).not.toContain("\uFFFD")
    // The exact boundary is respected: 66 CJK chars (198 bytes) is retained,
    // the 67th (would hit 201 bytes) is dropped for the ellipsis.
    expect(body).toBe("汉".repeat(66))
    // An exactly-200-byte string passes through unchanged (byte-length early
    // return), while 200 bytes + one multibyte char truncates.
    expect(boundCommand("x".repeat(200))).toBe("x".repeat(200))
    expect(boundCommand("x".repeat(200) + "汉").endsWith("…")).toBe(true)
  })

  it("disabled guard never polls, records a disabled result, and breached resolves null", async () => {
    const f = fakeDeps()
    const guard = startMemoryGuard(USER_DATA, defaultCfg({ enabled: false }), f.deps)
    expect(f.psCalls.length).toBe(0)
    expect(f.intervalCallback).toBeNull()
    const breach = await guard.breached
    expect(breach).toBeNull()
    expect(guard.result().configured.enabled).toBe(false)
    expect(guard.result().pollCount).toBe(0)
    expect(guard.result().series).toEqual([])
  })

  it("throws on unsupported platforms so the benchmark fails before launch", () => {
    const f = fakeDeps({ platform: "win32" })
    expect(() => startMemoryGuard(USER_DATA, defaultCfg(), f.deps)).toThrow(MemoryGuardUnavailableError)
    expect(f.psCalls.length).toBe(0)
  })

  it("initial ps poll failure throws so the benchmark fails closed before launch", () => {
    const f = fakeDeps()
    f.deps.ps = () => {
      throw new Error("ps: ENOENT (spawn failed)")
    }
    expect(() => startMemoryGuard(USER_DATA, defaultCfg(), f.deps)).toThrow(MemoryGuardUnavailableError)
    // The failed guard never leaves a live interval behind (cleared in failPoll).
    expect(f.clearCount).toBe(1)
  })

  it("a later ps poll failure stops polling and rejects breached (fail closed, no uncaught interval exception)", async () => {
    const f = fakeDeps()
    f.setStdout(`${START} 100 30 1000 1000 /Code --user-data-dir=${USER_DATA}\n`)
    const guard = startMemoryGuard(USER_DATA, defaultCfg(), f.deps)
    expect(guard.result().failure).toBeNull()
    // ps starts failing on the next interval tick.
    f.deps.ps = () => {
      throw new Error("ps exited with status 1")
    }
    const abort = guard.breached
    f.intervalCallback!()
    await expect(abort).rejects.toThrow(MemoryGuardUnavailableError)
    // The bounded failure is recorded, polling stopped, and the interval cleared.
    expect(guard.result().failure?.reason).toBe("ps-failed")
    expect(guard.result().failure?.detail).toContain("ps exited with status 1")
    expect(f.clearCount).toBe(1)
    // No further polls after the failure.
    const before = f.psCalls.length
    guard.pollOnce()
    expect(f.psCalls.length).toBe(before)
  })

  it("registerBackend after a poll failure never resumes polling but keeps the identity for cleanup", async () => {
    const f = fakeDeps()
    f.setStdout(`${START} 100 30 1000 1000 /Code --user-data-dir=${USER_DATA}\n`)
    const guard = startMemoryGuard(USER_DATA, defaultCfg(), f.deps)
    f.deps.ps = () => {
      throw new Error("ps: ENOENT")
    }
    f.intervalCallback!() // poll failure → guard stops, breached rejects
    await guard.breached.catch(() => undefined)
    expect(guard.result().failure).not.toBeNull()
    const before = f.psCalls.length
    // A dead guard must not resume polling...
    guard.registerBackend(backendId())
    expect(f.psCalls.length).toBe(before)
    // ...but the identity stays available so teardown can still terminate the
    // backend by exact identity even though monitoring is gone.
    expect(guard.backendIdentity()?.pid).toBe(700)
  })

  it("stop() clears the interval, is idempotent, and never leaves a timer", () => {
    const f = fakeDeps()
    const guard = startMemoryGuard(USER_DATA, defaultCfg(), f.deps)
    expect(f.clearCount).toBe(0)
    guard.stop()
    expect(f.clearCount).toBe(1)
    guard.stop()
    expect(f.clearCount).toBe(1)
    const before = f.psCalls.length
    guard.pollOnce()
    expect(f.psCalls.length).toBe(before)
  })

  it("teardown continuation: a clean stop resolves breached with null and keeps results", async () => {
    const f = fakeDeps()
    f.setStdout(`${START} 100 30 1000 1000 /Code --user-data-dir=${USER_DATA}\n`)
    const guard = startMemoryGuard(USER_DATA, defaultCfg(), f.deps)
    const promise = guard.breached
    guard.stop()
    const breach = await promise
    expect(breach).toBeNull()
    expect(guard.result().maxOwnedCount).toBe(1)
    expect(guard.result().maxAggregateRss).toBe(1000 * 1024)
  })

  it("records the VSZ rail note and label truthfully on the result", () => {
    const f = fakeDeps({ platform: "darwin" })
    const guard = startMemoryGuard(USER_DATA, defaultCfg(), f.deps)
    const result = guard.result()
    expect(result.configured.label).toContain("engineering safety rails")
    expect(result.configured.vszRailNote).toContain("darwin")
    expect(result.configured.platform).toBe("darwin")
    guard.stop()
  })
})

// ---------------------------------------------------------------------------
// Backend identity ownership (stable PID + immutable CLI path + raw start)
// ---------------------------------------------------------------------------

const CLI = "/var/folders/kilo-p0-cli-abc/kilo"
const BACKEND_START = "Tue Aug 11 14:00:00 2026"

function backendId(over: Partial<BackendRoot> = {}): BackendRoot {
  return { pid: 700, cliPath: CLI, start: BACKEND_START, registeredAt: 1000, ...over }
}

describe("memory guard backend identity ownership (PID + CLI path + start)", () => {
  it("seeds the backend as an owned root by exact identity after reparenting (PPID 1)", () => {
    // Extension Host is gone: no userData processes remain; the backend was
    // reparented to PID 1 and its descendants keep their PPIDs.
    const rows = [
      ownedRow(1, 0, 100, 100, "/sbin/launchd"),
      ownedRow(700, 1, 500, 1000, `${CLI} serve --port 0`, BACKEND_START),
      ownedRow(701, 700, 200, 500, "/usr/bin/git status"),
      ownedRow(702, 700, 300, 500, "node mcp-fixture.mjs"),
    ]
    const tree = buildOwnedTree(rows, USER_DATA, backendId())
    expect([...tree.pids].sort()).toEqual([700, 701, 702])
    expect(tree.backendStatus?.status).toBe("matched")
    expect(tree.backendStatus?.registeredAt).toBe(1000)
    expect(tree.aggregateRssKb).toBe(500 + 200 + 300)
  })

  it("never owns a reused PID (same path-looking args, different start identity)", () => {
    const rows = [
      ownedRow(1, 0, 100, 100, "/sbin/launchd"),
      // Same PID and path-looking args but a DIFFERENT start → the PID was
      // reused by an unrelated process; it must never be counted owned.
      ownedRow(700, 1, 999999, 1000, `${CLI} serve --port 0`, "Tue Aug 11 15:30:00 2026"),
    ]
    const tree = buildOwnedTree(rows, USER_DATA, backendId())
    expect(tree.pids.size).toBe(0)
    expect(tree.backendStatus?.status).toBe("mismatch")
    expect(tree.backendStatus?.detail).toContain("start identity")
    expect(tree.aggregateRssKb).toBe(0)
  })

  it("never owns an args mismatch (same PID and start, different CLI path)", () => {
    const rows = [
      ownedRow(1, 0, 100, 100, "/sbin/launchd"),
      // Same PID, same start, but args no longer contain the pinned CLI path.
      ownedRow(700, 1, 999999, 1000, "/other/bin/kilo serve --port 0", BACKEND_START),
    ]
    const tree = buildOwnedTree(rows, USER_DATA, backendId())
    expect(tree.pids.size).toBe(0)
    expect(tree.backendStatus?.status).toBe("mismatch")
    expect(tree.backendStatus?.detail).toContain("CLI path")
  })

  it("reports a missing backend identity without owning anything", () => {
    const tree = buildOwnedTree([ownedRow(1, 0, 100, 100, "/sbin/launchd")], USER_DATA, backendId())
    expect(tree.pids.size).toBe(0)
    expect(tree.backendStatus?.status).toBe("missing")
  })

  it("keeps userData ownership intact alongside the backend identity", () => {
    const rows = [
      ownedRow(100, 30, 1000, 1000, `/Code --user-data-dir=${USER_DATA}`),
      ownedRow(101, 100, 400, 400, "Code Helper --type=renderer"),
      ownedRow(700, 101, 500, 1000, `${CLI} serve --port 0`, BACKEND_START),
      // The user's production VS Code — never owned.
      ownedRow(60, 1, 9000, 1000, "/Applications/Code --user-data-dir=/Users/u/Library/Application Support/Code"),
    ]
    const tree = buildOwnedTree(rows, USER_DATA, backendId())
    expect([...tree.pids].sort()).toEqual([100, 101, 700])
    expect(tree.backendStatus?.status).toBe("matched")
  })

  it("verifyBackendRow rejects on each identity component (missing/start/path)", () => {
    expect(verifyBackendRow(backendId(), undefined).status).toBe("missing")
    expect(
      verifyBackendRow(backendId(), ownedRow(700, 1, 1, 1, `${CLI} serve`, "Tue Aug 11 15:30:00 2026")).status,
    ).toBe("mismatch")
    expect(verifyBackendRow(backendId(), ownedRow(700, 1, 1, 1, "/other/bin/kilo serve", BACKEND_START)).status).toBe(
      "mismatch",
    )
    expect(verifyBackendRow(backendId(), ownedRow(700, 1, 1, 1, `${CLI} serve --port 0`, BACKEND_START))).toEqual({
      status: "matched",
      detail: null,
    })
  })
})

describe("memory guard runtime backend registration (dynamic, during readiness)", () => {
  it("registers the identity dynamically and seeds it as owned on the next poll", () => {
    const f = fakeDeps()
    const guard = startMemoryGuard(USER_DATA, defaultCfg(), f.deps)
    // Before registration: only userData seeds (none in the table) → empty.
    expect(guard.result().maxOwnedCount).toBe(0)
    // Extension host reports spawn.done; the identity verifies on register.
    f.setStdout(
      psLines([
        ownedRow(1, 0, 100, 100, "/sbin/launchd"),
        ownedRow(700, 1, 500, 1000, `${CLI} serve --port 0`, BACKEND_START),
        ownedRow(701, 700, 200, 500, "/usr/bin/git status"),
      ]),
    )
    guard.registerBackend(backendId())
    const result = guard.result()
    expect(result.maxOwnedCount).toBe(2)
    expect(result.backend?.status).toBe("matched")
    expect(result.backend?.matchedPolls).toBe(1)
    expect(result.backend?.identity.cliPath).toBe(CLI)
    expect(result.backend?.identity.start).toBe(BACKEND_START)
    guard.stop()
  })

  it("exposes the registered identity for cleanup and is idempotent per PID", () => {
    const f = fakeDeps()
    const guard = startMemoryGuard(USER_DATA, defaultCfg(), f.deps)
    guard.registerBackend(backendId())
    expect(guard.backendIdentity()?.pid).toBe(700)
    // Re-registering the same PID is a no-op (the first identity is kept).
    guard.registerBackend({ ...backendId(), start: "Tue Aug 11 99:99:99 2026" })
    expect(guard.backendIdentity()?.start).toBe(BACKEND_START)
    expect(guard.backendIdentity()?.cliPath).toBe(CLI)
    guard.stop()
  })

  it("records a PID-reuse mismatch on the result and never owns the reused process", () => {
    const f = fakeDeps()
    const guard = startMemoryGuard(USER_DATA, defaultCfg(), f.deps)
    f.setStdout(psLines([ownedRow(700, 1, 999999, 1000, `${CLI} serve --port 0`, "Tue Aug 11 15:30:00 2026")]))
    guard.registerBackend(backendId())
    const result = guard.result()
    expect(result.backend?.status).toBe("mismatch")
    expect(result.backend?.matchedPolls).toBe(0)
    expect(result.maxOwnedCount).toBe(0)
    expect(result.maxAggregateRss).toBe(0)
    guard.stop()
  })

  it("canary-shaped lifecycle: backend stays monitored after Extension Host exit + reparenting", () => {
    const f = fakeDeps()
    const guard = startMemoryGuard(USER_DATA, defaultCfg(), f.deps)
    // Phase 1 — live lifecycle: userData tree with the backend as a descendant.
    f.setStdout(
      psLines([
        ownedRow(100, 30, 1000, 1000, `/Code --user-data-dir=${USER_DATA}`),
        ownedRow(101, 100, 400, 400, "Code Helper --type=renderer"),
        ownedRow(700, 101, 500, 1000, `${CLI} serve --port 0`, BACKEND_START),
      ]),
    )
    guard.registerBackend(backendId())
    expect(guard.result().maxOwnedCount).toBe(3)
    expect(guard.result().backend?.matchedPolls).toBe(1)
    // Phase 2 — the Extension Host exits; VS Code processes vanish and the
    // backend is reparented to PID 1. It must REMAIN an owned root by exact
    // identity, with its new descendants still monitored.
    f.setNow(10_000)
    f.setStdout(
      psLines([
        ownedRow(1, 0, 100, 100, "/sbin/launchd"),
        ownedRow(700, 1, 500, 1000, `${CLI} serve --port 0`, BACKEND_START),
        ownedRow(702, 700, 300, 500, "node mcp-fixture.mjs"),
      ]),
    )
    guard.pollOnce()
    const result = guard.result()
    expect(result.backend?.status).toBe("matched")
    expect(result.backend?.matchedPolls).toBe(2)
    expect(result.maxOwnedCount).toBe(3)
    guard.stop()
  })
})

describe("exact identity-checked backend termination (exactTerminateBackend)", () => {
  const sleepFn = async () => undefined
  const ok = (): BackendVerification => ({ status: "matched", detail: null })
  const miss = (): BackendVerification => ({ status: "missing", detail: "gone" })
  const mis = (): BackendVerification => ({ status: "mismatch", detail: "PID reused" })

  it("SIGTERMs then re-verifies: a process that exits on SIGTERM is never SIGKILLed", async () => {
    const signals: string[] = []
    const verifies: BackendVerification[] = [ok(), miss(), miss()]
    const outcome = await exactTerminateBackend(
      () => verifies.shift()!,
      (sig) => signals.push(sig),
      100,
      sleepFn,
    )
    expect(signals).toEqual(["SIGTERM"])
    expect(outcome).toEqual({ terminated: true, status: "missing", detail: null })
  })

  it("re-verifies immediately before SIGKILL and reports clean once gone", async () => {
    const signals: string[] = []
    const verifies: BackendVerification[] = [ok(), ok(), miss()]
    const outcome = await exactTerminateBackend(
      () => verifies.shift()!,
      (sig) => signals.push(sig),
      100,
      sleepFn,
    )
    expect(signals).toEqual(["SIGTERM", "SIGKILL"])
    expect(outcome).toEqual({ terminated: true, status: "missing", detail: null })
  })

  it("reports a backend that survives SIGKILL as cleanup evidence", async () => {
    const signals: string[] = []
    const verifies: BackendVerification[] = [ok(), ok(), ok()]
    const outcome = await exactTerminateBackend(
      () => verifies.shift()!,
      (sig) => signals.push(sig),
      100,
      sleepFn,
    )
    expect(signals).toEqual(["SIGTERM", "SIGKILL"])
    expect(outcome).toEqual({ terminated: false, status: "matched", detail: "backend survived SIGKILL" })
  })

  it("never signals a mismatched identity (PID reused) — reports it as evidence", async () => {
    const signals: string[] = []
    const outcome = await exactTerminateBackend(
      () => mis(),
      (sig) => signals.push(sig),
      100,
      sleepFn,
    )
    expect(signals).toEqual([])
    expect(outcome).toEqual({ terminated: false, status: "mismatch", detail: "PID reused" })
  })

  it("treats an already-missing backend as cleanly gone without signaling", async () => {
    const signals: string[] = []
    const outcome = await exactTerminateBackend(
      () => miss(),
      (sig) => signals.push(sig),
      100,
      sleepFn,
    )
    expect(signals).toEqual([])
    expect(outcome).toEqual({ terminated: true, status: "missing", detail: "gone" })
  })
})
