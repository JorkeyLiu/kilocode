/**
 * Pure source wrapper generation logic.
 *
 * Extracted from local-bin.ts so tests can exercise the actual generator
 * without depending on the generated bin/kilo artifact (which is git-ignored
 * and absent on clean checkout).
 */

/** Generate the bash wrapper content that runs the CLI from source. */
export function generateSourceWrapperContent(opencodeDir: string, bunPath: string): string {
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `cd ${JSON.stringify(opencodeDir)}`,
    `exec ${JSON.stringify(bunPath)} --conditions=browser src/index.ts "$@"`,
    "",
  ].join("\n")
}
