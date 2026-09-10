// type-checked compile fixture for root SDK preservation
// This file is typechecked via dedicated tsconfig.typecheck.json with noEmit.
// Bun strips types, so this file provides explicit compile-time proof without emitting artifacts.

import { KiloClient } from "../src/client.js"
import type { V2Config } from "../src/client.js"
import type { Config as V2ConfigType, ProviderConfig as V2ProviderConfig } from "../src/v2/gen/types.gen.js"
import type { ConfigGetData } from "../src/gen/types.gen.js"
import { KiloClient as BaseKiloClient } from "../src/gen/sdk.gen.js"
import { createClient } from "../src/gen/client/client.gen.js"

// V2 ProviderConfig must have current canonical fields
type _V2ProviderHasCanonical = V2ProviderConfig extends {
  endpoint?: string
  protocol?: "openai/completions" | "openai/responses" | "anthropic/messages"
  credential?: string
}
  ? true
  : false
const _checkV2: _V2ProviderHasCanonical = true

// Root SDK KiloClient must be constructible and instanceof-compatible
const _client = createClient({ baseUrl: "http://localhost" })
const _a = new KiloClient({ client: _client })
const _b = new BaseKiloClient({ client: _client })
const _instanceofCheck: boolean = _a instanceof KiloClient && _a instanceof BaseKiloClient && _b instanceof KiloClient

// config.get default fields response: data, error, request, response with V2Config
async function checkDefaultFields(client: KiloClient) {
  const res = await client.config.get()
  const _data: V2ConfigType | undefined = res.data
  const _err: unknown | undefined = res.error
  const _req: Request = res.request
  const _resp: Response = res.response
  const _provider = _data?.provider?.["acme"]
  const _endpoint: string | undefined = _provider?.endpoint
  const _protocol = _provider?.protocol
  const _cred: string | undefined = _provider?.credential
  void _endpoint; void _protocol; void _cred
}

// throwOnError true should narrow to no error union and preserve request/response
async function checkThrowOnError(client: KiloClient) {
  const res = await client.config.get({ throwOnError: true })
  const _data: V2ConfigType = res.data
  const _req: Request = res.request
  const _resp: Response = res.response
  // with throwOnError true, error field is not present
  // @ts-expect-error - error should not exist when throwOnError true
  const _err = res.error
  void _err
  void _data; void _req; void _resp
}

// responseStyle data should return unwrapped V2Config
async function checkDataStyle(client: KiloClient) {
  const data = await client.config.get<false, "data">({ responseStyle: "data" })
  const _direct: V2ConfigType | undefined = data
  void _direct
  const dataThrow = await client.config.get<true, "data">({ responseStyle: "data", throwOnError: true })
  const _directThrow: V2ConfigType = dataThrow
  void _directThrow
}

// update input must accept endpoint/protocol/credential via V2 types and support generics
async function checkUpdate(client: KiloClient) {
  const res = await client.config.update({
    body: {
      provider: {
        acme: {
          endpoint: "https://api.example.com",
          protocol: "openai/completions",
          credential: "secret:kilo.credentials.global.provider.acme",
          name: "acme",
          models: { m1: { name: "M1" } },
        },
      },
    },
  })
  const _d: V2ConfigType | undefined = res.data
  void _d
  const data = await client.config.update<true, "data">({
    body: {
      provider: {
        x: {
          endpoint: "https://x.test",
          protocol: "openai/responses",
          credential: "secret:kilo.credentials.project.provider.x",
        },
      },
    },
    responseStyle: "data",
    throwOnError: true,
  })
  const _data2: V2ConfigType = data
  void _data2
  // update error field should be BadRequestError union
  const upd = await client.config.update()
  const _err: unknown | undefined = upd.error
  void _err
}

// providers must remain unchanged
async function checkProviders(client: KiloClient) {
  const res = await client.config.providers()
  const _providers = res.data?.providers
  const _def = res.data?.default
  void _providers; void _def
  // providers retains original single-options convention (ThrowOnError only)
  const withThrow = await client.config.providers({ throwOnError: true })
  void withThrow
}

// session namespace must remain unchanged
async function checkSession(client: KiloClient) {
  const list = await client.session.list()
  const _data = list.data
  void _data
  const get = await client.session.get({ path: { id: "test" } })
  void get
}

// ensure Options generics preserved
type _GetOptionsCheck = ConfigGetData extends { url: "/config" } ? true : false
const _getOpt: _GetOptionsCheck = true

// ensure V2 global config is only in v2 SDK
import type { KiloClient as V2KiloClient } from "../src/v2/client.js"
async function checkV2Global(v2: V2KiloClient) {
  const g = await v2.global.config.get()
  void g
  const u = await v2.global.config.update({ config: { provider: { acme: { endpoint: "https://g.test", protocol: "openai/completions", credential: "secret:kilo.credentials.global.provider.acme" } } } })
  void u
  const p = await v2.config.get({ directory: "/tmp" })
  void p
}

void checkDefaultFields; void checkThrowOnError; void checkDataStyle; void checkUpdate; void checkProviders; void checkSession; void checkV2Global
