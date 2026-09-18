/** @jsxImportSource solid-js */
import { Show, type Component } from "solid-js"
import { Button } from "@kilocode/kilo-ui/button"
import { useWorkStyle } from "../src/context/work-style"
import { useLanguage } from "../src/context/language"

/**
 * Agent Manager empty-state Work Style picker. Mounts the existing picker
 * surface (Review/Autonomous) when no session exists; never restores ordinary
 * chat. Consumes the canonical `useWorkStyle()` owner (provided by
 * `WorkStyleProvider` in the AgentManagerApp chain) so toasts, applying
 * state, and Custom display stay consistent with the ordinary surface.
 */
export const WorkStyleEmptyPicker: Component = () => {
  const work = useWorkStyle()
  const language = useLanguage()

  return (
    <div class="am-workstyle-picker" data-testid="am-workstyle-picker">
      <div class="am-workstyle-title">{language.t("workStyle.main.title")}</div>
      <div style={{ display: "flex", gap: "8px", "flex-wrap": "wrap", "justify-content": "center" }}>
        <Button
          variant={work.level() === "review" ? "primary" : "secondary"}
          size="small"
          disabled={work.applying()}
          onClick={() => work.apply("human-in-the-loop")}
        >
          {language.t("workStyle.level.review")}
        </Button>
        <Button
          variant={work.level() === "autonomous" ? "primary" : "secondary"}
          size="small"
          disabled={work.applying()}
          onClick={() => work.apply("autonomous")}
        >
          {language.t("workStyle.level.autonomous")}
        </Button>
      </div>
      <Show when={work.level() === "custom"}>
        <div class="am-workstyle-custom">{language.t("workStyle.level.custom")}</div>
      </Show>
    </div>
  )
}
