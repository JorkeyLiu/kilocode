/**
 * SidebarSessionList — Topic-first session navigation for the Agent Manager
 * sidebar (P1 orchestration-first navigation).
 *
 * Topics are derived at render time from runtime session facts only (see
 * ./topics.ts): each root session defines one Topic, descendants belong via
 * existing parentID edges, activity is the max member updatedAt, and Topics
 * order by activity descending with a deterministic ID tie-break. Orphans,
 * missing-parent components, and cycles degrade to independent Topics.
 *
 * Rendering:
 * - Topic rows (root sessions) with expand/collapse disclosure
 * - Child session hierarchy under an expanded Topic (indented, seq-numbered)
 * - Date grouping headers (scoped class: am-session-date-header)
 * - Active Topic derives from the active session
 * - Rename of a Topic's root session relabels the Topic (label derives from
 *   the root title)
 * - Selection/expansion are presentation state only — no persistence, no new
 *   extension messages, no session mutation
 * - Auto-expand runs only when the active session or its Topic changes, so a
 *   manual collapse survives unrelated session inventory updates
 *
 * Non-authoritative preview (first unit): while the full catalog drain is in
 * flight and no authoritative snapshot has landed, the list may render a
 * flat read-only preview accumulated from `sessionsProgress` page deltas.
 * Preview never derives Topics, never touches the session store, and offers
 * no select/rename/delete/expand actions.
 */

import { For, Show, createMemo, createEffect, createSignal, on, onMount, onCleanup, type Component } from "solid-js"
import { Icon } from "@kilocode/kilo-ui/icon"
import { IconButton } from "@kilocode/kilo-ui/icon-button"
import { Dialog } from "@kilocode/kilo-ui/dialog"
import { Button } from "@kilocode/kilo-ui/button"
import { useDialog } from "@kilocode/kilo-ui/context/dialog"
import { useSession } from "../src/context/session"
import { useLanguage } from "../src/context/language"
import { formatRelativeDate } from "../src/utils/date"
import { SessionRenameEditor } from "../src/components/shared/SessionRenameEditor"
import {
  buildByID,
  ancestorIDs,
  dateGroupKey,
  DATE_GROUP_KEYS,
  buildDisplayList,
  type DisplayItem,
} from "../src/utils/session-tree"
import { deriveTopics, activeTopicID, type TopicView } from "./topics"
import {
  captureScrollAnchor,
  restoreScrollAnchor,
  createScrollAnchorTracker,
  type ScrollAnchorTracker,
} from "../src/utils/scroll-anchor"
import type { SessionInfo } from "../src/types/messages"
import { sortPreview } from "./catalog-preview"

export { isStalePreview, mergePreview, sortPreview } from "./catalog-preview"

interface SidebarSessionListProps {
  /** Getter for the .am-list scroll container owned by the parent. */
  listContainer: () => HTMLElement | undefined
  sessions: SessionInfo[]
  sessionsLoaded: boolean
  currentSelection: string | null
  onSelectSession: (id: string) => void
  untitledLabel: string
  t: (key: string) => string
  expanded?: () => Set<string>
  setExpanded?: (updater: (prev: Set<string>) => Set<string>) => void
  /** Non-authoritative flat preview accumulated from page deltas. */
  preview?: SessionInfo[]
  /** True when the in-flight drain failed and preview offers Retry. */
  previewFailed?: boolean
  /** Retry starts a new full refresh via the existing loadSessions request. */
  onRetryPreview?: () => void
}

const DEPTH_PX = 12

export const SidebarSessionList: Component<SidebarSessionListProps> = (props) => {
  const session = useSession()
  const lang = useLanguage()
  const dialog = useDialog()
  const [internalExpanded, setInternalExpanded] = createSignal<Set<string>>(new Set())
  const expanded = () => (props.expanded ? props.expanded() : internalExpanded())
  const setExpanded = (updater: (prev: Set<string>) => Set<string>) => {
    if (props.setExpanded) props.setExpanded(updater)
    else setInternalExpanded((prev: Set<string>) => updater(prev))
  }
  const [defaultExpanded, setDefaultExpanded] = createSignal(false)
  const [renaming, setRenaming] = createSignal<string | null>(null)
  // Container-owned scroll anchor tracker — always has a pre-update anchor
  // available regardless of which component triggered the sessions update.
  const tracker: ScrollAnchorTracker = createScrollAnchorTracker(props.listContainer)

  onMount(() => tracker.start())
  onCleanup(() => tracker.stop())

  function name(s: SessionInfo) {
    return s.title || props.untitledLabel
  }

  function saveRename(title: string) {
    const id = renaming()
    if (!id) return
    const existing = props.sessions.find((s) => s.id === id)
    if (!existing || title !== (existing.title || "")) session.renameSession(id, title)
    setRenaming(null)
  }

  function confirmDelete(s: SessionInfo, restore?: HTMLElement) {
    dialog.show(
      () => (
        <Dialog title={lang.t("session.delete.title")} fit>
          <div class="dialog-confirm-body">
            <span>{lang.t("session.delete.confirm", { name: name(s) })}</span>
            <div class="dialog-confirm-actions">
              <Button variant="ghost" size="large" onClick={() => dialog.close()}>
                {lang.t("common.cancel")}
              </Button>
              <Button
                variant="primary"
                size="large"
                onClick={() => {
                  session.deleteSession(s.id)
                  dialog.close()
                }}
              >
                {lang.t("session.delete.button")}
              </Button>
            </div>
          </div>
        </Dialog>
      ),
      () => {
        queueMicrotask(() => {
          if (restore?.isConnected) restore.focus()
        })
      },
    )
  }

  function toggle(id: string) {
    const container = props.listContainer()
    const anchor = container ? captureScrollAnchor(container) : null

    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

    if (container && anchor) {
      requestAnimationFrame(() => restoreScrollAnchor(container, anchor))
    }
  }

  // --- Topic derivation (pure, runtime session facts only) ---
  const topics = createMemo(() => deriveTopics(props.sessions))
  const byID = createMemo(() => buildByID(props.sessions))

  // Active Topic derives from the active session.
  const activeTopic = createMemo(() => activeTopicID(topics(), session.currentSessionID()))

  // Per-topic display hierarchies: each topic's member closure rendered with
  // the shared tree builder (roots at depth 0, children indented below).
  const topicDisplays = createMemo(() => {
    const map = new Map<string, DisplayItem<SessionInfo>[]>()
    for (const tp of topics()) {
      map.set(tp.id, buildDisplayList(tp.members, expanded()))
    }
    return map
  })

  // Auto-expand the active session's Topic (and its in-topic ancestors) — but
  // only when the active session or its Topic changes. Unrelated inventory
  // updates (e.g. an updatedAt bump on the same active session) recompute the
  // memos to the same values, so `on` does not re-fire and a manual collapse
  // survives the update.
  createEffect(
    on([() => session.currentSessionID(), activeTopic], ([id, active]) => {
      if (!id || !active) return
      const cur = props.sessions.find((s) => s.id === id)
      if (!cur) return
      const ids = new Set(ancestorIDs(cur, byID()))
      ids.add(active)
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
    }),
  )

  // Expand the most active Topic that has children by default (once).
  createEffect(() => {
    if (defaultExpanded()) return
    const list = topics()
    if (list.length === 0) return
    setDefaultExpanded(true)
    // Topics are already ordered activity-descending by deriveTopics.
    for (const tp of list) {
      if (tp.hasChildren) {
        setExpanded((prev) => {
          const next = new Set(prev)
          next.add(tp.id)
          return next
        })
        break
      }
    }
  })

  // Restore scroll anchor after sessions change from any source.
  // The tracker's anchor was captured from the last scroll event, which is
  // guaranteed to be pre-update (scroll events are macrotasks that always
  // precede reactive microtask updates).
  // { defer: true } skips the initial run (no prior anchor yet)
  createEffect(
    on(
      () => props.sessions.length,
      () => {
        requestAnimationFrame(() => tracker.restore())
      },
      { defer: true },
    ),
  )

  const DATE_GROUP_RANK = Object.fromEntries(DATE_GROUP_KEYS.map((k, i) => [props.t(k), i]))
  function topicGroupKey(tp: TopicView<SessionInfo>): string {
    return props.t(dateGroupKey(tp.activity))
  }

  const grouped = createMemo(() => {
    const items = topics()
    const map = new Map<string, TopicView<SessionInfo>[]>()
    for (const tp of items) {
      const key = topicGroupKey(tp)
      const list = map.get(key) ?? []
      list.push(tp)
      map.set(key, list)
    }
    return [...map.entries()].sort((a, b) => (DATE_GROUP_RANK[a[0]] ?? 99) - (DATE_GROUP_RANK[b[0]] ?? 99))
  })

  const previewRows = createMemo(() => sortPreview(props.preview ?? []))
  const showPreview = () => !props.sessionsLoaded && ((props.preview ?? []).length > 0 || !!props.previewFailed)

  return (
    <Show
      when={props.sessionsLoaded || !showPreview()}
      fallback={
        <div
          class="am-preview-list"
          role="status"
          aria-live="polite"
          aria-label={props.t("agentManager.catalog.previewTitle")}
        >
          <div class="am-preview-heading">{props.t("agentManager.catalog.previewTitle")}</div>
          <For each={previewRows()}>
            {(s) => (
              <div class="am-item" data-preview-id={s.id} aria-disabled="true">
                <span class="am-session-expand-toggle" data-placeholder="true" aria-hidden="true" />
                <span class="am-item-title">
                  <span class="am-item-title-text">{s.title || props.untitledLabel}</span>
                </span>
                <span class="am-item-time">{formatRelativeDate(s.updatedAt)}</span>
              </div>
            )}
          </For>
          <Show
            when={props.previewFailed}
            fallback={
              <div class="am-preview-foot">
                <span class="am-preview-status">{props.t("agentManager.catalog.previewStatus")}</span>
                <div class="am-skeleton-session">
                  <div class="am-skeleton-session-title" style={{ width: "60%" }} />
                  <div class="am-skeleton-session-time" />
                </div>
              </div>
            }
          >
            <div class="am-preview-foot">
              <Button variant="ghost" size="small" onClick={() => props.onRetryPreview?.()}>
                {props.t("agentManager.catalog.retry")}
              </Button>
            </div>
          </Show>
        </div>
      }
    >
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
        {grouped().map(([label, topicList]) => (
          <>
            <div class="am-session-date-header">{label}</div>
            <For each={topicList}>
              {(tp) => {
                const root = tp.root
                const isTopicActive = () => activeTopic() === tp.id
                const isRenaming = () => renaming() === root.id
                const isExpanded = () => expanded().has(tp.id)
                const childItems = () => (topicDisplays().get(tp.id) ?? []).slice(1)
                return (
                  <>
                    {/* Topic row — the root session defines the Topic */}
                    <div
                      class={`am-item am-topic-root ${isTopicActive() ? "am-item-active" : ""}`}
                      data-sidebar-id={root.id}
                      data-topic-id={tp.id}
                      data-depth="0"
                      tabindex="0"
                      onClick={() => {
                        if (isRenaming()) return
                        props.onSelectSession(root.id)
                      }}
                      onKeyDown={(e) => {
                        if (e.target !== e.currentTarget || isRenaming()) return
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault()
                          props.onSelectSession(root.id)
                        } else if (e.key === "ArrowLeft") {
                          e.preventDefault()
                          if (isExpanded()) toggle(tp.id)
                        } else if (e.key === "ArrowRight") {
                          e.preventDefault()
                          if (!isExpanded()) toggle(tp.id)
                        }
                      }}
                    >
                      {/* Disclosure column: real toggle or inert placeholder */}
                      <Show
                        when={tp.hasChildren}
                        fallback={<span class="am-session-expand-toggle" data-placeholder="true" aria-hidden="true" />}
                      >
                        <button
                          class="am-session-expand-toggle"
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation()
                            e.preventDefault()
                            toggle(tp.id)
                          }}
                          aria-label={
                            isExpanded() ? lang.t("agentManager.topic.collapse") : lang.t("agentManager.topic.expand")
                          }
                          aria-expanded={isExpanded()}
                          aria-controls={isExpanded() ? `topic-children-${tp.id}` : undefined}
                        >
                          <Icon name={isExpanded() ? "chevron-down" : "chevron-right"} size="small" />
                        </button>
                      </Show>
                      <Show
                        when={isRenaming()}
                        fallback={
                          <>
                            <span class="am-item-title">
                              <span class="am-item-title-text">{name(root)}</span>
                            </span>
                            <span class="am-item-time">{formatRelativeDate(tp.activity)}</span>
                            <span class="am-item-actions">
                              <IconButton
                                icon="edit"
                                size="small"
                                variant="ghost"
                                aria-label={`${lang.t("common.rename")}: ${name(root)}`}
                                onClick={(e) => {
                                  e.stopPropagation()
                                  setRenaming(root.id)
                                }}
                              />
                              <IconButton
                                icon="trash"
                                size="small"
                                variant="ghost"
                                aria-label={`${lang.t("session.delete.title")}: ${name(root)}`}
                                onClick={(e) => {
                                  e.stopPropagation()
                                  confirmDelete(root, e.currentTarget)
                                }}
                              />
                            </span>
                          </>
                        }
                      >
                        <span class="am-item-rename" onClick={(e) => e.stopPropagation()}>
                          <SessionRenameEditor
                            title={root.title || ""}
                            fill
                            stop
                            onSave={saveRename}
                            onCancel={() => setRenaming(null)}
                          />
                        </span>
                      </Show>
                    </div>
                    {/* Child session hierarchy under the expanded Topic */}
                    <Show when={isExpanded()}>
                      <div class="am-topic-children" id={`topic-children-${tp.id}`} role="group">
                        <For each={childItems()}>
                          {(item) => {
                            const s = item.session
                            const isActive = () => s.id === session.currentSessionID()
                            const depthStyle = { "--am-session-indent": `${item.depth * DEPTH_PX}px` }
                            const isRenamingChild = () => renaming() === s.id
                            return (
                              <div
                                class={`am-item ${isActive() ? "am-item-active" : ""}`}
                                data-sidebar-id={s.id}
                                data-depth={item.depth}
                                style={depthStyle}
                                tabindex="0"
                                onClick={() => {
                                  if (isRenamingChild()) return
                                  props.onSelectSession(s.id)
                                }}
                                onKeyDown={(e) => {
                                  if (e.target !== e.currentTarget || isRenamingChild()) return
                                  if (e.key === "Enter" || e.key === " ") {
                                    e.preventDefault()
                                    props.onSelectSession(s.id)
                                  }
                                }}
                              >
                                {/* Disclosure column: real toggle or inert placeholder */}
                                <Show
                                  when={item.hasChildren}
                                  fallback={
                                    <span class="am-session-expand-toggle" data-placeholder="true" aria-hidden="true" />
                                  }
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
                                    aria-expanded={expanded().has(s.id)}
                                  >
                                    <Icon name={expanded().has(s.id) ? "chevron-down" : "chevron-right"} size="small" />
                                  </button>
                                </Show>
                                <Show
                                  when={isRenamingChild()}
                                  fallback={
                                    <>
                                      {/* Seq + title share the title column; seq is fixed-width so digits never shift the name */}
                                      <span class="am-item-title">
                                        <Show when={item.depth > 0}>
                                          <span class="am-session-child-seq">#{item.seq}</span>
                                        </Show>
                                        <span class="am-item-title-text">{name(s)}</span>
                                      </span>
                                      <span class="am-item-time">{formatRelativeDate(s.updatedAt)}</span>
                                      <span class="am-item-actions">
                                        <IconButton
                                          icon="edit"
                                          size="small"
                                          variant="ghost"
                                          aria-label={`${lang.t("common.rename")}: ${name(s)}`}
                                          onClick={(e) => {
                                            e.stopPropagation()
                                            setRenaming(s.id)
                                          }}
                                        />
                                        <IconButton
                                          icon="trash"
                                          size="small"
                                          variant="ghost"
                                          aria-label={`${lang.t("session.delete.title")}: ${name(s)}`}
                                          onClick={(e) => {
                                            e.stopPropagation()
                                            confirmDelete(s, e.currentTarget)
                                          }}
                                        />
                                      </span>
                                    </>
                                  }
                                >
                                  <span class="am-item-rename" onClick={(e) => e.stopPropagation()}>
                                    <SessionRenameEditor
                                      title={s.title || ""}
                                      fill
                                      stop
                                      onSave={saveRename}
                                      onCancel={() => setRenaming(null)}
                                    />
                                  </span>
                                </Show>
                              </div>
                            )
                          }}
                        </For>
                      </div>
                    </Show>
                  </>
                )
              }}
            </For>
          </>
        ))}
      </Show>
    </Show>
  )
}
