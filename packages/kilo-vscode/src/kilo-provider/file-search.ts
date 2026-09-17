import * as path from "path"
import * as vscode from "vscode"
import { mergeFileSearchResults } from "./file-search-results"
import { mergeFileSearchItems } from "./file-search-items"
import {
  fetchFindFilesTypePrivate,
  FIND_FILES_PRIVATE_LIMIT,
  type FindFilesPrivateConnection,
  type FindFilesTypePrivateOutcome,
} from "./find-files-private"

type Message = {
  query: string
  requestId: string
  sessionID?: string
}

type Input = {
  message: Message
  current?: string
  context?: string
  dir: (id?: string) => string
  open: (dir: string) => Promise<Set<string>>
  post: (message: unknown) => void
  connection?: FindFilesPrivateConnection | null
  workspace?: string
  timeoutMs?: number
}

// Private-authority `find/files` production consumer: each logical query
// (`type:file` and `type:directory`, limit 50) runs exactly one private
// attempt via the shared helper with zero SDK. Valid private success
// (including empty) returns the strict filtered result; validated terminal
// and unavailable/empty-backend each map to `[]` for that type so one type
// may succeed while the other fails. Merge/dedup/order, open-tab/active plus
// local candidate behavior, and the always-post `fileSearchResult` response
// are unchanged. The HTTP `GET /find/file` endpoint stays for other clients;
// VS Code issues no `client.find.files` on this path.
export async function handleFileSearch(input: Input): Promise<void> {
  const id = input.message.sessionID ?? input.current ?? input.context
  const dir = input.dir(id)
  const open = dir ? await input.open(dir) : new Set<string>()

  const query = input.message.query
  const limit = FIND_FILES_PRIVATE_LIMIT
  const [fileOut, folderOut] = await Promise.all([
    fetchFindFilesTypePrivate({
      connection: input.connection ?? null,
      directory: dir,
      query,
      type: "file",
      limit,
      workspace: input.workspace,
      timeoutMs: input.timeoutMs,
    }),
    fetchFindFilesTypePrivate({
      connection: input.connection ?? null,
      directory: dir,
      query,
      type: "directory",
      limit,
      workspace: input.workspace,
      timeoutMs: input.timeoutMs,
    }),
  ])
  const files = settled(fileOut, "file")
  const folders = settled(folderOut, "folder")
  const uri = vscode.window.activeTextEditor?.document.uri
  const rel = uri?.scheme === "file" && dir ? path.relative(dir, uri.fsPath) : undefined
  const active = rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel.replaceAll("\\", "/") : undefined
  const result = mergeFileSearchResults({ query, backend: files, open, active })
  const items = mergeFileSearchItems({
    query,
    files: result,
    folders,
    open: new Set(active ? [active, ...open] : open),
  })
  input.post({ type: "fileSearchResult", paths: result, items, dir, requestId: input.message.requestId })
}

function settled(out: FindFilesTypePrivateOutcome, kind: "file" | "folder"): string[] {
  if (out.kind === "ok") return out.files
  if (out.kind === "terminal") return []
  console.error(`[Kilo New] File search (${kind}) failed:`, { failed: true })
  return []
}
