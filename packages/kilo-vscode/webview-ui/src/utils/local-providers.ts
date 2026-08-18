export const ATOMIC_CHAT_PROVIDER_KEY = "atomic-chat"

/** Local OpenAI-compatible providers where the API key is not required (localhost). */
export const LOCAL_PROVIDER_OPTIONAL_API_KEY = new Set([ATOMIC_CHAT_PROVIDER_KEY, "lmstudio"])

export function isLocalProviderOptionalApiKey(providerID: string): boolean {
  return LOCAL_PROVIDER_OPTIONAL_API_KEY.has(providerID)
}
