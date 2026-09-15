import { describe, expect, test } from "bun:test"
import { Cause, Effect, Option } from "effect"
import { NamedError } from "@opencode-ai/core/util/error"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import type { Provider } from "../../src/provider/provider"
import { KiloSessionFallback } from "../../src/kilocode/session/fallback"
import { MessageV2 } from "../../src/session/message-v2"
import { fromRow, toRow } from "../../src/session/session"
import type { Err } from "../../src/session/retry"

const pid = (s: string) => ProviderV2.ID.make(s)
const mid = (s: string) => ModelV2.ID.make(s)

function apiError(input: { message: string; statusCode?: number; isRetryable: boolean; responseBody?: string }): Err {
  return new MessageV2.APIError({
    message: input.message,
    ...(input.statusCode !== undefined ? { statusCode: input.statusCode } : {}),
    isRetryable: input.isRetryable,
    ...(input.responseBody !== undefined ? { responseBody: input.responseBody } : {}),
  }).toObject()
}

function msg(
  id: string,
  info: { role: string; providerID?: string; finish?: string; error?: unknown },
): KiloSessionFallback.PriorMsg {
  return { info: { id, ...info } }
}

function model(providerID: string, id: string): Provider.Model {
  return { providerID: pid(providerID), id: mid(id) } as Provider.Model
}

describe("fallback selection parsing", () => {
  test("parses provider/model", () => {
    expect(KiloSessionFallback.parse("custom/openai-gpt")).toEqual({ providerID: "custom", modelID: "openai-gpt" })
  })
  test("trims whitespace", () => {
    expect(KiloSessionFallback.parse("  custom/model  ")).toEqual({ providerID: "custom", modelID: "model" })
  })
  test("rejects malformed values", () => {
    for (const bad of [undefined, null, "", "n slash", "/model", "provider/", "pro vider/model", "a".repeat(300)]) {
      expect(KiloSessionFallback.parse(bad)).toBeUndefined()
    }
  })
  test("active reads fallback_model only", () => {
    expect(KiloSessionFallback.active({ fallback_model: "custom/m" })).toEqual({
      providerID: "custom",
      modelID: "m",
    })
    expect(KiloSessionFallback.active({})).toBeUndefined()
    expect(KiloSessionFallback.active({ fallback_model: null })).toBeUndefined()
    expect(KiloSessionFallback.active({ fallback_model: "bad" })).toBeUndefined()
  })
  test("kilo gate", () => {
    expect(KiloSessionFallback.kilo("kilo")).toBe(true)
    expect(KiloSessionFallback.kilo("custom")).toBe(false)
    expect(KiloSessionFallback.kilo("openai")).toBe(false)
  })
})

describe("ordinary rate-limit classification", () => {
  test("accepts retryable 429", () => {
    expect(
      KiloSessionFallback.ordinary(apiError({ message: "Too Many Requests", statusCode: 429, isRetryable: true })),
    ).toBe(true)
  })
  test("rejects non-429 statuses", () => {
    for (const statusCode of [400, 401, 403, 404, 500]) {
      expect(KiloSessionFallback.ordinary(apiError({ message: "error", statusCode, isRetryable: true }))).toBe(false)
    }
  })
  test("rejects missing status and non-retryable 429", () => {
    expect(KiloSessionFallback.ordinary(apiError({ message: "Too Many Requests", isRetryable: true }))).toBe(false)
    expect(
      KiloSessionFallback.ordinary(
        apiError({ message: "Response interrupted after output", statusCode: 429, isRetryable: false }),
      ),
    ).toBe(false)
  })
  test("rejects quota markers in message or body", () => {
    expect(
      KiloSessionFallback.ordinary(
        apiError({
          message: "Quota exceeded. Check your plan and billing details.",
          statusCode: 429,
          isRetryable: true,
        }),
      ),
    ).toBe(false)
    expect(
      KiloSessionFallback.ordinary(
        apiError({
          message: "Too Many Requests",
          statusCode: 429,
          isRetryable: true,
          responseBody: JSON.stringify({ error: { code: "insufficient_quota" } }),
        }),
      ),
    ).toBe(false)
    expect(
      KiloSessionFallback.ordinary(
        apiError({
          message: "Too Many Requests",
          statusCode: 429,
          isRetryable: true,
          responseBody: JSON.stringify({ error: { code: "FreeUsageLimitError" } }),
        }),
      ),
    ).toBe(false)
  })
  test("rejects auth and invalid-request markers", () => {
    expect(
      KiloSessionFallback.ordinary(apiError({ message: "unauthorized", statusCode: 429, isRetryable: true })),
    ).toBe(false)
    expect(
      KiloSessionFallback.ordinary(
        apiError({
          message: "Too Many Requests",
          statusCode: 429,
          isRetryable: true,
          responseBody: JSON.stringify({ error: { code: "model_not_found" } }),
        }),
      ),
    ).toBe(false)
  })
  test("rejects Kilo product errors", () => {
    expect(
      KiloSessionFallback.ordinary(
        apiError({
          message: "limit",
          statusCode: 429,
          isRetryable: true,
          responseBody: JSON.stringify({ error: { code: "PROMOTION_MODEL_LIMIT_REACHED" } }),
        }),
      ),
    ).toBe(false)
  })
  test("rejects non-API errors", () => {
    expect(KiloSessionFallback.ordinary(new NamedError.Unknown({ message: "boom" }).toObject())).toBe(false)
  })
})

describe("prior Kilo success", () => {
  test("requires a finished error-free Kilo assistant turn before the current message", () => {
    expect(KiloSessionFallback.prior([], "msg_new")).toBe(false)
    expect(
      KiloSessionFallback.prior([msg("msg_new", { role: "assistant", providerID: "kilo", finish: "stop" })], "msg_new"),
    ).toBe(false)
    expect(
      KiloSessionFallback.prior(
        [msg("msg_old", { role: "assistant", providerID: "custom", finish: "stop" })],
        "msg_new",
      ),
    ).toBe(false)
    expect(
      KiloSessionFallback.prior([msg("msg_old", { role: "assistant", providerID: "kilo", finish: "stop" })], "msg_new"),
    ).toBe(true)
  })
  test("unfinished or errored Kilo turns do not count", () => {
    expect(KiloSessionFallback.prior([msg("msg_old", { role: "assistant", providerID: "kilo" })], "msg_new")).toBe(
      false,
    )
    expect(
      KiloSessionFallback.prior(
        [msg("msg_old", { role: "assistant", providerID: "kilo", finish: "stop", error: { name: "APIError" } })],
        "msg_new",
      ),
    ).toBe(false)
  })
})

describe("takeover gate", () => {
  const target = { providerID: "custom", modelID: "m" }
  const error = apiError({ message: "Too Many Requests", statusCode: 429, isRetryable: true })
  const base = { primaryProviderID: "kilo", active: target, error, priorKilo: true, exposed: false }
  test("eligible when every gate holds", () => {
    expect(KiloSessionFallback.check(base)).toEqual(target)
  })
  test("ineligible without prior Kilo success", () => {
    expect(KiloSessionFallback.check({ ...base, priorKilo: false })).toBeUndefined()
  })
  test("ineligible for non-Kilo primary", () => {
    expect(KiloSessionFallback.check({ ...base, primaryProviderID: "custom" })).toBeUndefined()
  })
  test("ineligible after output exposure", () => {
    expect(KiloSessionFallback.check({ ...base, exposed: true })).toBeUndefined()
  })
  test("ineligible for quota errors", () => {
    expect(
      KiloSessionFallback.check({
        ...base,
        error: apiError({ message: "Quota exceeded", statusCode: 429, isRetryable: true }),
      }),
    ).toBeUndefined()
  })
  test("ineligible without an active fallback", () => {
    expect(KiloSessionFallback.check({ ...base, active: undefined })).toBeUndefined()
  })
})

describe("sticky turn routing", () => {
  test("no sticky resolves the requested model unchanged", async () => {
    const seen: Array<{ providerID: string; modelID: string }> = []
    const out = await Effect.runPromise(
      KiloSessionFallback.turn({
        sticky: undefined,
        requested: { providerID: pid("kilo"), modelID: mid("kilo-model") },
        resolve: (providerID, modelID) => {
          seen.push({ providerID: String(providerID), modelID: String(modelID) })
          return Effect.succeed(model(String(providerID), String(modelID)))
        },
      }),
    )
    expect(out.providerID).toBe(pid("kilo"))
    expect(seen).toEqual([{ providerID: "kilo", modelID: "kilo-model" }])
  })
  test("sticky ignores the requested Kilo selection", async () => {
    const out = await Effect.runPromise(
      KiloSessionFallback.turn({
        sticky: { providerID: "custom", modelID: "m" },
        requested: { providerID: pid("kilo"), modelID: mid("kilo-model") },
        resolve: (providerID, modelID) => Effect.succeed(model(String(providerID), String(modelID))),
      }),
    )
    expect(out.providerID).toBe(pid("custom"))
    expect(out.id).toBe(mid("m"))
  })
  test("removed sticky target fails closed", async () => {
    const exit = await Effect.runPromiseExit(
      KiloSessionFallback.turn({
        sticky: { providerID: "custom", modelID: "gone" },
        requested: { providerID: pid("kilo"), modelID: mid("kilo-model") },
        resolve: () => Effect.die(new Error("not found")),
      }),
    )
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      const found = Cause.findErrorOption(exit.cause)
      expect(Option.isSome(found)).toBe(true)
      if (Option.isSome(found)) expect(found.value).toBeInstanceOf(KiloSessionFallback.StaleTargetError)
    }
  })
  test("removed message names the target", () => {
    expect(KiloSessionFallback.removed({ providerID: "custom", modelID: "gone" })).toContain("custom/gone")
  })
})

describe("session fallback row mapping", () => {
  const row = {
    id: "ses_test",
    project_id: "prj_test",
    workspace_id: null,
    parent_id: null,
    slug: "test",
    directory: "/tmp",
    path: null,
    title: "t",
    version: "v1",
    share_url: null,
    summary_additions: null,
    summary_deletions: null,
    summary_files: null,
    summary_diffs: null,
    metadata: null,
    cost: 0,
    tokens_input: 0,
    tokens_output: 0,
    tokens_reasoning: 0,
    tokens_cache_read: 0,
    tokens_cache_write: 0,
    revert: null,
    permission: null,
    agent: null,
    model: null,
    fallback: null,
    revision: 0,
    time_created: 1,
    time_updated: 1,
    time_compacting: null,
    time_archived: null,
  }
  test("old rows map to omitted fallback", () => {
    expect(fromRow(row as never).fallback).toBeUndefined()
  })
  test("fallback round-trips", () => {
    const info = fromRow({ ...row, fallback: { providerID: "custom", modelID: "m" } } as never)
    expect(info.fallback).toEqual({ providerID: "custom", modelID: "m" })
    expect(toRow(info).fallback).toEqual({ providerID: "custom", modelID: "m" })
  })
})
