/**
 * Pure source wrapper generation logic.
 *
 * Extracted from local-bin.ts so tests can exercise the actual generator
 * without depending on the generated bin/kilo artifact (which is git-ignored
 * and absent on clean checkout).
 */

 /** Generate the bash wrapper content that runs the full CLI from source (legacy dev path). */
export function generateSourceWrapperContent(opencodeDir: string, bunPath: string): string {
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `cd ${JSON.stringify(opencodeDir)}`,
    `exec ${JSON.stringify(bunPath)} --conditions=browser src/index.ts "$@"`,
    "",
  ].join("\n")
}

/** Generate the bash wrapper content that runs the serve-only backend from source. */
export function generateServeSourceWrapperContent(opencodeDir: string, bunPath: string): string {
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `cd ${JSON.stringify(opencodeDir)}`,
    `exec ${JSON.stringify(bunPath)} --conditions=browser src/serve-entry.ts "$@"`,
    "",
  ].join("\n")
}
