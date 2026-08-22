/**
 * Run-owned workspace seed for the real-restart E2E scenario (harness process
 * only — script/e2e-probe.ts imports this; never bundled into the extension).
 * Written into the scratch workspace BEFORE VS Code launches so the
 * lazily-spawned CLI backend loads every fixture at instance init:
 *
 *   - .kilo/kilo.json        — custom provider e2e-local/e2e-model pointing at
 *                              the run-owned scripted model server, one custom
 *                              primary agent (e2e-agent), and the default
 *                              model. Deliberately MINIMAL: no MCP, no skills,
 *                              no permission rules — but every implicit
 *                              generation (title via small_model, subagent via
 *                              subagent_model) is pinned to the run-owned
 *                              provider so no restart boundary can fall
 *                              through to the kilo gateway (LOCK-006).
 *   - .kilo/tool/e2e_marker.ts — the H-3 user-defined tool (writes a
 *                              run-owned artifact file via ctx.directory).
 *   - .kilo/node_modules + .kilo/package-lock.json — the no-op dependency
 *                              guard (same rationale as writeRealCompletedSeed).
 *
 * The scripted model's E2E_RESTART_PROMPT branch calls the user tool once
 * (writes e2e-custom-called.txt = "echo:restart") and then replies with the
 * fixed E2E_RESTART_DONE text — the durable transcript marker + artifact the
 * harness re-asserts after the SSE reconnect, the exact worker kill, and the
 * true window/extension restart, all from the SAME run-owned XDG scratch.
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { CONFIG_FILENAME } from "../src/config/paths"

/** The agent asset ids/labels the real-* scenarios pick through ModeSwitcher. */
export const REAL_AGENT_ASSETS = [
  { id: "e2e-agent", displayName: "E2E Agent", description: "E2E restart custom agent" },
  { id: "e2e-agent-b", displayName: "E2E Agent B", description: "E2E restart custom agent B" },
] as const

export interface RestartSeedPaths {
  configFile: string
  /** Project-scope canonical config the extension's CanonicalConfigService reads. */
  canonicalFile: string
  userToolFile: string
  artifactFile: string
}

export interface RealGlobalSeedPaths {
  configDir: string
  agentDir: string
  assetFiles: string[]
}

/** The exact bytes the run-owned user tool writes into the artifact file. */
export const RESTART_ARTIFACT_CONTENT = `echo:${"restart"}`

/**
 * The SAME run-owned provider in the closed canonical project-scope shape the
 * extension's CanonicalConfigService validator accepts (types.ts
 * APPROVED_PROVIDER_KEYS: name/endpoint/protocol/models/credential only;
 * protocol from CANONICAL_PROTOCOLS; no plaintext apiKey needed for a local
 * openai-compatible endpoint). The kilo.json backend seed above feeds ONLY the
 * CLI backend — the extension reads exclusively <workspace>/.kilo/kilo.jsonc
 * (paths.ts projectConfigFile), so without this seed the canonical provider
 * index can never serve e2e-local and waitForModelSelected(e2e-local/e2e-model)
 * cannot pass even after agents appear.
 */
export function realProjectSeed(port: number): Record<string, unknown> {
  return {
    model: "e2e-local/e2e-model",
    provider: {
      "e2e-local": {
        name: "E2E Local",
        endpoint: `http://127.0.0.1:${port}/v1`,
        protocol: "openai",
        credential: "secret:kilo.credentials.project.provider.e2e-local",
        models: {
          "e2e-model": {
            name: "E2E Model",
            variants: { low: {}, medium: {}, high: {} },
          },
        },
      },
    },
  }
}

export function writeRealRestartSeed(workspace: string, port: number, pluginToolUrl: string): RestartSeedPaths {
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
            description: "E2E restart custom agent",
            mode: "primary",
            model: "e2e-local/e2e-model",
          },
        },
        model: "e2e-local/e2e-model",
        small_model: "e2e-local/e2e-model",
        subagent_model: "e2e-local/e2e-model",
      },
      null,
      2,
    ),
  )

  // Project-scope canonical seed (extension-only; see realProjectSeed). The
  // backend kilo.json seed stays untouched — this is an additional file.
  const canonicalFile = join(workspace, ".kilo", CONFIG_FILENAME)
  writeFileSync(canonicalFile, JSON.stringify(realProjectSeed(port), null, 2))

  // The user-defined tool through the real ToolRegistry (plugin bridge): its
  // execute writes the run-owned artifact file under ctx.directory, so the
  // artifact is durable on disk across every restart boundary.
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

  // No-op dependency guard (same rationale as writeRealCompletedSeed): prevent
  // the detached Npm.install("@kilocode/plugin") fiber from reifying into the
  // run-owned .kilo config dir.
  const kiloDir = join(workspace, ".kilo")
  writeDependencyGuard(kiloDir, "kilo-e2e-workspace")

  return {
    configFile,
    canonicalFile,
    userToolFile,
    artifactFile: join(workspace, "e2e-custom-called.txt"),
  }
}

/**
 * The no-op dependency guard consumed by core Npm.install: an existing
 * node_modules dir makes the reify step skip (packages/core/src/npm.ts), so
 * the doomed background install of the unpublished branch version never runs.
 */
function writeDependencyGuard(dir: string, name: string): void {
  mkdirSync(join(dir, "node_modules"), { recursive: true })
  writeFileSync(
    join(dir, "package-lock.json"),
    JSON.stringify({
      name,
      version: "0.0.0",
      lockfileVersion: 3,
      packages: { "": { dependencies: { "@kilocode/plugin": "0.0.0" } } },
    }),
  )
}

/**
 * real-* scenarios only: seed the run-owned GLOBAL canonical root
 * `<scratch>/xdg-config/kilo` BEFORE the first kilo serve spawn:
 *
 *   - node_modules + package-lock.json — the same no-op dependency guard as
 *     the workspace seed, because core scans Global.Path.config (= this dir
 *     under the scratch XDG tree) and forks a detached background install of
 *     the unpublished branch version of @kilocode/plugin.
 *   - agent/<id>.md — one valid canonical agent asset per ModeSwitcher fixture
 *     identity. Post-S5 cutover, agents reach ModeSwitcher ONLY through the
 *     extension's CanonicalConfigService asset index, which scans these .md
 *     files under the XDG-honoring global root; kilo.json agent records never
 *     enter that index. Frontmatter satisfies validate.ts's strict agent
 *     schema; the model/variant pin comes from the workspace kilo.json seed.
 *
 * Hermetic by construction: everything lives inside <scratch>/xdg-config, and
 * the extension resolves the same root via XDG_CONFIG_HOME (paths.ts).
 */
export function writeRealGlobalSeed(scratch: string): RealGlobalSeedPaths {
  const configDir = join(scratch, "xdg-config", "kilo")
  writeDependencyGuard(configDir, "kilo-e2e-global")

  const agentDir = join(configDir, "agent")
  mkdirSync(agentDir, { recursive: true })
  const assetFiles = REAL_AGENT_ASSETS.map((asset) => {
    const file = join(agentDir, `${asset.id}.md`)
    writeFileSync(
      file,
      [
        "---",
        `displayName: ${asset.displayName}`,
        `description: ${asset.description}`,
        "mode: primary",
        "---",
        "",
        `You are ${asset.displayName}, the E2E fixture agent.`,
        "",
      ].join("\n"),
    )
    return file
  })

  return { configDir, agentDir, assetFiles }
}
