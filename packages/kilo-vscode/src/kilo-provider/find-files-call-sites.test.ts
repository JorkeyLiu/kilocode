import { describe, expect, test } from "bun:test"
import { readFile } from "fs/promises"
import { join } from "path"

// Structural proof that VS Code file search is private-authority with zero
// SDK fallback. The HTTP `GET /find/file` endpoint stays for other clients
// (CLI/TUI), but no production VS Code path may call `client.find.files`.
const ROOT = join(import.meta.dir, "..", "..")

async function src(rel: string): Promise<string> {
  return readFile(join(ROOT, rel), "utf8")
}

function findFilesCalls(text: string): number {
  return text.match(/\.find\.files\s*\(/g)?.length ?? 0
}

describe("find-files call-site guard", () => {
  test("no production client.find.files remains in kilo-vscode src", async () => {
    const { readdir } = await import("fs/promises")
    const hits: string[] = []
    const walk = async (dir: string) => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          await walk(full)
          continue
        }
        if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue
        const text = await readFile(full, "utf8")
        for (const [idx, line] of text.split("\n").entries()) {
          const trimmed = line.trim()
          if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue
          if (line.includes(".find.files(")) hits.push(`${full.slice(ROOT.length + 1)}:${idx + 1}:${trimmed}`)
        }
      }
    }
    await walk(join(ROOT, "src"))
    expect(hits).toEqual([])
  })

  test("shared helper is private-authority with zero SDK", async () => {
    const helper = await src("src/kilo-provider/find-files-private.ts")
    expect(helper).toContain("fetchFindFilesTypePrivate")
    expect(helper).not.toContain("fetchFindFilesTypePrivateFirst")
    expect(findFilesCalls(helper)).toBe(0)
    expect(helper).not.toContain("coerceSdkFiles")
    expect(helper).not.toContain("SdkClient")
  })

  test("file-search consumer drops the SDK client and keeps private authority", async () => {
    const consumer = await src("src/kilo-provider/file-search.ts")
    expect(consumer).toContain("fetchFindFilesTypePrivate")
    expect(consumer).not.toContain("fetchFindFilesTypePrivateFirst")
    expect(findFilesCalls(consumer)).toBe(0)
    expect(consumer).not.toContain("client:")
    expect(consumer).not.toContain("KiloClient")
  })

  test("KiloProvider file-search call site passes no client", async () => {
    const provider = await src("src/KiloProvider.ts")
    expect(provider).toContain("handleFileSearch({")
    // The requestFileSearch block must not pass a client.
    const start = provider.indexOf('case "requestFileSearch"')
    expect(start).toBeGreaterThan(-1)
    const end = provider.indexOf("break", start)
    const block = provider.slice(start, end)
    expect(block).toContain("handleFileSearch({")
    expect(block).not.toContain("client:")
    expect(findFilesCalls(block)).toBe(0)
  })

  test("no legacy PrivateFirst refs remain for find/files", async () => {
    const helper = await src("src/kilo-provider/find-files-private.ts")
    const consumer = await src("src/kilo-provider/file-search.ts")
    for (const [name, text] of [
      ["helper", helper],
      ["consumer", consumer],
    ] as const) {
      expect(text, name).not.toContain("find-files-privatefirst")
      expect(text, name).not.toContain("fetchFindFilesTypePrivateFirst")
      expect(text, name).not.toContain("FindFilesTypePrivateFirstOutcome")
    }
  })
})
