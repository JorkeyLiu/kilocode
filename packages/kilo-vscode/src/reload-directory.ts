/**
 * P3.1 reload directory routing, kept vscode-free so the surface-priority
 * rules are executable-tested without an Extension Host.
 *
 * ## Why this exists
 *
 * `kilo-code.new.reload` reboots the shared backend instance for one
 * directory. The removed sidebar provider reloaded its own current session's
 * directory; reload must still respect a currently active session directory —
 * the active editor-tab chat panel when focused, else the Agent Manager's
 * active session. Sessions live in the surface's session→directory map, so
 * their directory wins; root sessions are omitted from that map and resolve
 * to the fallback (first workspace root / cwd), matching the old semantics.
 */

/** A chat surface's active-session facts, as exposed by the providers. */
export type SessionDirectorySource = {
  sessionID?: string
  sessionDirectories: ReadonlyMap<string, string>
}

/**
 * Resolve the directory for the backend instance reload: the active editor
 * tab's current session directory when a tab is focused, else the Agent
 * Manager's active session directory, else the fallback. The session ID
 * follows the same surface preference chat surfaces use (active tab, then
 * Agent Manager); the directory lookup reuses the session→directory maps the
 * auto-approve toggle aggregates.
 */
export function resolveReloadDirectory(input: {
  tab: SessionDirectorySource | undefined
  agentManager: SessionDirectorySource | undefined
  fallback: string
}): string {
  const sid = input.tab?.sessionID ?? input.agentManager?.sessionID
  if (sid) {
    const dir = input.tab?.sessionDirectories.get(sid) ?? input.agentManager?.sessionDirectories.get(sid)
    if (dir) return dir
  }
  return input.fallback
}
