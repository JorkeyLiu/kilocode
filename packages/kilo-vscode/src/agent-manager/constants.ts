/** Telemetry source identifier for all Agent Manager events. */
export const PLATFORM = "agent-manager" as const

/** Keep baseline snapshots without interrupting concurrently started agents. */
export const SNAPSHOT_INITIALIZATION = "wait" as const

/** Kilo config directory name. */
export const KILO_DIR = ".kilo"
