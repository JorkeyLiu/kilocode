import { describe, expect, it } from "bun:test"
import path from "node:path"
import * as fs from "node:fs"
import { randomUUID } from "node:crypto"
import esbuild from "esbuild"
import { solidPlugin } from "esbuild-plugin-solid"

// Static contract + real component interaction for PermissionLevelChip.
//
// Static: the shield entry posts exactly openSettingsPanel/autoApprove and
// never posts applyWorkStyle/setWorkStyle/updateConfig/toggleAutoApprove or
// mutates config. It lives in hint-actions next to the sandbox lock, never in
// hint-selectors with Agent/Model/Thinking selectors.
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
  const { ThinkingSelectorBase } = await import("./src/components/shared/ThinkingSelector.tsx")

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

  // Review renders as icon-only shield and navigates on click.
  {
    const { root, seen, cleanup } = mount("review")
    const btn = root.querySelector('[data-testid="permission-level-chip"]')
    if (!btn) fail("chip button missing")
    if (btn.tagName.toLowerCase() !== "button") fail("chip is not a native button")
    const text = (btn.textContent ?? "").trim()
    if (text.length !== 0) fail("shield entry must be icon-only, saw text: " + JSON.stringify(btn.textContent))
    if (text.includes("Permissions:")) fail("shield must not carry selector text")
    if (!btn.innerHTML.includes("shield")) fail("shield icon missing: " + JSON.stringify(btn.innerHTML.slice(0, 200)))
    if (btn.innerHTML.includes('name="lock"') || btn.innerHTML.includes(">lock<")) fail("shield must not reuse sandbox lock identity")
    const aria = btn.getAttribute("aria-label") ?? ""
    if (aria !== "Permission level Review. Open permission settings.") fail("aria not fully interpolated: " + JSON.stringify(aria))
    if (/[{}]/.test(aria)) fail("aria contains braces: " + JSON.stringify(aria))
    const title = btn.getAttribute("title") ?? ""
    if (title !== aria) fail("title must carry the level: " + JSON.stringify(title))
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

  // Autonomous / Custom / skipped-as-Not-set aria + title.
  {
    const cases = [["autonomous", "Autonomous"], ["custom", "Custom"], ["skipped", "Not set"], ["unset", "Not set"]]
    for (const [level, want] of cases) {
      const { root, cleanup } = mount(level)
      const btn = root.querySelector('[data-testid="permission-level-chip"]')
      if (!btn) fail(level + " chip missing")
      const aria = btn.getAttribute("aria-label") ?? ""
      if (aria !== "Permission level " + want + ". Open permission settings.") fail(level + " aria wrong: " + JSON.stringify(aria))
      if (/[{}]/.test(aria)) fail(level + " aria contains braces: " + JSON.stringify(aria))
      const title = btn.getAttribute("title") ?? ""
      if (!title.includes(want)) fail(level + " title missing level: " + JSON.stringify(title))
      if ((btn.textContent ?? "").trim().length !== 0) fail(level + " must stay icon-only")
      cleanup()
    }
  }

  // Composer coexistence: exactly one thinking variant label (Low) and one
  // independent shield icon — never two reasoning selectors, never selector
  // text on the shield.
  {
    const root = document.createElement("div")
    document.body.appendChild(root)
    const workValue = {
      style: () => "unset",
      level: () => "unset",
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
                    return [
                      createComponent(ThinkingSelectorBase, {
                        variants: ["low", "medium", "high"],
                        value: "low",
                        onSelect: noop,
                        globalTrigger: false,
                      }),
                      createComponent(PermissionLevelChip, {}),
                    ]
                  },
                })
              },
            })
          },
        }),
      root,
    )
    const thinking = root.querySelectorAll(".thinking-selector-trigger-label")
    if (thinking.length !== 1) fail("expected one thinking label, saw " + thinking.length)
    if ((thinking[0].textContent ?? "").trim() !== "Low") {
      fail("thinking text wrong: " + JSON.stringify(thinking[0].textContent))
    }
    const chips = root.querySelectorAll('[data-testid="permission-level-chip"]')
    if (chips.length !== 1) fail("expected one permission shield, saw " + chips.length)
    if ((chips[0].textContent ?? "").trim().length !== 0) fail("shield must be icon-only")
    if (!(chips[0].getAttribute("aria-label") ?? "").includes("Not set")) {
      fail("coexist aria wrong: " + JSON.stringify(chips[0].getAttribute("aria-label")))
    }
    if ((chips[0].textContent ?? "").trim() === "Low") fail("chip must not mimic thinking label")
    dispose()
    root.remove()
  }

  console.log("${PASS}")
  process.exit(0)
`

describe("PermissionLevelChip contract", () => {
  const chip = fs.readFileSync(path.join(WEBVIEW, "src/components/shared/PermissionLevelChip.tsx"), "utf-8")
  const prompt = fs.readFileSync(path.join(WEBVIEW, "src/components/chat/PromptInput.tsx"), "utf-8")
  const agent = fs.readFileSync(path.join(WEBVIEW, "agent-manager/AgentManagerApp.tsx"), "utf-8")
  const picker = fs.readFileSync(path.join(WEBVIEW, "agent-manager/WorkStyleEmptyPicker.tsx"), "utf-8")

  it("posts exactly openSettingsPanel/autoApprove", () => {
    expect(chip).toContain("openSettingsPanel")
    expect(chip).toContain("autoApprove")
  })

  it("never mutates config", () => {
    expect(chip).not.toContain("applyWorkStyle")
    expect(chip).not.toContain("setWorkStyle")
    expect(chip).not.toContain("updateConfig")
    expect(chip).not.toContain("toggleAutoApprove")
  })

  it("uses canonical work-style state and native button/tooltip patterns", () => {
    expect(chip).toContain("useWorkStyle")
    expect(chip).toContain("useVSCode")
    expect(chip).toContain("Tooltip")
    expect(chip).toContain('placement="top"')
    expect(chip).toContain('variant="ghost"')
    expect(chip).toContain('size="small"')
    expect(chip).toContain("permission-level-chip")
  })

  it("is an icon-only shield entry distinct from the sandbox lock", () => {
    expect(chip).toContain('name="shield"')
    expect(chip).not.toContain('name="lock"')
    expect(chip).not.toContain("permissionLevelChip.label")
    expect(chip).not.toContain("Permissions:")
    expect(chip).toContain("permissionLevelChip.aria")
    expect(chip).toContain("title={label()}")
  })

  it("keeps thinking variant logic untouched", () => {
    const thinking = fs.readFileSync(path.join(WEBVIEW, "src/components/shared/ThinkingSelector.tsx"), "utf-8")
    expect(thinking).toContain("thinking-selector-trigger-label")
    expect(thinking).not.toContain("Permissions:")
    expect(thinking).not.toContain("permissionLevelChip")
  })

  it("reuses the baseline permission keys in every locale", () => {
    const dir = path.join(WEBVIEW, "src/i18n")
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".ts"))
    expect(files.length).toBe(20)
    for (const file of files) {
      const text = fs.readFileSync(path.join(dir, file), "utf-8")
      expect(text).not.toContain("permissionLevelChip.label")
      expect(text).toContain('"permissionLevelChip.tooltip": "Open permission settings"')
      expect(text).toContain('"permissionLevelChip.aria": "Permission level {{level}}. Open permission settings."')
    }
  })

  it("sits in hint-actions next to SandboxButton, never in hint-selectors", () => {
    const selectorsStart = prompt.indexOf("prompt-input-hint-selectors")
    const actionsStart = prompt.indexOf("prompt-input-hint-actions")
    const chipIndex = prompt.indexOf("<PermissionLevelChip")
    const sandboxIndex = prompt.indexOf("<SandboxButtonBase")
    const thinkingIndex = prompt.indexOf("<ThinkingSelector")
    expect(selectorsStart).toBeGreaterThan(-1)
    expect(actionsStart).toBeGreaterThan(-1)
    expect(chipIndex).toBeGreaterThan(-1)
    expect(sandboxIndex).toBeGreaterThan(-1)
    expect(thinkingIndex).toBeGreaterThan(-1)
    expect(chipIndex).toBeGreaterThan(actionsStart)
    expect(chipIndex).toBeLessThan(prompt.indexOf("prompt.action.enhance", actionsStart))
    const selectorsBlock = prompt.slice(selectorsStart, actionsStart)
    expect(selectorsBlock).not.toContain("<PermissionLevelChip")
    expect(thinkingIndex).toBeLessThan(actionsStart)
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
  }, 30000)
})
