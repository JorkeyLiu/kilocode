import { describe, expect, it } from "bun:test"
import type { RunRecord, SampleEnv, SampleRecord, SummaryRecord } from "../../script/p0-bench/types"
import { SCENARIOS } from "../../script/p0-bench/types"

/**
 * Durable evidence-field contract for the P0 extension JSONL records
 * (v:1, additive, version-compatible). Every measured sample and run record
 * must carry unambiguous provenance: environment, commit/head, dirty state,
 * condition, sample, raw stages, explicit failures, and per-metric summaries.
 */
describe("p0 extension record field contract", () => {
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

  it("a clean sample serializes with provenance, raw stages, and an empty failures array", () => {
    const sample: SampleRecord = {
      v: 1,
      kind: "sample",
      scenario: "cold-start",
      condition: {
        id: "cold-start",
        configSeeded: false,
        agents: 0,
        providers: 0,
        mcp: null,
        note: "fresh VS Code profile",
      },
      sample: 1,
      cycle: 0,
      phase: "measured",
      lifecycle: 1,
      startedAt: 1000,
      elapsedMs: 500,
      env,
      provenance: {
        cliPath: "/ws/bin/kilo",
        cliPathInWorkspace: true,
        cliExists: true,
        cliSha256: "a".repeat(64),
        cliVersionHash: "deadbeef",
        spawnedPid: 4242,
        spawnedArgsMatch: true,
        spawnedStart: null,
      },
      key: { activateMs: 100 },
      stages: [{ surface: "extension", stage: "activate.start", t: 1000 }],
      failures: [],
      blocked: null,
      ok: true,
    }
    const json = JSON.parse(JSON.stringify(sample)) as Record<string, unknown>
    expect(json.v).toBe(1)
    expect(json.kind).toBe("sample")
    expect(json.failures).toEqual([])
    expect((json.env as Record<string, unknown>).gitCommit).toBe(env.gitCommit)
    expect((json.env as Record<string, unknown>).gitDirty).toBe(true)
    expect((json.env as Record<string, unknown>).gitHead).toBe("abc1234")
    expect((json.env as Record<string, unknown>).backendCli).toBe("/ws/packages/kilo-vscode/bin/kilo")
    expect(Array.isArray(json.stages)).toBe(true)
  })

  it("a blocked sample keeps blocked and reports the failure in the explicit failures array", () => {
    const sample: SampleRecord = {
      v: 1,
      kind: "sample",
      scenario: "no-provider",
      condition: {
        id: "no-provider",
        configSeeded: true,
        agents: 0,
        providers: 0,
        mcp: null,
        note: "seeded providerless state",
      },
      sample: 2,
      cycle: 0,
      phase: "warmup",
      lifecycle: 1,
      startedAt: 2000,
      elapsedMs: 0,
      env,
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
      failures: ["VS Code did not exit within 300000ms"],
      blocked: { reason: "VS Code did not exit within 300000ms", detail: "stack..." },
      ok: false,
    }
    const json = JSON.parse(JSON.stringify(sample)) as Record<string, unknown>
    expect((json.failures as string[]).join(" ")).toContain("did not exit")
    expect((json.blocked as { reason: string }).reason).toContain("did not exit")
    expect(json.ok).toBe(false)
  })

  it("summary records carry n/min/median/p95/max/mean with unit", () => {
    const summary: SummaryRecord = {
      v: 1,
      kind: "summary",
      scenario: "cold-start",
      metric: "activateToDataReadyMs",
      unit: "ms",
      n: 5,
      min: 1000,
      median: 1500,
      p95: 2500,
      max: 2500,
      mean: 1500,
    }
    const json = JSON.parse(JSON.stringify(summary)) as Record<string, unknown>
    expect(json.kind).toBe("summary")
    expect(json.n).toBe(5)
    expect(json.p95).toBe(json.max)
  })

  it("run records carry campaign provenance on both start and finish", () => {
    const runEnv = {
      os: "darwin",
      arch: "arm64",
      node: "v22.0.0",
      extension: "0.1.0",
      gitHead: "abc1234",
      gitCommit: env.gitCommit,
      gitDirty: true,
      backendCli: "/ws/packages/kilo-vscode/bin/kilo",
    }
    const start: RunRecord = {
      v: 1,
      kind: "run",
      event: "start",
      startedAt: 0,
      scenarios: [...SCENARIOS],
      samples: 5,
      warmup: 1,
      outDir: "/tmp/kilo-p0-bench-ts",
      env: runEnv,
    }
    const finish: RunRecord = {
      v: 1,
      kind: "run",
      event: "finish",
      finishedAt: 100,
      elapsedMs: 100,
      scenarios: [...SCENARIOS],
      samples: 5,
      warmup: 1,
      status: "ok",
      outDir: "/tmp/kilo-p0-bench-ts",
      env: runEnv,
    }
    for (const record of [start, finish]) {
      const json = JSON.parse(JSON.stringify(record)) as Record<string, unknown>
      const envJson = json.env as Record<string, unknown>
      expect(envJson.gitCommit).toBe(env.gitCommit)
      expect(envJson.gitDirty).toBe(true)
      expect(envJson.backendCli).toBe(runEnv.backendCli)
    }
  })

  it("samples and run records carry the immutable CLI snapshot provenance additively", () => {
    const cliSnapshot = {
      sourcePath: "/ws/packages/kilo-vscode/bin/kilo",
      snapshotPath: "/var/folders/kilo-p0-cli-abc/kilo",
      sourceSha256: "a".repeat(64),
      snapshotSha256: "a".repeat(64),
      sourceSize: 157234274,
      snapshotSize: 157234274,
      createdAt: 1234,
    }
    const sample: SampleRecord = {
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
      env: { ...env, backendCli: cliSnapshot.snapshotPath, cliSnapshot },
      provenance: {
        cliPath: cliSnapshot.snapshotPath,
        cliPathInWorkspace: false,
        cliExists: true,
        cliSha256: cliSnapshot.snapshotSha256,
        cliVersionHash: "deadbeef",
        spawnedPid: 4242,
        spawnedArgsMatch: true,
        spawnedStart: "Tue Aug 11 13:15:12 2026",
      },
      key: {},
      stages: [],
      failures: [],
      blocked: null,
      ok: true,
    }
    const sampleJson = JSON.parse(JSON.stringify(sample)) as Record<string, unknown>
    const envJson = sampleJson.env as Record<string, unknown>
    expect(envJson.backendCli).toBe(cliSnapshot.snapshotPath)
    expect((envJson.cliSnapshot as Record<string, unknown>).snapshotPath).toBe(cliSnapshot.snapshotPath)
    expect((envJson.cliSnapshot as Record<string, unknown>).sourceSha256).toBe("a".repeat(64))
    const provenanceJson = sampleJson.provenance as Record<string, unknown>
    expect(provenanceJson.cliPath).toBe(cliSnapshot.snapshotPath)
    expect(provenanceJson.cliSha256).toBe(cliSnapshot.snapshotSha256)

    const run: RunRecord = {
      v: 1,
      kind: "run",
      event: "start",
      startedAt: 0,
      scenarios: [...SCENARIOS],
      samples: 5,
      warmup: 1,
      outDir: "/ws/out",
      env: { ...env, backendCli: cliSnapshot.snapshotPath, cliSnapshot },
    }
    const runJson = JSON.parse(JSON.stringify(run)) as Record<string, unknown>
    expect((runJson.env as Record<string, unknown>).cliSnapshot).toBeDefined()
  })

  it("a memory-guard-aborted sample is ok:false with blocked reason memory-guard-abort", () => {
    const sample: SampleRecord = {
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
      env,
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
      failures: ["memory-guard-abort: aggregate-rss"],
      blocked: { reason: "memory-guard-abort", detail: '{"reason":"aggregate-rss","aggregateRss":6442450944}' },
      ok: false,
      memoryGuard: {
        configured: {
          enabled: true,
          pollMs: 1000,
          maxProcessRssBytes: 4 * 1024 * 1024 * 1024,
          maxAggregateRssBytes: 6 * 1024 * 1024 * 1024,
          maxProcessVszBytes: 64 * 1024 * 1024 * 1024,
          label: "engineering safety rails (not performance thresholds/R7; not SLA)",
          env: ["KILO_P0_MEMORY_GUARD", "KILO_P0_MEMORY_GUARD_POLL_MS"],
          platform: "darwin",
          vszRailNote: "darwin: macOS ps reports a fixed ~400 GB address-space baseline for every process",
        },
        failure: null,
        pollCount: 12,
        totalPollMs: 240,
        maxPollMs: 45,
        maxAggregateRss: 6 * 1024 * 1024 * 1024,
        maxOwnedCount: 6,
        maxProcessRss: 3 * 1024 * 1024 * 1024,
        maxProcessVsz: 8 * 1024 * 1024 * 1024,
        maxProcess: { pid: 100, ppid: 30, rss: 3 * 1024 * 1024 * 1024, vsz: 8 * 1024 * 1024 * 1024, command: "/Code" },
        breach: {
          reason: "aggregate-rss",
          t: 1000,
          elapsedMs: 12000,
          aggregateRss: 6442450944,
          maxProcessRss: 3221225472,
          maxProcessVsz: 8589934592,
          pid: 100,
          ppid: 30,
          command: "/Code --user-data-dir=/tmp/...",
          ownedCount: 6,
        },
        series: [{ t: 1000, aggregateRss: 6442450944, topRss: 3221225472, topVsz: 8589934592, topPid: 100, count: 6 }],
      },
    }
    const json = JSON.parse(JSON.stringify(sample)) as Record<string, unknown>
    const guard = json.memoryGuard as Record<string, unknown>
    expect(guard.breach).toBeDefined()
    expect((guard.breach as Record<string, unknown>).reason).toBe("aggregate-rss")
    expect((guard.configured as Record<string, unknown>).label).toContain("engineering safety rails")
    expect((guard.series as unknown[]).length).toBe(1)
    expect((json.blocked as { reason: string }).reason).toBe("memory-guard-abort")
    expect(json.ok).toBe(false)
  })

  it("a clean sample records a bounded memory guard result with a capped series", () => {
    const sample: SampleRecord = {
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
      env,
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
      memoryGuard: {
        configured: {
          enabled: true,
          pollMs: 1000,
          maxProcessRssBytes: 4 * 1024 * 1024 * 1024,
          maxAggregateRssBytes: 6 * 1024 * 1024 * 1024,
          maxProcessVszBytes: 64 * 1024 * 1024 * 1024,
          label: "engineering safety rails (not performance thresholds/R7; not SLA)",
          env: ["KILO_P0_MEMORY_GUARD"],
          platform: "darwin",
          vszRailNote: null,
        },
        failure: null,
        pollCount: 5,
        totalPollMs: 100,
        maxPollMs: 30,
        maxAggregateRss: 0,
        maxOwnedCount: 0,
        maxProcessRss: 0,
        maxProcessVsz: 0,
        maxProcess: null,
        breach: null,
        series: [],
      },
    }
    const json = JSON.parse(JSON.stringify(sample)) as Record<string, unknown>
    const guard = json.memoryGuard as Record<string, unknown>
    expect(guard.breach).toBeNull()
    expect(json.ok).toBe(true)
  })

  it("a clean sample records the spawned backend start identity and guard backend monitoring additively (v1)", () => {
    const sample: SampleRecord = {
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
      env,
      provenance: {
        cliPath: "/var/folders/kilo-p0-cli-abc/kilo",
        cliPathInWorkspace: false,
        cliExists: true,
        cliSha256: "a".repeat(64),
        cliVersionHash: "deadbeef",
        spawnedPid: 13992,
        spawnedArgsMatch: true,
        spawnedStart: "Tue Aug 11 14:00:00 2026",
      },
      key: {},
      stages: [],
      failures: [],
      blocked: null,
      ok: true,
      memoryGuard: {
        configured: {
          enabled: true,
          pollMs: 1000,
          maxProcessRssBytes: 4 * 1024 * 1024 * 1024,
          maxAggregateRssBytes: 6 * 1024 * 1024 * 1024,
          maxProcessVszBytes: 64 * 1024 * 1024 * 1024,
          label: "engineering safety rails (not performance thresholds/R7; not SLA)",
          env: ["KILO_P0_MEMORY_GUARD"],
          platform: "darwin",
          vszRailNote: null,
        },
        failure: null,
        pollCount: 5,
        totalPollMs: 100,
        maxPollMs: 30,
        maxAggregateRss: 0,
        maxOwnedCount: 0,
        maxProcessRss: 0,
        maxProcessVsz: 0,
        maxProcess: null,
        breach: null,
        series: [],
        backend: {
          identity: { pid: 13992, cliPath: "/var/folders/kilo-p0-cli-abc/kilo", start: "Tue Aug 11 14:00:00 2026" },
          registeredAt: 1200,
          status: "matched",
          detail: null,
          lastSeenAt: 1600,
          matchedPolls: 4,
        },
      },
    }
    const json = JSON.parse(JSON.stringify(sample)) as Record<string, unknown>
    const provenance = json.provenance as Record<string, unknown>
    expect(provenance.spawnedStart).toBe("Tue Aug 11 14:00:00 2026")
    expect(provenance.spawnedPid).toBe(13992)
    const guard = json.memoryGuard as Record<string, unknown>
    const backend = guard.backend as Record<string, unknown>
    expect(backend).toBeDefined()
    expect((backend.identity as Record<string, unknown>).pid).toBe(13992)
    expect((backend.identity as Record<string, unknown>).cliPath).toBe("/var/folders/kilo-p0-cli-abc/kilo")
    expect(backend.status).toBe("matched")
    expect(backend.matchedPolls).toBe(4)
  })

  it("a many-agent-mcp sample records MCP fixture handshake + exact identity + cleanup status additively (v1)", () => {
    const sample: SampleRecord = {
      v: 1,
      kind: "sample",
      scenario: "many-agent-mcp",
      condition: {
        id: "many-agent-mcp",
        configSeeded: true,
        agents: 8,
        providers: 0,
        mcp: "p0-bench-mcp",
        note: "seeded scratch XDG kilo.json with 8 real custom agents + one real local stdio MCP server fixture",
      },
      sample: 1,
      cycle: 0,
      phase: "measured",
      lifecycle: 1,
      startedAt: 1000,
      elapsedMs: 500,
      env,
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
      key: { mcpConnectMs: 420 },
      stages: [],
      failures: [],
      blocked: null,
      ok: true,
      mcpFixture: {
        handshake: { pid: 5555, connectedAt: 1600 },
        identity: { pid: 5555, start: "Tue Aug 11 13:15:12 2026", path: "/var/folders/kilo-p0-mcp-abc/mcp-fixture.mjs" },
        discoveryError: null,
        cleanup: {
          status: "clean",
          detail: "MCP fixture PID 5555 cleaned by exact identity (PID + raw start + fixture script path re-verified before each signal)",
        },
      },
    }
    const json = JSON.parse(JSON.stringify(sample)) as Record<string, unknown>
    const fixture = json.mcpFixture as Record<string, unknown>
    expect(fixture).toBeDefined()
    expect((fixture.handshake as Record<string, unknown>).pid).toBe(5555)
    expect((fixture.handshake as Record<string, unknown>).connectedAt).toBe(1600)
    expect((fixture.identity as Record<string, unknown>).pid).toBe(5555)
    expect((fixture.identity as Record<string, unknown>).start).toBe("Tue Aug 11 13:15:12 2026")
    expect((fixture.identity as Record<string, unknown>).path).toBe(
      "/var/folders/kilo-p0-mcp-abc/mcp-fixture.mjs",
    )
    expect((fixture.cleanup as Record<string, unknown>).status).toBe("clean")
    expect((fixture.cleanup as Record<string, unknown>).detail).toContain("exact identity")
    expect(json.ok).toBe(true)
  })

  it("a backend-cleanup-failed sample is ok:false with cleanup-failed evidence (never ok:true)", () => {
    const sample: SampleRecord = {
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
      env,
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
      failures: ["cleanup-failed: backend PID 13992 not cleanly terminated (matched: backend survived SIGKILL)"],
      blocked: {
        reason: "cleanup-failed",
        detail: "teardown-failed: cleanup: backend PID 13992 not cleanly terminated (matched: backend survived SIGKILL)",
      },
      ok: false,
    }
    const json = JSON.parse(JSON.stringify(sample)) as Record<string, unknown>
    expect(json.ok).toBe(false)
    expect((json.failures as string[]).join(" ")).toContain("backend survived SIGKILL")
    expect((json.blocked as { reason: string }).reason).toBe("cleanup-failed")
  })
})
