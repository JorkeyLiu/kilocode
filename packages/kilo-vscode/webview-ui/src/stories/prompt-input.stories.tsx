/** @jsxImportSource solid-js */
/**
 * Stories for the PromptInput component.
 *
 * Covers the main prompt bar including the mode switcher, model dropdown,
 * and the thinking-effort (variant) dropdown that appears for models that
 * support reasoning variants.
 *
 * Two viewport widths are captured for each scenario:
 *   - 420 px  — typical sidebar width
 *   - 200 px  — narrow / collapsed sidebar
 */

import type { Meta, StoryObj } from "storybook-solidjs-vite"
import { type ParentComponent } from "solid-js"
import { StoryProviders, mockSessionValue } from "./StoryProviders"
import { SessionContext } from "../context/session"
import { WorkStyleContext } from "../context/work-style"
import { PromptInput } from "../components/chat/PromptInput"
import { SandboxTooltipContent } from "../components/shared/SandboxButton"
import { Button } from "@kilocode/kilo-ui/button"
import { Icon } from "@kilocode/kilo-ui/icon"
import { Tooltip } from "@kilocode/kilo-ui/tooltip"

const agents = [
  { name: "code", description: "Write, edit and review code", mode: "primary" as const },
  { name: "ask", description: "Answer questions without making changes", mode: "primary" as const },
  { name: "architect", description: "Plan and design before implementation", mode: "primary" as const },
]

const noop = () => {}

const PromptProviders: ParentComponent<{
  variants?: boolean
  modelOverride?: boolean
  level?: "review" | "autonomous" | "custom" | "unset"
}> = (props) => {
  const base = mockSessionValue({ status: "idle" })
  const session = {
    ...base,
    agents: () => agents,
    selectedAgent: () => "code",
    variantList: () => (props.variants ? ["low", "medium", "high"] : []),
    currentVariant: () => (props.variants ? ("medium" as string | undefined) : undefined),
    hasModelOverride: () => props.modelOverride ?? false,
    clearModelOverride: noop,
  }
  const level = () => props.level ?? "review"
  const work = {
    style: () => "unset" as const,
    level,
    loading: () => false,
    applying: () => false,
    shouldShowOnboarding: () => false,
    apply: noop,
  }

  return (
    <StoryProviders noPadding>
      {/* overflow:hidden prevents margin-collapse so top/bottom borders are captured in screenshots */}
      <div style={{ overflow: "hidden" }}>
        <SessionContext.Provider value={session as any}>
          <WorkStyleContext.Provider value={work as any}>{props.children}</WorkStyleContext.Provider>
        </SessionContext.Provider>
      </div>
    </StoryProviders>
  )
}

// Child-session scenario: the resolved agent is a delegated subagent that is NOT in
// the visible agent list, so the mode switcher renders fixed/disabled.
const FixedSubagentProviders: ParentComponent = (props) => {
  const base = mockSessionValue({ status: "idle" })
  const session = {
    ...base,
    agents: () => agents,
    allAgents: () => [
      ...agents,
      { name: "delegate-writer", displayName: "Delegate Writer", mode: "subagent" as const },
    ],
    selectedAgent: () => "delegate-writer",
    variantList: () => [],
    currentVariant: () => undefined,
    hasModelOverride: () => false,
    clearModelOverride: noop,
  }
  const work = {
    style: () => "unset" as const,
    level: () => "review" as const,
    loading: () => false,
    applying: () => false,
    shouldShowOnboarding: () => false,
    apply: noop,
  }

  return (
    <StoryProviders noPadding>
      <div style={{ overflow: "hidden" }}>
        <SessionContext.Provider value={session as any}>
          <WorkStyleContext.Provider value={work as any}>{props.children}</WorkStyleContext.Provider>
        </SessionContext.Provider>
      </div>
    </StoryProviders>
  )
}

// ---------------------------------------------------------------------------
// Meta — fullscreen so the screenshot is exactly the component width
// ---------------------------------------------------------------------------

const meta: Meta = {
  title: "Prompt Input",
  parameters: { layout: "fullscreen" },
}
export default meta
type Story = StoryObj

// ---------------------------------------------------------------------------
// Stories — standard model (no thinking variants)
// ---------------------------------------------------------------------------

export const Default420: Story = {
  name: "Default — 420px",
  render: () => (
    <PromptProviders>
      <PromptInput />
    </PromptProviders>
  ),
}

export const Default200: Story = {
  name: "Default — 200px",
  render: () => (
    <PromptProviders>
      <PromptInput />
    </PromptProviders>
  ),
}

export const SandboxTooltipEnabled: Story = {
  name: "Sandbox tooltip — enabled",
  render: () => (
    <StoryProviders>
      <div style={{ padding: "120px 0 0 180px" }}>
        <Tooltip
          forceOpen
          value={<SandboxTooltipContent enabled network />}
          contentClass="prompt-sandbox-tooltip-content"
          placement="top"
        >
          <Button variant="ghost" size="small" class="prompt-status-button prompt-status-button--active">
            <Icon name="lock" size="small" />
          </Button>
        </Tooltip>
      </div>
    </StoryProviders>
  ),
}

export const SandboxTooltipDisabled: Story = {
  name: "Sandbox tooltip — disabled",
  render: () => (
    <StoryProviders>
      <div style={{ padding: "120px 0 0 180px" }}>
        <Tooltip
          forceOpen
          value={<SandboxTooltipContent enabled={false} network />}
          contentClass="prompt-sandbox-tooltip-content"
          placement="top"
        >
          <Button variant="ghost" size="small" class="prompt-status-button">
            <Icon name="lock" size="small" />
          </Button>
        </Tooltip>
      </div>
    </StoryProviders>
  ),
}

// ---------------------------------------------------------------------------
// Stories — model with thinking-effort variants (ThinkingSelector visible)
// ---------------------------------------------------------------------------

export const WithThinking420: Story = {
  name: "With thinking selector — 420px",
  render: () => (
    <PromptProviders variants>
      <PromptInput />
    </PromptProviders>
  ),
}

export const WithThinking200: Story = {
  name: "With thinking selector — 200px",
  render: () => (
    <PromptProviders variants>
      <PromptInput />
    </PromptProviders>
  ),
}

// ---------------------------------------------------------------------------
// Stories — model override active (reset button visible)
// ---------------------------------------------------------------------------

export const WithModelOverride420: Story = {
  name: "With model override — 420px",
  render: () => (
    <PromptProviders modelOverride>
      <PromptInput />
    </PromptProviders>
  ),
}

export const WithModelOverride200: Story = {
  name: "With model override — 200px",
  render: () => (
    <PromptProviders modelOverride>
      <PromptInput />
    </PromptProviders>
  ),
}

// ---------------------------------------------------------------------------
// Stories — fixed delegated subagent (child session): mode switcher disabled
// ---------------------------------------------------------------------------

export const FixedSubagent420: Story = {
  name: "Fixed subagent — 420px",
  render: () => (
    <FixedSubagentProviders>
      <PromptInput />
    </FixedSubagentProviders>
  ),
}

export const FixedSubagent200: Story = {
  name: "Fixed subagent — 200px",
  render: () => (
    <FixedSubagentProviders>
      <PromptInput />
    </FixedSubagentProviders>
  ),
}

// ---------------------------------------------------------------------------
// Stories — permission level chip (read-only, opens settings)
// ---------------------------------------------------------------------------

export const PermissionAutonomous420: Story = {
  name: "Permission Autonomous — 420px",
  render: () => (
    <PromptProviders level="autonomous">
      <PromptInput />
    </PromptProviders>
  ),
}

export const PermissionCustom420: Story = {
  name: "Permission Custom — 420px",
  render: () => (
    <PromptProviders level="custom">
      <PromptInput />
    </PromptProviders>
  ),
}

export const PermissionCustom200: Story = {
  name: "Permission Custom — 200px",
  render: () => (
    <PromptProviders level="custom">
      <PromptInput />
    </PromptProviders>
  ),
}
