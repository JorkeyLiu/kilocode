/**
 * Private runtime ownership token.
 *
 * One cryptographically unique value per `kilo-serve serve` instance, minted
 * by the extension (`ServerManager`) and inherited through `process.env` by
 * every runtime-dependent child (shell, Effect spawner, node-pty/bun-pty,
 * LSP, MCP, custom env paths). Crash cleanup enumerates exactly this token;
 * explicit `persistent` BackgroundProcess runners strip it so an instance
 * crash never reaps independently owned persistent work.
 *
 * Pure helpers only: no Effect service, no Promise facade, no process.env
 * mutation. Callers pass env records explicitly.
 */
export const RUNTIME_TOKEN_ENV = "KILO_RUNTIME_TOKEN" as const

const TOKEN_RE = /^[0-9a-f]{64}$/

export function isValidRuntimeToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN_RE.test(value)
}

export function readRuntimeToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env[RUNTIME_TOKEN_ENV]
  return isValidRuntimeToken(value) ? value : undefined
}

/**
 * Remove the instance token from an env record (persistent exclusion).
 * Returns a shallow copy; the input is never mutated. Non-token keys,
 * including the per-process `KILO_BACKGROUND_PROCESS_TOKEN` oracle, are
 * preserved verbatim.
 */
export function stripRuntimeToken<T extends NodeJS.ProcessEnv | Record<string, string | undefined>>(
  env: T,
): T {
  if (!(RUNTIME_TOKEN_ENV in env)) return env
  const out = { ...env }
  delete (out as Record<string, unknown>)[RUNTIME_TOKEN_ENV]
  return out
}

/**
 * Re-assert the live instance token after a custom env spread so a custom
 * `env`/`environment` record can neither strip nor spoof ownership. When the
 * source carries no valid token the candidate is returned unchanged (never
 * inject a token the runtime does not hold).
 */
export function assertRuntimeToken<T extends NodeJS.ProcessEnv | Record<string, string | undefined>>(
  candidate: T,
  source: NodeJS.ProcessEnv = process.env,
): T {
  const live = readRuntimeToken(source)
  if (!live) return candidate
  if ((candidate as Record<string, unknown>)[RUNTIME_TOKEN_ENV] === live) return candidate
  return { ...candidate, [RUNTIME_TOKEN_ENV]: live } as T
}
