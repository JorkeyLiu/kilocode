import { describe, expect, test } from "bun:test"
import { resolveOrganizationId } from "@/kilocode/session-export/org-auth"

// LOCK-004/014: session export org eligibility reads the Kilo provider's
// org id from the canonical config shape `provider.kilo.options.kilocodeOrganizationId`.
// The mis-shaped reads (`provider.kilo.organizationId`, `provider.options.*`) must
// produce no org id, and oauth/env fallbacks stay intact.
describe("resolveOrganizationId", () => {
  test("reads provider.kilo.options.kilocodeOrganizationId first", () => {
    const id = resolveOrganizationId({
      config: {
        provider: {
          kilo: {
            options: { kilocodeOrganizationId: "org_config" },
          },
        },
      },
      auth: { type: "oauth", accountId: "org_oauth" },
      env: { KILO_ORG_ID: "org_env" },
    })
    expect(id).toBe("org_config")
  })

  test("falls back to oauth account id when the config path is absent", () => {
    const id = resolveOrganizationId({
      config: { provider: { kilo: { options: {} } } },
      auth: { type: "oauth", accountId: "org_oauth" },
      env: { KILO_ORG_ID: "org_env" },
    })
    expect(id).toBe("org_oauth")
  })

  test("falls back to KILO_ORG_ID when config and oauth are absent", () => {
    const id = resolveOrganizationId({
      config: { provider: { kilo: { options: {} } } },
      auth: undefined,
      env: { KILO_ORG_ID: "org_env" },
    })
    expect(id).toBe("org_env")
  })

  test("ignores mis-shaped provider reads (no org derived)", () => {
    expect(
      resolveOrganizationId({
        config: {
          provider: {
            kilo: { organizationId: "mis-1" },
            options: { kilocodeOrganizationId: "mis-2" },
          },
        },
      }),
    ).toBeUndefined()
  })

  test("uses process.env by default when no env is supplied", () => {
    const previous = process.env.KILO_ORG_ID
    try {
      process.env.KILO_ORG_ID = "org_process"
      expect(resolveOrganizationId({ config: { provider: { kilo: { options: {} } } } })).toBe("org_process")
    } finally {
      if (previous === undefined) delete process.env.KILO_ORG_ID
      else process.env.KILO_ORG_ID = previous
    }
  })
})