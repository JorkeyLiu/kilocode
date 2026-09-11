import type { ToolCallPart } from "@opencode-ai/llm"
import type { LanguageModelV3ToolCall } from "@ai-sdk/provider"

export function repair(name: string, input: unknown, tools: Record<string, unknown>): { name: string; input: unknown } {
  if (tools[name] !== undefined) return { name, input }
  const lower = name.trim().toLowerCase()
  if (lower !== name && tools[lower] !== undefined) return { name: lower, input }
  const available = Object.keys(tools).filter((k) => k !== "invalid")
  const error =
    available.length === 0
      ? `Model tried to call unavailable tool '${name}'. No tools are available.`
      : `Model tried to call unavailable tool '${name}'. Available tools: ${available.join(", ")}.`
  return { name: "invalid", input: JSON.stringify({ tool: name, error }) }
}

export function repaired(event: ToolCallPart, tools: Record<string, unknown>): ToolCallPart {
  const fixed = repair(event.name, event.input, tools)
  if (fixed.name === event.name && fixed.input === event.input) return { ...event }
  const input = fixed.name === "invalid" && typeof fixed.input === "string" ? JSON.parse(fixed.input) : fixed.input
  return { ...event, name: fixed.name, input }
}

export function repairToolCall(
  failed: { readonly toolCall: LanguageModelV3ToolCall; readonly error: { readonly message: string } },
  tools: Record<string, unknown>,
): LanguageModelV3ToolCall {
  const original = failed.toolCall.toolName
  const fixed = repair(original, failed.toolCall.input, tools)
  if (fixed.name !== "invalid" && fixed.name !== original) return { ...failed.toolCall, toolName: fixed.name }
  return {
    ...failed.toolCall,
    input: JSON.stringify({ tool: original, error: failed.error.message }),
    toolName: "invalid",
  }
}
