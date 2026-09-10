import type { AssetDirectory, CanonicalPaths } from "./types"
import type { ConfigConvergenceAdapter, ConvergenceDescriptor, ConvergenceState } from "./convergence"

export function configDescriptor(paths: CanonicalPaths, scope: "global" | "project"): ConvergenceDescriptor {
  if (scope === "global") return { kind: "config", scope: "global" }
  return { kind: "config", scope: "project", directory: paths.projectRoot! }
}

export function assetDescriptor(
  paths: CanonicalPaths,
  assetType: AssetDirectory,
  id: string,
  scope: "global" | "project",
): ConvergenceDescriptor {
  if (scope === "global") return { kind: "asset", asset: assetType, scope: "global", id }
  return { kind: "asset", asset: assetType, scope: "project", directory: paths.projectRoot!, id }
}

/**
 * Acquire once; run inside try/finally with exactly-once best-effort
 * resolve after acquire success — run return, throw, or caller abort all
 * settle the lease (F1). The original run exception always rethrows;
 * resolve never converts a failure into success. Adapter absence (tests
 * without convergence) runs directly with no fence.
 */
export async function withFence<R extends { ok: boolean }>(
  adapter: ConfigConvergenceAdapter | undefined,
  descriptors: readonly ConvergenceDescriptor[],
  run: () => Promise<R>,
  blocked: (message: string) => R,
): Promise<R & { convergence?: ConvergenceState }> {
  if (!adapter) return (await run()) as R & { convergence?: ConvergenceState }
  const acquired = await adapter.acquire(descriptors)
  if (!acquired.ok) return blocked(`Runtime convergence fence unavailable; write blocked: ${acquired.message}`)
  let result: R | undefined
  let failure: unknown
  let failed = false
  try {
    result = await run()
  } catch (err) {
    failed = true
    failure = err
  }
  let state: ConvergenceState | undefined
  try {
    state = await adapter.resolve(acquired.leaseId)
  } catch {
    state = { status: "pending", message: "runtime convergence pending" }
  }
  if (failed) throw failure
  if (result!.ok && state) return { ...result!, convergence: state }
  return result as R & { convergence?: ConvergenceState }
}
