import { describe, expect, it } from "bun:test"

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
})
