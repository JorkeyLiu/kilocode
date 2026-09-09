import { createSignal } from "solid-js"
import type { AgentConfig } from "../../types/messages"

/**
 * Local draft state for a single custom-agent edit view.
 *
 * Pure Solid signals, no JSX and no effects of its own: the owning view
 * drives `sync` explicitly (agent switch / server hash advance) and reads
 * `shown` for display. This keeps every rule below unit-testable without a
 * DOM harness:
 *
 * - Identity isolation: a name change ALWAYS resets local state, even when
 *   the assetHash is identical, so agent A state never leaks into agent B.
 *   The caller flushes the previous agent BEFORE syncing the next one.
 * - Same-name server advances reset only while idle; while a mutation is
 *   pending, local state is retained until the server confirms.
 * - Numeric fields keep their raw text locally. Only a fully matching
 *   literal commits (empty string clears per existing clear semantics);
 *   intermediate/invalid input stays local-only and is never persisted.
 */

export type AgentNumericKey = "temperature" | "top_p" | "steps"

const FLOAT_RE = /^[+-]?(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?$/
const INT_RE = /^[+-]?\d+$/

export function parseAgentFloat(raw: string): number | undefined {
  const text = raw.trim()
  if (!FLOAT_RE.test(text)) return undefined
  const parsed = Number(text)
  return Number.isFinite(parsed) ? parsed : undefined
}

export function parseAgentSteps(raw: string): number | undefined {
  const text = raw.trim()
  if (!INT_RE.test(text)) return undefined
  const parsed = Number(text)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

export interface AgentDraftSnapshot {
  name: string
  hash: string | null
  server: AgentConfig
}

export interface AgentDraftPatch {
  frontmatter?: Record<string, unknown>
  body?: string
}

function textsOf(server: AgentConfig): Record<AgentNumericKey, string> {
  return {
    temperature: server.temperature?.toString() ?? "",
    top_p: server.top_p?.toString() ?? "",
    steps: server.steps?.toString() ?? "",
  }
}

export function createAgentDraft(commit: (name: string, patch: AgentDraftPatch) => void) {
  const [name, setName] = createSignal("")
  const [hash, setHash] = createSignal<string | null>(null)
  const [overrides, setOverrides] = createSignal<Partial<AgentConfig>>({})
  const [texts, setTexts] = createSignal<Record<AgentNumericKey, string>>({
    temperature: "",
    top_p: "",
    steps: "",
  })

  const sync = (snap: AgentDraftSnapshot, pending: boolean): void => {
    if (snap.name !== name() || (snap.hash !== hash() && !pending)) {
      setName(snap.name)
      setHash(snap.hash)
      setOverrides({})
      setTexts(textsOf(snap.server))
    }
  }

  const shown = (server: AgentConfig): AgentConfig => ({ ...server, ...overrides() })
  const text = (key: AgentNumericKey): string => texts()[key]
  const currentName = (): string => name()

  const send = (patch: AgentDraftPatch): void => {
    const target = name()
    if (!target) return
    commit(target, patch)
  }

  /** Generic delta (switches, model/variant selectors, permission). */
  const set = (values: Partial<AgentConfig>): void => {
    setOverrides((prev) => ({ ...prev, ...values }))
    const frontmatter = { ...values } as Record<string, unknown>
    delete frontmatter.prompt
    send(typeof values.prompt === "string" ? { frontmatter, body: values.prompt } : { frontmatter })
  }

  const setText = (key: "description" | "prompt", val: string): void => {
    if (key === "prompt") {
      setOverrides((prev) => ({ ...prev, prompt: val }))
      send({ frontmatter: {}, body: val })
      return
    }
    const value = val || undefined
    setOverrides((prev) => ({ ...prev, description: value }))
    send({ frontmatter: { description: value } })
  }

  const setNumeric = (key: AgentNumericKey, raw: string): void => {
    setTexts((prev) => ({ ...prev, [key]: raw }))
    if (raw.trim() === "") {
      setOverrides((prev) => ({ ...prev, [key]: undefined }))
      send({ frontmatter: { [key]: undefined } })
      return
    }
    const parsed = key === "steps" ? parseAgentSteps(raw) : parseAgentFloat(raw)
    if (parsed === undefined) return
    setOverrides((prev) => ({ ...prev, [key]: parsed }))
    send({ frontmatter: { [key]: parsed } })
  }

  return { sync, shown, text, currentName, set, setText, setNumeric }
}

export type AgentDraft = ReturnType<typeof createAgentDraft>
