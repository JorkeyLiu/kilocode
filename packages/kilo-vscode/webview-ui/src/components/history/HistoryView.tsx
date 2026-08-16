/**
 * HistoryView component
 * Local session history list.
 */

import { Component, createEffect, onCleanup } from "solid-js"
import { Button } from "@kilocode/kilo-ui/button"
import { useLanguage } from "../../context/language"
import SessionList from "./SessionList"

interface HistoryViewProps {
  onSelectSession: (id: string) => void
  onBack?: () => void
}

const HistoryView: Component<HistoryViewProps> = (props) => {
  const language = useLanguage()
  let localPanel: HTMLDivElement | undefined

  createEffect(() => {
    const frame = requestAnimationFrame(() => {
      localPanel
        ?.querySelector<HTMLInputElement | HTMLTextAreaElement>(
          '[data-slot="list-search"] input, [data-slot="list-search"] textarea',
        )
        ?.focus()
    })

    onCleanup(() => cancelAnimationFrame(frame))
  })

  return (
    <div class="history-view">
      <div class="history-view-header">
        <Button variant="ghost" size="small" icon="arrow-left" onClick={() => props.onBack?.()}>
          {language.t("common.goBack")}
        </Button>
      </div>
      <div class="history-view-content" ref={localPanel} id="history-panel-local" role="tabpanel">
        <SessionList onSelectSession={props.onSelectSession} />
      </div>
    </div>
  )
}

export default HistoryView
