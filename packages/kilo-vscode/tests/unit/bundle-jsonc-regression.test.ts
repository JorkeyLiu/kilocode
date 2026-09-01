/**
 * Regression guard: jsonc-parser must bundle as ESM, not UMD.
 *
 * The UMD entry (lib/umd/main.js) uses runtime require2("./impl/format")
 * calls that fail at extension-host load time because the impl submodules
 * are not shipped in dist. This test proves the built extension bundle
 * contains no runtime require2 references to jsonc-parser UMD internals.
 */

import { describe, expect, it } from "bun:test"
import * as fs from "fs"
import * as path from "path"
import { build } from "esbuild"
import { createRequire } from "node:module"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname, resolve } from "node:path"
import { spawnSync } from "node:child_process"

const DIST = path.resolve(__dirname, "../../dist/extension.js")

describe("jsonc-parser bundle regression", () => {
  it("extension bundle contains no runtime require2 calls", () => {
    if (!fs.existsSync(DIST)) return // skip if not built
    const source = fs.readFileSync(DIST, "utf-8")
    expect(source).not.toContain("require2")
  })

  it("extension bundle statically includes jsonc-parser ESM impl files", () => {
    if (!fs.existsSync(DIST)) return // skip if not built
    const source = fs.readFileSync(DIST, "utf-8")
    expect(source).toContain("jsonc-parser/lib/esm/impl/format.js")
    expect(source).toContain("jsonc-parser/lib/esm/impl/scanner.js")
    expect(source).toContain("jsonc-parser/lib/esm/impl/parser.js")
  })

  it("esbuild config has jsonc-parser ESM plugin", () => {
    const esbuildPath = path.resolve(__dirname, "../../esbuild.js")
    const source = fs.readFileSync(esbuildPath, "utf-8")
    expect(source).toContain("jsonc-parser-esm")
    expect(source).toContain('require("path").join(dir, "lib", "esm", "main.js")')
  })

  it("launcher has jsonc-parser ESM plugin with robust ESM resolution", () => {
    const launcherPath = path.resolve(__dirname, "../../script/e2e-probe-launch.mjs")
    const source = fs.readFileSync(launcherPath, "utf-8")
    expect(source).toContain("jsonc-parser-esm")
    expect(source).toContain('filter: /^jsonc-parser$/')
    expect(source).toContain('createRequire(import.meta.url)')
    expect(source).toContain('require.resolve("jsonc-parser/package.json")')
    expect(source).toContain('join(dir, "lib", "esm", "main.js")')
    expect(source).toContain("plugins: [jsoncParserEsmPlugin]")
    // must preserve direct define and not introduce external bypass for jsonc-parser
    expect(source).toContain('define: { __KILO_E2E_BUNDLE__: "true" }')
    expect(source).not.toContain("KILO_E2E_BUNDLE_TEST")
    expect(source).not.toContain('"jsonc-parser"')
    // launcher external list must stay the direct trio, no jsonc-parser external
    expect(source).toContain('external: ["@vscode/test-electron", "@playwright/test", "esbuild"]')
  })

  it("launcher-equivalent Node CJS bundle is self-contained and parses JSONC comments/trailing commas at runtime (actual e2e-evidence entry)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kilo-jsonc-launcher-"))
    try {
      const out = join(dir, "out.cjs")
      const entry = resolve(__dirname, "../../script/e2e-evidence.ts")
      /**
       * Force jsonc-parser to resolve to its ESM module entry instead of the UMD
       * main entry. The UMD bundle uses runtime `require2("./impl/format")` calls
       * that fail at extension-host load time because the impl submodules are not
       * shipped in dist. The ESM entry statically imports its dependencies, so
       * esbuild can bundle them all into a single file.
       * Mirrors packages/kilo-vscode/esbuild.js jsoncParserEsmPlugin (lines ~67-76)
       * and script/e2e-probe-launch.mjs jsoncParserEsmPlugin.
       */
      const jsoncParserEsmPlugin = {
        name: "jsonc-parser-esm",
        setup(b: import("esbuild").PluginBuild) {
          b.onResolve({ filter: /^jsonc-parser$/ }, () => {
            const require = createRequire(import.meta.url)
            const pkg = require.resolve("jsonc-parser/package.json")
            const d = dirname(pkg)
            return { path: join(d, "lib", "esm", "main.js") }
          })
        },
      }
      await build({
        entryPoints: [entry],
        bundle: true,
        platform: "node",
        format: "cjs",
        target: "node20",
        define: { __KILO_E2E_BUNDLE__: "true" },
        external: ["@vscode/test-electron", "@playwright/test", "esbuild"],
        outfile: out,
        logLevel: "silent",
        plugins: [jsoncParserEsmPlugin],
      })
      const source = readFileSync(out, "utf-8")
      expect(source).not.toContain('require("./impl/format")')
      expect(source).not.toContain('require2("./impl/format")')
      expect(source).not.toContain('lib/umd/main.js')
      // should bundle ESM impl, not leave UMD requires
      // runtime: Node import must succeed and JSONC comments/trailing commas must parse via real parseFailure
      const runner = join(dir, "runner.cjs")
      writeFileSync(
        runner,
        [
          `const m = require(${JSON.stringify(out)});`,
          `const ok = m.parseFailure("workspace/.kilo/kilo.jsonc", Buffer.from('// comment\\n{"a":1,}\\n'));`,
          `if (ok !== null) { console.error("ok failed", ok); process.exit(1); }`,
          `const bad = m.parseFailure("workspace/.kilo/kilo.jsonc", Buffer.from("{not jsonc"));`,
          `if (bad === null || !bad.includes("invalid JSONC")) { console.error("bad failed", bad); process.exit(2); }`,
          `const ok2 = m.parseFailure("workspace/.kilo/kilo.jsonc", Buffer.from('{"x":1, // trailing\\n "y":2,}'));`,
          `if (ok2 !== null) { console.error("ok2 failed", ok2); process.exit(3); }`,
          `console.log("OK");`,
        ].join("\n"),
      )
      const result = spawnSync(process.execPath, [runner], { encoding: "utf8" })
      expect(result.status).toBe(0)
      expect(result.stdout).toContain("OK")
      expect(result.stderr).not.toContain("Cannot find module")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("launcher-equivalent minimal jsonc entry bundles ESM and runs comment+trailing comma parse without UMD (build-only smoke, no VS Code)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kilo-jsonc-minimal-"))
    try {
      const entry = join(dir, "entry.ts")
      writeFileSync(
        entry,
        [
          `import { parse } from "jsonc-parser"`,
          `export function testParse(text: string) {`,
          `  const errors: unknown[] = [];`,
          `  const value = parse(text, errors as any, { allowTrailingComma: true });`,
          `  return { value, errors };`,
          `}`,
        ].join("\n"),
      )
      const out = join(dir, "out.cjs")
      const jsoncParserEsmPlugin = {
        name: "jsonc-parser-esm",
        setup(b: import("esbuild").PluginBuild) {
          b.onResolve({ filter: /^jsonc-parser$/ }, () => {
            const require = createRequire(import.meta.url)
            const pkg = require.resolve("jsonc-parser/package.json")
            const d = dirname(pkg)
            return { path: join(d, "lib", "esm", "main.js") }
          })
        },
      }
      await build({
        entryPoints: [entry],
        bundle: true,
        platform: "node",
        format: "cjs",
        target: "node20",
        define: { __KILO_E2E_BUNDLE__: "true" },
        external: ["@vscode/test-electron", "@playwright/test", "esbuild"],
        outfile: out,
        logLevel: "silent",
        plugins: [jsoncParserEsmPlugin],
      })
      const source = readFileSync(out, "utf-8")
      expect(source).not.toContain('require("./impl/format")')
      expect(source).not.toContain('require2("./impl/format")')
      expect(source).not.toContain("lib/umd")
      const runner = join(dir, "runner.cjs")
      writeFileSync(
        runner,
        [
          `const m = require(${JSON.stringify(out)});`,
          `const { value, errors } = m.testParse('// comment\\n{"a":1,}');`,
          `if (errors.length !== 0) { console.error(errors); process.exit(1); }`,
          `if (value.a !== 1) { console.error(value); process.exit(2); }`,
          `const r2 = m.testParse('{"x":1, // trailing\\n "y":2,}');`,
          `if (r2.errors.length !== 0) { console.error(r2.errors); process.exit(3); }`,
          `if (r2.value.x !== 1 || r2.value.y !== 2) { console.error(r2.value); process.exit(4); }`,
          `console.log("OK2");`,
        ].join("\n"),
      )
      const result = spawnSync(process.execPath, [runner], { encoding: "utf8" })
      expect(result.status).toBe(0)
      expect(result.stdout).toContain("OK2")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
