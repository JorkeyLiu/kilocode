/**
 * Drag-and-drop sortable tab components for the agent manager tab bar.
 */

import { Component } from "solid-js"
import type { JSX } from "solid-js"
import type { SessionInfo } from "../src/types/messages"
import { IconButton } from "@kilocode/kilo-ui/icon-button"
import { Icon } from "@kilocode/kilo-ui/icon"
import { TooltipKeybind } from "@kilocode/kilo-ui/tooltip"
import { useLanguage } from "../src/context/language"
import { SessionTab } from "../src/components/chat/SessionTab"
import { SessionTabMenu } from "../src/components/chat/SessionTabMenu"
import { SortableTabContainer } from "../src/components/chat/TabDnd"
import { parseBindingTokens } from "./keybind-tokens"

/** Individual sortable tab wrapper using the `use:sortable` directive. */
export const SortableTab: Component<{
  tab: SessionInfo
  active: boolean
  busy: boolean
  keybind?: string
  closeKeybind?: string
  onSelect: () => void
  onMiddleClick: (e: MouseEvent) => void
  onClose: () => void
  onCloseOthers: () => void
  onFork?: () => void
  role?: "tab"
  selected?: boolean
  tabIndex?: number
  onKeyDown?: JSX.EventHandlerUnion<HTMLDivElement, KeyboardEvent>
}> = (props) => {
  const { t } = useLanguage()
  return (
    <SortableTabContainer id={props.tab.id}>
      <SessionTabMenu
        showFork
        onFork={props.onFork}
        onClose={props.onClose}
        onCloseOthers={props.onCloseOthers}
        closeShortcut={
          props.closeKeybind ? (
            <span class="am-menu-shortcut">
              {parseBindingTokens(props.closeKeybind).map((token) => (
                <kbd class="am-menu-key">{token}</kbd>
              ))}
            </span>
          ) : undefined
        }
      >
        <SessionTab
          title={props.tab.title || t("agentManager.session.untitled")}
          active={props.active}
          busy={props.busy}
          keybind={props.keybind}
          closeKeybind={props.closeKeybind}
          closeTabIndex={props.active ? 0 : -1}
          role={props.role}
          selected={props.selected}
          tabIndex={props.tabIndex}
          onKeyDown={props.onKeyDown}
          closeTitle={t("agentManager.tab.close")}
          closeLabel={t("agentManager.tab.closeTab")}
          onSelect={props.onSelect}
          onMiddleClick={props.onMiddleClick}
          onClose={props.onClose}
        />
      </SessionTabMenu>
    </SortableTabContainer>
  )
}
