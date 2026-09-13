import { describe, expect, it } from "bun:test"
import fs from "node:fs"
import path from "node:path"

const PROVIDER = path.resolve(import.meta.dir, "../../src/KiloProvider.ts")
const HELPER = path.resolve(import.meta.dir, "../../src/kilo-provider/session-delete.ts")

function sliceBlock(source: string, start: number): string {
  const open = source.indexOf("{", start)
  expect(open).toBeGreaterThan(-1)
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++
    if (source[i] === "}") {
      depth--
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  throw new Error("block closing brace not found")
}

function raceBranch(resolve: string): string {
  const marker = "if (draftID && this.closedDrafts.delete(draftID)) {"
  const first = resolve.indexOf(marker)
  expect(first, "create-await orphan cleanup branch must exist").toBeGreaterThan(-1)
  const open = resolve.indexOf("{", first)
  let depth = 0
  for (let i = open; i < resolve.length; i++) {
    if (resolve[i] === "{") depth++
    if (resolve[i] === "}") {
      depth--
      if (depth === 0) return resolve.slice(first, i + 1)
    }
  }
  throw new Error("orphan branch closing brace not found")
}

describe("draft create/close race orphan cleanup is private-first", () => {
  const source = fs.readFileSync(PROVIDER, "utf-8")
  const resolve = sliceBlock(source, source.indexOf("private async resolveSession"))
  const branch = raceBranch(resolve)

  it("reuses deleteSessionPrivateFirst with connection/session/directory", () => {
    expect(source).toContain('import { deleteSessionPrivateFirst } from "./kilo-provider/session-delete"')
    expect(branch).toContain("deleteSessionPrivateFirst({")
    expect(branch).toContain("connection: this.connectionService")
    expect(branch).toContain("sessionId: session.id")
    expect(branch).toContain("directory: dir")
    expect(branch).toContain("client: this.client!")
  })

  it("has no direct SDK delete bypass in the race branch", () => {
    expect(branch).not.toContain(".session.delete")
    expect(branch).not.toContain("query_directory")
  })

  it("logs failure with session id/directory and still returns undefined without UI", () => {
    expect(branch).toContain("try {")
    expect(branch).toContain("} catch (error) {")
    expect(branch).toContain("Failed to delete orphaned draft session")
    expect(branch).toContain("sessionId: session.id")
    expect(branch).toContain("directory: dir")
    expect(branch).toContain("return undefined")
    expect(branch).not.toContain("postMessage")
    expect(branch).not.toContain("sendMessageFailed")
    expect(branch).not.toContain("sessionDeleted")
    expect(branch).not.toContain("stopSessionProcesses")
    expect(branch).not.toContain("pruneDeletedSession")
  })

  it("leaves the prompt-time closedDrafts checkpoint and normal delete path untouched", () => {
    expect(source).toContain("if (draftID && this.closedDrafts.delete(draftID)) {")
    expect(source).toContain("private async handleDeleteSession")
    const handle = sliceBlock(source, source.indexOf("private async handleDeleteSession"))
    expect(handle).toContain("deleteSessionPrivateFirst({")
    expect(handle).toContain("pruneDeletedSession(sessionID)")
  })

  it("wires the executable private-first helper (behavior covered by helper tests)", async () => {
    const mod = await import("../../src/kilo-provider/session-delete")
    expect(typeof mod.deleteSessionPrivateFirst).toBe("function")
    const helper = fs.readFileSync(HELPER, "utf-8")
    expect(helper).toContain("durableRawDelete")
    expect(helper).toContain("transportUnknown")
  })
})
