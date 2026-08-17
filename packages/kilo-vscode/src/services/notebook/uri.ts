import * as vscode from "vscode"

interface NotebookResolution {
  notebook: vscode.NotebookDocument
  cells: vscode.NotebookCell[]
  cell: vscode.NotebookCell
  index: number
  version: number
}

const resolutions = new WeakMap<vscode.Uri, NotebookResolution>()

function resolveNotebook(uri: vscode.Uri): NotebookResolution | undefined {
  const id = uri.toString()
  const cached = resolutions.get(uri)
  if (
    cached &&
    cached.notebook.version === cached.version &&
    vscode.workspace.notebookDocuments.includes(cached.notebook)
  ) {
    return cached
  }

  resolutions.delete(uri)
  for (const notebook of vscode.workspace.notebookDocuments) {
    const cells = notebook.getCells()
    const index = cells.findIndex((cell) => cell.document.uri.toString() === id)
    if (index < 0) continue
    const resolved = { notebook, cells, cell: cells[index]!, index, version: notebook.version }
    resolutions.set(uri, resolved)
    return resolved
  }
}

/**
 * Resolve a text-document URI to the owning notebook URI when the document is
 * a notebook cell; file URIs pass through unchanged. Used by chat context
 * gathering to map open notebook cells back to their parent notebook.
 */
export function notebookUri(uri: vscode.Uri): vscode.Uri | undefined {
  if (uri.scheme === "file") return uri
  if (uri.scheme !== "vscode-notebook-cell") return
  return resolveNotebook(uri)?.notebook.uri
}
