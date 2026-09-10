import type { SecretAdapter } from "./secret-adapter"
import { removeCredentialRef, restoreCredentialRef } from "./secret-adapter"
import type { ValidationError } from "./types"

/** Restore a credential to its prior value, or delete if no prior. Uses the exact validated ref. */
export async function restoreCredentialState(
  secrets: SecretAdapter,
  ref: string,
  priorValue: string | undefined,
): Promise<void> {
  if (priorValue !== undefined) {
    await restoreCredentialRef(secrets, ref, priorValue)
  } else {
    await removeCredentialRef(secrets, ref)
  }
}

export async function rollbackCredential(
  secrets: SecretAdapter,
  disposed: boolean,
  ref: string,
  priorValue: string | undefined,
): Promise<{ ok: false; kind: "disposed" | "io"; message: string } | null> {
  try {
    await restoreCredentialState(secrets, ref, priorValue)
    return null
  } catch (err) {
    console.error(`[Kilo Config] Credential rollback failed for ${ref}: ${String(err)}`)
    return { ok: false, kind: disposed ? "disposed" : "io", message: `Credential rollback failed: ${String(err)}` }
  }
}

export function normalizeCredentialFailure(
  result: { kind: string; message: string; errors?: readonly ValidationError[] } & { ok: false },
): { ok: false; kind: "stale" | "invalid" | "disposed" | "io"; message: string; errors?: readonly ValidationError[] } {
  if (result.kind === "conflict") {
    return { ...result, kind: "invalid" }
  }
  return { ok: false, kind: result.kind as "stale" | "invalid" | "disposed" | "io", message: result.message, errors: result.errors }
}
