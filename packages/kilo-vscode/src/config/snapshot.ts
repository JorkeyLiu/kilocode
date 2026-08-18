/**
 * P4.1 Immutable snapshot lease/read API.
 *
 * A caller can retain a MaterializedConfig object while later valid edits
 * create a new object for new readers. Old objects remain unchanged.
 * This supplies P4.1's generation-pinning-ready contract; private runtime
 * generation consumption lands P4.2.
 */

import type { MaterializedConfig } from "./types"

/**
 * An immutable snapshot that callers can retain without being affected
 * by later materializations. The snapshot holds a reference to the exact
 * frozen MaterializedConfig produced at materialization time.
 */
export interface ConfigSnapshot {
  /** The materialized config at the time this snapshot was taken. */
  readonly config: MaterializedConfig
  /** Monotonic generation counter (matches config.version). */
  readonly generation: number
  /** Content hash at snapshot time. */
  readonly contentHash: string
}

/**
 * Create an immutable snapshot from a materialized config.
 */
export function snapshot(config: MaterializedConfig): ConfigSnapshot {
  return {
    config,
    generation: config.version,
    contentHash: config.contentHash,
  }
}

/**
 * Compare two snapshots for identity (same generation and content hash).
 */
export function sameSnapshot(a: ConfigSnapshot, b: ConfigSnapshot): boolean {
  return a.generation === b.generation && a.contentHash === b.contentHash
}
