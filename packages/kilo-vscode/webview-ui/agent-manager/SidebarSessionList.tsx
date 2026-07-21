/**
 * SidebarSessionList — tree-hierarchical session list for the Agent Manager sidebar.
 *
 * Renders the complete flat session inventory as a parent/child tree:
 * - Parent-child tree hierarchy (indented children with expand/collapse)
 * - Date grouping headers (scoped class: am-session-date-header)
 * - Sequence numbers for child sessions
 * - Latest root's child group expanded by default
 */

import { For, Show, createMemo, createEffect, createSignal, type Component } from "solid-js"
import { Icon } from "@kilocode/kilo-ui/icon"
import { useSession } from "../src/context/session"
import { formatRelativeDate } from "../src/utils/date"
import {
  buildDisplayList,
  buildByID,
  ancestorIDs,
  resolveGroupKey,
  DATE_GROUP_KEYS,
  type DisplayItem,
} from "../src/utils/session-tree"
import type { SessionInfo } from "../src/types/messages"

interface SidebarSessionListProps {
  sessions: SessionInfo[]
  sessionsLoaded: boolean
  currentSelection: string | null
  onSelectSession: (id: string) => void
  untitledLabel: string
  t: (key: string) => string
}

const DEPTH_PX = 12

export const SidebarSessionList: Component<SidebarSessionListProps> = (props) => {
  const session = useSession()
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set())
  const [defaultExpanded, setDefaultExpanded] = createSignal(false)

  function toggle(pid: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(pid)) next.delete(pid)
      else next.add(pid)
      return next
    })
  }

  const display = createMemo(() => buildDisplayList(props.sessions, expanded()))
  const byID = createMemo(() => buildByID(props.sessions))

  // Auto-expand ancestors of the currently selected session.
  createEffect(() => {
    const id = session.currentSessionID()
    const sessions = props.sessions
    if (!id) return
    const cur = sessions.find((s) => s.id === id)
    if (!cur) return
    const ids = ancestorIDs(cur, byID())
    if (!ids.length) return
    setExpanded((prev) => {
      const next = new Set(prev)
      let added = false
      for (const pid of ids) {
        if (!next.has(pid)) {
          next.add(pid)
          added = true
        }
      }
      return added ? next : prev
    })
  })

  // Expand the latest root session's child group by default (once).
  createEffect(() => {
    if (defaultExpanded()) return
    const sessions = props.sessions
    if (sessions.length === 0) return
    setDefaultExpanded(true)
    // Roots sorted newest-first by updatedAt
    const roots = sessions
      .filter((s) => !s.parentID)
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    for (const root of roots) {
      if (sessions.some((s) => s.parentID === root.id)) {
        setExpanded((prev) => {
          const next = new Set(prev)
          next.add(root.id)
          return next
        })
        break
      }
    }
  })

  const DATE_GROUP_RANK = Object.fromEntries(DATE_GROUP_KEYS.map((k, i) => [props.t(k), i]))
  function groupKey(item: DisplayItem<SessionInfo>): string {
    return props.t(resolveGroupKey(item, byID()))
  }

  const grouped = createMemo(() => {
    const items = display()
    const map = new Map<string, DisplayItem<SessionInfo>[]>()
    for (const item of items) {
      const key = groupKey(item)
      const list = map.get(key) ?? []
      list.push(item)
      map.set(key, list)
    }
    return [...map.entries()].sort((a, b) => (DATE_GROUP_RANK[a[0]] ?? 99) - (DATE_GROUP_RANK[b[0]] ?? 99))
  })

  return (
    <Show
      when={props.sessionsLoaded}
      fallback={
        <div class="am-skeleton-list">
          <div class="am-skeleton-session">
            <div class="am-skeleton-session-title" style={{ width: "70%" }} />
            <div class="am-skeleton-session-time" />
          </div>
          <div class="am-skeleton-session">
            <div class="am-skeleton-session-title" style={{ width: "55%" }} />
            <div class="am-skeleton-session-time" />
          </div>
          <div class="am-skeleton-session">
            <div class="am-skeleton-session-title" style={{ width: "65%" }} />
            <div class="am-skeleton-session-time" />
          </div>
        </div>
      }
    >
      {grouped().map(([label, items]) => (
        <>
          <div class="am-session-date-header">{label}</div>
          <For each={items}>
            {(item) => {
              const s = item.session
              const isActive = () => s.id === session.currentSessionID()
              const depthStyle = { "--am-session-indent": `${item.depth * DEPTH_PX}px` }
              return (
                <button
                  class={`am-item ${isActive() ? "am-item-active" : ""}`}
                  data-sidebar-id={s.id}
                  data-depth={item.depth}
                  style={depthStyle}
                  onClick={() => props.onSelectSession(s.id)}
                >
                  {/* Disclosure column: real toggle or inert placeholder for title alignment */}
                  <Show
                    when={item.hasChildren}
                    fallback={<span class="am-session-expand-toggle" data-placeholder="true" aria-hidden="true" />}
                  >
                    <button
                      class="am-session-expand-toggle"
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        e.preventDefault()
                        toggle(s.id)
                      }}
                      aria-label={expanded().has(s.id) ? "Collapse children" : "Expand children"}
                    >
                      <Icon name={expanded().has(s.id) ? "chevron-down" : "chevron-right"} size="small" />
                    </button>
                  </Show>
                  {/* Seq + title share the title column; seq is fixed-width so digits never shift the name */}
                  <span class="am-item-title">
                    <Show when={item.depth > 0}>
                      <span class="am-session-child-seq">#{item.seq}</span>
                    </Show>
                    <span class="am-item-title-text">{s.title || props.untitledLabel}</span>
                  </span>
                  <span class="am-item-time">{formatRelativeDate(s.updatedAt)}</span>
                </button>
              )
            }}
          </For>
        </>
      ))}
    </Show>
  )
}
