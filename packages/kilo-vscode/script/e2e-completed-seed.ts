/**
 * Run-owned workspace seed for the real-completed E2E scenario (harness
 * process only — script/e2e-probe.ts imports this; never bundled into the
 * extension). Written into the scratch workspace BEFORE VS Code launches so
 * the lazily-spawned CLI backend loads every fixture at instance init:
 *
 *   - .kilo/kilo.json        — custom provider e2e-local/e2e-model pointing at
 *                              the run-owned scripted model server, two custom
 *                              agents, the default model, the H-6 permission
 *                              rule (read ask.txt -> ask, question -> allow),
 *                              and the H-5 MCP stdio server config,
 *   - .kilo/tool/e2e_marker.ts — the H-3 user-defined tool (writes a
 *                              run-owned artifact file via ctx.directory),
 *   - .kilo/skills/e2e-skill/SKILL.md — the H-4 run-owned skill,
 *   - .kilo/node_modules + .kilo/package-lock.json — the no-op dependency
 *                              guard: the config loader fires a DETACHED
 *                              `Npm.install("@kilocode/plugin")` for every
 *                              existing writable config dir; pre-seeding
 *                              node_modules + a lock that already contains
 *                              @kilocode/plugin makes that install a no-op
 *                              (packages/core/src/npm.ts install guard),
 *   - mcp-fixture/server.js    — the H-5 stdio MCP server (imports the
 *                              already-installed MCP SDK by absolute file URL
 *                              from packages/opencode/node_modules), serving
 *                              one real tool (e2e_echo) that writes every
 *                              call to a run-owned log before answering,
 *   - ask.txt                  — the H-6 permission target file,
 *   - rollback.txt             — the H-12 tracked rollback file (committed by
 *                              initWorkspaceGit; the write tool edits it and
 *                              Revert-to-here/Redo All restore the exact bytes).
 */

import { spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { SCRIPTED } from "./e2e-scripted-model"

export interface CompletedSeedPaths {
  configFile: string
  userToolFile: string
  skillFile: string
  mcpServerFile: string
  mcpLogPath: string
  permissionFile: string
  /** H-12: the tracked file the write tool edits and revert restores. */
  rollbackFile: string
}

/**
 * Run-owned workspace seed for the real-overflow E2E scenario (H-13). Written
 * into the scratch workspace BEFORE VS Code launches so the lazily-spawned CLI
 * backend loads it at instance init. Deliberately MINIMAL and dedicated — the
 * small context/compaction config must NOT be shared with real-completed
 * (whose model serves the H-2..H-7 scripted turns), so this seed writes only:
 *
 *   - .kilo/kilo.json — the custom provider e2e-local/e2e-model pointing at the
 *     run-owned scripted model server, with a deliberately SMALL
 *     `limit.context`/`limit.output` and a low `compaction.threshold_percent`
 *     (the internal context-overflow safeguard trigger levers; empirically the
 *     preflight payload estimate — system prompt + tool schemas + history — is
 *     ~15–20K tokens, so a cap below that preflight-compacts before the model
 *     is ever called and can never produce the large first response; the
 *     smallest robust cap measured is limit.context × 50% = 30K, which the
 *     scripted large response's reported usage deterministically crosses),
 *     the default model, the subagent model, and one custom primary agent the
 *     harness picks in the ModeSwitcher (mirroring the proven real-completed
 *     Phase 0 so the first send never races the provider catalog load),
 *   - .kilo/node_modules + .kilo/package-lock.json — the no-op dependency
 *     guard (same as real-completed).
 *
 * No git, no user tools, no skills, no MCP, no permission rules: the scenario
 * is pure text turns against the scripted provider.
 */
export function writeRealOverflowSeed(workspace: string, port: number): string {
  const configFile = join(workspace, ".kilo", "kilo.json")
  mkdirSync(dirname(configFile), { recursive: true })
  writeFileSync(
    configFile,
    JSON.stringify(
      {
        $schema: "https://app.kilo.ai/config.json",
        provider: {
          "e2e-local": {
            npm: "@ai-sdk/openai-compatible",
            name: "E2E Local",
            options: {
              baseURL: `http://127.0.0.1:${port}/v1`,
              apiKey: "e2e-fixture-key",
              timeout: false,
              headerTimeout: false,
              firstChunkTimeout: false,
            },
            models: {
              "e2e-model": {
                name: "E2E Model",
                variants: { low: {}, medium: {}, high: {} },
                // H-13: deliberately small context/output so the internal
                // overflow safeguard has a tiny headroom; the scripted large
                // response's reported usage crosses cap = context ×
                // threshold_percent (see writeRealOverflowSeed docs).
                limit: { context: 60000, output: 2000 },
              },
            },
          },
        },
        agent: {
          "e2e-agent": {
            displayName: "E2E Agent",
            description: "E2E overflow custom agent",
            mode: "primary",
            model: "e2e-local/e2e-model",
          },
        },
        model: "e2e-local/e2e-model",
        small_model: "e2e-local/e2e-model",
        subagent_model: "e2e-local/e2e-model",
        // H-13: low threshold — cap = floor(60000 × 50%) = 30000, above the
        // measured preflight payload (~15–20K) and below the scripted large
        // response usage (53000). compaction.auto stays default (true) — the
        // invisible internal safeguard.
        compaction: { threshold_percent: 50 },
      },
      null,
      2,
    ),
  )

  // No-op dependency guard (same rationale as writeRealCompletedSeed): prevent
  // the detached Npm.install("@kilocode/plugin") fiber from reifying into the
  // run-owned .kilo config dir.
  const kiloDir = join(workspace, ".kilo")
  mkdirSync(join(kiloDir, "node_modules"), { recursive: true })
  writeFileSync(
    join(kiloDir, "package-lock.json"),
    JSON.stringify({
      name: "kilo-e2e-workspace",
      version: "0.0.0",
      lockfileVersion: 3,
      packages: { "": { dependencies: { "@kilocode/plugin": "0.0.0" } } },
    }),
  )

  return configFile
}

export function buildMcpServerScript(sdkEsmDir: string, toolName: string): string {
  const entry = (rel: string) => `file://${join(sdkEsmDir, rel)}`
  return [
    `import { Server } from ${JSON.stringify(entry("server/index.js"))}`,
    `import { StdioServerTransport } from ${JSON.stringify(entry("server/stdio.js"))}`,
    `import { ListToolsRequestSchema, CallToolRequestSchema } from ${JSON.stringify(entry("types.js"))}`,
    `import { appendFileSync } from "node:fs"`,
    ``,
    `const server = new Server({ name: "e2e-fixture", version: "1.0.0" }, { capabilities: { tools: {} } })`,
    `server.setRequestHandler(ListToolsRequestSchema, async () => ({`,
    `  tools: [`,
    `    {`,
    `      name: ${JSON.stringify(toolName)},`,
    `      description: "Echo a message back",`,
    `      inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },`,
    `    },`,
    `  ],`,
    `}))`,
    `server.setRequestHandler(CallToolRequestSchema, async (request) => {`,
    `  const args = request.params.arguments ?? {}`,
    `  const message = String(args.message ?? "")`,
    `  appendFileSync(process.env.E2E_MCP_LOG ?? "mcp-fixture/calls.log", "echo:" + message + "\\n")`,
    `  return { content: [{ type: "text", text: "echo:" + message }] }`,
    `})`,
    `const transport = new StdioServerTransport()`,
    `await server.connect(transport)`,
    ``,
  ].join("\n")
}

export function writeRealCompletedSeed(
  workspace: string,
  port: number,
  sdkEsmDir: string,
  pluginToolUrl: string,
): CompletedSeedPaths {
  // H-5: the run-owned stdio MCP server fixture. The config command uses the
  // ABSOLUTE script path so the harness can record and prove the child's exact
  // process handle (ps by absolute path — never a pattern kill).
  const mcpServerFile = join(workspace, "mcp-fixture", "server.js")
  const configFile = join(workspace, ".kilo", "kilo.json")
  mkdirSync(dirname(configFile), { recursive: true })
  writeFileSync(
    configFile,
    JSON.stringify(
      {
        $schema: "https://app.kilo.ai/config.json",
        provider: {
          "e2e-local": {
            npm: "@ai-sdk/openai-compatible",
            name: "E2E Local",
            options: {
              baseURL: `http://127.0.0.1:${port}/v1`,
              apiKey: "e2e-fixture-key",
              timeout: false,
              headerTimeout: false,
              firstChunkTimeout: false,
            },
            models: {
              "e2e-model": {
                name: "E2E Model",
                variants: { low: {}, medium: {}, high: {} },
              },
            },
          },
        },
        agent: {
          "e2e-agent": {
            displayName: "E2E Agent",
            description: "E2E parity custom agent",
            mode: "primary",
            model: "e2e-local/e2e-model",
          },
          "e2e-agent-b": {
            displayName: "E2E Agent B",
            description: "E2E parity custom agent B",
            mode: "primary",
            model: "e2e-local/e2e-model",
          },
        },
        model: "e2e-local/e2e-model",
        // LOCK-006: every implicit generation resolves to the run-owned
        // provider. small_model routes the native title agent
        // (SessionPrompt.ensureTitle → Provider.getSmallModel) away from the
        // kilo gateway fallback (kilo/kilo-auto/small) — the proven external
        // title call; subagent_model pins the task-tool delegated child
        // (builtin `general`) to the same run-owned scripted provider.
        small_model: "e2e-local/e2e-model",
        subagent_model: "e2e-local/e2e-model",
        // H-6: question allowed; reading ask.txt asks inline (all other reads allowed).
        permission: {
          question: "allow",
          read: { "*": "allow", "ask.txt": "ask" },
          // H-12: allow the write tool ONLY on the tracked rollback file (the
          // pattern is relative to the git worktree == workspace, exactly what
          // the write tool asks for). No other edit rule is seeded.
          edit: { [SCRIPTED.rollbackFile]: "allow" },
        },
        // H-5: the run-owned stdio MCP server connects at instance init.
        mcp: {
          "e2e-fixture": {
            type: "local",
            command: ["bun", mcpServerFile],
            environment: { E2E_MCP_LOG: "mcp-fixture/calls.log" },
            enabled: true,
          },
        },
      },
      null,
      2,
    ),
  )

  // H-3: user-defined tool through the real ToolRegistry (plugin bridge).
  const userToolFile = join(workspace, ".kilo", "tool", "e2e_marker.ts")
  mkdirSync(dirname(userToolFile), { recursive: true })
  writeFileSync(
    userToolFile,
    [
      `import { tool } from ${JSON.stringify(pluginToolUrl)}`,
      `import { writeFileSync } from "node:fs"`,
      `export default tool({`,
      `  description: "Echo a message back",`,
      `  args: { message: tool.schema.string().describe("message to echo") },`,
      `  execute: async ({ message }, ctx) => {`,
      `    writeFileSync(ctx.directory + "/e2e-custom-called.txt", "echo:" + message)`,
      `    return "echo:" + message`,
      `  },`,
      `})`,
      "",
    ].join("\n"),
  )

  // H-4: run-owned skill (frontmatter name/description + content marker).
  const skillFile = join(workspace, ".kilo", "skills", "e2e-skill", "SKILL.md")
  mkdirSync(dirname(skillFile), { recursive: true })
  writeFileSync(
    skillFile,
    [
      "---",
      "name: e2e-skill",
      "description: E2E completed skill fixture",
      "---",
      "",
      "# E2E Skill",
      "",
      "E2E_SKILL_CONTENT_MARKER",
      "",
    ].join("\n"),
  )

  // No-op dependency guard: prevent the detached Npm.install("@kilocode/plugin")
  // fiber from reifying into the run-owned .kilo config dir.
  const kiloDir = join(workspace, ".kilo")
  mkdirSync(join(kiloDir, "node_modules"), { recursive: true })
  writeFileSync(
    join(kiloDir, "package-lock.json"),
    JSON.stringify({
      name: "kilo-e2e-workspace",
      version: "0.0.0",
      lockfileVersion: 3,
      packages: { "": { dependencies: { "@kilocode/plugin": "0.0.0" } } },
    }),
  )

  // H-5: the stdio MCP server fixture (run-owned).
  mkdirSync(dirname(mcpServerFile), { recursive: true })
  writeFileSync(mcpServerFile, buildMcpServerScript(sdkEsmDir, "e2e_echo"))

  // H-6: the permission target file (sentinel content returned by the read tool).
  const permissionFile = join(workspace, "ask.txt")
  writeFileSync(permissionFile, "E2E_PERMISSION_SENTINEL\n")

  // H-12: the tracked rollback file with KNOWN bytes, committed by
  // initWorkspaceGit so the write tool's snapshot/revert has the exact
  // pre-edit state to restore.
  const rollbackFile = join(workspace, SCRIPTED.rollbackFile)
  writeFileSync(rollbackFile, SCRIPTED.rollbackOriginal)

  return {
    configFile,
    userToolFile,
    skillFile,
    mcpServerFile,
    mcpLogPath: join(workspace, "mcp-fixture", "calls.log"),
    permissionFile,
    rollbackFile,
  }
}

/**
 * Make the run-owned workspace a git repo BEFORE VS Code launches. The shared
 * backend's Project.resolve (packages/core/src/project.ts) returns vcs only
 * when git.find locates a .git up-tree; without one the project resolves to
 * the global id and Project.fromDirectory sets worktree="/". The read tool
 * then forms its permission pattern as path.relative("/", file) — e.g.
 * "private/var/folders/.../workspace/ask.txt" — which never matches the
 * seeded relative rule "ask.txt" (only the "*" allow matches), so no pending
 * read permission and no PermissionDock. Initializing the workspace as a git
 * repo makes worktree == workspace, so the pattern is exactly "ask.txt" and
 * the seeded rule fires (matching the P0 H-6 fixture, which uses git: true).
 * Run-owned only: the repo lives in the scratch workspace the harness deletes.
 */
export function initWorkspaceGit(workspace: string): void {
  const git = (args: string[]) =>
    spawnSync("git", args, {
      cwd: workspace,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "kilo-e2e",
        GIT_AUTHOR_EMAIL: "e2e@localhost",
        GIT_COMMITTER_NAME: "kilo-e2e",
        GIT_COMMITTER_EMAIL: "e2e@localhost",
      },
    })
  const init = git(["init", "-q", "-b", "main"])
  if (init.status !== 0) throw new Error(`probe: workspace git init failed: ${init.stderr}`)
  const add = git(["add", "-A"])
  if (add.status !== 0) throw new Error(`probe: workspace git add failed: ${add.stderr}`)
  const commit = git(["commit", "-q", "-m", "e2e seed"])
  if (commit.status !== 0) throw new Error(`probe: workspace git commit failed: ${commit.stderr}`)
}
