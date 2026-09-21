export interface TerminalFont {
  fontFamily: string
  fontSize: number
}

export interface ManagedSessionState {
  id: string
  createdAt: string
}

export interface PanelOperation {
  opId: string
  outcome: "succeeded" | "failed" | "ambiguous" | "in-flight" | "superseded" | "abandoned"
  code: string
  message: string
  time: number
  cancel?: { source: "user_stop" | "steering" | "timeout" | "network_disconnect" | "unknown" }
}

/**
 * Per-session cumulative active-generation runtime, pushed by the extension
 * host. Must stay in sync with src/agent-manager/session-timing.ts.
 */
export interface SessionTimingEntry {
  /** Settled milliseconds across all completed active segments. */
  elapsedMs: number
  /** Epoch ms when the current active segment started; absent when idle/settled. */
  activeStart?: number
}

// Per-local-workspace git stats: branch name, diff additions/deletions, ahead/behind counts
export interface LocalGitStats {
  branch: string
  files: number
  additions: number
  deletions: number
  ahead: number
  behind: number
}

export type { ReviewCommentData as ReviewComment } from "../../../../src/shared/review-comments"
