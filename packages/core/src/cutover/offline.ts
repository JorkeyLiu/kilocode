/**
 * Internal offline cutover invocation path — not a public product surface.
 * Must be called with runtime quiesced and no handles open; it proves
 * exclusivity via filesystem lock and wal_checkpoint busy check, owns the
 * full archive→staged→atomic-handoff sequence, and retains the lock through
 * publication and activation. Normal activation must pass through verifyGate.
 */
import path from "path"
import { runCutover, recoverCutover, isFresh } from "./cutover"

export async function runOfflineCutover(opts: { dataRoot: string; archiveID?: string }): Promise<{ archiveID: string; archivePath: string }> {
  const root = path.resolve(opts.dataRoot)
  // refuse if runtime exclusivity cannot be proven: if a marker from previous crash remains, recover first
  await recoverCutover(root)
  return runCutover(opts)
}

export async function assertCanonicalActivation(dataRoot: string): Promise<void> {
  const ok = await isFresh(dataRoot)
  if (!ok) throw new Error("canonical boot gate failed: fresh activation verification did not pass")
}

export { recoverCutover }
