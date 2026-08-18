import type { CanonicalConfigService } from "../config/service"

export type KiloProviderOptions = {
  projectDirectory?: string | null
  platform?: string
  snapshotInitialization?: "wait"
  slimEditMetadata?: boolean
  tabTitle?: (title: string) => void
  /** Composite hosts (Agent Manager) own viewed/presence registration themselves. */
  disableViewedRegistration?: boolean
  /**
   * Test-only identity hook: inject a scheduler for the reconciliation retry
   * backoff. Returns a cancel function; defaults to setTimeout/clearTimeout.
   * Tests pass a fake clock so bounded backoff (LOCK-003) is deterministic
   * without real-time sleeps.
   */
  scheduleRetry?: (delayMs: number, fn: () => void) => () => void
  /** Canonical GUI authority for config, custom providers, and agents. */
  canonicalConfig?: CanonicalConfigService
}
