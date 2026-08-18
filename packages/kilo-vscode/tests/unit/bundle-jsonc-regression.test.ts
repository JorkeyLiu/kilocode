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
})
