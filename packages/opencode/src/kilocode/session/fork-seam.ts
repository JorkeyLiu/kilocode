// Deterministic failure injection for fork tests.
// Production defaults are all false/undefined; tests may mutate these globals.
// This module intentionally has no external dependencies and is not used in
// production code paths except for checking the flags in fork dispatch and
// cumulative diff. Crash residual is explicitly unclaimed.
export const ForkSeam = {
  // If set, the next fork will use this ID instead of SessionID.descending().
  // Consumed after one use (reset to undefined).
  nextId: undefined as string | undefined,
  // Fail the second diff write (session_diff/<target>) after the first (session_diff_base) succeeded.
  failSecondDiffWrite: false,
  // Fail the first diff write.
  failFirstDiffWrite: false,
  // Fail sandbox inherit/write.
  failSandboxWrite: false,
  // Fail the DB transaction after successful filesystem writes (simulates later
  // DB work failure, e.g., EventV2 or operation insert). Triggers ownership
  // compensation that must remove only artifacts owned by this attempt.
  failTxAfterFs: false,
  // Test-only: fail any claimed-file write after exclusive handle acquired (write/close).
  // Simulates write-after-claim failure to verify claimed-path cleanup.
  failClaimedWriteAfterOpen: false,
  // Test-only: fail cleanup of owned artifacts to prove original error preserved,
  // warning with target/cause emitted, and ownership flag retained (no false success).
  failCleanupFs: false,
  failCleanupStorage: false,
  capturedCleanupWarnings: [] as Array<{ target: string; cause: string }>,
}
