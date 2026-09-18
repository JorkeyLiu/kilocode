/** @jsxImportSource solid-js */
/**
 * Stories for Settings and ProvidersTab components.
 */

import { onMount } from "solid-js"
import type { Meta, StoryObj } from "storybook-solidjs-vite"
import { StoryProviders, mockSessionValue } from "./StoryProviders"
import { useDialog } from "@kilocode/kilo-ui/context/dialog"
import { SessionContext } from "../context/session"
import Settings from "../components/settings/Settings"
import ProvidersTab from "../components/settings/ProvidersTab"
import ProviderConnectDialog from "../components/settings/ProviderConnectDialog"
import CustomProviderDialog from "../components/settings/CustomProviderDialog"
import ModelsTab from "../components/settings/ModelsTab"
import AgentBehaviourTab from "../components/settings/AgentBehaviourTab"
import AutoApproveTab from "../components/settings/AutoApproveTab"
import {
  AUTONOMOUS_PERMISSION_PRESET,
  REVIEW_PERMISSION_PRESET,
} from "@opencode-ai/core/kilocode/permission-presets"
import ModeEditView from "../components/settings/ModeEditView"
import McpEditView from "../components/settings/McpEditView"
import type { AgentConfig, CommandConfig, Config } from "../types/messages"
import { SidebarEmptyState } from "../components/chat/SidebarEmptyState"
import { WorkStyleContext, type WorkStyleContextValue } from "../context/work-style"
import { useConfig } from "../context/config"

const meta: Meta = {
  title: "Settings",
  parameters: { layout: "fullscreen" },
}
export default meta
type Story = StoryObj

function noop() {}

const MOCK_AGENTS = [
  { name: "code", description: "General-purpose coding agent", mode: "primary" as const, native: true },
  { name: "debug", description: "Diagnose and fix bugs", mode: "primary" as const, native: true },
  { name: "architect", description: "Design systems and plan features", mode: "all" as const, native: true },
  {
    name: "reviewer",
    description: "Review code for quality and best practices",
    mode: "primary" as const,
    native: false,
  },
]

export const SettingsPanel: Story = {
  name: "Settings — full panel",
  render: () => (
    <StoryProviders>
      <div style={{ height: "700px", display: "flex", "flex-direction": "column" }}>
        <Settings />
      </div>
    </StoryProviders>
  ),
}

export const CanonicalAuthorityDiagnostics: Story = {
  name: "Settings — canonical diagnostics and unsupported controls",
  render: () => (
    <StoryProviders canonical diagnostics={[{ path: ["experimental"], message: "Unsupported setting is read-only: experimental" }]} config={{ model: "kilo/anthropic/claude-sonnet-4-6", experimental: { batch_tool: true } } as any}>
      <div style={{ "max-height": "700px", overflow: "auto" }}>
        <Settings tab="experimental" />
      </div>
    </StoryProviders>
  ),
}

export const CanonicalInteraction: Story = {
  name: "Settings — canonical interaction contracts",
  render: () => (
    <StoryProviders canonical diagnostics={[{ path: ["experimental"], message: "Unsupported setting is read-only: experimental" }]} config={{ model: "kilo/anthropic/claude-sonnet-4-6", provider: { openai: { name: "OpenAI" } } } as any}>
      <div data-testid="canonical-diagnostics" role="alert"><SettingsDiagnostics /></div>
      <div data-testid="canonical-unsupported-controls">
        <Settings tab="display" />
      </div>
    </StoryProviders>
  ),
}

export const CanonicalInteractionWithCapturedSettings: Story = {
  name: "Settings — canonical UI-local updateSetting contract",
  render: () => (
    <StoryProviders canonical onMessage={() => undefined} config={{ model: "kilo/anthropic/claude-sonnet-4-6" } as any}>
      <div data-testid="canonical-local-settings">
        <Settings tab="display" />
      </div>
    </StoryProviders>
  ),
}

function SettingsDiagnostics() {
  const config = useConfig()
  return <>{(config.diagnostics?.() ?? []).map((item) => item.message).join("; ")}</>
}

export const CanonicalOAuthHidden: Story = {
  name: "Settings — canonical OAuth controls hidden",
  render: () => (
    <StoryProviders canonical config={{ model: "kilo/anthropic/claude-sonnet-4-6" } as any}>
      <div style={{ "max-height": "700px", overflow: "auto" }}>
        <Settings tab="providers" />
      </div>
    </StoryProviders>
  ),
}

export const AutoApproveBashOnly: Story = {
  name: "AutoApproveTab — Bash-only config defaults",
  render: () => (
    <StoryProviders config={{ permission: { bash: { "*": "ask", "git status *": "allow" } } } as any}>
      <div style={{ "max-height": "700px", overflow: "auto" }}>
        <AutoApproveTab />
      </div>
    </StoryProviders>
  ),
}

export const SandboxingPanel: Story = {
  name: "Settings — sandboxing controls",
  render: () => (
    <StoryProviders config={{ sandbox: { network: "deny" } }} features={{ sandboxControls: true }}>
      <div style={{ height: "700px", display: "flex", "flex-direction": "column" }}>
        <Settings tab="sandboxing" />
      </div>
    </StoryProviders>
  ),
}

export const SandboxingAllowlist: Story = {
  name: "Settings — sandboxing with network destinations",
  render: () => (
    <StoryProviders
      config={{
        sandbox: {
          enabled: true,
          network: "deny",
          allowed_hosts: ["github.com:443", "api.github.com:443"],
          writable_paths: ["~/shared-output"],
        },
      }}
      features={{ sandboxControls: true }}
    >
      <div style={{ height: "700px", display: "flex", "flex-direction": "column" }}>
        <Settings tab="sandboxing" />
      </div>
    </StoryProviders>
  ),
}

export const ProvidersConfigure: Story = {
  name: "ProvidersTab — no providers configured",
  render: () => (
    <StoryProviders>
      <div style={{ "max-height": "700px", overflow: "auto" }}>
        <ProvidersTab />
      </div>
    </StoryProviders>
  ),
}

export const ProvidersDisabledExpanded: Story = {
  name: "ProvidersTab — disabled providers in configured list",
  render: () => (
    <StoryProviders
      connected={["anthropic", "openai"]}
      authStates={{ anthropic: "api", openai: "api" }}
      config={{ disabled_providers: ["openai"] } as any}
    >
      <div style={{ "max-height": "700px", overflow: "auto" }}>
        <ProvidersTab />
      </div>
    </StoryProviders>
  ),
}

const CONFIGURED_PROVIDERS_CONFIG = {
  disabled_providers: ["openai"],
  provider: {
    openai: {},
    azure: { name: "GPT-Load" },
    custom1: { name: "My Custom", npm: "@ai-sdk/openai-compatible", baseURL: "https://example.com" },
  },
} as any

const CONFIGURED_AUTH_STATES = { anthropic: "api" as const, openai: "api" as const, custom1: "api" as const }

export const ProvidersConfigured1280: Story = {
  name: "ProvidersTab — configured actions 1280px",
  render: () => (
    <StoryProviders
      connected={["anthropic", "openai", "custom1"]}
      authStates={{ ...CONFIGURED_AUTH_STATES, kilo: "oauth" as const }}
      config={CONFIGURED_PROVIDERS_CONFIG}
    >
      <div style={{ width: "1280px", "max-height": "700px", overflow: "auto" }}>
        <ProvidersTab />
      </div>
    </StoryProviders>
  ),
}

export const ProvidersConfigured420: Story = {
  name: "ProvidersTab — configured actions 420px",
  render: () => (
    <StoryProviders
      connected={["anthropic", "openai", "custom1"]}
      authStates={{ ...CONFIGURED_AUTH_STATES, kilo: "oauth" as const }}
      config={CONFIGURED_PROVIDERS_CONFIG}
    >
      <div style={{ width: "420px", "max-height": "700px", overflow: "auto" }}>
        <ProvidersTab />
      </div>
    </StoryProviders>
  ),
}

export const ProvidersConfigured200: Story = {
  name: "ProvidersTab — configured actions 200px",
  render: () => (
    <StoryProviders
      connected={["anthropic", "openai", "custom1"]}
      authStates={{ ...CONFIGURED_AUTH_STATES, kilo: "oauth" as const }}
      config={CONFIGURED_PROVIDERS_CONFIG}
    >
      <div style={{ width: "200px", "max-height": "700px", overflow: "auto" }}>
        <ProvidersTab />
      </div>
    </StoryProviders>
  ),
}

export const ModelsAutocompleteOpen: Story = {
  name: "ModelsTab — autocomplete model picker open",
  render: () => (
    <StoryProviders config={{} as any}>
      <OpenModelPicker>
        <ModelsTab />
      </OpenModelPicker>
    </StoryProviders>
  ),
}

export const ModelsAccessibleLabels: Story = {
  name: "ModelsTab — accessible model labels",
  render: () => (
    <StoryProviders config={{} as any}>
      <div style={{ "max-height": "700px", overflow: "auto" }}>
        <ModelsTab />
      </div>
    </StoryProviders>
  ),
}

export const ModelsSpeechToText: Story = {
  name: "ModelsTab — speech-to-text model",
  render: () => (
    <StoryProviders kiloAuth config={{ experimental: { speech_to_text_model: "google/chirp-3" } } as any}>
      <div style={{ "max-height": "700px", overflow: "auto" }}>
        <ModelsTab />
      </div>
    </StoryProviders>
  ),
}

function OpenModelPicker(props: { children: any }) {
  let ref: HTMLDivElement | undefined
  onMount(() => {
    requestAnimationFrame(() => {
      ref?.querySelector<HTMLButtonElement>('button[title="mistralai/codestral-2508"]')?.click()
    })
  })
  return (
    <div ref={ref} style={{ "max-height": "700px", overflow: "auto" }}>
      {props.children}
    </div>
  )
}

const work: WorkStyleContextValue = {
  style: () => "unset",
  level: () => "unset",
  loading: () => false,
  applying: () => false,
  shouldShowOnboarding: () => true,
  apply: noop,
}

function WorkStyleOnboarding() {
  return (
    <StoryProviders noPadding>
      <WorkStyleContext.Provider value={work}>
        <div style={{ height: "700px", overflow: "auto" }}>
          <SidebarEmptyState />
        </div>
      </WorkStyleContext.Provider>
    </StoryProviders>
  )
}

export const WorkStyleOnboardingDefault: Story = {
  name: "Work style onboarding — default width",
  render: () => <WorkStyleOnboarding />,
}

export const WorkStyleOnboarding200: Story = {
  name: "Work style onboarding — narrow width",
  render: () => <WorkStyleOnboarding />,
}

export const AgentBehaviourAgents: Story = {
  name: "AgentBehaviourTab — available agents list",
  render: () => {
    const session = {
      ...mockSessionValue({ id: "agents-story", status: "idle" }),
      agents: () => MOCK_AGENTS,
      allAgents: () => MOCK_AGENTS,
      removeAgent: noop,
      removeMcp: noop,
      skills: () => [],
      refreshSkills: noop,
      removeSkill: noop,
    }
    return (
      <StoryProviders sessionID="agents-story" status="idle">
        <SessionContext.Provider value={session as any}>
          <div style={{ "max-height": "700px", overflow: "auto" }}>
            <AgentBehaviourTab />
          </div>
        </SessionContext.Provider>
      </StoryProviders>
    )
  },
}

export const AgentBehaviourEditCustomMode: Story = {
  name: "AgentBehaviourTab — edit custom mode",
  render: () => {
    const session = {
      ...mockSessionValue({ id: "edit-mode-story", status: "idle" }),
      agents: () => MOCK_AGENTS,
      allAgents: () => MOCK_AGENTS,
      removeAgent: noop,
      removeMcp: noop,
      skills: () => [],
      refreshSkills: noop,
      removeSkill: noop,
    }
    const cfg: Record<string, AgentConfig> = {
      reviewer: {
        description: "Review code for quality and best practices",
        prompt: "You are a code reviewer. Focus on code quality, best practices, and potential bugs.",
        model: "kilo/anthropic/claude-sonnet-4-6",
        variant: "high",
        temperature: 0.3,
        permission: {
          read: "allow",
          grep: "allow",
          glob: "allow",
          edit: "deny",
          bash: "deny",
          task: "ask",
        },
      },
    }
    return (
      <StoryProviders sessionID="edit-mode-story" status="idle" config={{ agent: cfg } as any}>
        <SessionContext.Provider value={session as any}>
          <EditModeWrapper />
        </SessionContext.Provider>
      </StoryProviders>
    )
  },
}

/**
 * Renders AgentBehaviourTab and clicks into the "reviewer" custom mode's
 * edit view on mount. Uses requestAnimationFrame to ensure the DOM is
 * fully rendered before querying for the list item.
 */
function EditModeWrapper() {
  let ref: HTMLDivElement | undefined
  onMount(() => {
    requestAnimationFrame(() => {
      if (!ref) return
      const items = Array.from(ref.querySelectorAll<HTMLDivElement>("[style*='cursor: pointer']"))
      for (const item of items) {
        if (item.textContent?.includes("reviewer")) {
          item.click()
          return
        }
      }
    })
  })
  return (
    <div ref={ref} style={{ height: "700px", overflow: "auto" }}>
      <AgentBehaviourTab />
    </div>
  )
}

/** Clicks the given subtab button on mount. */
function SubtabWrapper(props: { tab: string }) {
  let ref: HTMLDivElement | undefined
  onMount(() => {
    requestAnimationFrame(() => {
      if (!ref) return
      const buttons = Array.from(ref.querySelectorAll<HTMLButtonElement>("button"))
      for (const btn of buttons) {
        if (btn.textContent?.toLowerCase().includes(props.tab.toLowerCase())) {
          btn.click()
          return
        }
      }
    })
  })
  return (
    <div ref={ref} style={{ height: "700px", overflow: "auto" }}>
      <AgentBehaviourTab />
    </div>
  )
}

const MOCK_COMMANDS: Record<string, CommandConfig> = {
  review: {
    template: "Review the changes in the current branch and provide feedback on code quality.",
    description: "Run a code review on the current branch",
  },
  deploy: {
    template: "Build and deploy the application to the staging environment.",
    description: "Deploy to staging",
  },
  test: {
    template: "Run the full test suite and report any failures.",
  },
}

export const AgentBehaviourWorkflows: Story = {
  name: "AgentBehaviourTab — workflows with commands",
  render: () => {
    const session = {
      ...mockSessionValue({ id: "workflows-story", status: "idle" }),
      agents: () => MOCK_AGENTS,
      allAgents: () => MOCK_AGENTS,
      removeAgent: noop,
      removeMcp: noop,
      skills: () => [],
      refreshSkills: noop,
      removeSkill: noop,
    }
    return (
      <StoryProviders sessionID="workflows-story" status="idle" config={{ command: MOCK_COMMANDS } as any}>
        <SessionContext.Provider value={session as any}>
          <SubtabWrapper tab="workflows" />
        </SessionContext.Provider>
      </StoryProviders>
    )
  },
}

export const AgentBehaviourWorkflowsEmpty: Story = {
  name: "AgentBehaviourTab — workflows empty state",
  render: () => {
    const session = {
      ...mockSessionValue({ id: "workflows-empty-story", status: "idle" }),
      agents: () => MOCK_AGENTS,
      allAgents: () => MOCK_AGENTS,
      removeAgent: noop,
      removeMcp: noop,
      skills: () => [],
      refreshSkills: noop,
      removeSkill: noop,
    }
    return (
      <StoryProviders sessionID="workflows-empty-story" status="idle">
        <SessionContext.Provider value={session as any}>
          <SubtabWrapper tab="workflows" />
        </SessionContext.Provider>
      </StoryProviders>
    )
  },
}

export const McpEditViewLocal: Story = {
  name: "McpEditView — local server (stdio)",
  render: () => (
    <StoryProviders
      config={
        {
          mcp: {
            filesystem: {
              type: "local",
              command: ["npx", "-y", "@modelcontextprotocol/server-filesystem", "/home/user"],
            },
          },
        } as any
      }
    >
      <div style={{ "max-height": "700px", overflow: "auto" }}>
        <McpEditView name="filesystem" onBack={noop} onRemove={noop} />
      </div>
    </StoryProviders>
  ),
}

export const McpEditViewLocalWithEnv: Story = {
  name: "McpEditView — local server with env vars",
  render: () => (
    <StoryProviders
      config={
        {
          mcp: {
            "my-mcp": {
              type: "local",
              command: ["node", "dist/index.js"],
              environment: { API_KEY: "sk-abc123", NODE_ENV: "production" },
            },
          },
        } as any
      }
    >
      <div style={{ "max-height": "700px", overflow: "auto" }}>
        <McpEditView name="my-mcp" onBack={noop} onRemove={noop} />
      </div>
    </StoryProviders>
  ),
}

export const McpEditViewRemote: Story = {
  name: "McpEditView — remote server (SSE)",
  render: () => (
    <StoryProviders
      config={
        {
          mcp: {
            "remote-mcp": {
              type: "remote",
              url: "https://mcp.example.com/sse",
            },
          },
        } as any
      }
    >
      <div style={{ "max-height": "700px", overflow: "auto" }}>
        <McpEditView name="remote-mcp" onBack={noop} onRemove={noop} />
      </div>
    </StoryProviders>
  ),
}

export const ModeEditExport: Story = {
  name: "ModeEditView — export button",
  render: () => {
    const cfg: Record<string, AgentConfig> = {
      reviewer: {
        description: "Review code for quality and best practices",
        prompt: "You are a code reviewer. Focus on code quality, best practices, and potential bugs.",
        model: "anthropic/claude-sonnet-4-20250514",
        temperature: 0.3,
      },
    }
    const session = {
      ...mockSessionValue({ id: "export-story", status: "idle" }),
      agents: () => MOCK_AGENTS,
      allAgents: () => MOCK_AGENTS,
      removeAgent: noop,
      removeMcp: noop,
      skills: () => [],
      refreshSkills: noop,
      removeSkill: noop,
    }
    return (
      <StoryProviders sessionID="export-story" status="idle" config={{ agent: cfg } as any}>
        <SessionContext.Provider value={session as any}>
          <div style={{ width: "420px", height: "700px", overflow: "auto" }}>
            <ModeEditView name="reviewer" onBack={noop} onRemove={noop} />
          </div>
        </SessionContext.Provider>
      </StoryProviders>
    )
  },
}

export const ModeEditPermissions: Story = {
  name: "ModeEditView — per-agent permissions",
  render: () => {
    const cfg: Record<string, AgentConfig> = {
      reviewer: {
        description: "Review code without editing it",
        prompt: "Find bugs, regressions, and missing tests.",
        permission: {
          "*": "deny",
          read: "allow",
          grep: "allow",
          glob: "allow",
          edit: { "*": "deny", "**/*.md": "allow" },
          bash: "deny",
          task: "ask",
          skill: "deny",
        },
      },
    }
    const session = {
      ...mockSessionValue({ id: "permissions-story", status: "idle" }),
      agents: () => MOCK_AGENTS,
      allAgents: () => MOCK_AGENTS,
      removeAgent: noop,
      removeMcp: noop,
      skills: () => [],
      refreshSkills: noop,
      removeSkill: noop,
    }
    return (
      <StoryProviders
        sessionID="permissions-story"
        status="idle"
        config={{ permission: { bash: "ask", external_directory: "ask" }, agent: cfg } as any}
      >
        <SessionContext.Provider value={session as any}>
          <div style={{ width: "460px", height: "760px", overflow: "auto" }}>
            <ModeEditView name="reviewer" onBack={noop} onRemove={noop} />
          </div>
        </SessionContext.Provider>
      </StoryProviders>
    )
  },
}


/** ProviderConnectDialog in manageApiKey mode: stored credential is never echoed; submit replaces via the secure host prompt. */
export const ProviderConnectManageApiKey: Story = {
  name: "ProviderConnectDialog — manage API key (secure replace)",
  render: () => {
    return (
      <StoryProviders
        connected={["openai"]}
        authStates={{ openai: "api" }}
        authMethods={{
          openai: [{ type: "api", label: "API Key" }],
        }}
      >
        <ProviderConnectManageApiKeyInner />
      </StoryProviders>
    )
  },
}

/** Inner component with access to useDialog — shows ProviderConnectDialog via dialog.show(). */
function ProviderConnectManageApiKeyInner() {
  const dialog = useDialog()
  onMount(() => {
    dialog.show(() => <ProviderConnectDialog providerID="openai" manageApiKey />)
  })
  return <div style={{ width: "512px", height: "600px" }} />
}

/* ── CustomProviderDialog stories ────────────────────────────────────────── */

function CustomProviderDialogInner() {
  const dialog = useDialog()
  onMount(() => {
    dialog.show(() => <CustomProviderDialog />)
  })
  return <div style={{ height: "700px" }} />
}

/** New custom provider dialog at wide container width — basic fields should pair in 2 columns. */
export const CustomProviderDialogWide1280: Story = {
  name: "CustomProviderDialog — wide (1280px)",
  render: () => (
    <StoryProviders>
      <div style={{ width: "1280px" }}>
        <CustomProviderDialogInner />
      </div>
    </StoryProviders>
  ),
  parameters: { viewport: { defaultViewport: "custom" } },
}

function CustomProviderDialogNarrowInner() {
  const dialog = useDialog()
  onMount(() => {
    dialog.show(() => <CustomProviderDialog />)
  })
  return <div style={{ height: "700px" }} />
}

/** New custom provider dialog at narrow width — basic fields should collapse to 1 column. */
export const CustomProviderDialogNarrow: Story = {
  name: "CustomProviderDialog — narrow (420px)",
  render: () => (
    <StoryProviders>
      <div style={{ width: "420px" }}>
        <CustomProviderDialogNarrowInner />
      </div>
    </StoryProviders>
  ),
  parameters: { viewport: { defaultViewport: "mobile1" } },
}

/** Edit existing custom provider — credential stays masked; untouched preserves, typing replaces. */
export const CustomProviderDialogEdit: Story = {
  name: "CustomProviderDialog — edit existing",
  render: () => {
    return (
      <StoryProviders
        connected={["custom-myapi"]}
        authStates={{ "custom-myapi": "api" }}
        config={
          {
            provider: {
              "custom-myapi": {
                name: "My API Provider",
                npm: "@ai-sdk/openai-compatible",
                options: { baseURL: "https://api.example.com/v1" },
              },
            },
          } as any
        }
      >
        <div style={{ width: "960px" }}>
          <CustomProviderDialogEditInner />
        </div>
      </StoryProviders>
    )
  },
  parameters: { viewport: { defaultViewport: "custom" } },
}

function CustomProviderDialogEditInner() {
  const dialog = useDialog()
  onMount(() => {
    dialog.show(() => (
      <CustomProviderDialog
        existing={{
          providerID: "custom-myapi",
          name: "My API Provider",
          config: {
            npm: "@ai-sdk/openai-compatible",
            options: { baseURL: "https://api.example.com/v1" },
          },
        }}
      />
    ))
  })
  return <div style={{ height: "700px" }} />
}

/**
 * Canonical custom-agent mutation scenarios (no Playwright code — the
 * visual-regression runner auto-discovers these stories).
 *
 * A file-backed custom agent (scope + assetHash + retained frontmatter/body)
 * keeps every edit control enabled in canonical mode; writes serialize
 * through the session coordinator (mutateAgent/scheduleAgentEdit mocks
 * below stand in for the extension host).
 */
const CANONICAL_CUSTOM_AGENT = {
  name: "reviewer",
  displayName: "Reviewer",
  description: "Review code for quality and best practices",
  mode: "primary" as const,
  native: false,
  scope: "project" as const,
  assetHash: "story-asset-hash-001",
  frontmatter: {
    name: "reviewer",
    mode: "primary",
    description: "Review code for quality and best practices",
    model: "kilo/anthropic/claude-sonnet-4-6",
  },
  body: "You are a code reviewer. Focus on code quality, best practices, and potential bugs.",
  stamp: {
    globalHash: null,
    projectHash: "story-project-hash-001",
    materializationVersion: 3,
    assetHash: "story-asset-hash-001",
  },
}

function canonicalAgentSession(sessionID: string, extra?: Record<string, unknown>) {
  const posted: unknown[] = []
  const applied = (input: { action: string; name: string }) =>
    Promise.resolve({
      ok: true as const,
      requestId: "story-req-1",
      name: input.name,
      action: input.action,
      contentHash: "story-asset-hash-002",
    })
  return {
    posted,
    value: {
      ...mockSessionValue({ id: sessionID, status: "idle" }),
      agents: () => [CANONICAL_CUSTOM_AGENT],
      allAgents: () => [CANONICAL_CUSTOM_AGENT],
      agentDiagnostic: () => null,
      isAgentPending: () => false,
      mutateAgent: (input: { action: string; name: string }) => {
        posted.push({ ...input, canonical: true })
        return applied(input)
      },
      scheduleAgentEdit: (name: string, patch: unknown) => {
        posted.push({ action: "edit", name, patch, canonical: true })
        return applied({ action: "edit", name })
      },
      flushAgentEdits: noop,
      cancelAgentMutations: noop,
      removeAgent: noop,
      removeMcp: noop,
      skills: () => [],
      refreshSkills: noop,
      removeSkill: noop,
      ...extra,
    },
  }
}

export const AgentBehaviourCanonicalCustomAgentEdit: Story = {
  name: "AgentBehaviourTab — canonical custom agent edit available",
  render: () => {
    const session = canonicalAgentSession("canonical-agent-edit-story")
    return (
      <StoryProviders sessionID="canonical-agent-edit-story" status="idle" canonical>
        <SessionContext.Provider value={session.value as any}>
          <div style={{ "max-height": "700px", overflow: "auto" }}>
            <ModeEditView name="reviewer" onBack={noop} onRemove={noop} />
          </div>
        </SessionContext.Provider>
      </StoryProviders>
    )
  },
}

export const AgentBehaviourCanonicalCustomAgentError: Story = {
  name: "AgentBehaviourTab — canonical custom agent mutation error",
  render: () => {
    const session = canonicalAgentSession("canonical-agent-error-story", {
      agentDiagnostic: () => 'Agent "reviewer" draft is stale [stale]',
    })
    return (
      <StoryProviders sessionID="canonical-agent-error-story" status="idle" canonical>
        <SessionContext.Provider value={session.value as any}>
          <div style={{ "max-height": "700px", overflow: "auto" }}>
            <AgentBehaviourTab />
          </div>
        </SessionContext.Provider>
      </StoryProviders>
    )
  },
}

/**
 * Custom-only product boundary: one canonical custom provider configured.
 * Renders the custom configured row (name/Custom tag/edit/delete/switch),
 * the custom Configure entry, and the custom-only unavailable notice, with
 * no built-in provider rows, OAuth, ChatGPT/API-key manage, or Anaconda
 * entries (built-in add rows are dormant in helpers and not rendered).
 */
export const ProvidersCustomOnly: Story = {
  name: "ProvidersTab — custom-only boundary",
  render: () => (
    <StoryProviders
      canonical
      connected={["custom-acme"]}
      authStates={{ "custom-acme": "api" }}
      config={
        {
          provider: {
            "custom-acme": {
              name: "Acme Custom",
              endpoint: "https://api.acme.example/v1",
              protocol: "openai/completions",
            },
          },
        } as any
      }
    >
      <div style={{ "max-height": "700px", overflow: "auto" }}>
        <ProvidersTab />
      </div>
    </StoryProviders>
  ),
}

export const AutoApproveLevelReview: Story = {
  name: "AutoApproveTab — Review level",
  render: () => (
    <StoryProviders
      config={{ permission_level: "review", permission: REVIEW_PERMISSION_PRESET } as any}
      globalConfig={{ permission_level: "review", permission: REVIEW_PERMISSION_PRESET } as any}
    >
      <div style={{ "max-height": "700px", overflow: "auto" }}>
        <AutoApproveTab />
      </div>
    </StoryProviders>
  ),
}

export const AutoApproveLevelAutonomous: Story = {
  name: "AutoApproveTab — Autonomous level",
  render: () => (
    <StoryProviders
      config={{ permission_level: "autonomous", permission: AUTONOMOUS_PERMISSION_PRESET } as any}
      globalConfig={{ permission_level: "autonomous", permission: AUTONOMOUS_PERMISSION_PRESET } as any}
    >
      <div style={{ "max-height": "700px", overflow: "auto" }}>
        <AutoApproveTab />
      </div>
    </StoryProviders>
  ),
}

export const AutoApproveLevelCustom: Story = {
  name: "AutoApproveTab — Custom level",
  render: () => (
    <StoryProviders
      config={{ permission: { "*": "ask", edit: "allow" } } as any}
      globalConfig={{ permission: { "*": "ask", edit: "allow" } } as any}
    >
      <div style={{ "max-height": "700px", overflow: "auto" }}>
        <AutoApproveTab />
      </div>
    </StoryProviders>
  ),
}

export const AutoApproveLevelReview420: Story = {
  name: "AutoApproveTab — Review level 420px",
  render: () => (
    <StoryProviders
      config={{ permission_level: "review", permission: REVIEW_PERMISSION_PRESET } as any}
      globalConfig={{ permission_level: "review", permission: REVIEW_PERMISSION_PRESET } as any}
    >
      <div style={{ width: "420px", "max-height": "700px", overflow: "auto" }}>
        <AutoApproveTab />
      </div>
    </StoryProviders>
  ),
}

export const AutoApproveLevelCustom200: Story = {
  name: "AutoApproveTab — Custom level 200px",
  render: () => (
    <StoryProviders
      config={{ permission: { "*": "ask", edit: "allow" } } as any}
      globalConfig={{ permission: { "*": "ask", edit: "allow" } } as any}
    >
      <div style={{ width: "200px", "max-height": "700px", overflow: "auto" }}>
        <AutoApproveTab />
      </div>
    </StoryProviders>
  ),
}
