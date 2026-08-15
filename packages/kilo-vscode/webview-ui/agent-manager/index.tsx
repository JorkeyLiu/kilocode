// Agent Manager SolidJS entry point
// Shares components and providers with the editor-tab chat webview
// webviewReady is sent by ServerProvider inside the component tree

import { render } from "solid-js/web"
import "@kilocode/kilo-ui/styles"
import "../src/styles/chat.css"
import { AgentManagerApp } from "./AgentManagerApp"
import { p0WebviewStage } from "../src/utils/perf"

const root = document.getElementById("root")
if (root) {
  // P0 perf: module load -> render commit -> first paint (opt-in KILO_P0_PERF).
  p0WebviewStage("webview.load")
  render(() => <AgentManagerApp />, root)
  p0WebviewStage("webview.render")
  requestAnimationFrame(() => p0WebviewStage("webview.paint"))
}
