/**
 * Side-effect-free bridge components shared by the editor-tab chat and Agent
 * Manager webviews.
 *
 * `DataBridge` and `MermaidDownloadBridge` previously lived in App.tsx. The
 * Agent Manager imported them from there, which pulled the whole editor-tab App
 * module into the Agent Manager bundle and ran App.tsx's module-scope tool
 * registrations (`registerExpandedTaskTool`, `registerVscodeToolOverrides`)
 * as an accidental side effect.
 *
 * This module contains no module-scope side effects. Each webview entry
 * explicitly registers the tool renderers it owns (editor tabs: App.tsx;
 * Agent Manager: its own entry boundary).
 */

import { Component, createMemo, onMount, onCleanup } from "solid-js"
import { DataProvider } from "@kilocode/kilo-ui/context/data"
import { useSession } from "./context/session"
import { useVSCode } from "./context/vscode"
import { useProvider } from "./context/provider"
import { useServer } from "./context/server"
import type { Message as SDKMessage, Part as SDKPart } from "@kilocode/sdk/v2"

/**
 * Bridge our session store to the DataProvider's expected Data shape.
 *
 * CRITICAL: `data` is a plain object with getters — NOT a createMemo wrapping
 * the whole shape. Wrapping the shape in a memo defeats Solid's fine-grained
 * reactivity: any single `store.parts[X]` mutation would re-run the outer
 * memo, producing a fresh POJO, which invalidates every downstream consumer
 * that reads `data.store.*` — including all mounted SessionTurn memos that
 * scan all messages in the session. With hundreds of messages and a dozen
 * visible turns, per-token streaming ends up doing O(N × visible_turns) work
 * per delta, which is why long sessions stream slowly.
 *
 * By exposing the underlying Solid store directly via getters, consumers
 * reading `data.store.message[X]` or `data.store.part[Y]` subscribe to only
 * that specific key. A text-delta on message Y only invalidates consumers
 * that actually read `part[Y]`, not the whole tree.
 */
export const DataBridge: Component<{ children: any }> = (props) => {
  const session = useSession()
  const vscode = useVSCode()
  const prov = useProvider()
  const server = useServer()

  // Memos for fields that change infrequently (not per-token) — cheap and
  // avoids allocating a fresh array/object on every consumer read.
  const sessionList = createMemo(
    () => session.sessions().map((s) => ({ ...s, id: s.id, role: "user" as const })) as unknown as any[],
  )

  const permissionsBySession = createMemo(() => {
    const grouped: Record<string, any[]> = {}
    for (const p of session.permissions()) {
      const sid = p.sessionID
      if (!sid) continue
      ;(grouped[sid] ??= []).push(p)
    }
    return grouped
  })

  const providerData = createMemo(() => ({
    all: new Map(Object.entries(prov.providers())),
    connected: prov.connected(),
    default: prov.defaults(),
  }))

  // Stable object with reactive getters — passes through to Solid stores so
  // consumers keep per-key reactivity. The family-filter previously done here
  // was counter-productive: consumers only ever do per-session-id / per-
  // message-id lookups, so they never see unrelated entries in practice, and
  // the filter pass itself was the source of the O(N) cascade.
  const data = {
    get session() {
      return sessionList()
    },
    get session_status() {
      return session.allStatusMap() as unknown as Record<string, any>
    },
    get session_diff() {
      return {} as Record<string, any[]>
    },
    get message() {
      return session.allMessages() as unknown as Record<string, SDKMessage[]>
    },
    get part() {
      return session.allParts() as unknown as Record<string, SDKPart[]>
    },
    get permission() {
      return permissionsBySession()
    },
    // Questions are handled directly by QuestionDock via session.questions(),
    // not through DataProvider. The DataProvider's question field is unused here.
    get question() {
      return {}
    },
    get provider() {
      return providerData() as unknown as any
    },
  }

  const respond = (input: { sessionID: string; permissionID: string; response: "once" | "always" | "reject" }) => {
    session.respondToPermission(input.permissionID, input.response, [], [])
  }

  const reply = (input: { requestID: string; answers: string[][] }) => {
    session.replyToQuestion(input.requestID, input.answers)
  }

  const reject = (input: { requestID: string }) => {
    session.rejectQuestion(input.requestID)
  }

  const open = (filePath: string, line?: number, column?: number) => {
    vscode.postMessage({ type: "openFile", filePath, line, column })
  }

  const openUrl = (url: string) => {
    vscode.postMessage({ type: "openExternal", url })
  }

  const openContent = (content: string, language?: string) => {
    vscode.postMessage({ type: "openContent", content, language })
  }

  // File existence validation for code span candidates
  const pending = new Map<string, (existing: string[]) => void>()
  const counter = { n: 0 }
  const validateFiles = (paths: string[]): Promise<string[]> => {
    const id = `vf-${++counter.n}`
    return new Promise((resolve) => {
      pending.set(id, resolve)
      vscode.postMessage({ type: "validateFiles", id, paths })
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id)
          resolve([])
        }
      }, 3000)
    })
  }
  const handler = (event: MessageEvent) => {
    const msg = event.data
    if (msg?.type === "validateFilesResult" && msg.id) {
      const cb = pending.get(msg.id)
      if (cb) {
        pending.delete(msg.id)
        cb(msg.existing ?? [])
      }
    }
  }
  onMount(() => window.addEventListener("message", handler))
  onCleanup(() => window.removeEventListener("message", handler))

  const directory = () => {
    const dir = server.workspaceDirectory()
    if (!dir) return ""
    return dir.endsWith("/") || dir.endsWith("\\") ? dir : dir + "/"
  }

  return (
    <DataProvider
      data={data}
      directory={directory()}
      // @ts-expect-error — onPermissionRespond/onQuestion* are extension-specific props not yet in kilo-ui's DataProvider types
      onPermissionRespond={respond}
      onQuestionReply={reply}
      onQuestionReject={reject}
      onOpenFile={open}
      onOpenUrl={openUrl}
      onOpenContent={openContent}
      onValidateFiles={validateFiles}
    >
      {props.children}
    </DataProvider>
  )
}

type MermaidImageEvent = CustomEvent<{ dataUrl: string; filename: string }>

export const MermaidDownloadBridge: Component = () => {
  const vscode = useVSCode()

  onMount(() => {
    const save = (event: Event) => {
      const detail = (event as MermaidImageEvent).detail
      if (!detail?.dataUrl || !detail.filename) return
      event.preventDefault()
      vscode.postMessage({ type: "saveImage", dataUrl: detail.dataUrl, filename: detail.filename })
    }
    window.addEventListener("kilo:save-image", save)
    onCleanup(() => {
      window.removeEventListener("kilo:save-image", save)
    })
  })

  return null
}
