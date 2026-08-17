import { beforeEach, describe, expect, it } from "bun:test"
import * as vscode from "vscode"
import { notebookUri } from "../../src/services/notebook/uri"

function uri(scheme: string, path: string, fragment = ""): vscode.Uri {
  const value = `${scheme}:${path}${fragment ? `#${fragment}` : ""}`
  return {
    scheme,
    fsPath: path,
    toString: () => value,
  } as vscode.Uri
}

function document(id: string, text: string, languageId = "python", version = 1): vscode.TextDocument {
  return {
    uri: uri("vscode-notebook-cell", "/workspace/example.ipynb", id),
    fileName: `/workspace/${id}.py`,
    languageId,
    version,
    getText: () => text,
  } as vscode.TextDocument
}

function notebooks(value: vscode.NotebookDocument[]): void {
  Object.defineProperty(vscode.workspace, "notebookDocuments", {
    configurable: true,
    value,
  })
}

describe("notebook context", () => {
  beforeEach(() => notebooks([]))

  it("resolves file and notebook cell URIs", () => {
    const file = uri("file", "/workspace/file.ts")
    const cell = document("code", "value = 1")
    const notebook = {
      uri: uri("file", "/workspace/example.ipynb"),
      getCells: () => [{ kind: vscode.NotebookCellKind.Code, document: cell }],
    } as vscode.NotebookDocument
    notebooks([notebook])

    expect(notebookUri(file)).toBe(file)
    expect(notebookUri(cell.uri)).toBe(notebook.uri)
    expect(notebookUri(uri("untitled", "Untitled-1"))).toBeUndefined()
  })

  it("reuses notebook resolution within the same notebook version", () => {
    const current = document("current", "value = 1")
    const cells = [{ kind: vscode.NotebookCellKind.Code, document: current }] as vscode.NotebookCell[]
    let calls = 0
    const notebook = {
      uri: uri("file", "/workspace/example.ipynb"),
      version: 1,
      getCells: () => {
        calls++
        return cells
      },
    } as vscode.NotebookDocument
    notebooks([notebook])

    expect(notebookUri(current.uri)).toBe(notebook.uri)
    expect(calls).toBe(1)
  })
})
