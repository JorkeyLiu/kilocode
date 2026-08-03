// Kilo-owned helper for the canonical committed models snapshot.
//
// Normal builds (script/generate.ts) read this committed snapshot with no
// network access. The only build-snapshot network path is the explicit
// refresh operation (script/kilocode/refresh-models.ts), which validates the
// fetched data with the existing parser before atomically replacing the file.

import path from "path"
import { fileURLToPath } from "url"
import { rm, rename, writeFile } from "fs/promises"
import { parseModelsSnapshot } from "../../src/kilocode/provider/models-snapshot-shape"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const root = path.resolve(__dirname, "..", "..")

/** Package-root-relative path to the canonical committed models snapshot. */
export const MODELS_SNAPSHOT_RELATIVE = "src/kilocode/provider/models-api.json"

/** Absolute path to the canonical committed models snapshot. */
export function modelsSnapshotPath(pkgRoot = root): string {
  return path.join(pkgRoot, MODELS_SNAPSHOT_RELATIVE)
}

/** Raw snapshot text: committed snapshot by default, MODELS_DEV_API_JSON override. */
export async function loadModelsSnapshot(env: Record<string, string | undefined> = process.env) {
  const override = env["MODELS_DEV_API_JSON"]
  const file = override ? override : modelsSnapshotPath()
  return {
    text: await Bun.file(file).text(),
    source: override ? ("override" as const) : ("committed" as const),
    file,
  }
}

/** The refresh fetch is bounded: abort a stalled request after this long. */
export const MODELS_REFRESH_TIMEOUT_MS = 30_000

/**
 * Fetch `${url}/api.json`, validate it with the models snapshot parser, then
 * atomically replace the snapshot at `file`. Any fetch (including a timeout
 * abort), schema, or write failure preserves the existing snapshot. Returns
 * validation stats.
 */
export async function refreshModelsSnapshot(
  url: string,
  file = modelsSnapshotPath(),
  timeout = MODELS_REFRESH_TIMEOUT_MS,
) {
  try {
    const res = await fetch(`${url}/api.json`, { signal: AbortSignal.timeout(timeout) })
    if (!res.ok) throw new Error(`models.dev fetch failed: HTTP ${res.status} (${url}/api.json)`)
    const text = await res.text()
    const parsed = parseModelsSnapshot(text, `${url}/api.json`)
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    try {
      await writeFile(tmp, text)
      await rename(tmp, file)
    } finally {
      await rm(tmp, { force: true })
    }
    return parsed.stats
  } catch (err) {
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      throw new Error(`models.dev fetch timed out after ${timeout}ms (${url}/api.json)`, { cause: err })
    }
    throw err
  }
}
