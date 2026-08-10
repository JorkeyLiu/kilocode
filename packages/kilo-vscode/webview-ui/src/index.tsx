/* @refresh reload */
import "@kilocode/kilo-ui/styles"
import { render } from "solid-js/web"
import App from "./App"
import { p0WebviewStage } from "./utils/perf"

const root = document.getElementById("root")

if (!root) {
  throw new Error("Root element not found")
}

// P0 perf: module load -> render commit -> first paint (opt-in KILO_P0_PERF).
p0WebviewStage("webview.load")
render(() => <App />, root)
p0WebviewStage("webview.render")
requestAnimationFrame(() => p0WebviewStage("webview.paint"))
