/**
 * P3.3 static absence + presence contract for cloud-sessions and KiloClaw
 * removal (LOCK-003) in the VS Code extension.
 *
 * Static analysis — reads the extension source and webview to verify:
 * - Cloud session preview/import/fork handler, components, and message types
 *   are structurally absent.
 * - KiloClaw provider, webview tree, command, slash entry, and message types
 *   are structurally absent.
 * - The extension manifest and esbuild/knip/tsconfig no longer reference the
 *   removed KiloClaw bundle or command.
 * - Retained surfaces survive: local history (HistoryView + SessionList),
 *   Agent Manager serializer, the migration bridge, EventServiceClient
 *   presence, and generic message flow.
 */

import { describe, it, expect } from "bun:test"
import fs from "node:fs"
import path from "node:path"

const ROOT = path.resolve(import.meta.dir, "../..")
const SRC = path.join(ROOT, "src")
const WEBVIEW = path.join(ROOT, "webview-ui")

const read = (file: string) => fs.readFileSync(file, "utf8")

describe("P3.3 cloud-sessions + KiloClaw structural absence (VS Code)", () => {
  it("cloud-session handler, CloudSessionList, and cloud prune context are deleted", () => {
    for (const file of [
      path.join(SRC, "kilo-provider/handlers/cloud-session.ts"),
      path.join(WEBVIEW, "src/components/history/CloudSessionList.tsx"),
      path.join(WEBVIEW, "src/context/session-cloud-prune.ts"),
      path.join(WEBVIEW, "src/components/chat/CloudImportDialog.tsx"),
    ]) {
      expect(fs.existsSync(file), `${file} should be removed`).toBe(false)
    }
  })

  it("KiloClaw provider source and webview tree are deleted", () => {
    expect(fs.existsSync(path.join(SRC, "kiloclaw/KiloClawProvider.ts"))).toBe(false)
    expect(fs.existsSync(path.join(WEBVIEW, "kiloclaw"))).toBe(false)
  })

  it("extension.ts registers no KiloClaw provider/serializer/command or cloud deep link", () => {
    const ext = read(path.join(SRC, "extension.ts"))
    expect(ext).not.toContain("KiloClawProvider")
    expect(ext).not.toContain("kiloClawProvider")
    expect(ext).not.toContain("kilo-code.new.kiloClawOpen")
    expect(ext).not.toContain("openCloudSession")
    expect(ext).not.toContain("/kilocode/s/")
  })

  it("KiloProvider handles no cloud session or KiloClaw messages", () => {
    const provider = read(path.join(SRC, "KiloProvider.ts"))
    expect(provider).not.toContain("handleRequestCloudSessions")
    expect(provider).not.toContain("handleRequestCloudSessionData")
    expect(provider).not.toContain("handleImportAndSend")
    expect(provider).not.toContain("cloudSessionCtx")
    expect(provider).not.toContain("openCloudSession")
    expect(provider).not.toContain("openKiloClaw")
  })

  it("webview message unions carry no cloud session or KiloClaw members", () => {
    const extMessages = read(path.join(WEBVIEW, "src/types/messages/extension-messages.ts"))
    const webviewMessages = read(path.join(WEBVIEW, "src/types/messages/webview-messages.ts"))
    for (const msg of [
      "CloudSessionsLoadedMessage",
      "GitRemoteUrlLoadedMessage",
      "CloudSessionDataLoadedMessage",
      "CloudSessionImportedMessage",
      "CloudSessionImportFailedMessage",
      "OpenCloudSessionMessage",
      "RequestCloudSessionsMessage",
      "RequestCloudSessionDataMessage",
      "ImportAndSendMessage",
      "OpenKiloClawRequest",
      "RequestGitRemoteUrlMessage",
    ]) {
      expect(extMessages).not.toContain(msg)
      expect(webviewMessages).not.toContain(msg)
    }
  })

  it("session context exposes no cloud preview or selectCloudSession surface", () => {
    const session = read(path.join(WEBVIEW, "src/context/session.tsx"))
    expect(session).not.toContain("selectCloudSession")
    expect(session).not.toContain("cloudPreviewId")
    expect(session).not.toContain("handleCloudSessionDataLoaded")
    expect(session).not.toContain("handleCloudSessionImported")
    expect(session).not.toContain("pendingCloudPrune")
  })

  it("local history view retains the local session list and back navigation", () => {
    const history = read(path.join(WEBVIEW, "src/components/history/HistoryView.tsx"))
    expect(history).toContain("SessionList")
    expect(history).not.toContain("CloudSessionList")
    expect(history).not.toContain("CloudImportDialog")
  })

  it("manifest, esbuild, knip, and tsconfig drop KiloClaw references", () => {
    const pkg = JSON.parse(read(path.join(ROOT, "package.json")))
    const commands = pkg.contributes?.commands?.map((c: { command: string }) => c.command) ?? []
    expect(commands).not.toContain("kilo-code.new.kiloClawOpen")
    expect(read(path.join(ROOT, "esbuild.js"))).not.toContain("kiloclaw")
    expect(read(path.join(ROOT, "knip.json"))).not.toContain("kiloclaw")
    expect(read(path.join(WEBVIEW, "tsconfig.json"))).not.toContain("kiloclaw")
  })

  it("retained surfaces survive (Agent Manager serializer, history, message flow)", () => {
    const ext = read(path.join(SRC, "extension.ts"))
    expect(ext).toContain("AgentManagerProvider.viewType")
    expect(ext).toContain("selectKiloModel")
  })

  it("no cloud or KiloClaw i18n keys remain in any locale", () => {
    const locales = fs.readdirSync(path.join(WEBVIEW, "src/i18n")).filter((f) => f.endsWith(".ts"))
    for (const file of locales) {
      const src = read(path.join(WEBVIEW, "src/i18n", file))
      expect(src).not.toContain("session.cloud")
      expect(src).not.toContain("session.tab.cloud")
    }
  })
})

describe("P3.3 E2E wiring — the cloud-claw-removal scenario is registered and evidence-mapped", () => {
  const RUNNER = read(path.join(ROOT, "tests/e2e/runner.ts"))
  const PROBE = read(path.join(ROOT, "script/e2e-probe.ts"))
  const EVIDENCE = read(path.join(ROOT, "script/e2e-evidence.ts"))

  it("registers the cloud-claw-removal scenario in the probe scenario table and parser", () => {
    expect(PROBE).toContain('"cloud-claw-removal"')
    expect(PROBE).toContain('value === "cloud-claw-removal"')
    expect(PROBE).toContain('if (scenarios.has("cloud-claw-removal"))')
  })

  it("maps the cloud-claw-removal ready marker in the probe", () => {
    expect(PROBE).toContain('if (scenarios.has("cloud-claw-removal")) return "cloud-claw-removal-ready"')
  })

  it("registers the focused scenario in the runner with a dedicated flag and supported value", () => {
    expect(RUNNER).toContain('runCloudClawRemoval: scenario === "cloud-claw-removal"')
    expect(RUNNER).toContain('"cloud-claw-removal"')
    expect(RUNNER).toContain("await assertCloudClawRemoval(vscodeApi, ext, scratch, fixtureId)")
  })

  it("records the runtime evidence as a required artifact in the evidence inventory", () => {
    expect(EVIDENCE).toContain('if (scenarios.has("cloud-claw-removal"))')
    expect(EVIDENCE).toContain('{ rel: "cloud-claw-removal-runtime-evidence", base: "scratch" }')
  })

  it("declares a dedicated package script for the focused scenario", () => {
    const pkg = JSON.parse(read(path.join(ROOT, "package.json")))
    expect(pkg.scripts["test:e2e:cloud-claw-removal"]).toBe(
      "KILO_E2E_SCENARIO=cloud-claw-removal node script/e2e-probe-launch.mjs",
    )
  })

  it("runs the forbidden product identifiers in the runner (identifier-based, cloud/KiloClaw/Console/JetBrains)", () => {
    // The runner's forbidden-identifier list must cover the removed products by
    // exact token, so the runtime manifest/command/bundle assertions are
    // identifier-based rather than broad substring searches.
    expect(RUNNER).toContain("const FORBIDDEN_PRODUCT_IDS")
    expect(RUNNER).toContain('"KiloClawProvider"')
    expect(RUNNER).toContain('"openCloudSession"')
    expect(RUNNER).toContain('"JetBrainsProvider"')
    expect(RUNNER).toContain('"ConsoleProvider"')
    // The bundle-list check targets removed-product bundle names only.
    expect(RUNNER).toContain("const FORBIDDEN_BUNDLE_PREFIXES")
    expect(RUNNER).toContain('"kiloclaw"')
  })
})

