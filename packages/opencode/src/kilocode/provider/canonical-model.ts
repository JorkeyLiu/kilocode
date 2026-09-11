// kilocode_change - pure canonical model synthesis (memory only, never persisted)
import { Provider } from "@/provider/provider"
import type { CanonicalProviderPayload, CanonicalProviderModelPayload } from "@opencode-ai/core/kilocode/canonical-record"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

function modalitiesMap(payload: CanonicalProviderModelPayload | undefined, side: "input" | "output") {
  const list = payload?.modalities?.[side]
  const has = (m: string) => Array.isArray(list) && (list as readonly string[]).includes(m)
  // text true by default, rest false unless explicitly included
  const fallbackText = true
  return {
    text: list !== undefined ? has("text") : fallbackText,
    audio: has("audio"),
    image: has("image"),
    video: has("video"),
    pdf: has("pdf"),
  }
}

export namespace CanonicalModel {
  export type Input = {
    readonly providerId: string
    readonly modelId: string
    readonly record: CanonicalProviderPayload
  }

  export function synthesize(input: Input): Provider.Model {
    const rec = input.record as CanonicalProviderPayload
    const payload = (rec.models as Record<string, CanonicalProviderModelPayload> | undefined)?.[input.modelId]
    // payload must exist; resolver guarantees, but pure function keeps safe fallback
    const name = payload?.name && payload.name.length > 0 ? payload.name : input.modelId
    const reasoning = payload?.reasoning ?? false
    const variantsRaw = (payload?.variants ?? {}) as Record<string, unknown>
    // patch variants: filter disabled sentinels (legacy deletes) and omit field
    const variants: Record<string, Record<string, unknown>> = {}
    for (const [k, v] of Object.entries(variantsRaw)) {
      if (!v || typeof v !== "object") continue
      const recV = v as Record<string, unknown>
      if (recV.disabled) continue
      const { disabled: _d, ...rest } = recV
      // keep only if rest non-empty? allow empty but still map
      variants[k] = rest as Record<string, unknown>
    }

    const inputMods = modalitiesMap(payload, "input")
    const outputMods = modalitiesMap(payload, "output")

    // Keep existing ProviderTransform variant helper contract: models that expose
    // explicit variants keep them; no auto-generation beyond payload. The disabled
    // filtering above matches the legacy config conversion.
    return {
      id: ModelV2.ID.make(input.modelId),
      providerID: ProviderV2.ID.make(input.providerId),
      api: {
        id: input.modelId,
        npm: "@ai-sdk/openai-compatible",
        url: "",
      },
      name,
      family: "",
      capabilities: {
        temperature: false,
        reasoning,
        attachment: false,
        toolcall: true,
        input: inputMods,
        output: outputMods,
        interleaved: false,
      },
      cost: {
        input: 0,
        output: 0,
        cache: { read: 0, write: 0 },
      },
      // limit 0 is conservative unknown catalog data: intentionally disables
      // proactive overflow estimate/compaction/output capping which require known
      // context/output sizes. Do not fabricate limits here.
      limit: {
        context: 0,
        output: 0,
      },
      status: "active",
      options: {},
      headers: {},
      release_date: "",
      variants,
    }
  }
}
