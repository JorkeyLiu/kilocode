import { describe, expect, it } from "bun:test"
import { unlinkSync } from "node:fs"
import path from "node:path"
import { build } from "esbuild"
import { solidPlugin } from "esbuild-plugin-solid"

const ROOT = path.resolve(import.meta.dir, "../..")
const WEBVIEW = path.join(ROOT, "webview-ui")
const FIXTURE = path.join(ROOT, "tests/fixtures/task-header-token-label.tsx")

describe("task header token label", () => {
  it("always shows the locale-formatted token count, appending the percentage when available", async () => {
    // The fixture renders the real TaskHeader under happy-dom and throws on any
    // mismatch, so a zero exit means both the with-percentage and
    // without-percentage labels render exactly as locked.
    const solid = path.dirname(Bun.resolveSync("solid-js/package.json", WEBVIEW))
    const aliases: Record<string, string> = {
      "solid-js": path.join(solid, "dist/solid.js"),
      "solid-js/web": path.join(solid, "web/dist/web.js"),
      "solid-js/store": path.join(solid, "store/dist/store.js"),
    }
    const dedupe = {
      name: "solid-dedupe",
      setup(ctx: Parameters<NonNullable<Parameters<typeof build>[0]["plugins"]>[number]["setup"]>[0]) {
        ctx.onResolve({ filter: /^solid-js(\/web|\/store)?$/ }, (args) => ({ path: aliases[args.path] }))
      },
    }
    // Same inline sprite handling as the package esbuild.js so kilo-ui's file-icon
    // import graph bundles without an svg loader.
    const svgSprite = {
      name: "svg-sprite-inline",
      setup(ctx: Parameters<NonNullable<Parameters<typeof build>[0]["plugins"]>[number]["setup"]>[0]) {
        ctx.onLoad({ filter: /sprite\.svg$/ }, (args) => {
          const content = require("node:fs").readFileSync(args.path, "utf8")
          return {
            contents: `
              const svg = ${JSON.stringify(content)};
              const inject = () => {
                if (!document.getElementById("kilo-sprite")) {
                  const el = document.createElement("div");
                  el.id = "kilo-sprite";
                  el.style.display = "none";
                  el.innerHTML = svg;
                  document.body.appendChild(el);
                }
              };
              if (document.body) inject();
              else document.addEventListener("DOMContentLoaded", inject);
              export default "";
            `,
            loader: "js",
          }
        })
      },
    }
    const result = await build({
      entryPoints: [FIXTURE],
      bundle: true,
      conditions: ["browser"],
      external: ["happy-dom"],
      format: "esm",
      logLevel: "silent",
      platform: "node",
      plugins: [dedupe, svgSprite, solidPlugin()],
      target: "es2022",
      write: false,
    })
    const file = path.join(ROOT, `.task-header-token-label-${crypto.randomUUID()}.mjs`)
    await Bun.write(file, result.outputFiles[0]!.contents)
    const child = Bun.spawnSync(["bun", file], { cwd: WEBVIEW, stdout: "pipe", stderr: "pipe" })
    unlinkSync(file)

    const output = child.stdout.toString() + child.stderr.toString()
    expect(child.exitCode, output).toBe(0)
  })
})
