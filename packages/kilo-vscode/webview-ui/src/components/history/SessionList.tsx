/**
 * SessionList component
 * Displays all sessions grouped by date, with context menu for rename/delete.
 * Uses kilo-ui List component for keyboard navigation and accessibility.
 * Header/back button are owned by the parent HistoryView.
 *
 * Parent-child tree hierarchy:
 * - Root sessions render at the top level
 * - Child sessions render indented under their parent
 * - Children are collapsed by default (expanded for the selected parent)
 * - Child sessions display sequence numbers (#1, #2, etc.) sorted by createdAt
 */

import { Component, Show, createSignal, createMemo, createEffect, onMount, type JSX } from "solid-js"
import { List } from "@kilocode/kilo-ui/list"
import { ContextMenu } from "@kilocode/kilo-ui/context-menu"
import { Dialog } from "@kilocode/kilo-ui/dialog"
import { Button } from "@kilocode/kilo-ui/button"
import { IconButton } from "@kilocode/kilo-ui/icon-button"
import { Icon } from "@kilocode/kilo-ui/icon"
import { useDialog } from "@kilocode/kilo-ui/context/dialog"
import { useSession } from "../../context/session"
import { useLanguage } from "../../context/language"
import { formatRelativeDate } from "../../utils/date"
import { DATE_GROUP_KEYS, buildByID, ancestorIDs, buildDisplayList, resolveGroupKey } from "../../utils/session-tree"
import type { SessionInfo } from "../../types/messages"
import { SessionRenameEditor } from "../shared/SessionRenameEditor"

type DisplayItem = import("../../utils/session-tree").DisplayItem<SessionInfo>

interface SessionListProps {
  onSelectSession: (id: string) => void
}

const SessionList: Component<SessionListProps> = (props) => {
  const session = useSession()
  const language = useLanguage()
  const dialog = useDialog()

  const [renamingId, setRenamingId] = createSignal<string | null>(null)
  const [pendingRenameId, setPendingRenameId] = createSignal<string | null>(null)
  const [notice, setNotice] = createSignal("")
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set())
  let seq = 0

  onMount(() => {
    console.log("[Kilo New] SessionList mounted, loading sessions")
    session.loadSessions()
  })

  // --- Tree hierarchy helpers ---

  /** Toggle a parent's expanded state. */
  function toggle(pid: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(pid)) next.delete(pid)
      else next.add(pid)
      return next
    })
  }

  /** Auto-expand ancestors of the currently selected session.
   *  Tracks both currentSessionID and the session collection so that when
   *  metadata arrives after the active ID is set, ancestors still expand. */
  createEffect(() => {
    const id = session.currentSessionID()
    const sessions = session.sessions()
    if (!id) return
    const cur = sessions.find((s) => s.id === id)
    if (!cur) return
    const ids = ancestorIDs(cur, buildByID(sessions))
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

  /** Compute the flat display list: roots + recursive expanded children. */
  const display = createMemo<DisplayItem[]>(() => buildDisplayList(session.sessions(), expanded()))

  /** Group key memo using the shared resolver. */
  const byID = createMemo(() => buildByID(session.sessions()))

  // --- End tree helpers ---

  const currentSession = (): SessionInfo | undefined => {
    const id = session.currentSessionID()
    return session.sessions().find((s) => s.id === id)
  }

  function startRename(s: SessionInfo) {
    setRenamingId(s.id)
  }

  function saveRename(title: string) {
    const id = renamingId()
    if (!id) return
    const existing = session.sessions().find((s) => s.id === id)
    if (!existing || title !== (existing.title || "")) session.renameSession(id, title)
    setRenamingId(null)
  }

  function cancelRename() {
    setRenamingId(null)
  }

  function name(s: SessionInfo) {
    return s.title || language.t("session.untitled")
  }

  function label(action: string, s: SessionInfo) {
    return `${action}: ${name(s)}`
  }

  function announce(s: DisplayItem | undefined) {
    const id = ++seq
    setNotice("")
    if (!s) return
    queueMicrotask(() => {
      if (id !== seq) return
      const current = session.currentSessionID() === s.session.id ? `. ${language.t("session.current")}` : ""
      setNotice(`${name(s.session)}${current}`)
    })
  }

  function confirmDelete(s: SessionInfo, restore?: HTMLElement) {
    dialog.show(
      () => (
        <Dialog title={language.t("session.delete.title")} fit>
          <div class="dialog-confirm-body">
            <span>{language.t("session.delete.confirm", { name: name(s) })}</span>
            <div class="dialog-confirm-actions">
              <Button variant="ghost" size="large" onClick={() => dialog.close()}>
                {language.t("common.cancel")}
              </Button>
              <Button
                variant="primary"
                size="large"
                onClick={() => {
                  session.deleteSession(s.id)
                  dialog.close()
                }}
              >
                {language.t("session.delete.button")}
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

  function wrapItem(item: DisplayItem, node: JSX.Element): JSX.Element {
    return (
      <ContextMenu>
        <ContextMenu.Trigger
          as="div"
          class="session-row"
          data-depth={item.depth}
          style={{ "--session-depth-indent": `${item.depth * 12}px` }}
        >
          <Show
            when={renamingId() === item.session.id}
            fallback={
              <>
                {node}
                <IconButton
                  data-slot="session-row-action"
                  icon="edit"
                  size="small"
                  variant="ghost"
                  aria-label={label(language.t("common.rename"), item.session)}
                  onClick={() => startRename(item.session)}
                />
                <IconButton
                  data-slot="session-row-action"
                  icon="trash"
                  size="small"
                  variant="ghost"
                  aria-label={label(language.t("session.delete.title"), item.session)}
                  onClick={(event) => confirmDelete(item.session, event.currentTarget)}
                />
              </>
            }
          >
            <div data-slot="session-row-editor">
              <SessionRenameEditor title={item.session.title || ""} fill onSave={saveRename} onCancel={cancelRename} />
            </div>
          </Show>
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content
            class="session-list-menu"
            onCloseAutoFocus={(event) => {
              if (pendingRenameId() !== item.session.id) return
              event.preventDefault()
              setPendingRenameId(null)
              startRename(item.session)
            }}
          >
            <ContextMenu.Item onSelect={() => setPendingRenameId(item.session.id)}>
              <ContextMenu.ItemLabel>{language.t("common.rename")}</ContextMenu.ItemLabel>
            </ContextMenu.Item>
            <ContextMenu.Item onSelect={() => session.exportSessionTranscript(item.session.id)}>
              <ContextMenu.ItemLabel>{language.t("command.session.export")}</ContextMenu.ItemLabel>
            </ContextMenu.Item>
            <ContextMenu.Separator />
            <ContextMenu.Item onSelect={() => confirmDelete(item.session)}>
              <ContextMenu.ItemLabel>{language.t("common.delete")}</ContextMenu.ItemLabel>
            </ContextMenu.Item>
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu>
    )
  }

  /** Resolve the date-group key for an item (all descendants inherit their root ancestor's group). */
  function groupKey(item: DisplayItem): string {
    return language.t(resolveGroupKey(item, byID()))
  }

  return (
    <div class="session-list">
      <List<DisplayItem>
        items={display()}
        key={(item) => item.session.id}
        filterKeys={["session.title"]}
        current={currentSession() ? display().find((item) => item.session.id === currentSession()!.id) : undefined}
        onMove={announce}
        onSelect={(item) => {
          if (item && renamingId() !== item.session.id) {
            props.onSelectSession(item.session.id)
          }
        }}
        search={{ placeholder: language.t("session.search.placeholder"), autofocus: true }}
        emptyMessage={language.t("session.empty")}
        groupBy={groupKey}
        sortGroupsBy={(a, b) => {
          const rank = Object.fromEntries(DATE_GROUP_KEYS.map((k, i) => [language.t(k), i]))
          return (rank[a.category] ?? 99) - (rank[b.category] ?? 99)
        }}
        itemWrapper={wrapItem}
      >
        {(item) => (
          <>
            {/* Disclosure slot: real toggle when expandable, inert placeholder otherwise */}
            <Show
              when={item.hasChildren}
              fallback={<span data-slot="session-disclosure" data-placeholder="true" aria-hidden="true" />}
            >
              <button
                data-slot="session-disclosure"
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  e.preventDefault()
                  toggle(item.session.id)
                }}
                aria-label={expanded().has(item.session.id) ? "Collapse children" : "Expand children"}
              >
                <Icon name={expanded().has(item.session.id) ? "chevron-down" : "chevron-right"} />
              </button>
            </Show>
            {/* Seq + title share the title column; seq is fixed-width so digits never shift the name */}
            <span data-slot="list-item-title">
              <Show when={item.depth > 0}>
                <span data-slot="session-seq">#{item.seq}</span>
              </Show>
              <span data-slot="list-item-title-text">{name(item.session)}</span>
            </span>
            <span data-slot="list-item-description">{formatRelativeDate(item.session.updatedAt)}</span>
            <Show when={session.currentSessionID() === item.session.id}>
              <span class="sr-only">{language.t("session.current")}</span>
            </Show>
          </>
        )}
      </List>
      <div data-slot="session-list-status" class="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {notice()}
      </div>
    </div>
  )
}

export default SessionList
