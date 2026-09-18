/** @jsxImportSource solid-js */
import { Show, createSignal, onCleanup, onMount, type Component } from "solid-js"
import { Button } from "@kilocode/kilo-ui/button"
import { useVSCode } from "../src/context/vscode"
import { useLanguage } from "../src/context/language"
import type { ExtensionMessage } from "../src/types/messages"

type Main = "review" | "autonomous" | "custom" | "unset" | "skipped"

/**
 * Agent Manager empty-state Work Style picker. Mounts the existing picker
 * surface (Review/Autonomous) when no session exists; never restores ordinary
 * chat. Posts the same canonical applyWorkStyle message as Settings.
 */
export const WorkStyleEmptyPicker: Component = () => {
  const vscode = useVSCode()
  const language = useLanguage()
  const [main, setMain] = createSignal<Main>("unset")

  const unsubscribe = vscode.onMessage((message: ExtensionMessage) => {
    const rec = message as Record<string, unknown>
    if (rec.type !== "workStyleLoaded" && rec.type !== "workStyleApplied") return
    const next = (rec as { mainState?: Main; level?: Main; style?: string }).mainState
      ?? (rec as { level?: Main }).level
    if (next === "review" || next === "autonomous" || next === "custom") {
      setMain(next)
      return
    }
    const style = (rec as { style?: string }).style
    if (style === "human-in-the-loop") setMain("review")
    else if (style === "autonomous") setMain("autonomous")
  })

  onMount(() => vscode.postMessage({ type: "requestWorkStyle" }))
  onCleanup(() => unsubscribe())

  const apply = (level: "review" | "autonomous") => {
    vscode.postMessage({
      type: "applyWorkStyle",
      style: level === "review" ? "human-in-the-loop" : "autonomous",
    })
  }

  return (
    <div class="am-workstyle-picker" data-testid="am-workstyle-picker">
      <div class="am-workstyle-title">{language.t("workStyle.main.title")}</div>
      <div style={{ display: "flex", gap: "8px", "flex-wrap": "wrap", "justify-content": "center" }}>
        <Button variant={main() === "review" ? "primary" : "secondary"} size="small" onClick={() => apply("review")}>
          {language.t("workStyle.level.review")}
        </Button>
        <Button variant={main() === "autonomous" ? "primary" : "secondary"} size="small" onClick={() => apply("autonomous")}>
          {language.t("workStyle.level.autonomous")}
        </Button>
      </div>
      <Show when={main() === "custom"}>
        <div class="am-workstyle-custom">{language.t("workStyle.level.custom")}</div>
      </Show>
    </div>
  )
}
