const TrustedAgentBrand = Symbol("TrustedAgentBrand")
export type TrustedAgentContext = { readonly __trustedAgentBrand: true; readonly agent: string } & { readonly [TrustedAgentBrand]?: true }
export function isTrustedAgentContext(v: unknown): v is TrustedAgentContext {
  return typeof v === "object" && v !== null && TrustedAgentBrand in (v as object) && (v as any)[TrustedAgentBrand] === true && typeof (v as any).agent === "string" && (v as any).agent.length > 0
}
let promptCap: symbol | undefined
export function setPromptCapability(cap: symbol): void {
  if (!promptCap) promptCap = cap
}
export function getTrustedBrand(cap: symbol): symbol | undefined {
  if (cap !== promptCap) return undefined
  return TrustedAgentBrand
}
export function __testCreateTrustedAgentContext(agent: string): TrustedAgentContext {
  return { [TrustedAgentBrand]: true, __trustedAgentBrand: true, agent } as unknown as TrustedAgentContext
}
