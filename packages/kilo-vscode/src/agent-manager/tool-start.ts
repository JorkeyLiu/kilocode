import type { KiloClient, Session } from "@kilocode/sdk/v2/client"
import { PLATFORM, SNAPSHOT_INITIALIZATION } from "./constants"

const LABEL_MAX = 28

export interface ToolTask {
  prompt?: string
  name?: string
  model?: { providerID: string; modelID: string }
  variant?: string
}

export interface ToolRequest {
  requestID: string
  sessionID?: string
  directory?: string
  sandboxInheritanceToken?: string
  tasks: ToolTask[]
}

export interface ToolSource {
  sandboxInheritanceToken?: string
}

export interface ToolDeps {
  getClient: () => KiloClient
  getRoot: () => string | undefined
  getPanel: () => { sessions: { registerSession(session: Session): void } } | undefined
  openPanel: (preserveFocus?: boolean) => void
  waitReady: (context: string) => Promise<void>
  claimRequest?: (requestID: string) => boolean
  createLocalSession: (task: ToolTask, source?: ToolSource) => Promise<boolean>
  push: () => void
  post: (msg: unknown) => void
  capture: (event: string, props?: Record<string, unknown>) => void
  log: (...args: unknown[]) => void
  error: (msg: string) => void
}

export async function startFromTool(deps: ToolDeps, req: ToolRequest): Promise<void> {
  if (deps.claimRequest && !deps.claimRequest(req.requestID)) {
    deps.log(`Agent Manager tool skipped duplicate request ${req.requestID}`)
    return
  }

  deps.openPanel(true)
  await deps.waitReady("startFromTool")
  const total = req.tasks.length
  const state = { ok: 0 }
  const source = { sandboxInheritanceToken: req.sandboxInheritanceToken }

  for (let i = 0; i < req.tasks.length; i++) {
    const task = req.tasks[i]!
    try {
      const done = await deps.createLocalSession(task, source)
      if (done) state.ok++
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      deps.log("Agent Manager tool task failed", msg)
      deps.post({ type: "error", message: `Agent Manager tool task failed: ${msg}` })
    }
  }

  if (state.ok === 0) deps.error(`Failed to start any Agent Manager sessions for request ${req.requestID}.`)
  deps.log(`Agent Manager tool request ${req.requestID} complete: ${state.ok}/${total}`)
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object"
}

function model(value: unknown): ToolTask["model"] {
  if (!record(value)) return undefined
  const providerID = typeof value.providerID === "string" ? value.providerID.trim() : ""
  const modelID = typeof value.modelID === "string" ? value.modelID.trim() : ""
  if (!providerID || !modelID) return undefined
  return { providerID, modelID }
}

function task(value: unknown): ToolTask | undefined {
  if (!record(value)) return undefined
  const out: ToolTask = {}
  for (const key of ["prompt", "name"] as const) {
    if (Object.hasOwn(value, key) && typeof value[key] === "string" && value[key].trim()) out[key] = value[key]
  }
  const hasModel = Object.hasOwn(value, "model")
  const selected = hasModel ? model(value.model) : undefined
  if (hasModel && !selected) return undefined
  if (selected) out.model = selected

  if (Object.hasOwn(value, "variant")) {
    if (!selected || typeof value.variant !== "string" || !value.variant.trim()) return undefined
    out.variant = value.variant.trim()
  }
  if (selected && !out.prompt) return undefined
  if (!out.prompt && !out.name) return undefined
  return out
}

export function parseToolRequest(value: unknown): ToolRequest | undefined {
  if (!record(value)) return undefined
  const tasks = value.tasks
  if (!Array.isArray(tasks) || tasks.length === 0) return undefined
  const limited = tasks.slice(0, 20)
  const parsed = limited.map(task).filter((item): item is ToolTask => !!item)
  if (parsed.length !== limited.length) return undefined
  return {
    requestID: typeof value.requestID === "string" ? value.requestID : `am-${Date.now()}`,
    sessionID: typeof value.sessionID === "string" ? value.sessionID : undefined,
    directory: typeof value.directory === "string" ? value.directory : undefined,
    sandboxInheritanceToken:
      typeof value.sandboxInheritanceToken === "string" ? value.sandboxInheritanceToken : undefined,
    tasks: parsed,
  }
}
