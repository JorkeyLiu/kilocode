import * as vscode from "vscode"

export function getWorkspaceRoot(): string | undefined {
  const folders = vscode.workspace.workspaceFolders
  if (folders && folders.length > 0) return folders[0].uri.fsPath
  return undefined
}

export function openFileInEditor(
  filePath: string,
  line?: number,
  column?: number,
  viewColumn: vscode.ViewColumn = vscode.ViewColumn.Beside,
  prefix = "Kilo",
): void {
  const uri = vscode.Uri.file(filePath)
  const options: vscode.TextDocumentShowOptions = { viewColumn, preview: true }
  if (line !== undefined && line > 0) {
    const target = Math.max(1, Math.floor(line))
    const col = column !== undefined && column > 0 ? column - 1 : 0
    const pos = new vscode.Position(target - 1, col)
    options.selection = new vscode.Range(pos, pos)
  }

  void vscode.commands
    .executeCommand("vscode.open", uri, options)
    .then(undefined, (err) => console.error(`[Kilo New] ${prefix}: Failed to open file:`, uri.fsPath, err))
}
