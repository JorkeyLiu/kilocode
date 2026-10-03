import { createMemo } from "solid-js"
import type { Accessor } from "solid-js"
import type { PermissionRequest, QuestionRequest, SessionInfo, SessionStatusInfo } from "../src/types/messages"
import { LOCAL } from "./navigate"
import { deriveTopics } from "./topics"

export type SidebarSearchState = "idle" | "busy" | "retry" | "waiting"

type SearchItem = {
  key: string
  title: string
  meta: string[]
  search: string
  updatedAt: string
  state: SidebarSearchState
  visible: boolean
}

export type SidebarSearchItem =
  | (SearchItem & {
      kind: "local"
      group: "contexts"
      count: number
    })
  | (SearchItem & {
      kind: "session"
      group: "sessions"
      sessionId: string
      location: "local"
    })

interface SidebarSearchInput {
  local: SessionInfo[]
  localLabel: string
  localBranch?: string
  untitled: string
  pending: (id: string) => boolean
  status: (id: string) => SidebarSearchState
  busy: (id: string) => boolean
  localBusy: boolean
}

const score = (state: SidebarSearchState) => (state === "waiting" ? 3 : state === "idle" ? 0 : 2)

/** Safe timestamp rank: malformed sorts as oldest (0), never NaN/throw. */
const rank = (iso: string) => {
  const n = Date.parse(iso)
  return Number.isFinite(n) ? n : 0
}

/** Deterministic tie-break: code-unit order, never locale-dependent. */
const byKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/**
 * Base order for an empty query (and tie-break for equally relevant fuzzy
 * matches): authoritative Topic order — activity descending with deterministic
 * ID tie-break. Transient presentation (state/visible) never reorders Topics.
 */
export function sortSidebarSearch(a: SidebarSearchItem, b: SidebarSearchItem) {
  return rank(b.updatedAt) - rank(a.updatedAt) || byKey(a.key, b.key)
}

export function buildSidebarSearch(input: SidebarSearchInput): SidebarSearchItem[] {
  // Authoritative Topic projection over the usable inventory (pending tabs are
  // ephemeral, never Topics). Orphan/missing-parent/cycle components degrade
  // to independent Topics via deriveTopics — never dropped as non-roots.
  const usable = input.local.filter((session) => !input.pending(session.id))
  const topics = deriveTopics(usable)
  const sessions: SidebarSearchItem[] = topics.map((tp) => {
    // Transient attention presentation only: the most severe member state.
    // Never reorders Topics (see sortSidebarSearch).
    let state: SidebarSearchState = "idle"
    let best = -1
    for (const m of tp.members) {
      const s = input.status(m.id)
      const v = score(s)
      if (v > best) {
        best = v
        state = s
      }
    }
    const title = tp.label || input.untitled
    const memberTitles = tp.members.map((m) => m.title || input.untitled)
    const memberIDs = tp.members.map((m) => m.id)
    return {
      key: `session:${tp.id}`,
      kind: "session" as const,
      group: "sessions" as const,
      title,
      meta: [input.localLabel],
      search: [title, ...memberTitles, ...memberIDs, input.localLabel].join(" "),
      sessionId: tp.id,
      location: "local" as const,
      updatedAt: tp.activity,
      state,
      visible: true,
    }
  })
  let localState: SidebarSearchState = "idle"
  let best = -1
  for (const s of usable) {
    const st = input.status(s.id)
    const v = score(st)
    if (v > best) {
      best = v
      localState = st
    }
  }
  const contexts: SidebarSearchItem[] = [
    {
      key: LOCAL,
      kind: "local",
      group: "contexts",
      title: input.localLabel,
      meta: input.localBranch ? [input.localBranch] : [],
      search: [input.localLabel, input.localBranch].filter(Boolean).join(" "),
      updatedAt: topics[0]?.activity ?? "",
      state: input.localBusy && localState === "idle" ? "busy" : localState,
      visible: true,
      count: topics.length,
    },
  ]

  // The List keeps this order for an empty query and as the tie-break order for equally relevant fuzzy matches.
  return [...sessions.sort(sortSidebarSearch), ...contexts.sort(sortSidebarSearch)]
}

interface SidebarSearchDeps {
  local: Accessor<SessionInfo[]>
  localBranch: Accessor<string | undefined>
  selection: Accessor<string | null>
  sessionId: Accessor<string | undefined>
  statuses: Accessor<Record<string, SessionStatusInfo>>
  permissions: Accessor<PermissionRequest[]>
  questions: Accessor<QuestionRequest[]>
  pending: (id: string) => boolean
  busy: (id: string) => boolean
  localBusy: Accessor<boolean>
  t: (key: string) => string
}

export function createSidebarSearch(deps: SidebarSearchDeps) {
  const items = createMemo(() => {
    const statuses = deps.statuses()
    const blocked = new Set([
      ...deps.permissions().map((item) => item.sessionID),
      ...deps.questions().map((item) => item.sessionID),
    ])
    return buildSidebarSearch({
      local: deps.local(),
      localLabel: deps.t("agentManager.local"),
      localBranch: deps.localBranch(),
      untitled: deps.t("agentManager.session.untitled"),
      pending: deps.pending,
      status: (id) => {
        if (blocked.has(id)) return "waiting"
        const status = statuses[id]?.type
        return status === "busy" || status === "retry" ? status : "idle"
      },
      busy: deps.busy,
      localBusy: deps.localBusy(),
    })
  })

  const current = createMemo(() => {
    const id = deps.sessionId()
    const selection = deps.selection()
    const list = items()
    const active = list.find(
      (item) =>
        item.kind === "session" && item.sessionId === id && item.location === "local" && selection === LOCAL,
    )
    if (active || !selection) return active
    // The active session may be a Topic member (child): highlight its Topic.
    // Pure derivation from the same inventory — presentation only.
    if (id && selection === LOCAL) {
      const usable = deps.local().filter((s) => !deps.pending(s.id))
      const topics = deriveTopics(usable)
      for (const tp of topics) {
        if (tp.members.some((m) => m.id === id)) {
          const topicItem = list.find((item) => item.kind === "session" && item.sessionId === tp.id)
          if (topicItem) return topicItem
          break
        }
      }
    }
    if (selection === LOCAL) return list.find((item) => item.kind === "local")
    return undefined
  })

  return { items, current }
}
