import { describe, expect, it } from "bun:test"
import path from "node:path"
import * as fs from "node:fs"
import { randomUUID } from "node:crypto"
import esbuild from "esbuild"
import { solidPlugin } from "esbuild-plugin-solid"

// Renders the real ModeSwitcherBase (kilo-ui popover + solid-js JSX) in a
// happy-dom child process, bundled with the same esbuild + esbuild-plugin-solid
// toolchain the production webview uses (bun's runtime transpiler does not honor
// the webview tsconfig's solid-js jsxImportSource). The child prints an explicit
// PASS/FAIL sentinel; other non-zero exits are transient spawn failures and are
// retried so the suite stays deterministic.
const WEBVIEW = path.resolve(import.meta.dir, "../../webview-ui")

const PASS = "MODE_SWITCHER_PASS"
const FAIL = "MODE_SWITCHER_FAIL:"

const CHILD = `
  import { Window } from "happy-dom"

  const window = new Window()
  globalThis.window = window
  globalThis.document = window.document
  globalThis.Node = window.Node
  globalThis.navigator = window.navigator

  const { createComponent, createSignal } = await import("solid-js")
  const { render } = await import("solid-js/web")
  const { LanguageContext } = await import("./src/context/language.tsx")
  const { ModeSwitcherBase } = await import("./src/components/shared/ModeSwitcher.tsx")

  const fail = (reason) => {
    console.log("${FAIL}" + reason)
    process.exit(2)
  }

  const noop = () => {}
  const languageValue = {
    locale: () => "en",
    setLocale: noop,
    userOverride: () => "",
    t: (key) => key,
  }

  const visibleAgents = [
    { name: "code", description: "Code", mode: "primary" },
    { name: "ask", description: "Ask", mode: "primary" },
  ]

  function mount(disabled, label, value) {
    const root = document.createElement("div")
    const dispose = render(
      () =>
        createComponent(LanguageContext.Provider, {
          value: languageValue,
          get children() {
            return createComponent(ModeSwitcherBase, {
              agents: visibleAgents,
              value,
              onSelect: noop,
              disabled,
              label,
            })
          },
        }),
      root,
    )
    return { root, dispose }
  }

  // Disabled case (child session fixed to a delegated subagent): the trigger is a
  // disabled button showing the subagent label, and no popover content exists.
  {
    const { root, dispose } = mount(true, "Delegate Writer", "delegate-writer")
    const disabledBtn = root.querySelector("button[disabled]")
    if (!disabledBtn) fail("disabled mode switcher has no disabled button")
    if (!disabledBtn.textContent.includes("Delegate Writer")) {
      fail("disabled mode switcher label wrong: " + JSON.stringify(disabledBtn.textContent))
    }
    if (root.querySelector("[data-component='popover-content']")) {
      fail("disabled mode switcher opened a popover")
    }
    dispose()
  }

  // Enabled case (regular session): the trigger is an enabled button showing the
  // visible agent label.
  {
    const { root, dispose } = mount(false, undefined, "code")
    const btn = root.querySelector("button")
    if (!btn) fail("enabled mode switcher has no trigger button")
    if (btn.hasAttribute("disabled")) fail("enabled mode switcher trigger is disabled")
    if (!btn.textContent.includes("Code")) {
      fail("enabled mode switcher label wrong: " + JSON.stringify(btn.textContent))
    }
    dispose()
  }

  console.log("${PASS}")
`

describe("ModeSwitcher disabled state (LOCK-002)", () => {
  it("renders a fixed disabled trigger with the subagent label; enabled otherwise", async () => {
    const name = `.tmp-mode-switcher-${randomUUID()}`
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

      expect.unreachable(`ModeSwitcher child never reported success:\n${failures.join("\n")}`)
    } finally {
      fs.rmSync(entry, { force: true })
      fs.rmSync(out, { force: true })
    }
  })
})
