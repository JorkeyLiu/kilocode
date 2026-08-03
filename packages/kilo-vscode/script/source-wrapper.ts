/**
 * Pure source wrapper generation logic.
 *
 * Extracted from local-bin.ts so tests can exercise the actual generator
 * without depending on the generated bin/kilo artifact (which is git-ignored
 * and absent on clean checkout).
 */

import { join } from "node:path"

const COMMITTED_MODELS_FIXTURE = "src/kilocode/provider/models-api.json"

/** Absolute path to the committed models-api.json fixture. */
export function committedModelsFixturePath(opencodeDir: string): string {
  return join(opencodeDir, COMMITTED_MODELS_FIXTURE)
}

/** Relative segments of the fixture path (for source-map / doc purposes). */
export const FIXTURE_RELATIVE = COMMITTED_MODELS_FIXTURE

/**
 * Generate the bash wrapper content that runs the CLI from source.
 *
 * The wrapper exports KILO_MODELS_PATH to the committed fixture so cold
 * source-dev provider catalog contains catalog-only providers/models
 * (e.g. opencode-go/mimo-v2.5) even when models.dev network and user
 * disk cache are unavailable. Callers can override KILO_MODELS_PATH.
 */
export function generateSourceWrapperContent(opencodeDir: string, bunPath: string): string {
  const fixturePath = JSON.stringify(committedModelsFixturePath(opencodeDir)).slice(1, -1)
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `cd ${JSON.stringify(opencodeDir)}`,
    `export KILO_MODELS_PATH="\${KILO_MODELS_PATH:-${fixturePath}}"`,
    `exec ${JSON.stringify(bunPath)} --conditions=browser src/index.ts "$@"`,
    "",
  ].join("\n")
}
