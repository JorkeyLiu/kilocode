import type { KiloClient, SessionStatus } from "@kilocode/sdk/v2/client"
import {
  summarizeMcp,
  summarizeMessage,
  summarizePermissions,
  summarizeQuestions,
  summarizeSession,
  summarizeStatuses,
  type BackendSnapshot,
  type McpTruth,
} from "./fixture-backend"
import { fetchSessionChildrenPrivateFirst } from "../kilo-provider/session-children-privatefirst"
import { fetchSessionStatusesPrivateFirst } from "../kilo-provider/session-status-privatefirst"
import { fetchMcpStatusPrivate } from "../kilo-provider/mcp-status-private"
import { attemptMcpDisconnectPrivate, buildMcpDisconnectReq } from "../kilo-provider/mcp-connection-privatefirst"
import { fetchAgentsPrivateFirst } from "../kilo-provider/agent-list-privatefirst"
import { fetchProviderCatalogPrivateFirst } from "../kilo-provider/provider-catalog-privatefirst"
import { readPermissionsForDir } from "../kilo-provider/permission-privatefirst"
import { readQuestionsForDir } from "../kilo-provider/question-privatefirst"
import {
  fetchFixtureSessionListPrivateFirst,
  fetchFixtureSessionMessagesPrivateFirst,
} from "../kilo-provider/fixture-session-privatefirst"

/**
 * Vscode-free fixture backend truth (KILO_E2E_FIXTURE only).
 *
 * Owns the read-only served-backend snapshot and the MCP disconnect
 * convergence used by the env-gated E2E fixture bridge. The provider retains
 * panel lifecycle, persistence, and business ownership: it supplies the
 * workspace root, the SDK client loader, the private connection, the
 * observation reader, and a log sink. No extension-host import, no production path
 * dependence, no new persistence.
 */

export interface SnapshotDeps {
  root: string
  getClient: (root: string) => Promise<KiloClient>
  connection: unknown
  reader: unknown | null
  log: (...args: unknown[]) => void
}

export interface DisconnectDeps {
  root: string
  connection: unknown
  log: (...args: unknown[]) => void
}

/**
 * Read-only snapshot of served-backend truth for the real-session E2E
 * fixture (KILO_E2E_FIXTURE only, registered by extension.ts): the session
 * list, per-session transcripts (text + completed tool-part summaries),
 * session statuses, the served agent catalog, the connected provider ids,
 * MCP server statuses, pending permission/question requests, and the
 * backend-derived child session ids. Session list and per-session
 * transcripts go through their shared private-first helpers (same
 * `observation/list` + `observation/messages` sources as production)
 * with the same snapshot projections; statuses, children, MCP status,
 * agent list, provider catalog, permission list, and question list go
 * through their shared private-first helpers the same way. The
 * extension-host runner writes this to the scratch dir and the harness
 * asserts on it. No production effect: the command is unregistered when
 * the env var is absent.
 */
export async function backendSnapshotForFixture(deps: SnapshotDeps): Promise<BackendSnapshot> {
  const root = deps.root
  const client = await deps.getClient(root)
  const empty = (label: string): never[] => {
    deps.log(`fixture backendSnapshot: ${label} failed; returning empty`)
    return []
  }
  const reader = deps.reader
  const listOutcome = await fetchFixtureSessionListPrivateFirst({
    reader: reader as Parameters<typeof fetchFixtureSessionListPrivateFirst>[0]["reader"],
    client: client as unknown as Parameters<typeof fetchFixtureSessionListPrivateFirst>[0]["client"],
    directory: root,
  }).catch((err) => {
    deps.log("fixture backendSnapshot: session.list failed:", err)
    return empty("session.list") as unknown as Awaited<ReturnType<typeof fetchFixtureSessionListPrivateFirst>>
  })
  const sessions = listOutcome.kind === "ok" ? listOutcome.sessions : empty("session.list")
  let readable = true
  let statuses: Record<string, SessionStatus> = {}
  try {
    const statusOutcome = await fetchSessionStatusesPrivateFirst({
      connection: deps.connection as unknown as Parameters<typeof fetchSessionStatusesPrivateFirst>[0]["connection"],
      client: client as unknown as Parameters<typeof fetchSessionStatusesPrivateFirst>[0]["client"],
      directory: root,
    })
    if (statusOutcome.kind === "ok") statuses = statusOutcome.statuses as Record<string, SessionStatus>
    else {
      readable = false
      deps.log("fixture backendSnapshot: session.status failed; returning empty")
      statuses = {}
    }
  } catch (err) {
    deps.log("fixture backendSnapshot: session.status failed:", err)
    readable = false
    statuses = {}
  }
  const agents = await fetchAgentsPrivateFirst({
    connection: deps.connection as unknown as Parameters<typeof fetchAgentsPrivateFirst>[0]["connection"],
    client: client as unknown as Parameters<typeof fetchAgentsPrivateFirst>[0]["client"],
    directory: root,
  })
    .then((outcome) => (outcome.kind === "ok" ? outcome.agents : empty("app.agents")))
    .catch(() => empty("app.agents"))
  const connected = await fetchProviderCatalogPrivateFirst({
    connection: deps.connection as unknown as Parameters<typeof fetchProviderCatalogPrivateFirst>[0]["connection"],
    client: client as unknown as Parameters<typeof fetchProviderCatalogPrivateFirst>[0]["client"],
    directory: root,
  })
    .then((outcome) => (outcome.kind === "ok" ? (outcome.data.connected ?? []) : empty("provider.catalog")))
    .catch(() => empty("provider.catalog"))
  const messages: Record<string, ReturnType<typeof summarizeMessage>[]> = {}
  const children: Record<string, string[]> = {}
  const unreadable: Record<string, boolean> = {}
  for (const s of sessions) {
    // Private-first transcript read: one private observation/messages
    // attempt plus at most one same-session/directory SDK fallback per
    // session. Valid private pages and SDK fallback produce the same
    // fixture `messages` projection; terminal and unavailable close
    // fail-soft to empty with the existing log label plus unreadable.
    const msgOutcome = await fetchFixtureSessionMessagesPrivateFirst({
      reader: reader as Parameters<typeof fetchFixtureSessionMessagesPrivateFirst>[0]["reader"],
      client: client as unknown as Parameters<typeof fetchFixtureSessionMessagesPrivateFirst>[0]["client"],
      directory: root,
      sessionId: s.id,
    }).catch(
      () =>
        empty(`session.messages(${s.id})`) as unknown as Awaited<
          ReturnType<typeof fetchFixtureSessionMessagesPrivateFirst>
        >,
    )
    const rows = msgOutcome.kind === "ok" ? msgOutcome.items : empty(`session.messages(${s.id})`)
    if (msgOutcome.kind !== "ok") unreadable[s.id] = false
    messages[s.id] = (rows as Parameters<typeof summarizeMessage>[0][]).map(summarizeMessage)
    // Private-authority children read: one private attempt with zero SDK.
    // Valid private `succeeded`+`accepted` (including valid empty) and
    // validated terminal `failed` (`retryable === false`) are authoritative
    // with zero SDK; every gate-off/not-started/worker-error/transport/
    // protocol/malformed/ambiguous/retryable-fence/timeout/closed branch
    // fails closed to explicit unavailable with zero SDK (`getClientAsync`,
    // `client.session.children`); signal is transport-only cancellation
    // via `$/cancelRequest` with abort-listener cleanup, never a wire
    // payload. `compareChildrenParity` stays as pure diagnostic/test
    // evidence only and issues no third request.
    const kids = await fetchSessionChildrenPrivateFirst({
      connection: deps.connection as unknown as Parameters<typeof fetchSessionChildrenPrivateFirst>[0]["connection"],
      parentSessionId: s.id,
      directory: root,
    })
      .then((outcome) => (outcome.kind === "ok" ? outcome.children : empty(`session.children(${s.id})`)))
      .catch((err: unknown) => {
        deps.log(`fixture backendSnapshot: session.children(${s.id}) failed:`, err)
        return empty(`session.children(${s.id})`)
      })
    children[s.id] = kids.map((kid) => (kid as { id?: string }).id ?? "").filter((id) => id.length > 0)
  }
  const mcp = await fetchMcpStatusPrivate({
    connection: deps.connection as Parameters<typeof fetchMcpStatusPrivate>[0]["connection"],
    directory: root,
  })
    .then((outcome) => (outcome.kind === "ok" ? summarizeMcp(outcome.status) : undefined))
    .catch((err) => {
      deps.log("fixture backendSnapshot: mcp.status failed:", err)
      return undefined
    })
  const pending = await Promise.all([
    readPermissionsForDir({
      connection: deps.connection as unknown as Parameters<typeof readPermissionsForDir>[0]["connection"],
      client,
      directory: root,
    })
      .then((read) =>
        read.kind === "ok"
          ? summarizePermissions(read.perms as unknown as Parameters<typeof summarizePermissions>[0])
          : (empty("permission.list") as unknown as ReturnType<typeof summarizePermissions>),
      )
      .catch(() => empty("permission.list") as unknown as ReturnType<typeof summarizePermissions>),
    readQuestionsForDir({
      connection: deps.connection as unknown as Parameters<typeof readQuestionsForDir>[0]["connection"],
      client,
      directory: root,
    })
      .then((read) =>
        read.kind === "ok"
          ? summarizeQuestions(read.items as unknown as Parameters<typeof summarizeQuestions>[0])
          : (empty("question.list") as unknown as ReturnType<typeof summarizeQuestions>),
      )
      .catch(() => empty("question.list") as unknown as ReturnType<typeof summarizeQuestions>),
  ]).then(([permissions, questions]) => ({ permissions, questions }))
  return {
    requestedAt: new Date().toISOString(),
    sessions: sessions.map(summarizeSession),
    messages,
    statuses: summarizeStatuses(statuses),
    ...(readable ? {} : { statusReadable: false as const }),
    ...(Object.keys(unreadable).length > 0 ? { messagesReadable: unreadable } : {}),
    agents: agents.map((agent) => (agent as { name?: string }).name ?? "").filter((name) => name.length > 0),
    connectedProviders: connected,
    ...(mcp ? { mcp } : {}),
    ...(pending ? { pending } : {}),
    children,
  }
}

/**
 * Disconnect a named MCP server through the private authority, then return
 * the served MCP status map. Env-gated E2E fixture bridge only
 * (KILO_E2E_FIXTURE): lets the harness prove the run-owned MCP stdio child
 * is cleaned up by its exact owner (disconnect through the private
 * authority, not a process-name kill). Once-only with zero SDK
 * fallback/retry; every outcome converges through private status.
 * No production effect when the env var is absent.
 */
export async function mcpDisconnectForFixture(deps: DisconnectDeps, name: string): Promise<McpTruth> {
  const root = deps.root
  try {
    const attempt = await attemptMcpDisconnectPrivate(
      deps.connection as unknown as Parameters<typeof attemptMcpDisconnectPrivate>[0],
      buildMcpDisconnectReq(root, name),
    )
    if (attempt.kind !== "ok") {
      const detail = attempt.kind === "failed" ? attempt.code : attempt.reason
      deps.log(`fixture mcpDisconnect(${name}) failed:`, detail)
    }
  } catch (err) {
    deps.log(`fixture mcpDisconnect(${name}) failed:`, err)
  }
  const outcome = await fetchMcpStatusPrivate({
    connection: deps.connection as Parameters<typeof fetchMcpStatusPrivate>[0]["connection"],
    directory: root,
  }).catch((err) => {
    deps.log("fixture mcpDisconnect: mcp.status failed:", err)
    return { kind: "unavailable" } as const
  })
  if (outcome.kind === "ok") return summarizeMcp(outcome.status)
  return summarizeMcp({})
}
