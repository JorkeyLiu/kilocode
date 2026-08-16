import { createMemo } from "solid-js"
import type { Accessor } from "solid-js"
import type { PermissionRequest, QuestionRequest, SessionInfo, SessionStatusInfo } from "../src/types/messages"
import { LOCAL } from "./navigate"

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

const root = (item: SessionInfo) => !item.parentID
const score = (state: SidebarSearchState) => (state === "waiting" ? 3 : state === "idle" ? 0 : 2)
const newest = (items: SessionInfo[], fallback: string) =>
  items.reduce((latest, item) => (item.updatedAt > latest ? item.updatedAt : latest), fallback)

export function sortSidebarSearch(a: SidebarSearchItem, b: SidebarSearchItem) {
  return (
    score(b.state) - score(a.state) ||
    Number(b.visible) - Number(a.visible) ||
    b.updatedAt.localeCompare(a.updatedAt) ||
    a.title.localeCompare(b.title)
  )
}

export function buildSidebarSearch(input: SidebarSearchInput): SidebarSearchItem[] {
  const local = input.local.filter((session) => root(session) && !input.pending(session.id))
  const sessions: SidebarSearchItem[] = local.map((session) => ({
    key: `session:${session.id}`,
    kind: "session" as const,
    group: "sessions" as const,
    title: session.title || input.untitled,
    meta: [input.localLabel],
    search: [session.title || input.untitled, input.localLabel, session.id].join(" "),
    sessionId: session.id,
    location: "local" as const,
    updatedAt: session.updatedAt,
    state: input.status(session.id),
    visible: true,
  }))
  const localState = local.map((session) => input.status(session.id)).sort((a, b) => score(b) - score(a))[0] ?? "idle"
  const contexts: SidebarSearchItem[] = [
    {
      key: LOCAL,
      kind: "local",
      group: "contexts",
      title: input.localLabel,
      meta: input.localBranch ? [input.localBranch] : [],
      search: [input.localLabel, input.localBranch].filter(Boolean).join(" "),
      updatedAt: newest(local, ""),
      state: input.localBusy && localState === "idle" ? "busy" : localState,
      visible: true,
      count: local.length,
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
    const active = items().find(
      (item) =>
        item.kind === "session" && item.sessionId === id && item.location === "local" && selection === LOCAL,
    )
    if (active || !selection) return active
    if (selection === LOCAL) return items().find((item) => item.kind === "local")
    return undefined
  })

  return { items, current }
}
