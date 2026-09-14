import { describe, expect, it } from "bun:test"
import path from "node:path"
import * as fs from "node:fs"
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import esbuild from "esbuild"
import { solidPlugin } from "esbuild-plugin-solid"
import { KiloConnectionService } from "../../src/services/cli-backend/connection-service"

const { KiloProvider } = await import("../../src/KiloProvider")

const ROOT = resolve(import.meta.dir, "../..")
const WEBVIEW = path.resolve(import.meta.dir, "../../webview-ui")

function read(rel: string): string {
  return readFileSync(resolve(ROOT, rel), "utf8")
}

describe("device-auth dead state removal", () => {
  it("extension message union drops Started/Complete and keeps Failed/Cancelled/profileData", () => {
    const src = read("webview-ui/src/types/messages/extension-messages.ts")
    expect(src).not.toContain("deviceAuthStarted")
    expect(src).not.toContain("deviceAuthComplete")
    expect(src).not.toContain("DeviceAuthStartedMessage")
    expect(src).not.toContain("DeviceAuthCompleteMessage")
    expect(src).toContain('type: "deviceAuthFailed"')
    expect(src).toContain('type: "deviceAuthCancelled"')
    expect(src).toContain('type: "profileData"')
  })

  it("host has no loginAttempt field in source or runtime", () => {
    const src = read("src/KiloProvider.ts")
    expect(src).not.toContain("loginAttempt")
    const connection = new KiloConnectionService({} as never)
    const host = new KiloProvider({} as never, connection, undefined, {}) as unknown as Record<string, unknown>
    expect("loginAttempt" in host).toBe(false)
    expect(host.loginAttempt).toBeUndefined()
    ;(host as unknown as { dispose: () => void }).dispose()
  })

  it("host never emits Started/Complete across auth fail-closed flows", async () => {
    const connection = new KiloConnectionService({} as never)
    ;(connection as unknown as { getClient: () => unknown }).getClient = () => null as never
    const host = new KiloProvider({} as never, connection, undefined, {}) as unknown as {
      postMessage: (m: unknown) => void
      dispose: () => void
      setupWebviewMessageHandler: (w: unknown) => void
    }
    const messages: unknown[] = []
    host.postMessage = (m) => messages.push(m)
    let handler: ((msg: Record<string, unknown>) => Promise<unknown>) | undefined
    const webview = {
      onDidReceiveMessage: (cb: (msg: Record<string, unknown>) => Promise<unknown>) => {
        handler = cb
        return { dispose: () => {} }
      },
      postMessage: async () => true,
      options: {},
      html: "",
    }
    host.setupWebviewMessageHandler(webview)
    const send = async (msg: Record<string, unknown>) => {
      await handler?.(msg)
    }
    await send({ type: "login" })
    await send({ type: "cancelLogin" })
    await send({ type: "logout" })
    await send({ type: "setOrganization", organizationId: "org-1" })
    await send({ type: "refreshProfile" })
    expect(messages.some((m) => (m as Record<string, unknown>).type === "deviceAuthStarted")).toBe(false)
    expect(messages.some((m) => (m as Record<string, unknown>).type === "deviceAuthComplete")).toBe(false)
    expect(messages.some((m) => (m as Record<string, unknown>).type === "deviceAuthFailed")).toBe(true)
    expect(messages.some((m) => (m as Record<string, unknown>).type === "deviceAuthCancelled")).toBe(true)
    expect(messages.some((m) => (m as Record<string, unknown>).type === "profileData")).toBe(true)
    host.dispose()
  })

  it("ProfileCustomOnly story bundles", async () => {
    const out = path.join(WEBVIEW, `.tmp-profile-custom-only-${randomUUID()}.js`)
    try {
      const built = await esbuild.build({
        entryPoints: [path.join(WEBVIEW, "src/stories/profile.stories.tsx")],
        bundle: true,
        format: "esm",
        platform: "browser",
        outfile: out,
        plugins: [
          solidPlugin(),
          {
            name: "worker-url-external",
            setup(b) {
              b.onResolve({ filter: /worker/ }, (a) => ({ path: a.path, external: true }))
            },
          },
        ],
        external: ["happy-dom"],
        logLevel: "silent",
      })
      expect(built.errors.length).toBe(0)
      const bundled = fs.readFileSync(out, "utf8")
      expect(bundled).toContain("ProfileCustomOnly")
    } finally {
      fs.rmSync(out, { force: true })
    }
  }, 30_000)
})

const PASS = "DEVICE_AUTH_COMPAT_PASS"
const FAIL = "DEVICE_AUTH_COMPAT_FAIL:"

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
  const { VSCodeProvider } = await import("./src/context/vscode.tsx")
  const { ServerProvider, ServerContext } = await import("./src/context/server.tsx")

  const fail = (reason) => {
    console.log("${FAIL}" + reason)
    process.exit(2)
  }
  const eq = (actual, expected, label) => {
    if (actual !== expected) fail(label + ": got " + JSON.stringify(actual) + " expected " + JSON.stringify(expected))
  }

  let ctx = null
  const Probe = () => {
    ctx = useContext(ServerContext)
    return null
  }
  const root = document.createElement("div")
  const dispose = render(
    () =>
      createComponent(VSCodeProvider, {
        get children() {
          return createComponent(ServerProvider, {
            get children() {
              return createComponent(Probe, {})
            },
          })
        },
      }),
    root,
  )
  if (!ctx) fail("ServerContext never became available")

  const emit = (message) => window.dispatchEvent(new window.MessageEvent("message", { data: message }))
  const flush = () => new Promise((r) => setTimeout(r, 0))

  emit({ type: "ready", serverInfo: { version: "test" }, workspaceDirectory: "/" })
  await flush()
  eq(ctx.deviceAuth().status, "idle", "initial deviceAuth must be idle")

  const profile = { profile: { email: "a@b.c" }, balance: null, kiloPass: null, currentOrgId: null }
  emit({ type: "profileData", data: profile })
  await flush()
  eq(ctx.profileData()?.profile?.email, "a@b.c", "profileData must still be consumed")

  emit({ type: "deviceAuthFailed", error: "boom" })
  await flush()
  eq(ctx.deviceAuth().status, "error", "deviceAuthFailed must still be consumed")
  eq(ctx.deviceAuth().error, "boom", "deviceAuthFailed error must be kept")

  emit({ type: "deviceAuthCancelled" })
  await flush()
  eq(ctx.deviceAuth().status, "idle", "deviceAuthCancelled must still reset to idle")

  emit({ type: "deviceAuthStarted", code: "x", verificationUrl: "https://example.com", expiresIn: 60 })
  await flush()
  eq(ctx.deviceAuth().status, "idle", "deviceAuthStarted must have no production path")

  emit({ type: "deviceAuthComplete" })
  await flush()
  eq(ctx.deviceAuth().status, "idle", "deviceAuthComplete must have no production path")

  dispose()
  console.log("${PASS}")
`

describe("device-auth server compat", () => {
  it("Failed/Cancelled/profileData still consume and Started/Complete have no path", async () => {
    const name = `.tmp-device-auth-compat-${randomUUID()}`
    const entry = path.join(WEBVIEW, `${name}.ts`)
    const out = path.join(WEBVIEW, `${name}.js`)
    fs.writeFileSync(entry, CHILD)
    try {
      const attempts = 3
      const failures: string[] = []
      for (let attempt = 1; attempt <= attempts; attempt++) {
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
        } catch (err) {
          failures.push(`attempt ${attempt} build: ${String(err)}`)
          continue
        }
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
      expect.unreachable(`device-auth compat child never reported success:\n${failures.join("\n")}`)
    } finally {
      fs.rmSync(entry, { force: true })
      fs.rmSync(out, { force: true })
    }
  }, 30_000)
})
