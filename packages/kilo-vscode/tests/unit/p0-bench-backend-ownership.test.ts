import { describe, expect, it } from "bun:test"
import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import {
  exactTerminateBackend,
  buildOwnedTree,
  startMemoryGuard,
  verifyBackendRow,
  type BackendRoot,
  type BackendVerification,
  type MemoryGuardConfig,
  type MemoryGuardDeps,
  type ProcessRow,
} from "../../script/p0-bench/memory-guard"
import {
  applyBackendIdentityGate,
  awaitBackendIdentity,
  discoverBackendIdentity,
  emptyMcpFixtureEvidence,
  processesWithPath,
  settleBackendRegistration,
  snapshotSurvivorCleanup,
  terminateBackendWithPs,
  verifyCleanup,
} from "../../script/p0-bench/sample"
import type { ParsedRecords } from "../../script/p0-bench/parse"
import type { GuardBreach, SampleRecord } from "../../script/p0-bench/types"

const GIB = 1024 * 1024 * 1024
const START = "Tue Aug 11 13:15:12 2026"
const BACKEND_START = "Tue Aug 11 14:00:00 2026"
const USER_DATA = "/var/folders/kilo-p0-abc/user-data"
const CLI = "/var/folders/kilo-p0-cli-abc/kilo"

function ownedRow(pid: number, ppid: number, rssKb: number, vszKb: number, args: string, start = START): ProcessRow {
  return { pid, ppid, rssKb, vszKb, start, args }
}

function psLines(rows: ProcessRow[]): string {
  return rows.map((r) => `${r.start} ${r.pid} ${r.ppid} ${r.rssKb} ${r.vszKb} ${r.args}`).join("\n")
}

function backendId(): BackendRoot {
  return { pid: 13992, cliPath: CLI, start: BACKEND_START, registeredAt: 1000 }
}

/** Minimal injected guard harness (no real ps, no real timers). */
function harness() {
  let stdout = ""
  let now = 0
  const deps: MemoryGuardDeps = {
    ps: () => stdout,
    now: () => now,
    setInterval: (fn) => fn,
    clearInterval: () => undefined,
    platform: "darwin",
    onBreach: (_b: GuardBreach) => undefined,
  }
  return {
    deps,
    setStdout: (s: string) => {
      stdout = s
    },
    setNow: (n: number) => {
      now = n
    },
  }
}

function defaultCfg(): MemoryGuardConfig {
  return {
    enabled: true,
    pollMs: 1000,
    maxProcessRssBytes: 4 * GIB,
    maxAggregateRssBytes: 6 * GIB,
    maxProcessVszBytes: 64 * GIB,
  }
}

/**
 * Deterministic canary-shaped lifecycle simulation. Mirrors the guarded canary
 * incident: a backend PID recorded by spawn.done running from the immutable CLI
 * snapshot, whose Extension Host exited and reparented it to PID 1. The guard
 * must keep it an owned root by exact identity (PID + CLI path + raw start),
 * and cleanup must terminate it ONLY after re-verifying that identity.
 */
describe("canary-shaped lifecycle (backend ownership end-to-end)", () => {
  it("monitors the reparented backend + descendants, then identity-checked cleanup terminates it", async () => {
    const h = harness()
    const guard = startMemoryGuard(USER_DATA, defaultCfg(), h.deps)

    // Phase 1 — live lifecycle: userData VS Code tree with the backend as a
    // descendant (spawn.done observed → identity registered).
    h.setStdout(
      psLines([
        ownedRow(100, 30, 1000, 1000, `/Code --user-data-dir=${USER_DATA}`),
        ownedRow(101, 100, 400, 400, "Code Helper --type=renderer"),
        ownedRow(13992, 101, 500, 1000, `${CLI} serve --port 0`, BACKEND_START),
      ]),
    )
    guard.registerBackend(backendId())
    expect(guard.result().maxOwnedCount).toBe(3)
    expect(guard.result().backend?.status).toBe("matched")

    // Phase 2 — the Extension Host exits; VS Code processes vanish and the
    // backend is reparented to PID 1 (the canary's failure mode). It must stay
    // owned: the guard seeds it by exact identity, PPID is irrelevant.
    h.setNow(10_000)
    h.setStdout(
      psLines([
        ownedRow(1, 0, 100, 100, "/sbin/launchd"),
        ownedRow(13992, 1, 500, 1000, `${CLI} serve --port 0`, BACKEND_START),
        ownedRow(13993, 13992, 300, 500, "node mcp-fixture.mjs"),
      ]),
    )
    guard.pollOnce()
    const monitored = guard.result()
    expect(monitored.backend?.status).toBe("matched")
    expect(monitored.backend?.matchedPolls).toBe(2)
    expect(monitored.maxOwnedCount).toBe(3)
    // The monitored tree's backend root is verifiable exactly.
    const tree = buildOwnedTree(
      [
        ownedRow(1, 0, 100, 100, "/sbin/launchd"),
        ownedRow(13992, 1, 500, 1000, `${CLI} serve --port 0`, BACKEND_START),
        ownedRow(13993, 13992, 300, 500, "node mcp-fixture.mjs"),
      ],
      USER_DATA,
      backendId(),
    )
    expect([...tree.pids].sort()).toEqual([13992, 13993])
    expect(tree.backendStatus?.status).toBe("matched")

    // Phase 3 — cleanup. The identity is re-verified immediately before each
    // signal: SIGTERM, then the process is gone → clean, no SIGKILL needed.
    const signals: string[] = []
    let alive = true
    const outcome = await exactTerminateBackend(
      () => {
        if (!alive) return { status: "missing", detail: "gone" } as BackendVerification
        return verifyBackendRow(
          backendId(),
          ownedRow(13992, 1, 500, 1000, `${CLI} serve --port 0`, BACKEND_START),
        )
      },
      (sig) => {
        signals.push(sig)
        if (sig === "SIGTERM") alive = false
      },
      100,
      async () => undefined,
    )
    expect(signals).toEqual(["SIGTERM"])
    expect(outcome).toEqual({ terminated: true, status: "missing", detail: null })
    guard.stop()
  })

  it("never signals a reparented PID that was reused by an unrelated process", async () => {
    // After the Extension Host exit the backend PID is gone; an unrelated
    // process took the same PID (different raw start). The identity must be
    // treated as exited/reused: no signal, and cleanup reports the mismatch.
    const signals: string[] = []
    const reused = ownedRow(13992, 1, 999999, 1000, `${CLI} serve --port 0`, "Tue Aug 11 15:30:00 2026")
    const verify = () => verifyBackendRow(backendId(), reused)
    expect(verify().status).toBe("mismatch")
    const outcome = await exactTerminateBackend(verify, (sig) => signals.push(sig), 100, async () => undefined)
    expect(signals).toEqual([])
    expect(outcome.terminated).toBe(false)
    expect(outcome.status).toBe("mismatch")
    // The guard never counts the reused process as owned either.
    const tree = buildOwnedTree([reused], USER_DATA, backendId())
    expect(tree.pids.size).toBe(0)
    expect(tree.backendStatus?.status).toBe("mismatch")
  })
})

/**
 * Snapshot deletion must wait for the backend: processesWithPath finds any live
 * process still running from the exact CLI snapshot path (the campaign refuses
 * to delete the snapshot while one exists). Uses a real, tiny marker process —
 * the same `ps -axo pid=,args=` scan the harness performs.
 */
describe("snapshot cleanup waits for the backend (processesWithPath)", () => {
  it("detects a live process running from the snapshot path and reports it gone after exit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kilo-p0-snap-wait-"))
    const marker = join(dir, "kilo")
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{}, 1000)", marker])
    try {
      await new Promise<void>((resolve) => {
        const deadline = Date.now() + 10_000
        const poll = () => {
          if (processesWithPath(marker).some((p) => p.pid === child.pid)) return resolve()
          if (Date.now() > deadline) return resolve() // fail via expect below
          setTimeout(poll, 50)
        }
        poll()
      })
      const live = processesWithPath(marker)
      expect(live.some((p) => p.pid === child.pid)).toBe(true)
      // The snapshot is NOT deletable while a process runs from it.
      expect(live.length).toBeGreaterThan(0)
    } finally {
      child.kill("SIGTERM")
      await waitGone(child.pid)
    }
    // After the process exits, no live process runs from the path → deletable.
    expect(processesWithPath(marker).some((p) => p.pid === child.pid)).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })
})

/**
 * Backend registration vs teardown race. The registration runs concurrently
 * with the drive; teardown must read a SETTLED registration state (awaited or
 * bounded+cancelled, never read mid-flight) before verifyCleanup/backendIdentity
 * and sample finalization.
 */
describe("backend registration settle before teardown (bounded, race-safe)", () => {
  it("waits out a pending registration and returns its identity when it settles first", async () => {
    const signal = { cancelled: false }
    const identity = { pid: 13992, cliPath: CLI, start: BACKEND_START, registeredAt: 1000 }
    const settled = await settleBackendRegistration(Promise.resolve(identity), signal, 10_000)
    expect(settled).toEqual({ identity, timedOut: false })
    expect(signal.cancelled).toBe(false)
  })

  it("bounds a still-pending registration and cancels the loop so no late registration mutates mid-teardown", async () => {
    const signal = { cancelled: false }
    const pending = new Promise<null>(() => {}) // never settles on its own
    const settled = await settleBackendRegistration(pending, signal, 50)
    expect(settled).toEqual({ identity: null, timedOut: true })
    expect(signal.cancelled).toBe(true)
  })

  it("resolves null promptly when a registration genuinely resolved without an identity", async () => {
    const signal = { cancelled: false }
    const settled = await settleBackendRegistration(Promise.resolve(null), signal, 10_000)
    expect(settled).toEqual({ identity: null, timedOut: false })
    expect(signal.cancelled).toBe(false)
  })
})

describe("awaitBackendIdentity (registration captures the verified backend)", () => {
  const never = new Promise<never>(() => {})

  it("captures the verified identity from spawn.done PID + CLI path records", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kilo-p0-reg-id-"))
    const cli = join(dir, "kilo")
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{}, 1000)", cli, "serve"])
    try {
      const records = (): ParsedRecords => ({ stages: [], cliPath: cli, spawnedPid: child.pid })
      const identity = await awaitBackendIdentity(records, never, 10_000)
      expect(identity?.pid).toBe(child.pid)
      expect(identity?.cliPath).toBe(resolve(cli))
      expect(identity!.start.length).toBeGreaterThan(0)
    } finally {
      child.kill("SIGTERM")
      await waitGone(child.pid)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("a cancelled signal stops the registration loop promptly (bounded teardown settle)", async () => {
    const signal = { cancelled: true }
    const identity = await awaitBackendIdentity(
      () => ({ stages: [], cliPath: null, spawnedPid: null }),
      never,
      10_000,
      signal,
    )
    expect(identity).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Missing backend identity = hard failure (LOCK-PERF: missing ownership
// evidence is failure, never baseline). The gate forces ok:false on every
// sample when a spawned backend PID was observed but the stable identity never
// settled — and never false-positives a sample legitimately blocked before any
// spawn.
// ---------------------------------------------------------------------------

/** Minimal valid sample record for gate tests. */
function gateSample(over: Partial<SampleRecord> = {}): SampleRecord {
  return {
    v: 1,
    kind: "sample",
    scenario: "cold-start",
    condition: { id: "cold-start", configSeeded: false, agents: 0, providers: 0, mcp: null, note: "" },
    sample: 1,
    cycle: 0,
    phase: "measured",
    lifecycle: 1,
    startedAt: 1000,
    elapsedMs: 500,
    env: {
      os: "darwin",
      arch: "arm64",
      node: "v22.0.0",
      vscode: "1.90.0",
      extension: "0.1.0",
      gitHead: "abc1234",
      gitCommit: "abc1234".padEnd(40, "0"),
      gitDirty: true,
      backendCli: "/tmp/kilo-p0-cli-abc/kilo",
    },
    provenance: {
      cliPath: null,
      cliPathInWorkspace: false,
      cliExists: false,
      cliSha256: null,
      cliVersionHash: null,
      spawnedPid: null,
      spawnedArgsMatch: false,
      spawnedStart: null,
    },
    key: {},
    stages: [],
    failures: [],
    blocked: null,
    ok: true,
    ...over,
  }
}

describe("backend identity gate (missing registration is a hard failure, never ok)", () => {
  it("a spawned PID observed without a settled identity forces ok:false with blocked reason backend-identity-unavailable (registration timeout after spawn)", () => {
    const samples = [gateSample()]
    const outcome = applyBackendIdentityGate(
      samples,
      true,
      true,
      true,
      "backend identity registration did not settle within the bounded window",
      null,
      "",
    )
    expect(samples[0]!.ok).toBe(false)
    expect(samples[0]!.blocked?.reason).toBe("backend-identity-unavailable")
    expect(samples[0]!.blocked?.detail).toContain("did not settle within the bounded window")
    expect(samples[0]!.failures.join(" ")).toContain("backend-identity-unavailable")
    expect(outcome.failed).toBe(true)
    expect(outcome.blockedReason).toBe("backend-identity-unavailable")
  })

  it("a ps-failed registration (guard cannot verify) is a hard failure, never a baseline", () => {
    const samples = [gateSample()]
    applyBackendIdentityGate(samples, true, true, true, "ps poll failed; polling stopped: ps exited with status 1", null, "")
    expect(samples[0]!.ok).toBe(false)
    expect(samples[0]!.blocked?.reason).toBe("backend-identity-unavailable")
    expect(samples[0]!.failures.join(" ")).toContain("ps poll failed")
  })

  it("a mismatch/reused-PID registration (identity never verified) fails the sample", () => {
    const samples = [gateSample()]
    applyBackendIdentityGate(samples, true, true, true, null, null, "")
    expect(samples[0]!.ok).toBe(false)
    expect(samples[0]!.blocked?.reason).toBe("backend-identity-unavailable")
    expect(samples[0]!.blocked?.detail).toContain("never verified")
  })

  it("a sample legitimately blocked BEFORE any spawn is never a false positive", () => {
    const samples = [gateSample()]
    const outcome = applyBackendIdentityGate(samples, true, false, true, "VS Code failed to launch", null, "")
    expect(outcome.failed).toBe(false)
    expect(samples[0]!.ok).toBe(true)
    expect(samples[0]!.blocked).toBeNull()
  })

  it("VS Code never launched (blocked before launch) never triggers the gate", () => {
    const samples = [gateSample()]
    const outcome = applyBackendIdentityGate(samples, false, true, true, "launch failed", null, "")
    expect(outcome.failed).toBe(false)
    expect(samples[0]!.ok).toBe(true)
  })

  it("a settled identity never triggers the gate even when a spawn was observed", () => {
    const samples = [gateSample()]
    const outcome = applyBackendIdentityGate(samples, true, true, false, "unused error", null, "")
    expect(outcome.failed).toBe(false)
    expect(samples[0]!.ok).toBe(true)
    expect(samples[0]!.blocked).toBeNull()
  })

  it("merges the original failure evidence into the bounded detail without losing it", () => {
    const samples = [gateSample({ blocked: { reason: "dataReady.done gate timeout", detail: "no dataReady.done in 180s" } })]
    applyBackendIdentityGate(samples, true, true, true, "identity only verifiable by late discovery", null, "")
    expect(samples[0]!.blocked?.reason).toBe("backend-identity-unavailable")
    expect(samples[0]!.blocked?.detail).toContain("dataReady.done gate timeout")
    expect(samples[0]!.blocked!.detail.length).toBeLessThanOrEqual(2000)
    expect(samples[0]!.failures[0]!.length).toBeLessThanOrEqual(200)
  })

  it("run status: a gate-failed sample is blocked, so the campaign run is partial/failed, never ok", () => {
    const samples = [gateSample({ phase: "measured", ok: true })]
    const outcome = applyBackendIdentityGate(samples, true, true, true, "registration did not settle", null, "")
    // emitResult (campaign) marks anyBlocked from sample.blocked → finish status
    // is "partial" (or "failed" with no ok measured sample) — never "ok".
    expect(outcome.failed).toBe(true)
    expect(samples[0]!.blocked).not.toBeNull()
    expect(samples[0]!.ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Fail-closed late identity discovery (PID + exact snapshot path + raw lstart)
// ---------------------------------------------------------------------------

/** Poll `ps` until `pid` is in the live process table. */
async function waitForPid(pid: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const row = spawnSync("ps", ["-p", String(pid), "-o", "pid="], { encoding: "utf8" })
    if ((row.stdout ?? "").trim() === String(pid)) return
    if (Date.now() > deadline) throw new Error(`test: process ${pid} not in ps within ${timeoutMs}ms`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Poll `ps` until `pid` disappears from the live process table. The production
 * cleanup signals via raw `process.kill` (never through the ChildProcess API),
 * under which bun does not populate `exitCode`/`signalCode` nor emit 'exit' —
 * the process table is the authoritative liveness source (the same mechanism
 * the harness itself uses).
 */
async function waitGone(pid: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const row = spawnSync("ps", ["-p", String(pid), "-o", "pid="], { encoding: "utf8" })
    if ((row.stdout ?? "").trim() !== String(pid)) return
    if (Date.now() > deadline) throw new Error(`test: process ${pid} still in ps within ${timeoutMs}ms`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

describe("fail-closed late identity discovery (discoverBackendIdentity)", () => {
  it("verifies a live process running from the exact CLI path with serve and captures raw lstart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kilo-p0-disc-"))
    const cli = join(dir, "kilo")
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{}, 1000)", cli, "serve"])
    try {
      await waitForPid(child.pid)
      const identity = discoverBackendIdentity(child.pid, cli)
      expect(identity?.pid).toBe(child.pid)
      expect(identity?.cliPath).toBe(resolve(cli))
      expect(identity!.start.length).toBeGreaterThan(0)
    } finally {
      child.kill("SIGTERM")
      await waitGone(child.pid)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("returns null for a live PID not running the CLI (args lack serve → reused-PID-safe, never signaled)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kilo-p0-disc-mis-"))
    const cli = join(dir, "kilo")
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{}, 1000)", cli])
    try {
      await waitForPid(child.pid)
      expect(discoverBackendIdentity(child.pid, cli)).toBeNull()
    } finally {
      child.kill("SIGTERM")
      await waitGone(child.pid)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("returns null when the observed PID is no longer in the live process table", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kilo-p0-disc-gone-"))
    const cli = join(dir, "kilo")
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{}, 1000)", cli, "serve"])
    try {
      await waitForPid(child.pid)
      child.kill("SIGTERM")
      await waitGone(child.pid)
      expect(discoverBackendIdentity(child.pid, cli)).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("returns null without a CLI path anchor (never invents an identity from a bare PID)", () => {
    expect(discoverBackendIdentity(4242, null)).toBeNull()
  })
})

describe("verified late discovery cleanup (discover → exact identity terminate)", () => {
  it("a late-discovered backend identity is terminated with re-verification before each signal, leaving no process", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kilo-p0-disc-clean-"))
    const cli = join(dir, "kilo")
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{}, 1000)", cli, "serve"])
    try {
      await waitForPid(child.pid)
      const identity = discoverBackendIdentity(child.pid, cli)
      expect(identity).not.toBeNull()
      const outcome = await terminateBackendWithPs(identity!, 2_000)
      expect(outcome.terminated).toBe(true)
      expect(alive(child.pid)).toBe(false)
    } finally {
      try {
        child.kill("SIGKILL")
      } catch {
        // already gone
      }
      await waitGone(child.pid)
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("snapshot survivor cleanup at campaign finally (snapshotSurvivorCleanup)", () => {
  it("terminates a verified survivor running from the snapshot path, then runs the snapshot cleanup", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kilo-p0-surv-"))
    const snap = join(dir, "kilo")
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{}, 1000)", snap, "serve"])
    let cleaned = false
    try {
      await waitForPid(child.pid)
      await snapshotSurvivorCleanup(snap, () => (cleaned = true), 2_000)
      expect(cleaned).toBe(true)
      expect(alive(child.pid)).toBe(false)
    } finally {
      try {
        child.kill("SIGKILL")
      } catch {
        // already gone
      }
      await waitGone(child.pid)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("never signals an unverifiable survivor: snapshot preserved, campaign fails, process untouched", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kilo-p0-surv-unv-"))
    const snap = join(dir, "kilo")
    // Live process running FROM the snapshot path but without `serve` — its
    // identity cannot be verified, so it must never be signaled.
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{}, 1000)", snap])
    let cleaned = false
    try {
      await waitForPid(child.pid)
      await expect(snapshotSurvivorCleanup(snap, () => (cleaned = true), 1_000)).rejects.toThrow(/snapshot NOT deleted/)
      expect(cleaned).toBe(false)
      expect(alive(child.pid)).toBe(true) // no signal was sent
    } finally {
      child.kill("SIGKILL")
      await waitGone(child.pid)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("runs the snapshot cleanup when no process runs from the snapshot path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kilo-p0-surv-none-"))
    const snap = join(dir, "kilo")
    let cleaned = false
    await snapshotSurvivorCleanup(snap, () => (cleaned = true))
    expect(cleaned).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })
})

describe("artifact retention when the backend identity was never verified (verifyCleanup)", () => {
  it("retains the scratch evidence and fails with a blocker naming the PID/path (no signal)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kilo-p0-retain-"))
    const scratch = join(dir, "scratch")
    mkdirSync(scratch, { recursive: true })
    try {
      await expect(
        verifyCleanup(
          join(scratch, "user-data"),
          0,
          scratch,
          "cold-start",
          null,
          { pid: 4242, cliPath: "/tmp/kilo-p0-cli-abc/kilo" },
          emptyMcpFixtureEvidence(),
        ),
      ).rejects.toThrow(/identity was never verified/)
      // The blocker threw BEFORE the scratch deletion: evidence is retained.
      expect(existsSync(scratch)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("a verified backend is terminated by exact identity and the scratch is deleted (no leak, clean)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kilo-p0-clean-"))
    const scratch = join(dir, "scratch")
    mkdirSync(scratch, { recursive: true })
    const cli = join(dir, "cli", "kilo")
    mkdirSync(dirname(cli), { recursive: true })
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{}, 1000)", cli, "serve"])
    try {
      await waitForPid(child.pid)
      const identity = discoverBackendIdentity(child.pid, cli)
      expect(identity).not.toBeNull()
      await verifyCleanup(join(scratch, "user-data"), 0, scratch, "cold-start", identity, null, emptyMcpFixtureEvidence())
      expect(existsSync(scratch)).toBe(false)
      expect(alive(child.pid)).toBe(false)
    } finally {
      try {
        child.kill("SIGKILL")
      } catch {
        // already gone
      }
      await waitGone(child.pid)
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// Backend termination failure defers to MCP fixture cleanup (verifyCleanup):
// a verified backend that cannot be terminated must never skip the exact MCP
// fixture cleanup — the blocker throws only AFTER the fixture was cleaned and
// BEFORE port/scratch deletion, so fixture cleanup is always attempted.
// ---------------------------------------------------------------------------

describe("backend termination failure still invokes MCP fixture cleanup (verifyCleanup)", () => {
  it("an unkillable verified backend defers the blocker until after exact MCP cleanup, then fails closed with scratch retained", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kilo-p0-unkill-"))
    const scratch = join(dir, "scratch")
    mkdirSync(scratch, { recursive: true })
    const markerPath = join(scratch, "mcp-connected")
    writeFileSync(markerPath, JSON.stringify({ pid: 5555, connectedAt: 1000 }))
    const mcp = emptyMcpFixtureEvidence()
    mcp.handshake = { pid: 5555, connectedAt: 1000 }
    mcp.identity = { pid: 5555, start: START, path: "/var/folders/kilo-p0-mcp-abc/mcp-fixture.mjs" }
    let fixtureTerminated = false
    try {
      await expect(
        verifyCleanup(
          join(scratch, "user-data"),
          0,
          scratch,
          "many-agent-mcp",
          backendId(),
          null,
          mcp,
          // The verified backend is unkillable in this simulation — SIGTERM +
          // SIGKILL never clear it — so the termination failure must be
          // deferred, not thrown before the fixture cleanup.
          async () => ({ terminated: false, status: "matched", detail: "backend survived SIGKILL" }),
          async () => {
            fixtureTerminated = true
            return { terminated: true, status: "missing", detail: null }
          },
        ),
      ).rejects.toThrow(/backend PID 13992 not cleanly terminated/)
      // The exact MCP fixture cleanup was STILL attempted after the backend
      // termination failed — an unkillable backend never leaks the fixture.
      expect(fixtureTerminated).toBe(true)
      expect(mcp.cleanup.status).toBe("clean")
      // The blocker threw BEFORE the scratch deletion: evidence is retained.
      expect(existsSync(scratch)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
