import * as path from "path"
import * as vscode from "vscode"
import type { KiloClient } from "@kilocode/sdk/v2/client"
import { mergeFileSearchResults } from "./file-search-results"
import { mergeFileSearchItems } from "./file-search-items"
import {
  fetchFindFilesTypePrivateFirst,
  FIND_FILES_PRIVATE_LIMIT,
  type FindFilesPrivateConnection,
  type FindFilesTypePrivateFirstOutcome,
} from "./find-files-privatefirst"

type Message = {
  query: string
  requestId: string
  sessionID?: string
}

type Input = {
  client: KiloClient | null
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

// Private-first `find/files` production consumer: each logical query
// (`type:file` and `type:directory`, limit 50) runs one private attempt
// first via the shared helper, falling back to exactly one same-tuple SDK
// `client.find.files` only on fallback-eligible private outcomes. Valid
// private success (including empty) and validated terminal close with zero
// SDK. Merge/dedup/order and fail-soft post behavior are unchanged.
export async function handleFileSearch(input: Input): Promise<void> {
  const client = input.client
  if (!client) {
    input.post({ type: "fileSearchResult", paths: [], items: [], dir: "", requestId: input.message.requestId })
    return
  }

  const id = input.message.sessionID ?? input.current ?? input.context
  const dir = input.dir(id)
  const open = dir ? await input.open(dir) : new Set<string>()

  const query = input.message.query
  const limit = FIND_FILES_PRIVATE_LIMIT
  const [fileOut, folderOut] = await Promise.all([
    fetchFindFilesTypePrivateFirst({
      connection: input.connection ?? null,
      client: client as never,
      directory: dir,
      query,
      type: "file",
      limit,
      workspace: input.workspace,
      timeoutMs: input.timeoutMs,
    }),
    fetchFindFilesTypePrivateFirst({
      connection: input.connection ?? null,
      client: client as never,
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

function settled(out: FindFilesTypePrivateFirstOutcome, kind: "file" | "folder"): string[] {
  if (out.kind === "ok") return out.files
  if (out.kind === "terminal") return []
  console.error(`[Kilo New] File search (${kind}) failed:`, { failed: true })
  return []
}
