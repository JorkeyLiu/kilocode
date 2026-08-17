import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { makeRuntime } from "@/effect/run-service"

export type OrgState = { type: "personal" } | { type: "org"; id: string } | { type: "unknown" }
export type OrgSource = () => Promise<OrgState>

const config = makeRuntime(Config.Service, Config.defaultLayer)
const auth = makeRuntime(Auth.Service, Auth.defaultLayer)

type Env = {
  KILO_API_KEY?: string
  KILO_ORG_ID?: string
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return
  const trimmed = value.trim()
  return trimmed || undefined
}

function org(auth: unknown): string | undefined {
  const data = record(auth)
  if (data.type === "oauth") return text(data.accountId)
  return
}

export function resolveOrganizationId(input: { config?: unknown; auth?: unknown; env?: Env }): string | undefined {
  const cfg = record(input.config)
  const kilo = record(record(cfg.provider).kilo)
  const options = record(kilo.options)
  const env = input.env ?? process.env
  return (
    // Config shape: provider.kilo.options.kilocodeOrganizationId
    text(options.kilocodeOrganizationId) ??
    org(input.auth) ??
    text(env.KILO_ORG_ID)
  )
}

export async function getAuthOrgId(): Promise<OrgState> {
  try {
    const [cfg, info] = await Promise.all([
      config.runPromise((svc) => svc.get()),
      auth.runPromise((svc) => svc.get("kilo")),
    ])
    const id = resolveOrganizationId({ config: cfg, auth: info })
    if (id) return { type: "org", id }
    return { type: "personal" }
  } catch (err) {
    console.warn("[session-export] org lookup failed", err)
    return { type: "unknown" }
  }
}
