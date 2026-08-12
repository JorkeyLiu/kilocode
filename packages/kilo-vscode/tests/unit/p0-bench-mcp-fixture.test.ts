import { describe, expect, it } from "bun:test"
import { spawn } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Readable } from "node:stream"
import {
  exactTerminateBackend,
  verifyProcessRow,
  type BackendVerification,
  type ProcessRoot,
  type ProcessRow,
} from "../../script/p0-bench/memory-guard"
import {
  applyMcpFixtureEvidence,
  cleanupMcpFixture,
  emptyMcpFixtureEvidence,
  terminateFixtureWithPs,
  verifiedFixtureIdentity,
  verifyFixturePs,
} from "../../script/p0-bench/sample"
import type { McpFixtureEvidence, SampleRecord, ScenarioID } from "../../script/p0-bench/types"

const FIXTURE_PATH = "/var/folders/kilo-p0-mcp-abc/mcp-fixture.mjs"
const START = "Tue Aug 11 13:15:12 2026"

/** Absolute path of the real run-owned MCP fixture script. */
const FIXTURE_SCRIPT = new URL("../../script/p0-bench/mcp-fixture.mjs", import.meta.url).pathname

function fixtureRow(pid: number, start: string, args: string): ProcessRow {
  return { pid, ppid: 1, rssKb: 300, vszKb: 500, start, args }
}

function fixtureId(over: Partial<ProcessRoot> = {}): ProcessRoot {
  return { pid: 5555, path: FIXTURE_PATH, start: START, ...over }
}

function mkSample(scenario: ScenarioID): SampleRecord {
  return {
    v: 1,
    kind: "sample",
    scenario,
    condition: {
      id: scenario,
      configSeeded: scenario === "many-agent-mcp",
      agents: scenario === "many-agent-mcp" ? 8 : 0,
      providers: 0,
      mcp: scenario === "many-agent-mcp" ? "p0-bench-mcp" : null,
      note: "fixture test",
    },
    sample: 1,
    cycle: 0,
    phase: "measured",
    lifecycle: 1,
    startedAt: 1000,
    elapsedMs: 0,
    env: {
      os: "darwin",
      arch: "arm64",
      node: "v22.0.0",
      vscode: "1.90.0",
      extension: "0.1.0",
      gitHead: null,
      gitCommit: null,
      gitDirty: false,
      backendCli: null,
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
  }
}

// ---------------------------------------------------------------------------
// Generic exact identity verification (PID + raw start + exact script path)
// ---------------------------------------------------------------------------

describe("MCP fixture identity verification (verifyProcessRow)", () => {
  it("matches only PID + same raw start + args containing the exact fixture script path", () => {
    const identity = fixtureId()
    const matched = fixtureRow(5555, START, `node ${FIXTURE_PATH}`)
    expect(verifyProcessRow(identity, matched)).toEqual({ status: "matched", detail: null })
  })

  it("rejects a missing process (exited) as missing — never signaled", () => {
    expect(verifyProcessRow(fixtureId(), undefined).status).toBe("missing")
  })

  it("rejects a reused PID (same PID, different raw start) as mismatch — never signaled", () => {
    const reused = fixtureRow(5555, "Tue Aug 11 15:30:00 2026", `node ${FIXTURE_PATH}`)
    expect(verifyProcessRow(fixtureId(), reused).status).toBe("mismatch")
  })

  it("rejects an args mismatch (same PID + start, args without the fixture script path)", () => {
    const wrong = fixtureRow(5555, START, "node /some/other/script.mjs")
    expect(verifyProcessRow(fixtureId(), wrong).status).toBe("mismatch")
  })

  it("still matches after reparenting (same PID + start + path, ppid 1 after backend death)", () => {
    const reparented = fixtureRow(5555, START, `node ${FIXTURE_PATH}`)
    expect(reparented.ppid).toBe(1)
    expect(verifyProcessRow(fixtureId(), reparented).status).toBe("matched")
  })
})

// ---------------------------------------------------------------------------
// No non-owned signal: exactTerminateBackend never signals a mismatch/missing
// ---------------------------------------------------------------------------

describe("MCP fixture cleanup never signals a non-owned process (exact terminate)", () => {
  it("terminates a verified fixture (SIGTERM → gone → clean, no SIGKILL needed)", async () => {
    const signals: string[] = []
    let alive = true
    const outcome = await exactTerminateBackend(
      () => {
        if (!alive) return { status: "missing", detail: "gone" } as BackendVerification
        return verifyProcessRow(fixtureId(), fixtureRow(5555, START, `node ${FIXTURE_PATH}`))
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
  })

  it("never signals a reused PID (start mismatch) and reports the mismatch truthfully", async () => {
    const signals: string[] = []
    const reused = fixtureRow(5555, "Tue Aug 11 15:30:00 2026", `node ${FIXTURE_PATH}`)
    const outcome = await exactTerminateBackend(
      () => verifyProcessRow(fixtureId(), reused),
      (sig) => signals.push(sig),
      100,
      async () => undefined,
    )
    expect(signals).toEqual([])
    expect(outcome.terminated).toBe(false)
    expect(outcome.status).toBe("mismatch")
    expect(outcome.detail).toContain("start identity")
  })

  it("never signals an args mismatch (same PID + start, wrong path) and reports it", async () => {
    const signals: string[] = []
    const wrong = fixtureRow(5555, START, "node /some/other/script.mjs")
    const outcome = await exactTerminateBackend(
      () => verifyProcessRow(fixtureId(), wrong, "fixture script path"),
      (sig) => signals.push(sig),
      100,
      async () => undefined,
    )
    expect(signals).toEqual([])
    expect(outcome.terminated).toBe(false)
    expect(outcome.status).toBe("mismatch")
    expect(outcome.detail).toContain("fixture script path")
  })

  it("reports a survivor that outlives SIGTERM and SIGKILL as a failed cleanup", async () => {
    const signals: string[] = []
    const outcome = await exactTerminateBackend(
      () => verifyProcessRow(fixtureId(), fixtureRow(5555, START, `node ${FIXTURE_PATH}`)),
      (sig) => {
        signals.push(sig)
        // the process is unkillable in this simulation — it always re-verifies matched
      },
      100,
      async () => undefined,
    )
    expect(signals).toEqual(["SIGTERM", "SIGKILL"])
    expect(outcome.terminated).toBe(false)
    expect(outcome.status).toBe("matched")
    expect(outcome.detail).toContain("survived SIGKILL")
  })
})

// ---------------------------------------------------------------------------
// cleanupMcpFixture: fail-closed decision flow (marker / identity / survivor)
// ---------------------------------------------------------------------------

describe("cleanupMcpFixture (fail-closed, evidence-recorded)", () => {
  const markerDir = () => mkdtempSync(join(tmpdir(), "kilo-p0-mcp-clean-"))

  it("skips cleanup when no marker exists (fixture never connected) — terminate never called", async () => {
    const dir = markerDir()
    try {
      const state = emptyMcpFixtureEvidence()
      let terminated = false
      const outcome = await cleanupMcpFixture(
        join(dir, "mcp-connected"),
        state,
        100,
        async () => {
          terminated = true
          return { terminated: true, status: "missing", detail: null }
        },
      )
      expect(outcome.status).toBe("not-attempted")
      expect(state.cleanup.status).toBe("not-attempted")
      expect(terminated).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("fails closed when the marker exists but the identity was never verified — no signal", async () => {
    const dir = markerDir()
    try {
      const markerPath = join(dir, "mcp-connected")
      writeFileSync(markerPath, JSON.stringify({ pid: 5555, connectedAt: 1000 }))
      const state = emptyMcpFixtureEvidence()
      state.handshake = { pid: 5555, connectedAt: 1000 }
      state.discoveryError = "PID 5555 did not verify against the live process table"
      let terminated = false
      const outcome = await cleanupMcpFixture(
        markerPath,
        state,
        100,
        async () => {
          terminated = true
          return { terminated: true, status: "missing", detail: null }
        },
      )
      expect(outcome.status).toBe("failed")
      expect(state.cleanup.status).toBe("failed")
      expect(state.cleanup.detail).toContain("never verified")
      expect(state.cleanup.detail).toContain("refusing to signal")
      expect(terminated).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("fails when the fixture survives SIGTERM + SIGKILL (cleanup failure status)", async () => {
    const dir = markerDir()
    try {
      const markerPath = join(dir, "mcp-connected")
      writeFileSync(markerPath, JSON.stringify({ pid: 5555, connectedAt: 1000 }))
      const state = emptyMcpFixtureEvidence()
      state.handshake = { pid: 5555, connectedAt: 1000 }
      state.identity = fixtureId()
      const outcome = await cleanupMcpFixture(
        markerPath,
        state,
        100,
        async () => ({ terminated: false, status: "matched", detail: "backend survived SIGKILL" }),
      )
      expect(outcome.status).toBe("failed")
      expect(state.cleanup.status).toBe("failed")
      expect(state.cleanup.detail).toContain("survived SIGKILL")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("fails when the identity became a mismatch at signal time (reused PID) — no signal, evidence", async () => {
    const dir = markerDir()
    try {
      const markerPath = join(dir, "mcp-connected")
      writeFileSync(markerPath, JSON.stringify({ pid: 5555, connectedAt: 1000 }))
      const state = emptyMcpFixtureEvidence()
      state.handshake = { pid: 5555, connectedAt: 1000 }
      state.identity = fixtureId()
      const outcome = await cleanupMcpFixture(
        markerPath,
        state,
        100,
        async () => ({ terminated: false, status: "mismatch", detail: "process start identity mismatch (PID likely reused)" }),
      )
      expect(outcome.status).toBe("failed")
      expect(state.cleanup.status).toBe("failed")
      expect(state.cleanup.detail).toContain("mismatch")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("records clean evidence when the fixture is gone by exact identity", async () => {
    const dir = markerDir()
    try {
      const markerPath = join(dir, "mcp-connected")
      writeFileSync(markerPath, JSON.stringify({ pid: 5555, connectedAt: 1000 }))
      const state = emptyMcpFixtureEvidence()
      state.handshake = { pid: 5555, connectedAt: 1000 }
      state.identity = fixtureId()
      const outcome = await cleanupMcpFixture(
        markerPath,
        state,
        100,
        async () => ({ terminated: true, status: "missing", detail: null }),
      )
      expect(outcome.status).toBe("clean")
      expect(state.cleanup.status).toBe("clean")
      expect(state.cleanup.detail).toContain("exact identity")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// Evidence attachment (handshake + identity + cleanup status on the records)
// ---------------------------------------------------------------------------

describe("applyMcpFixtureEvidence (evidence records handshake + identity + cleanup)", () => {
  it("attaches the evidence to every many-agent-mcp sample and leaves other scenarios untouched", () => {
    const mcpSamples = [mkSample("many-agent-mcp"), mkSample("many-agent-mcp")]
    const other = [mkSample("cold-start")]
    const evidence: McpFixtureEvidence = {
      handshake: { pid: 5555, connectedAt: 1000 },
      identity: { pid: 5555, start: START, path: FIXTURE_PATH },
      discoveryError: null,
      cleanup: { status: "clean", detail: "MCP fixture PID 5555 cleaned by exact identity" },
    }
    applyMcpFixtureEvidence(mcpSamples, "many-agent-mcp", evidence)
    applyMcpFixtureEvidence(other, "cold-start", evidence)
    for (const s of mcpSamples) expect(s.mcpFixture).toBe(evidence)
    expect(other[0]!.mcpFixture).toBeUndefined()
  })

  it("serializes handshake + identity + cleanup status additively on the record", () => {
    const sample = mkSample("many-agent-mcp")
    sample.mcpFixture = {
      handshake: { pid: 5555, connectedAt: 1000 },
      identity: { pid: 5555, start: START, path: FIXTURE_PATH },
      discoveryError: null,
      cleanup: { status: "failed", detail: "MCP fixture PID 5555 not cleanly terminated (matched: survived SIGKILL)" },
    }
    const json = JSON.parse(JSON.stringify(sample)) as { mcpFixture: Record<string, unknown> }
    const fixture = json.mcpFixture
    expect((fixture.handshake as { pid: number }).pid).toBe(5555)
    expect((fixture.identity as { start: string }).start).toBe(START)
    expect((fixture.identity as { path: string }).path).toBe(FIXTURE_PATH)
    expect((fixture.cleanup as { status: string }).status).toBe("failed")
    expect((fixture.cleanup as { detail: string }).detail).toContain("survived SIGKILL")
  })
})

// ---------------------------------------------------------------------------
// Real discovery + exact termination (lightweight fixture subprocess, cleanup
// guaranteed) — the backend-hard-kill survivor path against real ps + signals.
// ---------------------------------------------------------------------------

describe("verifiedFixtureIdentity / terminateFixtureWithPs (real ps + real signals)", () => {
  it("discovers a fixture survivor by exact identity and terminates it cleanly after backend death", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kilo-p0-mcp-real-"))
    const fixturePath = join(dir, "mcp-fixture.mjs")
    // The "backend" is already dead (hard-killed); the fixture survives as a
    // standalone process whose args carry the exact fixture script path, like
    // the real seeded `["node", "<fixture>"]` MCP config.
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{}, 1000)", fixturePath], { stdio: "ignore" })
    try {
      await new Promise<void>((resolve) => {
        const deadline = Date.now() + 10_000
        const poll = () => {
          if (verifiedFixtureIdentity(child.pid, fixturePath)) return resolve()
          if (Date.now() > deadline) return resolve() // fail via expect below
          setTimeout(poll, 50)
        }
        poll()
      })
      const identity = verifiedFixtureIdentity(child.pid, fixturePath)
      expect(identity).not.toBeNull()
      expect(identity!.pid).toBe(child.pid)
      expect(identity!.path).toBe(fixturePath)
      expect(identity!.start.length).toBeGreaterThan(0)
      expect(verifyFixturePs(identity!).status).toBe("matched")
      const outcome = await terminateFixtureWithPs(identity!, 2_000)
      expect(outcome.terminated).toBe(true)
      expect(outcome.status).toBe("missing")
      expect(verifyFixturePs(identity!).status).toBe("missing")
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL")
        await new Promise<void>((resolve) => child.once("exit", () => resolve()))
      }
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// Synchronous content-complete marker write: the marker is immediately
// parseable the instant it exists (no exists-before-content race). The probe
// polls on file existence then parses right away, so a marker whose file can
// appear before its content lands would surface as an unparsable read.
// ---------------------------------------------------------------------------

describe("MCP fixture marker is immediately parseable once it exists (sync write)", () => {
  it("drives the real handshake and the first observed existence already parses", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kilo-p0-mcp-marker-"))
    const marker = join(dir, "mcp-connected")
    const child = spawn(process.execPath, [FIXTURE_SCRIPT], {
      env: { ...process.env, P0_MCP_MARKER: marker },
      stdio: ["pipe", "pipe", "ignore"],
    })
    try {
      // Drive the REAL MCP handshake (initialize → initialized → tools/list);
      // the fixture writes the marker only after tools/list succeeds.
      child.stdin!.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-03-26", capabilities: {} },
        }) + "\n",
      )
      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n")
      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n")

      // Tightly poll for first existence: with the synchronous content-complete
      // write the file either does not exist or already holds the full payload,
      // so the very first observed existence must parse (an async
      // createWriteStream open/write could expose an exists-but-empty window
      // here).
      const deadline = Date.now() + 10_000
      let raw = ""
      for (;;) {
        if (existsSync(marker)) {
          raw = readFileSync(marker, "utf8")
          expect(() => JSON.parse(raw)).not.toThrow()
          break
        }
        if (Date.now() > deadline) throw new Error("test: marker never appeared")
        await new Promise((resolve) => setImmediate(resolve))
      }
      const parsed = JSON.parse(raw.trim()) as { pid?: unknown; connectedAt?: unknown }
      expect(parsed.pid).toBe(child.pid)
      expect(typeof parsed.connectedAt).toBe("number")
      // Small bounded payload: single line, far below the byte bound.
      expect(raw.trim().split("\n").length).toBe(1)
      expect(raw.length).toBeLessThan(200)
    } finally {
      if (child.stdin && !child.stdin.destroyed) child.stdin.end()
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL")
        await new Promise<void>((resolve) => child.once("exit", () => resolve()))
      }
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// prompts/list: the backend's startup dataReady queries MCP.prompts, and the
// fixture previously stayed silent on prompts/list so the SDK's default 60s
// request timeout made every sample wait ~60s (five completed samples showed
// dataReadySpanMs 60.2-60.4s). This drives the real subprocess and asserts a
// valid empty prompt list arrives quickly; a silent-fixture regression fails
// fast (bounded far below 60s) instead of hanging the suite.
// ---------------------------------------------------------------------------

/** First JSON-RPC response on `stream` whose `id` matches, or null past `ms`. */
function readResponse(stream: Readable, id: unknown, ms: number): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    let buf = ""
    let done = false
    const finish = (msg: Record<string, unknown> | null) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(msg)
    }
    const timer = setTimeout(() => finish(null), ms)
    stream.setEncoding("utf8")
    stream.on("data", (chunk: string) => {
      buf += chunk
      let nl: number
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        let msg: Record<string, unknown>
        try {
          msg = JSON.parse(line) as Record<string, unknown>
        } catch {
          continue
        }
        if (msg.id === id) finish(msg)
      }
    })
  })
}

describe("MCP fixture answers prompts/list quickly (real subprocess, no SDK 60s timeout)", () => {
  it("returns a valid empty prompt list after initialize and keeps the marker for tools/list only", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kilo-p0-mcp-prompt-"))
    const marker = join(dir, "mcp-connected")
    const child = spawn(process.execPath, [FIXTURE_SCRIPT], {
      env: { ...process.env, P0_MCP_MARKER: marker },
      stdio: ["pipe", "pipe", "ignore"],
    })
    try {
      // Real MCP handshake start: initialize → initialized → prompts/list.
      child.stdin!.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-03-26", capabilities: {} },
        }) + "\n",
      )
      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n")
      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "prompts/list" }) + "\n")

      // Bounded far below the SDK default 60s request timeout: a silent
      // fixture fails this test in 5s, never hanging the suite for a minute.
      const resp = await readResponse(child.stdout!, 2, 5_000)
      expect(resp).not.toBeNull()
      expect(resp!.jsonrpc).toBe("2.0")
      expect(resp!.id).toBe(2)
      expect(resp!.error).toBeUndefined()
      const result = resp!.result as { prompts?: unknown[] } | undefined
      expect(Array.isArray(result?.prompts)).toBe(true)
      expect(result!.prompts!.length).toBe(0)

      // The truthfulness marker writes ONLY after the tools/list handshake:
      // initialize + prompts/list alone must not produce it.
      expect(existsSync(marker)).toBe(false)

      // Completing the real handshake still writes the marker, unchanged.
      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }) + "\n")
      const deadline = Date.now() + 10_000
      while (!existsSync(marker)) {
        if (Date.now() > deadline) throw new Error("test: marker never appeared after tools/list")
        await new Promise((resolve) => setImmediate(resolve))
      }
      const parsed = JSON.parse(readFileSync(marker, "utf8").trim()) as { pid?: unknown; connectedAt?: unknown }
      expect(parsed.pid).toBe(child.pid)
      expect(typeof parsed.connectedAt).toBe("number")
    } finally {
      if (child.stdin && !child.stdin.destroyed) child.stdin.end()
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL")
        await new Promise<void>((resolve) => child.once("exit", () => resolve()))
      }
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
