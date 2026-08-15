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

export interface RestartSeedPaths {
  configFile: string
  userToolFile: string
  artifactFile: string
}

/** The exact bytes the run-owned user tool writes into the artifact file. */
export const RESTART_ARTIFACT_CONTENT = `echo:${"restart"}`

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

  return {
    configFile,
    userToolFile,
    artifactFile: join(workspace, "e2e-custom-called.txt"),
  }
}
