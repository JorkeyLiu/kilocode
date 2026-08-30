import fs from "node:fs"
import path from "node:path"
import type { Info } from "@/config/config"

export const E2E_MARKER_FILENAME = "e2e-marker.json"
const E2E_FIXTURE_ID_ENV = "KILO_E2E_FIXTURE_ID"
const SCRATCH_PREFIX = "kilo-e2e-"
const MARKER_MAX_BYTES = 2048

export function isE2EFixtureEnabled(): boolean {
  return process.env.KILO_E2E_FIXTURE === "1"
}

function isValidScratchShape(value: string): boolean {
  if (!value || value.length === 0) return false
  if (value.includes("\0")) return false
  if (!path.isAbsolute(value)) return false
  if (path.normalize(value) !== value) return false
  if (value.split(path.sep).includes("..")) return false
  if (value === "/tmp" || value === "/tmp/" || value === "/private/tmp" || value === "/private/tmp/") return false
  const base = path.basename(value)
  if (!base.startsWith(SCRATCH_PREFIX)) return false
  return true
}

// eslint-disable-next-line complexity
function isValidMarker(scratch: string, fixtureId: string | undefined): boolean {
  if (!fixtureId || fixtureId.length === 0 || fixtureId.length > 256) return false
  if (fixtureId.includes("\0") || fixtureId.includes("/") || fixtureId.includes("\\")) return false
  if (scratch.includes("\0")) return false
  if (scratch.split(path.sep).includes("..")) return false
  if (path.normalize(scratch) !== scratch) return false
  const markerPath = path.join(scratch, E2E_MARKER_FILENAME)
  if (markerPath.includes("\0") || markerPath.split(path.sep).includes("..")) return false
  if (path.normalize(markerPath) !== markerPath) return false
  try {
    const scratchLstat = fs.lstatSync(scratch)
    if (!scratchLstat.isDirectory()) return false
    if (scratchLstat.isSymbolicLink()) return false
    const markerLstat = fs.lstatSync(markerPath)
    if (!markerLstat.isFile()) return false
    if (markerLstat.isSymbolicLink()) return false
    if (markerLstat.size === 0 || markerLstat.size > MARKER_MAX_BYTES) return false
    const realScratch = fs.realpathSync(scratch)
    const realMarker = fs.realpathSync(markerPath)
    const rel = path.relative(realScratch, realMarker)
    if (rel.startsWith("..") || path.isAbsolute(rel)) return false
    if (rel !== E2E_MARKER_FILENAME) return false
    const raw = fs.readFileSync(markerPath, "utf8")
    if (raw.length > MARKER_MAX_BYTES) return false
    if (Buffer.byteLength(raw, "utf8") > MARKER_MAX_BYTES) return false
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (Object.keys(parsed).length !== 2) return false
    if (!("v" in parsed) || !("fixtureId" in parsed)) return false
    if (parsed.v !== 1) return false
    if (typeof parsed.fixtureId !== "string") return false
    if (parsed.fixtureId.length === 0 || parsed.fixtureId !== fixtureId) return false
    return true
  } catch {
    return false
  }
}

/**
 * Narrowly validated CLI-side E2E runtime provider seam.
 *
 * Fixed constants: provider ID e2e-local, model e2e-model, npm
 * @ai-sdk/openai-compatible, baseURL loopback http(s) /v1, apiKey fixture
 * value. Gate on KILO_E2E_FIXTURE=1 plus absolute KILO_E2E_SCRATCH and
 * KILO_E2E_PROVIDER_BASE_URL. No arbitrary JSON/config payload, no public Flag.
 *
 * This module is internal to Config.Service — not a public API, not a Flag,
 * not a CLI arg, not a SDK field, not a config file scope, not an endpoint
 * mapping. The synthetic fragment is lowest-priority global so project canonical
 * metadata (endpoint/protocol/credential/models) merges over it.
 */

const PROVIDER_ID = "e2e-local"
const MODEL_ID = "e2e-model"
const PROVIDER_NPM = "@ai-sdk/openai-compatible"
const FIXTURE_API_KEY = "e2e-fixture-key"

function isValidBaseURL(value: string): boolean {
  try {
    const url = new URL(value)
    if (url.protocol !== "http:" && url.protocol !== "https:") return false
    const host = url.hostname
    if (host !== "127.0.0.1" && host !== "localhost") return false
    if (url.username || url.password) return false
    if (url.search || url.hash) return false
    if (url.pathname !== "/v1") return false
    // no credentials/query/hash validated above; pathname must be exactly /v1
    return true
  } catch {
    return false
  }
}

export function isValidE2EBaseURL(value: unknown): boolean {
  if (typeof value !== "string" || value.length === 0) return false
  return isValidBaseURL(value)
}

export function isValidE2EScratch(value: unknown): boolean {
  if (typeof value !== "string" || value.length === 0) return false
  if (!isValidScratchShape(value)) return false
  // marker required: proves scratch belongs to current harness run
  const fixtureId = process.env[E2E_FIXTURE_ID_ENV]
  if (!isValidMarker(value, fixtureId)) return false
  return true
}

export function isValidScratchForTest(scratch: string): boolean {
  return isValidE2EScratch(scratch)
}

/**
 * Returns the synthetic E2E Info fragment when all gates pass, otherwise null.
 * Fail-closed: invalid or missing gate → null (no injection, no error throw).
 * Requires run-owned marker: scratch basename kilo-e2e-*, marker file exists as
 * regular file under scratch, marker fixtureId matches KILO_E2E_FIXTURE_ID,
 * bounded read, no symlink escape, loopback /v1.
 */
export function getE2EProviderFragment(): Info | null {
  if (!isE2EFixtureEnabled()) return null
  const scratch = process.env.KILO_E2E_SCRATCH
  if (!isValidE2EScratch(scratch)) return null
  const baseURL = process.env.KILO_E2E_PROVIDER_BASE_URL
  if (!isValidBaseURL(baseURL ?? "")) return null
  // Fixed exact provider/model — no arbitrary payload.
  return {
    model: `${PROVIDER_ID}/${MODEL_ID}`,
    small_model: `${PROVIDER_ID}/${MODEL_ID}`,
    subagent_model: `${PROVIDER_ID}/${MODEL_ID}`,
    provider: {
      [PROVIDER_ID]: {
        npm: PROVIDER_NPM,
        name: "E2E Local",
        options: {
          baseURL,
          apiKey: FIXTURE_API_KEY,
          timeout: false,
          headerTimeout: false,
          firstChunkTimeout: false,
        },
        models: {
          [MODEL_ID]: {
            name: "E2E Model",
          },
        },
      },
    },
  } as unknown as Info
}

/** For ServerManager validation (shared logic without importing Info). */
export function isE2EProviderEnvValid(env: NodeJS.ProcessEnv): boolean {
  if (env.KILO_E2E_FIXTURE !== "1") return false
  const scratch = env.KILO_E2E_SCRATCH
  if (typeof scratch !== "string" || !isValidScratchShape(scratch)) return false
  const fixtureId = env[E2E_FIXTURE_ID_ENV]
  if (!isValidMarker(scratch, fixtureId)) return false
  if (!isValidBaseURL(env.KILO_E2E_PROVIDER_BASE_URL ?? "")) return false
  return true
}

export function validateE2EFixtureMarkerForTest(scratch: string, fixtureId: string | undefined): boolean {
  return isValidMarker(scratch, fixtureId)
}

/** Fixed constants for tests — proves exact provider/model/npm/apiKey/baseURL shape. */
export const E2E_FIXTURE_CONSTANTS = {
  providerId: PROVIDER_ID,
  modelId: MODEL_ID,
  npm: PROVIDER_NPM,
  apiKey: FIXTURE_API_KEY,
  modelString: `${PROVIDER_ID}/${MODEL_ID}`,
} as const
