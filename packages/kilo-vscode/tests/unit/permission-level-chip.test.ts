import { describe, expect, it } from "bun:test"
import path from "node:path"
import * as fs from "node:fs"
import { randomUUID } from "node:crypto"
import esbuild from "esbuild"
import { solidPlugin } from "esbuild-plugin-solid"

// Static contract + real component interaction for PermissionLevelChip.
//
// Static: the chip posts exactly openSettingsPanel/autoApprove and never
// posts applyWorkStyle/setWorkStyle/updateConfig or mutates config.
// Runtime: renders the real PermissionLevelChip (solid-js + happy-dom,
// same esbuild toolchain as production) and clicks it, proving navigation.
const WEBVIEW = path.resolve(import.meta.dir, "../../webview-ui")
const ROOT = path.resolve(import.meta.dir, "../..")

const PASS = "PERMISSION_CHIP_PASS"
const FAIL = "PERMISSION_CHIP_FAIL:"

const CHILD = `
  import { Window } from "happy-dom"

  const window = new Window()
  globalThis.window = window
  globalThis.document = window.document
  globalThis.Node = window.Node
  globalThis.navigator = window.navigator
  globalThis.CustomEvent = window.CustomEvent
  globalThis.MouseEvent = window.MouseEvent
  globalThis.MutationObserver = window.MutationObserver
  if (window.ResizeObserver) globalThis.ResizeObserver = window.ResizeObserver
  if (window.IntersectionObserver) globalThis.IntersectionObserver = window.IntersectionObserver
  globalThis.requestAnimationFrame = window.requestAnimationFrame?.bind(window) ?? ((cb) => setTimeout(cb, 0))
  globalThis.cancelAnimationFrame = window.cancelAnimationFrame?.bind(window) ?? clearTimeout

  const { createComponent, createSignal } = await import("solid-js")
  const { render } = await import("solid-js/web")
  const { VSCodeProvider } = await import("./src/context/vscode.tsx")
  const { LanguageContext } = await import("./src/context/language.tsx")
  const { WorkStyleContext } = await import("./src/context/work-style.tsx")
  const { resolveTemplate } = await import("./src/context/language-utils.ts")
  const { PermissionLevelChip } = await import("./src/components/shared/PermissionLevelChip.tsx")

  const fail = (reason) => {
    console.log("${FAIL}" + reason)
    process.exit(2)
  }

  const noop = () => {}
  const dict = {
    "workStyle.level.review": "Review",
    "workStyle.level.autonomous": "Autonomous",
    "workStyle.level.custom": "Custom",
    "workStyle.level.unset": "Not set",
    "permissionLevelChip.tooltip": "Open permission settings",
    "permissionLevelChip.aria": "Permission level {{level}}. Open permission settings.",
  }
  const t = (key, params) => resolveTemplate(dict[key] ?? key, params)
  const languageValue = {
    locale: () => "en",
    setLocale: noop,
    userOverride: () => "",
    t,
  }

  function mount(level) {
    const seen = []
    const onMsg = (e) => seen.push(e.detail)
    window.addEventListener("kilo-webview-message", onMsg)
    const root = document.createElement("div")
    document.body.appendChild(root)
    const workValue = {
      style: () => "unset",
      level: () => level,
      loading: () => false,
      applying: () => false,
      shouldShowOnboarding: () => false,
      apply: noop,
    }
    const dispose = render(
      () =>
        createComponent(VSCodeProvider, {
          get children() {
            return createComponent(LanguageContext.Provider, {
              value: languageValue,
              get children() {
                return createComponent(WorkStyleContext.Provider, {
                  value: workValue,
                  get children() {
                    return createComponent(PermissionLevelChip, {})
                  },
                })
              },
            })
          },
        }),
      root,
    )
    return { root, dispose, seen, cleanup: () => { window.removeEventListener("kilo-webview-message", onMsg); dispose(); root.remove() } }
  }

  // Review renders and navigates on click.
  {
    const { root, seen, cleanup } = mount("review")
    const btn = root.querySelector('[data-testid="permission-level-chip"]')
    if (!btn) fail("chip button missing")
    if (btn.tagName.toLowerCase() !== "button") fail("chip is not a native button")
    if (!btn.textContent.includes("Review")) fail("review text wrong: " + JSON.stringify(btn.textContent))
    const aria = btn.getAttribute("aria-label") ?? ""
    if (aria !== "Permission level Review. Open permission settings.") fail("aria not fully interpolated: " + JSON.stringify(aria))
    if (/[{}]/.test(aria)) fail("aria contains braces: " + JSON.stringify(aria))
    if (btn.hasAttribute("disabled")) fail("chip must stay enabled offline (navigation)")
    btn.click()
    await new Promise((r) => setTimeout(r, 0))
    if (seen.length !== 1) fail("expected exactly one message, saw " + seen.length)
    const msg = seen[0]
    if (msg?.type !== "openSettingsPanel" || msg?.tab !== "autoApprove") {
      fail("wrong message: " + JSON.stringify(msg))
    }
    if (Object.keys(msg).sort().join(",") !== "tab,type") fail("extra keys: " + JSON.stringify(msg))
    cleanup()
  }

  // Autonomous / Custom / skipped-as-Not-set display.
  {
    const cases = [["autonomous", "Autonomous"], ["custom", "Custom"], ["skipped", "Not set"], ["unset", "Not set"]]
    for (const [level, want] of cases) {
      const { root, cleanup } = mount(level)
      const btn = root.querySelector('[data-testid="permission-level-chip"]')
      if (!btn) fail(level + " chip missing")
      if (!btn.textContent.includes(want)) fail(level + " text wrong: " + JSON.stringify(btn.textContent))
      const aria = btn.getAttribute("aria-label") ?? ""
      if (aria !== "Permission level " + want + ". Open permission settings.") fail(level + " aria wrong: " + JSON.stringify(aria))
      if (/[{}]/.test(aria)) fail(level + " aria contains braces: " + JSON.stringify(aria))
      cleanup()
    }
  }

  console.log("${PASS}")
`

describe("PermissionLevelChip contract", () => {
  const chip = fs.readFileSync(path.join(WEBVIEW, "src/components/shared/PermissionLevelChip.tsx"), "utf-8")
  const prompt = fs.readFileSync(path.join(WEBVIEW, "src/components/chat/PromptInput.tsx"), "utf-8")
  const agent = fs.readFileSync(path.join(WEBVIEW, "agent-manager/AgentManagerApp.tsx"), "utf-8")
  const picker = fs.readFileSync(path.join(WEBVIEW, "agent-manager/WorkStyleEmptyPicker.tsx"), "utf-8")

  it("posts exactly openSettingsPanel/autoApprove", () => {
    expect(chip).toContain('openSettingsPanel')
    expect(chip).toContain('autoApprove')
  })

  it("never mutates config", () => {
    expect(chip).not.toContain("applyWorkStyle")
    expect(chip).not.toContain("setWorkStyle")
    expect(chip).not.toContain("updateConfig")
  })

  it("uses canonical work-style state and native button/tooltip patterns", () => {
    expect(chip).toContain("useWorkStyle")
    expect(chip).toContain("useVSCode")
    expect(chip).toContain('Tooltip')
    expect(chip).toContain('placement="top"')
    expect(chip).toContain('variant="ghost"')
    expect(chip).toContain('size="small"')
    expect(chip).toContain("permission-level-chip")
  })

  it("sits after ThinkingSelector and before the reset-model button", () => {
    const thinking = prompt.indexOf("<ThinkingSelector")
    const levelChip = prompt.indexOf("<PermissionLevelChip")
    const reset = prompt.indexOf("prompt.action.resetModel")
    expect(thinking).toBeGreaterThan(-1)
    expect(levelChip).toBeGreaterThan(-1)
    expect(reset).toBeGreaterThan(-1)
    expect(levelChip).toBeGreaterThan(thinking)
    expect(levelChip).toBeLessThan(reset)
  })

  it("agent manager owns one canonical work-style state", () => {
    expect(agent).toContain("WorkStyleProvider")
    expect(picker).toContain("useWorkStyle")
    expect(picker).not.toContain("requestWorkStyle")
    expect(picker).not.toContain("workStyleLoaded")
    expect(picker).not.toContain("applyWorkStyle")
  })

  it("renders and navigates on click (real component)", async () => {
    const name = `.tmp-permission-chip-${randomUUID()}`
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
          expect.unreachable(output.slice(logic + FAIL.length).split("\n")[0]?.trim())
        }
        failures.push(`attempt ${attempt} exit ${result.exitCode}: ${output.trim() || "<no output>"}`)
      }
      expect.unreachable(`PermissionLevelChip child never reported success:\n${failures.join("\n")}`)
    } finally {
      fs.rmSync(entry, { force: true })
      fs.rmSync(out, { force: true })
    }
  })
})
