/**
 * JSX helpers for the agent-manager tab bar.
 *
 * Extracted from AgentManagerApp.tsx to keep that file under the
 * `max-lines` lint cap. These are not standalone components — they are
 * render helpers the main component composes with its `<For>` tab loop
 * and content area.
 */

import { Show } from "solid-js"
import type { Accessor, JSX } from "solid-js"
import { IconButton } from "@kilocode/kilo-ui/icon-button"
import { TooltipKeybind } from "@kilocode/kilo-ui/tooltip"
import { SortableTab } from "./sortable-tab"
import type { SessionInfo } from "../src/types/messages"

interface FocusTabDeps {
  id: string
  isPending: (id: string) => boolean
  tabLookup: Accessor<Map<string, SessionInfo>>
  setActivePendingId: (id: string | undefined) => void
  clearSession: () => void
  selectSession: (id: string) => void
}

export function focusCurrentTab(deps: FocusTabDeps) {
  const target = deps.tabLookup().get(deps.id)
  if (!target) return
  if (deps.isPending(target.id)) {
    deps.setActivePendingId(target.id)
    deps.clearSession()
    return
  }
  deps.setActivePendingId(undefined)
  deps.selectSession(target.id)
}

export interface TabRenderDeps {
  tabIds: () => string[]
  kb: () => Record<string, string>
  currentSessionID: () => string | undefined
  activePendingId: () => string | undefined
  /** Id of the currently visible tab. Single source of truth — kept in
   *  the parent component as `visibleTabId` (session ids only).
   *  Consumed here as a getter so Solid tracks its reactivity inside
   *  rendered JSX. */
  visibleTabId: () => string | undefined
  isPending: (id: string) => boolean
  isBusy: (id: string) => boolean
  tabLookup: () => Map<string, SessionInfo>
  adjacentHint: (id: string, activeId: string, ids: string[], prev: string, next: string) => string
  // Context and registry (for atomic close-others)
  ctx: () => string
  tabMgrCloseOthers: (ctx: string, target: string) => void
  // Handlers
  selectSessionTab: (id: string, pending: boolean) => void
  sessionMiddleClick: (id: string, e: MouseEvent) => void
  sessionClose: (id: string) => void
  /** Lightweight close: sends the backend close message without
   *  updating the tab registry or switching the active session. */
  sessionCloseMessage: (id: string) => void
  sessionFork: (id: string) => void
  onTabKey: (id: string, event: KeyboardEvent) => void
}

/** Render a single tab by id — session render path only. */
export function renderTab(id: string, deps: TabRenderDeps): JSX.Element {
  return <Show when={deps.tabLookup().get(id)}>{(s) => renderSessionTab(s, deps)}</Show>
}

function renderSessionTab(s: () => SessionInfo | undefined, deps: TabRenderDeps): JSX.Element {
  const pending = deps.isPending(s()!.id)
  const active = () =>
    pending ? s()!.id === deps.activePendingId() && !deps.currentSessionID() : s()!.id === deps.currentSessionID()
  const keybind = () => {
    if (active()) return ""
    return deps.adjacentHint(
      s()!.id,
      deps.visibleTabId() ?? "",
      deps.tabIds(),
      deps.kb().previousTab ?? "",
      deps.kb().nextTab ?? "",
    )
  }
  return (
    <SortableTab
      tab={s()!}
      active={active()}
      busy={deps.isBusy(s()!.id)}
      role="tab"
      selected={deps.visibleTabId() === s()!.id}
      tabIndex={deps.visibleTabId() === s()!.id ? 0 : -1}
      onKeyDown={(event) => deps.onTabKey(s()!.id, event)}
      keybind={keybind()}
      closeKeybind={deps.kb().closeTab ?? ""}
      onSelect={() => {
        deps.selectSessionTab(s()!.id, pending)
      }}
      onMiddleClick={(e: MouseEvent) => deps.sessionMiddleClick(s()!.id, e)}
      onClose={() => deps.sessionClose(s()!.id)}
      onCloseOthers={() => closeOthers(s()!.id, deps)}
      onFork={pending ? undefined : () => deps.sessionFork(s()!.id)}
    />
  )
}

function closeOthers(target: string, deps: TabRenderDeps) {
  // Collect the session IDs that need individual close messages sent to
  // the backend.
  const removedSessions: string[] = []
  for (const id of deps.tabIds()) {
    if (id === target) continue
    removedSessions.push(id)
  }
  // Atomically update the tab registry: keep only the target.
  deps.tabMgrCloseOthers(deps.ctx(), target)
  // Send individual close messages for each removed session so the backend
  // cleans up, and handle pending draft cleanup. These are lightweight
  // messages — they do NOT mutate the tab registry (already updated above).
  for (const id of removedSessions) {
    deps.sessionCloseMessage(id)
  }
  // Activate the surviving target.
  deps.selectSessionTab(target, deps.isPending(target))
}

export interface NewTabButtonDeps {
  contextSelected: () => boolean
  kb: () => Record<string, string>
  newSessionLabel: string
  moreOptionsLabel: string
  onNewSession: () => void
}

/**
 * Render the tab bar's "new" affordance: a single plus button that creates
 * a new agent session. Falls back to nothing when no sidebar context is
 * selected (tab bar isn't visible anyway).
 */
export function renderNewTabButton(deps: NewTabButtonDeps): JSX.Element {
  return (
    <Show when={deps.contextSelected()}>
      <div class="am-split-button am-tab-add-split">
        <TooltipKeybind
          title={deps.newSessionLabel}
          keybind={deps.kb().newTab ?? ""}
          placement="top"
          gutter={8}
          openDelay={0}
        >
          <IconButton
            icon="plus"
            size="small"
            variant="ghost"
            label={deps.newSessionLabel}
            onClick={deps.onNewSession}
          />
        </TooltipKeybind>
      </div>
    </Show>
  )
}
