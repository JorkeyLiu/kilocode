/**
 * S0 Lossless-family fixture builders and reproducible aggregate measurement
 * helpers for P4.2a storage baseline.
 *
 * Fixture classes establish deterministic inputs for S1-S5 without implementing
 * any future behavior.  Each class evidences owner/activity/lease relationships
 * that the retention engine (S2) must respect.
 *
 * The section 10 sqlite3 CLI commands are frozen as the canonical production
 * measurement surface.  Test-level aggregate verification uses service APIs
 * (SessionNs.Service) that share the same DB context as session operations,
 * avoiding the separate-:memory: SQLite problem with cross-connection queries.
 */
// ---------------------------------------------------------------------------
// Frozen section 10 measurement commands (canonical production surface)
// ---------------------------------------------------------------------------

/**
 * Exact executable sqlite3 CLI commands parameterized by a DB path.
 * These are the canonical read-only production measurement surface.
 *
 * Usage: `sqlite3 "file:<dbPath>?mode=ro" "<command>"`
 * Or equivalently: `sqlite3 <dbPath> "<command>"` (read-only mode is safer via URI)
 */
export const section10Sqlite3Command = (dbPath: string, sql: string) => `sqlite3 "file:${dbPath}?mode=ro" "${sql}"`

/**
 * Exact executable shell command for the file-store measurement.
 * This is a du(1) command, NOT a sqlite3 SQL statement — it must not be
 * wrapped in a sqlite3 invocation.
 *
 * Usage: `du -sh ~/.local/share/kilo/storage/* ~/.local/share/kilo/snapshot`
 */
export const section10FileStoresCommand = () => `du -sh ~/.local/share/kilo/storage/* ~/.local/share/kilo/snapshot`

/**
 * All frozen section 10 measurement commands.
 * SQL commands are sqlite3-wrapped; file-store commands are shell commands.
 */
export const SECTION_10_COMMANDS = {
  eventAggregate: `SELECT 'event', count(*), round(sum(length(data))/1024.0/1024.0, 1) FROM event;`,
  messageAggregate: `SELECT 'message', count(*), round(sum(length(data))/1024.0/1024.0, 1) FROM message;`,
  partAggregate: `SELECT 'part', count(*), round(sum(length(data))/1024.0/1024.0, 1) FROM part;`,
  sessionAggregate: `SELECT 'session', count(*), round(sum(length(data))/1024.0/1024.0, 1) FROM session;`,
  eventTypeBreakdown: `SELECT type, count(*), round(sum(length(data))/1024.0/1024.0, 1) FROM event GROUP BY type ORDER BY 3 DESC;`,
} as const

/** The five SQL fragments — these are wrapped by section10Sqlite3Command. */
export const SECTION_10_SQL = SECTION_10_COMMANDS

/**
 * Render a complete measurement command for the given DB path.
 * SQL commands produce a sqlite3 invocation; fileStores produces a du invocation.
 */
export const renderSection10Command = (dbPath: string, key: keyof typeof SECTION_10_COMMANDS | "fileStores") => {
  if (key === "fileStores") return section10FileStoresCommand()
  return section10Sqlite3Command(dbPath, SECTION_10_COMMANDS[key])
}

// ---------------------------------------------------------------------------
// Fixture hold token — S0 test-only read/maintenance hold model
// ---------------------------------------------------------------------------

/**
 * Scoped run-owned hold token representing a read/maintenance hold on a
 * session family.  This is a test fixture state, NOT a production lease.
 *
 * S2 must bind this input to a real production maintenance/read lease.
 * No claim of target protection is made here — this is an S0 input fixture
 * establishing the shape of data that S2 will consume.
 *
 * The hold exposes observable held/released state and enforces single-use
 * acquire/release lifecycle: release() transitions the hold to released and
 * is idempotent; assertHeld() and assertReleased() are the test observation
 * surface.
 */
export class TestHoldToken {
  readonly sessionID: string
  readonly holder: string
  readonly acquiredAt: number
  #released = false

  constructor(sessionID: string, holder: string) {
    this.sessionID = sessionID
    this.holder = holder
    this.acquiredAt = Date.now()
  }

  get isHeld(): boolean {
    return !this.#released
  }

  get isReleased(): boolean {
    return this.#released
  }

  /** Transition to released.  Idempotent — second call is a no-op. */
  release(): void {
    this.#released = true
  }

  /** Assert the hold is still held; throws if released. */
  assertHeld(): void {
    if (this.#released) throw new Error(`HoldToken released but assertHeld called (session=${this.sessionID})`)
  }

  /** Assert the hold has been released; throws if still held. */
  assertReleased(): void {
    if (!this.#released) throw new Error(`HoldToken still held but assertReleased called (session=${this.sessionID})`)
  }
}

/**
 * Acquire a test hold token.  Call release() or rely on fixture-scope
 * disposal to transition to released state.
 */
export const acquireTestHold = (sessionID: string, holder = "s0-test-fixture") => new TestHoldToken(sessionID, holder)
