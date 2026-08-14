/** @jsxImportSource solid-js */
/**
 * Stories for Agent Manager components:
 * FileTree, FullScreenDiffView, WorktreeItem, TabBar
 */

import type { Meta, StoryObj } from "storybook-solidjs-vite"
import { StoryProviders, defaultMockData, mockSessionValue } from "./StoryProviders"
import { FileTree } from "../../diff-viewer/FileTree"
import { FullScreenDiffView } from "../../diff-viewer/FullScreenDiffView"
import { ChatView } from "../components/chat/ChatView"
import { registerVscodeToolOverrides } from "../components/chat/VscodeToolOverrides"
import { SessionContext } from "../context/session"
import { ServerContext } from "../context/server"
import { WorktreeModeProvider } from "../context/worktree-mode"
import { SidebarSearchMenu } from "../../agent-manager/SidebarSearchMenu"
import { SidebarToggleButton } from "../../agent-manager/SidebarToggleButton"
import type { SidebarSearchItem } from "../../agent-manager/sidebar-search"
import { Button } from "@kilocode/kilo-ui/button"
import { IconButton } from "@kilocode/kilo-ui/icon-button"
import { Icon } from "@kilocode/kilo-ui/icon"
import { TooltipKeybind } from "@kilocode/kilo-ui/tooltip"
import { ContextMenu } from "@kilocode/kilo-ui/context-menu"
import { ThinkingSelectorBase } from "../components/shared/ThinkingSelector"
import { createSignal, onCleanup, onMount, type JSX } from "solid-js"
import type { WorktreeFileDiff } from "../types/messages"
import type { ReviewComment } from "../../diff-viewer/review-comments"
import { SidebarSessionList } from "../../agent-manager/SidebarSessionList"
import type { SessionInfo } from "../types/messages"
import "../../agent-manager/agent-manager.css"
import "../../agent-manager/agent-manager-review.css"

registerVscodeToolOverrides()

// ---------------------------------------------------------------------------
// Shared mock data
// ---------------------------------------------------------------------------

const mockDiffs: WorktreeFileDiff[] = [
  {
    file: "src/components/chat/ChatView.tsx",
    status: "modified",
    additions: 12,
    deletions: 4,
    before: `import { Component } from "solid-js"\n\nexport const ChatView: Component = () => {\n  return <div class="chat-view" />\n}\n`,
    after: `import { Component, createSignal } from "solid-js"\n\nexport const ChatView: Component = () => {\n  const [open, setOpen] = createSignal(false)\n  return <div class="chat-view" />\n}\n`,
  },
  {
    file: "src/components/chat/MessageList.tsx",
    status: "modified",
    additions: 3,
    deletions: 1,
    before: `export const MessageList = () => <div class="message-list" />\n`,
    after: `export const MessageList = () => (\n  <div class="message-list" role="log" aria-live="polite" />\n)\n`,
  },
  {
    file: "src/stories/chat.stories.tsx",
    status: "added",
    additions: 80,
    deletions: 0,
    before: "",
    after: `/** @jsxImportSource solid-js */\nimport type { Meta } from "storybook-solidjs-vite"\nconst meta: Meta = { title: "Chat" }\nexport default meta\n`,
  },
]

const context = Array.from({ length: 36 }, (_, i) => `  const item${i} = values[${i}]\n`).join("")
const foldedDiffs: WorktreeFileDiff[] = [
  {
    file: "src/components/chat/LongReview.ts",
    status: "modified",
    additions: 2,
    deletions: 2,
    before: `export function review(values: string[]) {\n  const title = "Draft"\n${context}  return title\n}\n`,
    after: `export function review(values: string[]) {\n  const title = "Ready"\n${context}  return title.toUpperCase()\n}\n`,
  },
]

const ROWS = 140
function edited(seed: string): WorktreeFileDiff {
  const before = Array.from({ length: ROWS }, (_, i) => `const row${i} = "${seed}-old-${i}"\n`).join("")
  const after = Array.from({ length: ROWS }, (_, i) => `const row${i} = "${seed}-new-${i}"\n`).join("")
  const patch = [
    "diff --git a/src/agent-edit.ts b/src/agent-edit.ts",
    "--- a/src/agent-edit.ts",
    "+++ b/src/agent-edit.ts",
    `@@ -1,${ROWS} +1,${ROWS} @@`,
    ...before
      .trimEnd()
      .split("\n")
      .map((line) => `-${line}`),
    ...after
      .trimEnd()
      .split("\n")
      .map((line) => `+${line}`),
    "",
  ].join("\n")

  return {
    file: "src/agent-edit.ts",
    status: "modified",
    additions: ROWS,
    deletions: ROWS,
    before,
    after,
    patch,
  }
}

const tail: WorktreeFileDiff = {
  file: "src/target.ts",
  status: "modified",
  additions: 1,
  deletions: 1,
  before: "const target = 'before'\n",
  after: "const target = 'after'\n",
  patch:
    "diff --git a/src/target.ts b/src/target.ts\n--- a/src/target.ts\n+++ b/src/target.ts\n@@ -1 +1 @@\n-const target = 'before'\n+const target = 'after'\n",
}

// ---------------------------------------------------------------------------
// Meta
// ---------------------------------------------------------------------------

const meta: Meta = {
  title: "AgentManager",
  parameters: { layout: "padded" },
}
export default meta
type Story = StoryObj

// ---------------------------------------------------------------------------
// Wide chat layout
// ---------------------------------------------------------------------------

const chatSessionID = "story-agent-manager-chat"
const chatUserID = "story-agent-manager-user"
const chatAssistantID = "story-agent-manager-assistant"
const chatTime = 1_718_000_000_000
const chatDiff = {
  file: "webview-ui/src/styles/chat-layout.css",
  status: "modified" as const,
  additions: 12,
  deletions: 4,
  before: ".chat-view {\n  display: flex;\n}\n",
  after: ".chat-view {\n  display: flex;\n  container: chat / inline-size;\n}\n",
}
const chatMessages = [
  {
    id: chatUserID,
    sessionID: chatSessionID,
    role: "user",
    createdAt: new Date(chatTime).toISOString(),
    time: { created: chatTime },
    summary: { diffs: [chatDiff] },
  },
  {
    id: chatAssistantID,
    sessionID: chatSessionID,
    role: "assistant",
    parentID: chatUserID,
    createdAt: new Date(chatTime + 1000).toISOString(),
    time: { created: chatTime + 1000, completed: chatTime + 5000 },
    modelID: "anthropic/claude-sonnet-4-6",
    providerID: "kilo",
    mode: "default",
    agent: "code",
    path: { cwd: "/project", root: "/project" },
  },
]
const chatParts = {
  [chatUserID]: [
    {
      id: "story-agent-manager-user-text",
      sessionID: chatSessionID,
      messageID: chatUserID,
      type: "text",
      text: "Make the full-screen Agent Manager conversation easier to scan without squeezing tool output or diffs.",
    },
  ],
  [chatAssistantID]: [
    {
      id: "story-agent-manager-assistant-text",
      sessionID: chatSessionID,
      messageID: chatAssistantID,
      type: "text",
      text: "The transcript now follows a centered 78 character reading lane. Long explanations share one consistent left edge, so the eye can move between turns without crossing the entire editor.\n\nTool output and the composer use the same lane, keeping every conversation element aligned.",
    },
    {
      id: "story-agent-manager-bash",
      sessionID: chatSessionID,
      messageID: chatAssistantID,
      type: "tool",
      callID: "story-agent-manager-bash-call",
      tool: "bash",
      state: {
        status: "completed",
        input: { command: "bun run test:unit", description: "Run focused Agent Manager tests" },
        output: "18 tests passed\n0 tests failed",
        title: "Run focused Agent Manager tests",
        metadata: {},
        time: { start: chatTime + 2000, end: chatTime + 4000 },
      },
    },
  ],
}
const chatData = {
  ...defaultMockData,
  message: { [chatSessionID]: chatMessages },
  part: chatParts,
}
const chatServer = {
  connectionState: () => "connected" as const,
  serverInfo: () => undefined,
  extensionVersion: () => "1.0.0",
  errorMessage: () => undefined,
  errorDetails: () => undefined,
  isConnected: () => true,
  profileData: () => null,
  deviceAuth: () => ({ status: "idle" as const }),
  startLogin: () => undefined,
  goToLogin: () => undefined,
  goToProfile: () => undefined,
  vscodeLanguage: () => "en",
  languageOverride: () => undefined,
  workspaceDirectory: () => "/project",
  gitInstalled: () => true,
}

function renderChat() {
  const session = {
    ...mockSessionValue({ id: chatSessionID, status: "idle", closeReason: "completed" }),
    messages: () => chatMessages,
    visibleMessages: () => chatMessages,
    userMessages: () => chatMessages.filter((message) => message.role === "user"),
    getParts: (id: string) => chatParts[id as keyof typeof chatParts] ?? [],
  }
  return (
    <StoryProviders data={chatData} sessionID={chatSessionID} status="idle" noPadding>
      <ServerContext.Provider value={chatServer}>
        <SessionContext.Provider value={session as any}>
          <WorktreeModeProvider>
            <div class="am-chat-wrapper" style={{ height: "100vh" }}>
              <ChatView onForkSession={() => undefined} />
            </div>
          </WorktreeModeProvider>
        </SessionContext.Provider>
      </ServerContext.Provider>
    </StoryProviders>
  )
}

export const ReadableChat1280: Story = {
  name: "Chat - readable wide editor",
  parameters: { layout: "fullscreen" },
  render: renderChat,
}

export const ReadableChat420: Story = {
  name: "Chat - constrained editor",
  parameters: { layout: "fullscreen" },
  render: renderChat,
}

// ---------------------------------------------------------------------------
// FileTree
// ---------------------------------------------------------------------------

export const FileTreeWithChanges: Story = {
  name: "FileTree — with modifications and additions",
  render: () => (
    <StoryProviders>
      <div style={{ width: "420px", height: "400px", overflow: "auto" }}>
        <FileTree diffs={mockDiffs} activeFile="src/components/chat/ChatView.tsx" onFileSelect={() => {}} showSummary />
      </div>
    </StoryProviders>
  ),
}

export const FileTreeEmpty: Story = {
  name: "FileTree — no changes",
  render: () => (
    <StoryProviders>
      <div style={{ width: "420px", height: "400px" }}>
        <FileTree diffs={[]} activeFile={null} onFileSelect={() => {}} />
      </div>
    </StoryProviders>
  ),
}

// ---------------------------------------------------------------------------
// Inline diff bulk actions
// ---------------------------------------------------------------------------

const buttonFixtureStyle: JSX.CSSProperties = {
  display: "inline-flex",
  "align-items": "center",
  gap: "10px",
  padding: "8px",
  background: "var(--surface-base)",
  border: "1px solid var(--border-weak-base)",
  "border-radius": "6px",
}

const buttonFixtureLabelStyle: JSX.CSSProperties = {
  color: "var(--text-weak)",
  "font-size": "var(--font-size-small)",
}

export const InlineDiffBulkActionExpandAllButton: Story = {
  name: "Inline Diff — expand all button",
  render: () => (
    <StoryProviders noPadding>
      <div style={buttonFixtureStyle}>
        <span style={buttonFixtureLabelStyle}>Inline diff action</span>
        <IconButton icon="files-expand" size="small" variant="ghost" label="Expand All" />
      </div>
    </StoryProviders>
  ),
}

export const InlineDiffBulkActionCollapseAllButton: Story = {
  name: "Inline Diff — collapse all button",
  render: () => (
    <StoryProviders noPadding>
      <div style={buttonFixtureStyle}>
        <span style={buttonFixtureLabelStyle}>Inline diff action</span>
        <IconButton icon="files-collapse" size="small" variant="ghost" label="Collapse All" />
      </div>
    </StoryProviders>
  ),
}

export const FullScreenDiffBulkActionExpandAllButton: Story = {
  name: "Full-screen Diff — expand all button",
  render: () => (
    <StoryProviders noPadding>
      <div style={buttonFixtureStyle}>
        <span style={buttonFixtureLabelStyle}>Full-screen diff action</span>
        <Button size="small" variant="ghost">
          <Icon name="chevron-grabber-vertical" size="small" />
          Expand All
        </Button>
      </div>
    </StoryProviders>
  ),
}

export const FullScreenDiffBulkActionCollapseAllButton: Story = {
  name: "Full-screen Diff — collapse all button",
  render: () => (
    <StoryProviders noPadding>
      <div style={buttonFixtureStyle}>
        <span style={buttonFixtureLabelStyle}>Full-screen diff action</span>
        <Button size="small" variant="ghost">
          <Icon name="chevron-grabber-vertical" size="small" />
          Collapse All
        </Button>
      </div>
    </StoryProviders>
  ),
}

// ---------------------------------------------------------------------------
// FullScreenDiffView
// ---------------------------------------------------------------------------

export const FullScreenDiffWithChanges: Story = {
  name: "FullScreenDiffView — with changes",
  render: () => (
    <StoryProviders>
      <div style={{ width: "420px", height: "700px", display: "flex" }}>
        <FullScreenDiffView
          diffs={mockDiffs}
          loading={false}
          diffStyle="unified"
          onDiffStyleChange={() => {}}
          comments={[]}
          onCommentsChange={() => {}}
          onClose={() => {}}
        />
      </div>
    </StoryProviders>
  ),
}

export const FullScreenDiffWithCollapsedContext: Story = {
  name: "FullScreenDiffView - collapsed unchanged context",
  render: () => (
    <StoryProviders>
      <div style={{ width: "420px", height: "700px", display: "flex" }}>
        <FullScreenDiffView
          diffs={foldedDiffs}
          loading={false}
          diffStyle="unified"
          onDiffStyleChange={() => {}}
          comments={[]}
          onCommentsChange={() => {}}
          onClose={() => {}}
        />
      </div>
    </StoryProviders>
  ),
}

export const FullScreenDiffAgentEditScroll: Story = {
  name: "FullScreenDiffView - preserve scroll during agent edit",
  render: () => {
    const [diffs, setDiffs] = createSignal([edited("before"), tail])
    const [version, setVersion] = createSignal("before")
    const [key, setKey] = createSignal("agent-edit-scroll")
    const [comments, setComments] = createSignal<ReviewComment[]>([])
    const update = () => {
      setDiffs([edited("after"), tail])
      setVersion("after")
    }
    const change = () => {
      setDiffs([edited("context"), tail])
      setKey("changed-context")
    }
    return (
      <StoryProviders noPadding>
        <div style={{ height: "700px", display: "flex", "flex-direction": "column" }}>
          <div style={{ display: "flex", gap: "8px", padding: "4px", "align-items": "center" }}>
            <Button size="small" onClick={update}>
              Apply agent edit
            </Button>
            <Button size="small" onClick={change}>
              Switch review context
            </Button>
            <span data-testid="agent-edit-version">{version()}</span>
            <span data-testid="review-context">{key()}</span>
          </div>
          <div style={{ display: "flex", "min-height": "0", flex: "1" }}>
            <FullScreenDiffView
              diffs={diffs()}
              loading={false}
              sessionKey={key()}
              diffStyle="unified"
              onDiffStyleChange={() => {}}
              comments={comments()}
              onCommentsChange={setComments}
              onClose={() => {}}
            />
          </div>
        </div>
      </StoryProviders>
    )
  },
}

// ---------------------------------------------------------------------------
// TabBar — renders tab bar structure matching SortableTab
// DOM to verify the tooltip-trigger height chain is correct.
// ---------------------------------------------------------------------------

/**
 * Mock tab matching the real SortableTab DOM:
 *   .am-tab-sortable > [context-menu-trigger] > [tooltip-trigger] > .am-tab
 */
const MockTab = (props: { title: string; active?: boolean }) => (
  <div class="am-tab-sortable">
    <ContextMenu>
      <ContextMenu.Trigger as="div" style={{ display: "contents" }}>
        <TooltipKeybind title={props.title} keybind="⌘1" placement="bottom" inactive={props.active}>
          <div class={`am-tab ${props.active ? "am-tab-active" : ""}`}>
            <span class="am-tab-label">{props.title}</span>
            <TooltipKeybind title="Close" keybind="⌘W" placement="bottom" class="am-tab-close-wrap">
              <IconButton icon="close-small" size="small" variant="ghost" label="Close" class="am-tab-close" />
            </TooltipKeybind>
          </div>
        </TooltipKeybind>
      </ContextMenu.Trigger>
    </ContextMenu>
  </div>
)

const MockTabLeading = () => (
  <div class="am-tab-leading">
    <SidebarToggleButton collapsed={false} onClick={() => {}} />
  </div>
)

const MockTabAdd = () => (
  <div class="am-tab-add-wrap">
    <div class="am-tab-add-separator" />
    <div class="am-split-button am-tab-add-split">
      <TooltipKeybind title="New session" keybind="⌘T" placement="bottom">
        <IconButton icon="plus" size="small" variant="ghost" label="New session" class="am-tab-add" />
      </TooltipKeybind>
    </div>
  </div>
)

export const TabBarMultipleTabs: Story = {
  name: "TabBar — multiple tabs with active",
  render: () => (
    <StoryProviders noPadding>
      <div class="am-tab-bar">
        <MockTabLeading />
        <div class="am-tab-scroll-area">
          <div class="am-tab-list-wrap">
            <div class="am-tab-list" style={{ "--tab-count": "3" } as JSX.CSSProperties}>
              <MockTab title="Implement auth" active />
              <MockTab title="Fix button styles" />
              <MockTab title="Add unit tests" />
            </div>
          </div>
        </div>
        <MockTabAdd />
      </div>
    </StoryProviders>
  ),
}

export const TabBarSingleTab: Story = {
  name: "TabBar — single active tab",
  render: () => (
    <StoryProviders noPadding>
      <div class="am-tab-bar">
        <MockTabLeading />
        <div class="am-tab-scroll-area">
          <div class="am-tab-list-wrap">
            <div class="am-tab-list" style={{ "--tab-count": "1" } as JSX.CSSProperties}>
              <MockTab title="PR #6966 worktree checkout" active />
            </div>
          </div>
        </div>
        <MockTabAdd />
      </div>
    </StoryProviders>
  ),
}

// ---------------------------------------------------------------------------
// NewWorktreeDialog — inline selector popovers must escape the dialog scroll
// containers. Regression: the reasoning-variant and mode pickers were clipped
// by .am-nv-dialog-content (overflow-y: auto) and .am-prompt-input-container
// (overflow: hidden) because the overflow escape hatch only covered the model
// picker. This fixture reproduces the real clipping chain (same CSS classes +
// the real inline ThinkingSelectorBase with portal={false}) so a screenshot
// baseline catches any future regression. Rendered inline (no dialog portal)
// because the visual-regression harness screenshots #storybook-root.
// ---------------------------------------------------------------------------

const VariantPickerOpener = () => {
  let frame = 0
  let attempts = 0
  const open = () => {
    if (document.querySelector("[data-component='popover-content']")) return
    if (attempts++ >= 120) return
    window.dispatchEvent(new CustomEvent("openVariantPicker"))
    frame = requestAnimationFrame(open)
  }
  onMount(() => {
    frame = requestAnimationFrame(open)
  })
  onCleanup(() => cancelAnimationFrame(frame))
  return null
}

export const NewWorktreeVariantDropdown1280: Story = {
  name: "NewWorktreeDialog — variant dropdown open",
  parameters: { layout: "fullscreen" },
  render: () => (
    <StoryProviders noPadding>
      {/* Filler pushes the prompt container to the bottom of the dialog content.
          The variant popover opens upward from the trigger, extending above the
          container's top edge. Without the overflow escape fix, .am-prompt-input-container
          (overflow: hidden + position: relative) clips the top of the popover. */}
      <div style={{ height: "100vh", display: "flex", "flex-direction": "column" }}>
        <div class="am-nv-dialog">
          <div class="am-nv-dialog-content">
            <div style={{ height: "500px", "flex-shrink": 0 }} />
            <div
              class="prompt-input-container am-prompt-input-container"
              style={{ position: "relative", "flex-shrink": 0 }}
            >
              <div class="prompt-input-hint">
                <div class="prompt-input-hint-selectors">
                  <ThinkingSelectorBase
                    variants={["low", "medium", "high"]}
                    value="low"
                    onSelect={() => {}}
                    portal={false}
                    deferDismiss
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <VariantPickerOpener />
    </StoryProviders>
  ),
}

const searchSection = { id: "polish", name: "Polish", color: "Blue", order: 0, collapsed: false }
const slackedSection = { id: "slacked", name: "SLACKED", color: "Yellow", order: 1, collapsed: false }
const sidebarSearchItems: SidebarSearchItem[] = [
  {
    key: "session:session-build",
    kind: "session",
    group: "sessions",
    title: "Build grouped worktree search",
    meta: ["Polish", "Agent Manager search", "feat/sidebar-search"],
    search: "Build grouped worktree search Agent Manager search feat/sidebar-search Polish",
    sessionId: "session-build",
    location: "worktree",
    worktreeId: "wt-search",
    updatedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
    state: "busy",
    visible: true,
    section: searchSection,
  },
  {
    key: "session:session-local",
    kind: "session",
    group: "sessions",
    title: "Investigate local indexing",
    meta: ["local"],
    search: "Investigate local indexing local",
    sessionId: "session-local",
    location: "local",
    updatedAt: new Date(Date.now() - 8 * 60_000).toISOString(),
    state: "idle",
    visible: true,
  },
  {
    key: "session:session-render",
    kind: "session",
    group: "sessions",
    title: "Render images in diff viewer",
    meta: ["SLACKED", "images diff viewer", "utopian-approval"],
    search: "Render images in diff viewer SLACKED images diff viewer utopian-approval",
    sessionId: "session-render",
    location: "worktree",
    worktreeId: "wt-render",
    updatedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    state: "idle",
    visible: true,
    section: slackedSection,
  },
  {
    key: "local",
    kind: "local",
    group: "contexts",
    title: "local",
    meta: ["main"],
    search: "local main",
    updatedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
    state: "idle",
    visible: true,
    count: 2,
  },
  {
    key: "worktree:wt-search",
    kind: "worktree",
    group: "contexts",
    title: "Agent Manager search",
    meta: ["Polish", "feat/sidebar-search"],
    search: "Agent Manager search Polish feat/sidebar-search",
    worktreeId: "wt-search",
    updatedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
    state: "busy",
    visible: true,
    section: searchSection,
    count: 2,
  },
]

export const SidebarSearchOpen: Story = {
  name: "Sidebar search — worktrees and sessions",
  render: () => {
    const [selected, setSelected] = createSignal("worktree:wt-search")
    let prompt!: HTMLTextAreaElement
    const refocus = () => requestAnimationFrame(() => prompt.focus())
    onMount(() => {
      window.addEventListener("focusPrompt", refocus)
      onCleanup(() => window.removeEventListener("focusPrompt", refocus))
    })
    return (
      <StoryProviders noPadding>
        <div style={{ "min-height": "430px", padding: "16px", background: "var(--surface-base)" }}>
          <div class="am-section-header">
            <span class="am-section-label">WORKTREES</span>
            <div class="am-section-actions">
              <SidebarSearchMenu
                items={() => sidebarSearchItems}
                keybind="⌘F"
                current={() => sidebarSearchItems.find((item) => item.key === selected())}
                labels={{
                  search: "Search worktrees and sessions",
                  scope: "Searches the local workspace, local sessions, worktrees, and their sessions",
                  contexts: "LOCAL & WORKTREES",
                  sessions: "SESSIONS",
                  waiting: "Wait",
                  retry: "Retry",
                }}
                onSelect={(item) => setSelected(item.key)}
                defaultOpen
                portal={false}
              />
            </div>
          </div>
          <output class="sr-only" data-slot="sidebar-search-selection">
            {selected()}
          </output>
          <textarea ref={prompt} class="sr-only" aria-label="Story prompt" />
        </div>
      </StoryProviders>
    )
  },
}

// ---------------------------------------------------------------------------
// P1 derived Topic navigation — SidebarSessionList
//
// Topics are derived at render time from runtime session facts only (roots
// define Topics, descendants belong via parentID, activity = max member
// updatedAt, activity-descending with ID tie-break). These stories exercise
// the hierarchy, orphan/cycle fallback, active-Topic derivation, rename/
// delete interactions, and the auto-expand-on-active-change rule. Selection
// is reported via data-testid so Playwright can assert the click routes
// through onSelectSession (which the app wires to the existing openSession
// transaction).
// ---------------------------------------------------------------------------

const storyT = (key: string): string =>
  ({
    "time.today": "Today",
    "time.yesterday": "Yesterday",
    "time.thisWeek": "This Week",
    "time.thisMonth": "This Month",
    "time.older": "Older",
  })[key] ?? key

const now = Date.now()
const agoMin = (n: number) => new Date(now - n * 60_000).toISOString()
const agoHours = (n: number) => new Date(now - n * 3_600_000).toISOString()

/** Roots with a child hierarchy, an orphan, and a cycle — the full fallback set. */
const topicFixtureSessions: SessionInfo[] = [
  { id: "topic-active", title: "Refactor agent manager sidebar", createdAt: agoMin(300), updatedAt: agoMin(1) },
  {
    id: "topic-active-child",
    parentID: "topic-active",
    title: "Extract topic derivation",
    createdAt: agoMin(200),
    updatedAt: agoMin(2),
  },
  {
    id: "topic-active-grandchild",
    parentID: "topic-active-child",
    title: "Fix orphan fallback",
    createdAt: agoMin(100),
    updatedAt: agoMin(3),
  },
  { id: "topic-stale", title: "Investigate provider routing", createdAt: agoHours(5), updatedAt: agoMin(30) },
  {
    id: "topic-stale-child",
    parentID: "topic-stale",
    title: "Trace SSE events",
    createdAt: agoHours(4),
    updatedAt: agoMin(40),
  },
  { id: "topic-old", title: "Write P1 acceptance docs", createdAt: agoHours(30), updatedAt: agoHours(26) },
  {
    id: "orphan",
    parentID: "missing-parent",
    title: "Orphaned session",
    createdAt: agoMin(600),
    updatedAt: agoMin(10),
  },
  { id: "orphan-child", parentID: "orphan", title: "Orphan child", createdAt: agoMin(590), updatedAt: agoMin(12) },
  { id: "cycle-a", parentID: "cycle-b", title: "Cycle member A", createdAt: agoMin(700), updatedAt: agoMin(20) },
  { id: "cycle-b", parentID: "cycle-a", title: "Cycle member B", createdAt: agoMin(690), updatedAt: agoMin(21) },
]

/** Actions stories can drive through the fixture's internal state. */
interface TopicFixtureActions {
  setSessions: (fn: (prev: SessionInfo[]) => SessionInfo[]) => void
  setActiveId: (id: string | undefined) => void
}

interface TopicListFixtureProps {
  sessions: SessionInfo[]
  activeId?: string
  /** Escapes the fixture's session/active signals so stories can simulate inventory updates. */
  controller?: (actions: TopicFixtureActions) => void
}

function TopicListFixture(props: TopicListFixtureProps) {
  const [sessions, setSessions] = createSignal<SessionInfo[]>(props.sessions)
  const [activeId, setActiveId] = createSignal<string | undefined>(props.activeId)
  props.controller?.({ setSessions, setActiveId })
  const session = {
    ...mockSessionValue(),
    sessions: () => sessions(),
    currentSessionID: () => activeId(),
    sessionsHasMore: () => false,
    loadMoreSessions: () => {},
    renameSession: (id: string, title: string) => {
      setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, title } : s)))
    },
    deleteSession: (id: string) => {
      setSessions((prev) => prev.filter((s) => s.id !== id))
    },
  }
  let listEl: HTMLDivElement | undefined
  return (
    <StoryProviders noPadding>
      <SessionContext.Provider value={session as any}>
        <div style={{ display: "flex", height: "640px", width: "340px", background: "var(--surface-base)" }}>
          <div class="am-list" ref={listEl}>
            <SidebarSessionList
              listContainer={() => listEl}
              sessions={sessions()}
              sessionsLoaded
              currentSelection={activeId() ?? null}
              onSelectSession={(id) => {
                const out = document.querySelector<HTMLElement>('[data-testid="topic-selection"]')
                if (out) out.textContent = id
              }}
              untitledLabel="Untitled"
              t={storyT}
            />
          </div>
        </div>
      </SessionContext.Provider>
    </StoryProviders>
  )
}

const TopicSelectionOutput = () => (
  <output class="sr-only" data-testid="topic-selection" aria-label="Selected session" />
)

export const TopicListHierarchy: Story = {
  name: "Topic list — hierarchy with active topic",
  parameters: { layout: "fullscreen" },
  render: () => (
    <>
      <TopicSelectionOutput />
      <TopicListFixture sessions={topicFixtureSessions} activeId="topic-active-child" />
    </>
  ),
}

export const TopicListOrphanCycle: Story = {
  name: "Topic list — orphan and cycle fallback",
  parameters: { layout: "fullscreen" },
  render: () => (
    <>
      <TopicSelectionOutput />
      <TopicListFixture
        sessions={topicFixtureSessions.filter(
          (s) => s.id === "topic-active" || s.id.startsWith("orphan") || s.id.startsWith("cycle"),
        )}
        activeId="orphan"
      />
    </>
  ),
}

export const TopicListInteractions: Story = {
  name: "Topic list — rename and delete interactions",
  parameters: { layout: "fullscreen" },
  render: () => (
    <>
      <TopicSelectionOutput />
      <TopicListFixture sessions={topicFixtureSessions} activeId="topic-active-child" />
    </>
  ),
}

export const TopicListAutoExpand: Story = {
  name: "Topic list — auto-expand only on active change",
  parameters: { layout: "fullscreen" },
  render: () => {
    let actions: TopicFixtureActions | undefined
    return (
      <>
        <div style={{ position: "fixed", bottom: "4px", left: "4px", "z-index": 10, display: "flex", gap: "8px" }}>
          <button
            data-testid="refresh-inventory"
            type="button"
            onClick={() =>
              actions?.setSessions((prev) =>
                prev.map((s) => (s.id === "topic-active-child" ? { ...s, updatedAt: agoMin(1) } : s)),
              )
            }
          >
            Refresh inventory
          </button>
          <button data-testid="activate-stale" type="button" onClick={() => actions?.setActiveId("topic-stale-child")}>
            Activate stale topic
          </button>
        </div>
        <TopicSelectionOutput />
        <TopicListFixture
          sessions={topicFixtureSessions}
          activeId="topic-active-child"
          controller={(a) => (actions = a)}
        />
      </>
    )
  },
}
