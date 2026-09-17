// kilocode_change - new file
import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import type { BunPlugin } from "bun"

const require = createRequire(import.meta.url)

describe("jsonc bundle", () => {
  test("build routes bare jsonc-parser to ESM", () => {
    const file = path.join(import.meta.dir, "../../../script/build.ts")
    const src = fs.readFileSync(file, "utf8")
    expect(src).toContain("jsonc-parser-esm")
    expect(src).toContain("lib")
    expect(src).toContain("esm")
    expect(src).toContain("main.js")
    expect(src).toContain("/^jsonc-parser$/")
  })

  test("dynamic require bundles ESM and parses comment plus trailing comma", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-jsonc-"))
    try {
      const entry = path.join(root, "entry.ts")
      fs.writeFileSync(
        entry,
        [
          `export function check(text: string) {`,
          `  const { parse } = require("jsonc-parser") as { parse: (t: string, e: unknown[], o?: unknown) => unknown }`,
          `  const errors: unknown[] = []`,
          `  const v = parse(text, errors, { allowTrailingComma: true })`,
          `  return { v, errors }`,
          `}`,
        ].join("\n"),
      )
      const out = path.join(root, "out.js")
      // Mirrors script/build.ts resolver: bare jsonc-parser -> lib/esm/main.js.
      const plugin: BunPlugin = {
        name: "jsonc-parser-esm",
        setup(build) {
          build.onResolve({ filter: /^jsonc-parser$/ }, () => {
            const pkg = require.resolve("jsonc-parser/package.json")
            return { path: path.join(path.dirname(pkg), "lib", "esm", "main.js") }
          })
        },
      }
      const res = await Bun.build({
        entrypoints: [entry],
        outdir: root,
        naming: "out.js",
        conditions: ["bun", "node"],
        format: "esm",
        minify: false,
        plugins: [plugin],
      })
      expect(res.success).toBe(true)
      const src = fs.readFileSync(out, "utf8")
      expect(src).not.toContain('require("./impl/format")')
      expect(src).not.toContain('require2("./impl/format")')
      expect(src).not.toContain("lib/umd")
      const mod = (await import(out)) as {
        check: (t: string) => { v: unknown; errors: unknown[] }
      }
      const ok = mod.check('// comment\n{"a":1,}')
      expect(ok.errors.length).toBe(0)
      expect(ok.v).toEqual({ a: 1 })
      const bad = mod.check("{not jsonc")
      expect(bad.errors.length).toBeGreaterThan(0)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
