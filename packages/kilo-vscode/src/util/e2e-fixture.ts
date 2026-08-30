import * as fs from "fs"
import * as path from "path"

export const E2E_FIXTURE_ENV = "KILO_E2E_FIXTURE"
export const E2E_FIXTURE_ID_ENV = "KILO_E2E_FIXTURE_ID"
export const E2E_MARKER_FILENAME = "e2e-marker.json"
export const E2E_SCRATCH_PREFIX = "kilo-e2e-"
const MARKER_MAX_BYTES = 2048

export function isE2EFixtureEnabled(): boolean {
  return process.env[E2E_FIXTURE_ENV] === "1"
}

function isValidScratchShape(value: string): boolean {
  if (!value || value.length === 0) return false
  if (value.includes("\0")) return false
  if (!path.isAbsolute(value)) return false
  if (path.normalize(value) !== value) return false
  if (value.split(path.sep).includes("..")) return false
  if (value === "/tmp" || value === "/tmp/" || value === "/private/tmp" || value === "/private/tmp/") return false
  const base = path.basename(value)
  if (!base.startsWith(E2E_SCRATCH_PREFIX)) return false
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
    // Reject symlinks explicitly via lstat before any realpath; residual TOCTOU
    // between lstat and read remains (no portable O_NOFOLLOW in Bun on Darwin/Linux for this seam).
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
    // Bounded read: enforce 2 KiB limit on raw bytes before parse
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

export function isValidE2EScratch(scratch: string | undefined): boolean {
  if (!scratch || scratch.length === 0) return false
  if (!isValidScratchShape(scratch)) return false
  const fixtureId = process.env[E2E_FIXTURE_ID_ENV]
  if (!isValidMarker(scratch, fixtureId)) return false
  return true
}

export function isValidE2EProviderEnv(env: NodeJS.ProcessEnv): boolean {
  if (env[E2E_FIXTURE_ENV] !== "1") return false
  const scratch = env.KILO_E2E_SCRATCH
  if (typeof scratch !== "string" || !isValidScratchShape(scratch)) return false
  const fixtureId = env[E2E_FIXTURE_ID_ENV]
  if (!isValidMarker(scratch, fixtureId)) return false
  const baseURL = env.KILO_E2E_PROVIDER_BASE_URL
  if (!baseURL || typeof baseURL !== "string") return false
  try {
    const url = new URL(baseURL)
    if (url.protocol !== "http:" && url.protocol !== "https:") return false
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") return false
    if (url.username || url.password) return false
    if (url.search || url.hash) return false
    if (url.pathname !== "/v1") return false
    return true
  } catch {
    return false
  }
}

export function createE2EMarker(scratch: string, fixtureId: string): void {
  const markerPath = path.join(scratch, E2E_MARKER_FILENAME)
  const payload = JSON.stringify({ v: 1, fixtureId })
  fs.writeFileSync(markerPath, payload, "utf8")
}
