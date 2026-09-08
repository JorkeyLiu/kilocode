import { describe, expect, it } from "bun:test"
import path from "node:path"
import * as fs from "node:fs"
import { randomUUID } from "node:crypto"
import esbuild from "esbuild"
import { solidPlugin } from "esbuild-plugin-solid"

// Focused regression for the happy-dom deterministic crash: VSCodeProvider
// postMessage must dispatch a window-realm CustomEvent (not a foreign-realm
// global CustomEvent) and must still call the VS Code API with the same
// message. Runs in a child like the session harnesses: solid-js effects only
// run under the browser condition and JSX needs esbuild-plugin-solid.
const WEBVIEW = path.resolve(import.meta.dir, "../../webview-ui")

const PASS = "VSCODE_POST_MESSAGE_PASS"
const FAIL = "VSCODE_POST_MESSAGE_FAIL:"

const CHILD = `
  import { Window } from "happy-dom"

  const window = new Window()
  globalThis.window = window
  globalThis.document = window.document
  globalThis.Node = window.Node
  globalThis.navigator = window.navigator

  const sent = []
  globalThis.acquireVsCodeApi = () => ({
    postMessage: (message) => sent.push(message),
    getState: () => undefined,
    setState: () => {},
  })

  const { createComponent, useContext } = await import("solid-js")
  const { render } = await import("solid-js/web")
  const { VSCodeProvider, useVSCode } = await import("./src/context/vscode.tsx")

  const fail = (reason) => {
    console.log("${FAIL}" + reason)
    process.exit(2)
  }

  let ctx = null
  const Probe = () => {
    ctx = useVSCode()
    return null
  }

  const root = document.createElement("div")
  const dispose = render(() => createComponent(VSCodeProvider, { get children() { return createComponent(Probe, {}) } }), root)

  if (!ctx) fail("VSCode context never became available")

  const received = []
  window.addEventListener("kilo-webview-message", (event) => received.push(event))

  const message = { type: "requestVariants" }
  // Must not throw: a foreign-realm CustomEvent deterministically crashes
  // happy-dom dispatchEvent (parameter 1 is not of type Event).
  try {
    ctx.postMessage(message)
  } catch (err) {
    fail("postMessage dispatch threw: " + String(err && err.stack || err))
  }

  const apiHit = sent.find((m) => m.type === "requestVariants")
  if (!apiHit) fail("VS Code api.postMessage never called: " + JSON.stringify(sent))
  if (received.length !== 1) fail("expected one kilo-webview-message event: got " + received.length)
  const event = received[0]
  if (!(event instanceof window.Event)) fail("dispatched event is not a window-realm Event")
  if (event.type !== "kilo-webview-message") fail("wrong event type: " + JSON.stringify(event.type))
  if (JSON.stringify(event.detail) !== JSON.stringify(message)) {
    fail("event detail must carry the posted message: got " + JSON.stringify(event.detail))
  }

  dispose()
  console.log("${PASS}")
`

describe("vscode postMessage window-realm event", () => {
  it("calls the VS Code API and notifies in-webview listeners with kilo-webview-message + detail", async () => {
    const name = `.tmp-vscode-post-message-${randomUUID()}`
    const entry = path.join(WEBVIEW, `${name}.ts`)
    const out = path.join(WEBVIEW, `${name}.js`)
    fs.writeFileSync(entry, CHILD)
    try {
      const built = await esbuild.build({
        entryPoints: [entry],
        bundle: true,
        format: "esm",
        platform: "browser",
        outfile: out,
        plugins: [solidPlugin()],
        external: ["happy-dom"],
        logLevel: "silent",
      })
      if (built.errors.length > 0) {
        expect.unreachable(`child bundle failed:\n${built.errors.map((e) => e.text).join("\n")}`)
      }

      const attempts = 3
      const failures: string[] = []
      for (let attempt = 1; attempt <= attempts; attempt++) {
        const result = Bun.spawnSync(["bun", out], {
          cwd: WEBVIEW,
          stdout: "pipe",
          stderr: "pipe",
        })
        const output = result.stdout.toString() + result.stderr.toString()
        if (output.includes(PASS)) return
        const logic = output.indexOf(FAIL)
        if (logic !== -1) {
          expect.unreachable(
            output
              .slice(logic + FAIL.length)
              .split("\n")[0]
              ?.trim(),
          )
        }
        failures.push(`attempt ${attempt} exit ${result.exitCode}: ${output.trim() || "<no output>"}`)
      }
      expect.unreachable(`vscode postMessage child never reported success:\n${failures.join("\n")}`)
    } finally {
      fs.rmSync(entry, { force: true })
      fs.rmSync(out, { force: true })
    }
  })
})
