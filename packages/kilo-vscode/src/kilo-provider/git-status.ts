import type { KiloClient } from "@kilocode/sdk/v2/client"
import {
  fetchHasGitPrivateFirst,
  type ProjectCurrentPrivateConnection,
} from "./project-current-privatefirst"

/**
 * Private-first `project/current` narrow projection for the `hasGit`
 * production boolean consumer (`vcs === "git"`).
 *
 * Only the derived boolean is consumed; full `Project.Info` stays SDK-only
 * and is never a private contract. `directory` is workspace routing
 * identity only. No new owner, no cache, no lifecycle change: `cachedGitRepo`
 * and the webview `gitStatus` message keep their existing semantics.
 * Null detaches to SDK-only. With a private connection edge there is at
 * most one private attempt plus at most one SDK read — never two SDK reads.
 */
let privConn: ProjectCurrentPrivateConnection | null = null

export function setProjectCurrentPrivateConnection(c: ProjectCurrentPrivateConnection | null): void {
  privConn = c
}

export async function hasGit(client: KiloClient, directory: string): Promise<boolean> {
  return fetchHasGitPrivateFirst({
    connection: privConn,
    client: client as unknown as never,
    directory,
  })
}
