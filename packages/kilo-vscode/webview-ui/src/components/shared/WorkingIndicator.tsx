/**
 * WorkingIndicator component
 * Shows a spinner, status text, and elapsed time counter while the agent is active.
 * Matches the v1.0.25 working indicator UX.
 */

import { type Component, Show, createSignal, createEffect, onCleanup } from "solid-js"
import { Spinner } from "@kilocode/kilo-ui/spinner"
import { Button } from "@kilocode/kilo-ui/button"
import { useSession } from "../../context/session"
import { useLanguage } from "../../context/language"
import { useVSCode } from "../../context/vscode"
import {
  cumulativeElapsedMs,
  formatElapsedSeconds,
  showIdleCumulative,
  showSpinner,
  showWorkingIndicator,
  tracksElapsedMs,
} from "./working-indicator-utils"

export const WorkingIndicator: Component = () => {
  const session = useSession()
  const language = useLanguage()
  const vscode = useVSCode()

  const [elapsed, setElapsed] = createSignal(0)
  const [retryCountdown, setRetryCountdown] = createSignal(0)

  // Agent Manager cumulative snapshot for the current session (undefined in
  // editor-tab webviews, which keep the legacy busySince behavior).
  const snapshot = () => {
    const id = session.currentSessionID() ?? session.draftSessionID()
    return id ? session.timingFor(id) : undefined
  }

  // Settled Agent Manager snapshot: keep showing the final cumulative duration
  // while the session is idle.
  const idleCumulative = () => showIdleCumulative(snapshot())

  const elapsedMs = () => cumulativeElapsedMs(snapshot(), session.busySince(), Date.now())

  createEffect(() => {
    const since = session.busySince()
    const status = session.status()
    const submitting = session.submitting()

    if (!tracksElapsedMs(status, submitting, since, snapshot())) {
      setElapsed(0)
      return
    }

    const tick = () => setElapsed(Math.floor(elapsedMs() / 1000))
    tick()
    const id = setInterval(tick, 1000)

    onCleanup(() => clearInterval(id))
  })

  createEffect(() => {
    const info = session.statusInfo()
    if (info.type !== "retry") {
      setRetryCountdown(0)
      return
    }

    const target = info.next
    setRetryCountdown(Math.max(0, Math.ceil((target - Date.now()) / 1000)))

    const id = setInterval(() => {
      const remaining = Math.max(0, Math.ceil((target - Date.now()) / 1000))
      setRetryCountdown(remaining)
      if (remaining <= 0) clearInterval(id)
    }, 1000)

    onCleanup(() => clearInterval(id))
  })

  const statusText = () => {
    const info = session.statusInfo()
    if (info.type === "retry") {
      const countdown = retryCountdown()
      const retryMsg = info.message || language.t("session.status.retry")
      return countdown > 0 ? `${retryMsg} (${countdown}s)` : retryMsg
    }
    if (info.type === "offline") {
      return info.message || language.t("session.status.offline")
    }
    return session.statusText() ?? language.t("ui.sessionTurn.status.thinking")
  }

  const formatElapsed = () => formatElapsedSeconds(elapsed())

  const blocked = () => {
    const id = session.currentSessionID()
    const perms = session
      .permissions()
      .filter((p) => p.sessionID === id && !(p.tool && ["todowrite", "todoread"].includes(p.toolName)))
    const questions = session.questions().filter((q) => q.sessionID === id)
    const suggestions = session.suggestions().filter((s) => s.sessionID === id)
    return perms.length > 0 || questions.length > 0 || suggestions.length > 0
  }

  const isRetrying = () => session.statusInfo().type === "retry"

  const handleCancelRetry = () => {
    const sid = session.currentSessionID()
    if (sid) {
      vscode.postMessage({ type: "abort", sessionID: sid })
    }
  }

  return (
    <div class="working-indicator-slot">
      <Show when={showWorkingIndicator(session.submitting(), session.status(), blocked(), snapshot())}>
        <div class="working-indicator">
          <Show when={showSpinner(snapshot(), session.submitting())}>
            <Spinner />
            <span class="working-text">{statusText()}</span>
          </Show>
          <Show when={elapsed() > 0}>
            <span class="working-elapsed">{formatElapsed()}</span>
          </Show>
          <Show when={isRetrying() && !idleCumulative()}>
            <Button
              variant="secondary"
              size="small"
              onClick={handleCancelRetry}
              class="working-cancel"
              style={{ "font-weight": "600", color: "var(--vscode-errorForeground, #f85149)" }}
            >
              {language.t("ui.sessionTurn.cancel") || "Cancel"}
            </Button>
          </Show>
        </div>
      </Show>
    </div>
  )
}
