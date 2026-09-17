import { describe, expect, it } from "bun:test"
import * as fs from "fs"
import * as path from "path"

// Metafile dependency-graph proof for the standalone private worker: the bundled
// graph must include observation/messages + session-messages adapter + shared
// message-read, and must not pull heavy runtime graphs (ai SDK, Provider,
// AppLayer/InstanceRef, drain-control, Snapshot service). Source-string checks
// in standalone-observation-list-lease.test.ts remain; this asserts the actual
// esbuild graph rather than file text.
describe("standalone worker bundle graph (metafile)", () => {
  it("bundles messages deps without heavy imports", async () => {
    const { build } = await import("esbuild")
    const res = await build({
      entryPoints: ["src/private-worker/standalone-worker.ts"],
      bundle: true,
      format: "esm",
      platform: "node",
      conditions: ["node", "import"],
      external: ["vscode"],
      write: false,
      metafile: true,
      logLevel: "silent",
    })
    const inputs = Object.keys(res.metafile?.inputs ?? {})
    expect(inputs.length).toBeGreaterThan(0)
    const has = (frag: string) => inputs.some((i) => i.includes(frag))
    expect(has("session-messages-adapter")).toBe(true)
    expect(has("session/message-read")).toBe(true)
    expect(has("private-worker/observation")).toBe(true)
    const heavy = inputs.filter(
      (i) => /\/ai\//.test(i) || i.includes("provider/provider") || i.includes("drain-control") || i.includes("snapshot/index"),
    )
    expect(heavy).toEqual([])
    const text = res.outputFiles?.map((f) => f.text).join("\n") ?? ""
    expect(text).toContain("createSessionMessagesDeps")
    expect(text).toContain("observation/messages")
    expect(text).not.toContain("InstanceRef")
    expect(text).not.toContain("AppLayer")
    expect(text).not.toContain("drain-control")
    expect(text).not.toMatch(/from ["']ai["']/)
  }, 60000)

  it("esbuild standalone config keeps ESM/node shape with createRequire bridge; extension stays CJS", () => {
    const cfg = fs.readFileSync(path.resolve(process.cwd(), "esbuild.js"), "utf8")
    const standaloneAt = cfg.indexOf("src/private-worker/standalone-worker.ts")
    expect(standaloneAt).toBeGreaterThan(-1)
    const standalone = cfg.slice(standaloneAt, standaloneAt + 2000)
    expect(standalone).toContain('format: "esm"')
    expect(standalone).toContain('platform: "node"')
    expect(standalone).toContain('conditions: ["node", "import"]')
    expect(standalone).toContain('external: ["vscode"]')
    expect(standalone).toContain("standalone-worker.mjs")
    expect(standalone).toContain("createRequire")
    expect(standalone).toContain("import.meta.url")
    // Extension CJS ownership: still CJS, still dist/extension.js, no bridge leak.
    expect(cfg).toContain('entryPoints: ["src/extension.ts"]')
    expect(cfg).toContain('format: "cjs"')
    expect(cfg).toContain('outfile: "dist/extension.js"')
    const banners = cfg.match(/banner:\s*\{/g) ?? []
    expect(banners.length).toBe(1)
    expect(cfg.indexOf("banner:")).toBeGreaterThan(standaloneAt)
  })

  it("emitted ESM wires createRequire bridge before undici dynamic builtin requires", async () => {
    const { build } = await import("esbuild")
    const res = await build({
      entryPoints: ["src/private-worker/standalone-worker.ts"],
      bundle: true,
      format: "esm",
      platform: "node",
      conditions: ["node", "import"],
      external: ["vscode"],
      write: false,
      metafile: false,
      logLevel: "silent",
      banner: {
        js: 'import { createRequire as __kiloCreateRequire } from "node:module"; const require = __kiloCreateRequire(import.meta.url);',
      },
    })
    const text = res.outputFiles?.map((f) => f.text).join("\n") ?? ""
    expect(text.length).toBeGreaterThan(0)
    // Exact previous failure surface: undici CJS calls __require("node:assert").
    expect(text).toContain('__require("node:assert")')
    // Bridge must define a real require before the __require shim runs.
    const bridgeAt = text.indexOf("__kiloCreateRequire(import.meta.url)")
    expect(bridgeAt).toBeGreaterThan(-1)
    expect(text).toContain('const require = __kiloCreateRequire(import.meta.url)')
    const shimAt = text.indexOf('Dynamic require of "')
    expect(shimAt).toBeGreaterThan(-1)
    expect(bridgeAt < shimAt).toBe(true)
    // The shim takes the `require` branch when a real require is in scope, so
    // startup on a compatible Node resolves node:assert/net/http instead of
    // throwing `Dynamic require of "node:assert" is not supported`.
    expect(text).toContain('typeof require !== "undefined"')
  }, 60000)

  it("createRequire bridge mechanism resolves node builtins without importing the full bundle", async () => {
    // Static bundle assertions above are the Node-22-safe proof (this repo's
    // system Node cannot parse the bundle's `await using`, so importing
    // dist/private-worker/standalone-worker.mjs here would false-fail).
    // This only proves the bridge mechanism itself; full startup proof runs
    // under the real Node 24 E2E. No worker/process is spawned here.
    const { createRequire } = await import("node:module")
    const localRequire = createRequire(import.meta.url)
    const assert = localRequire("node:assert") as { strictEqual: unknown }
    expect(typeof assert.strictEqual).toBe("function")
    const net = localRequire("node:net") as { connect: unknown }
    expect(typeof net.connect).toBe("function")
    const major = Number(process.version.slice(1).split(".")[0])
    if (major < 24) {
      expect(true).toBe(true)
      return
    }
  })
})
