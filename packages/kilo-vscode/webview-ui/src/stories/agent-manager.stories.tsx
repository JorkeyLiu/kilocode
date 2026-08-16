/** @jsxImportSource solid-js */
/**
 * Stories for Agent Manager components:
 * ChatView, SidebarSessionList, TabBar, SidebarSearchMenu
 */

import type { Meta, StoryObj } from "storybook-solidjs-vite"
import { StoryProviders, defaultMockData, mockSessionValue } from "./StoryProviders"
import { ChatView } from "../components/chat/ChatView"
import { registerVscodeToolOverrides } from "../components/chat/VscodeToolOverrides"
import { SessionContext } from "../context/session"
import { ServerContext } from "../context/server"
import { AgentManagerProvider } from "../context/agent-manager"
import { SidebarSearchMenu } from "../../agent-manager/SidebarSearchMenu"
import { SidebarToggleButton } from "../../agent-manager/SidebarToggleButton"
import type { SidebarSearchItem } from "../../agent-manager/sidebar-search"
import { Button } from "@kilocode/kilo-ui/button"
import { IconButton } from "@kilocode/kilo-ui/icon-button"
import { Icon } from "@kilocode/kilo-ui/icon"
import { TooltipKeybind } from "@kilocode/kilo-ui/tooltip"
import { ContextMenu } from "@kilocode/kilo-ui/context-menu"
import { createSignal, onCleanup, onMount, type JSX } from "solid-js"
import { SidebarSessionList } from "../../agent-manager/SidebarSessionList"
import type { SessionInfo } from "../types/messages"
import "../../agent-manager/agent-manager.css"

registerVscodeToolOverrides()

// ---------------------------------------------------------------------------
// Shared mock data
// ---------------------------------------------------------------------------

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
          <AgentManagerProvider>
            <div class="am-chat-wrapper" style={{ height: "100vh" }}>
              <ChatView onForkSession={() => undefined} />
            </div>
          </AgentManagerProvider>
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
              <MockTab title="Review PR #6966" active />
            </div>
          </div>
        </div>
        <MockTabAdd />
      </div>
    </StoryProviders>
  ),
}

const sidebarSearchItems: SidebarSearchItem[] = [
  {
    key: "session:session-build",
    kind: "session",
    group: "sessions",
    title: "Build grouped search",
    meta: ["local", "Agent Manager search", "feat/sidebar-search"],
    search: "Build grouped search Agent Manager search feat/sidebar-search local",
    sessionId: "session-build",
    location: "local",
    updatedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
    state: "busy",
    visible: true,
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
]

export const SidebarSearchOpen: Story = {
  name: "Sidebar search — sessions",
  render: () => {
    const [selected, setSelected] = createSignal("local")
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
            <span class="am-section-label">LOCAL</span>
            <div class="am-section-actions">
              <SidebarSearchMenu
                items={() => sidebarSearchItems}
                keybind="⌘F"
                current={() => sidebarSearchItems.find((item) => item.key === selected())}
                labels={{
                  search: "Search sessions",
                  scope: "Searches the local workspace and its sessions",
                  contexts: "LOCAL",
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
