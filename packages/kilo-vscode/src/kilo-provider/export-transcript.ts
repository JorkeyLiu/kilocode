import * as path from "path"
import * as vscode from "vscode"
import type { KiloClient, Message, Part } from "@kilocode/sdk/v2/client"
import { fetchMessagePage } from "./message-page"
import { sdkSessionToDetail } from "./session-detail"
import type { MessagesParityConnection } from "./session-messages-parity"
import type { SessionDetail } from "./session-detail"

type Item = {
  info: Message
  parts: Part[]
}

export async function exportTranscript(
  client: KiloClient,
  input: {
    sessionID: string
    dir: string
    getSessionDetail?: (sessionID: string, directory: string) => Promise<SessionDetail>
  },
  parityConnection?: MessagesParityConnection | null,
) {
  const detailPromise = input.getSessionDetail
    ? input.getSessionDetail(input.sessionID, input.dir)
    : client.session
        .get({ sessionID: input.sessionID, directory: input.dir }, { throwOnError: true })
        .then((r) => {
          if (!r.data) throw new Error("Session metadata not found")
          return sdkSessionToDetail(r.data)
        })
  const [session, page] = await Promise.all([
    detailPromise,
    fetchMessagePage(client, { sessionID: input.sessionID, workspaceDir: input.dir, limit: 0 }, parityConnection ?? null),
  ])
  const text = formatTranscript(session, page.items)
  const uri = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(path.join(input.dir, `session-${session.id.slice(0, 8)}.md`)),
    filters: { Markdown: ["md", "markdown"] },
    saveLabel: "Export",
  })
  if (!uri) return false
  await vscode.workspace.fs.writeFile(uri, Buffer.from(text, "utf8"))
  return true
}

export type TranscriptSession = Pick<SessionDetail, "id" | "title" | "createdAt" | "updatedAt">

export function formatTranscript(session: TranscriptSession, items: Item[]): string {
  const head = [
    `# ${session.title}`,
    "",
    `**Session ID:** ${session.id}`,
    `**Created:** ${new Date(session.createdAt).toLocaleString()}`,
    `**Updated:** ${new Date(session.updatedAt).toLocaleString()}`,
    "",
    "---",
    "",
    "",
  ].join("\n")
  const body = items.map((item) => formatMessage(item)).join("---\n\n")
  return `${head}${body}${items.length > 0 ? "---\n\n" : ""}`
}

function formatMessage(item: Item): string {
  const head = item.info.role === "user" ? "## User\n\n" : "## Assistant\n\n"
  return `${head}${item.parts.map((part) => formatPart(part)).join("")}`
}

function formatPart(part: Part): string {
  if (part.type === "text" && !part.synthetic) return `${part.text}\n\n`
  if (part.type === "tool") return `**Tool: ${part.tool}**\n\n`
  return ""
}
