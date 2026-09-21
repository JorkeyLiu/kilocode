/** @jsxImportSource solid-js */
import { Component, Show, createMemo } from "solid-js"
import type { PanelOperation } from "../src/types/messages/agent-manager"
import { operationStatusText, operationStatusTone } from "./operation-status-helpers"

export { operationStatusText, operationStatusTone } from "./operation-status-helpers"

export const OperationStatus: Component<{ op?: PanelOperation }> = (props) => {
  const text = createMemo(() => operationStatusText(props.op))
  const tone = createMemo(() => operationStatusTone(props.op))
  return (
    <Show when={text()}>
      {(t) => (
        <div data-component="am-operation-status" data-tone={tone()}>
          <span data-slot="am-operation-text">{t()}</span>
        </div>
      )}
    </Show>
  )
}
