export type * from "./gen/types.gen.js"

import { createClient } from "./gen/client/client.gen.js"
import { type Config } from "./gen/client/types.gen.js"
import { KiloClient as BaseKiloClient } from "./gen/sdk.gen.js"
import { wrapClientError } from "./error-interceptor.js"
export type { Config as KiloClientConfig } from "./gen/client/types.gen.js"
export { KiloClient as BaseKiloClient } from "./gen/sdk.gen.js"
export type { Config as V2Config, ProviderConfig as V2ProviderConfig } from "./v2/gen/types.gen.js"
import type { Config as V2ConfigImport } from "./v2/gen/types.gen.js"
import type { Client, Options, RequestResult, ResponseStyle } from "./gen/client/types.gen.js"
import type { ConfigGetData, ConfigUpdateData, ConfigUpdateErrors } from "./gen/types.gen.js"

type RefinedConfigGetResponses = {
  200: V2ConfigImport
}

type RefinedConfigUpdateResponses = {
  200: V2ConfigImport
}

type RefinedConfigUpdateData = Omit<ConfigUpdateData, "body"> & {
  body?: V2ConfigImport
}

export interface KiloClient extends Omit<BaseKiloClient, "config"> {
  config: Omit<BaseKiloClient["config"], "get" | "update"> & {
    get<ThrowOnError extends boolean = false, TResponseStyle extends ResponseStyle = "fields">(
      options?: Options<ConfigGetData, ThrowOnError, RefinedConfigGetResponses, TResponseStyle>,
    ): RequestResult<RefinedConfigGetResponses, unknown, ThrowOnError, TResponseStyle>
    update<ThrowOnError extends boolean = false, TResponseStyle extends ResponseStyle = "fields">(
      options?: Options<RefinedConfigUpdateData, ThrowOnError, RefinedConfigUpdateResponses, TResponseStyle>,
    ): RequestResult<RefinedConfigUpdateResponses, ConfigUpdateErrors, ThrowOnError, TResponseStyle>
  }
}

export const KiloClient = BaseKiloClient as unknown as {
  new (args?: { client?: Client }): KiloClient
} & typeof BaseKiloClient

function pick(value: string | null, fallback?: string) {
  if (!value) return
  if (!fallback) return value
  if (value === fallback) return fallback
  if (value === encodeURIComponent(fallback)) return fallback
  return value
}

function rewrite(request: Request, directory?: string) {
  if (request.method !== "GET" && request.method !== "HEAD") return request

  const value = pick(request.headers.get("x-kilo-directory"), directory)
  if (!value) return request

  const url = new URL(request.url)
  if (!url.searchParams.has("directory")) {
    url.searchParams.set("directory", value)
  }

  const next = new Request(url.href, request) // kilocode_change
  next.headers.delete("x-kilo-directory")
  return next
}

export function createKiloClient(config?: Config & { directory?: string }): KiloClient {
  if (!config?.fetch) {
    const customFetch: any = (req: any) => {
      return fetch(req, { duplex: "half", timeout: false } as any)
    }
    config = {
      ...config,
      fetch: customFetch,
    }
  }

  if (config?.directory) {
    config.headers = {
      ...config.headers,
      "x-kilo-directory": encodeURIComponent(config.directory),
    }
  }

  ;(config as any).duplex = "half"

  const client = createClient(config)
  client.interceptors.request.use((request) => rewrite(request, config?.directory))
  client.interceptors.error.use(wrapClientError)
  return new BaseKiloClient({ client }) as unknown as KiloClient
}
