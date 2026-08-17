import { describe, expect, test } from "bun:test"
import { OpenApi } from "effect/unstable/httpapi"
import { AgentBuilderPaths } from "../../../src/kilocode/server/httpapi/groups/agent-builder"
import { BackgroundProcessPaths } from "../../../src/kilocode/server/httpapi/groups/background-process"
import { ConfigConsolePaths } from "../../../src/kilocode/server/httpapi/groups/config-console"
import { KiloGatewayPaths } from "../../../src/kilocode/server/httpapi/groups/kilo-gateway"
import { KilocodePaths } from "../../../src/kilocode/server/httpapi/groups/kilocode"
import { NetworkPaths } from "../../../src/kilocode/server/httpapi/groups/network"
import { TelemetryPaths } from "../../../src/kilocode/server/httpapi/groups/telemetry"
import { SessionPaths } from "../../../src/server/routes/instance/httpapi/groups/session"
import { PublicApi } from "../../../src/server/routes/instance/httpapi/public"

type Schema = {
  anyOf?: Schema[]
  items?: Schema
  properties?: Record<string, Schema>
  type?: string
  enum?: string[]
  minLength?: number
  maxLength?: number
  pattern?: string
}

type Parameter = {
  in?: string
  name?: string
  schema?: Schema
}

type Method = "get" | "post" | "patch" | "put"

type Body = {
  content?: Record<string, { schema?: Schema }>
}

describe("Kilo PublicApi OpenAPI contract", () => {
  test("uses Kilo branding", () => {
    const spec = OpenApi.fromApi(PublicApi)
    expect(spec.info.title).toBe("kilo")
    expect(spec.info.description).toBe("kilo api")
  })

  test("includes legacy Kilo events in the generated SDK contract", () => {
    const spec = JSON.stringify(OpenApi.fromApi(PublicApi))
    for (const type of [
      "suggestion.shown",
      "session.network.asked",
      "background_process.updated",
      "interactive_terminal.updated",
    ]) {
      expect(spec).toContain(type)
    }
  })

  test("constrains agent builder route ids", () => {
    const spec = OpenApi.fromApi(PublicApi)
    const save = AgentBuilderPaths.save.replace(":id", "{id}")
    const params = spec.paths[save]?.put?.parameters as Parameter[] | undefined
    const schema = params?.find((param) => param.name === "id")?.schema

    expect(schema).toEqual({
      type: "string",
      minLength: 1,
      maxLength: 64,
      pattern: "^[a-zA-Z0-9][a-zA-Z0-9._-]*$",
    })
  })

  test("keeps workspace routing queries on background process routes", () => {
    const spec = OpenApi.fromApi(PublicApi)
    const routes = [
      { method: "get", path: BackgroundProcessPaths.list },
      { method: "get", path: BackgroundProcessPaths.get },
      { method: "get", path: BackgroundProcessPaths.logs },
      { method: "post", path: BackgroundProcessPaths.stop },
      { method: "post", path: BackgroundProcessPaths.restart },
      { method: "post", path: BackgroundProcessPaths.stopSession },
    ] satisfies Array<{ method: Method; path: string }>

    for (const route of routes) {
      const path = route.path.replace(/:([A-Za-z0-9_]+)/g, "{$1}")
      const params = spec.paths[path]?.[route.method]?.parameters as Parameter[] | undefined
      const query = params?.filter((param) => param.in === "query").map((param) => param.name)
      expect(query, `${route.method.toUpperCase()} ${route.path}`).toEqual(["directory", "workspace"])
    }
  })

  test("keeps directory routing queries on Kilo Console routes", () => {
    const spec = OpenApi.fromApi(PublicApi)
    const routes = [
      { method: "post", path: SessionPaths.viewed },
      { method: "get", path: ConfigConsolePaths.overlay },
      { method: "patch", path: ConfigConsolePaths.overlay },
    ] satisfies Array<{ method: Method; path: string }>

    for (const route of routes) {
      const params = spec.paths[route.path]?.[route.method]?.parameters as Parameter[] | undefined
      const query = params?.filter((param) => param.in === "query").map((param) => param.name)
      expect(query, `${route.method.toUpperCase()} ${route.path}`).toContain("directory")
      expect(query, `${route.method.toUpperCase()} ${route.path}`).toContain("workspace")
    }
  })

  test("keeps workspace routing queries on all Kilo-owned routed endpoints", () => {
    const spec = OpenApi.fromApi(PublicApi)
    const routes = [
      { method: "post", path: AgentBuilderPaths.preview },
      { method: "put", path: AgentBuilderPaths.save },
      { method: "post", path: "/enhance-prompt" },
      { method: "get", path: NetworkPaths.list },
      { method: "post", path: NetworkPaths.reply },
      { method: "post", path: NetworkPaths.reject },
      { method: "post", path: TelemetryPaths.capture },
      { method: "post", path: TelemetryPaths.setEnabled },
      { method: "get", path: ConfigConsolePaths.sources },
      { method: "get", path: ConfigConsolePaths.effective },
      { method: "get", path: ConfigConsolePaths.rules },
      { method: "put", path: ConfigConsolePaths.rules },
      { method: "get", path: ConfigConsolePaths.modelState },
      { method: "patch", path: ConfigConsolePaths.modelState },
      { method: "get", path: ConfigConsolePaths.tuiConfig },
      { method: "get", path: ConfigConsolePaths.tuiKeybinds },
      { method: "patch", path: ConfigConsolePaths.tuiConfig },
      { method: "get", path: KilocodePaths.sessionModelUsage },
    ] satisfies Array<{ method: Method; path: string }>

    for (const route of routes) {
      const path = route.path.replace(/:([A-Za-z0-9_]+)/g, "{$1}")
      const params = spec.paths[path]?.[route.method]?.parameters as Parameter[] | undefined
      const query = params?.filter((param) => param.in === "query").map((param) => param.name)
      expect(query, `${route.method.toUpperCase()} ${route.path}`).toContain("directory")
      expect(query, `${route.method.toUpperCase()} ${route.path}`).toContain("workspace")
    }
  })

  test("keeps personal organization resets nullable", () => {
    const spec = OpenApi.fromApi(PublicApi)
    const body = spec.paths[KiloGatewayPaths.organization]?.post?.requestBody as Body | undefined
    const schema = body?.content?.["application/json"]?.schema
    const props = schema?.properties
    expect(props?.organizationId).toEqual({ anyOf: [{ type: "string" }, { type: "null" }] })
  })

  test("keeps Kilo gateway responses nullable", () => {
    const spec = OpenApi.fromApi(PublicApi)
    const response = (path: string) => {
      const body = spec.paths[path]?.get?.responses?.["200"] as Body | undefined
      return body?.content?.["application/json"]?.schema
    }

    const profile = response(KiloGatewayPaths.profile)?.properties
    expect(profile?.balance).toEqual({ anyOf: [expect.objectContaining({ type: "object" }), { type: "null" }] })
    expect(profile?.kiloPass).toEqual({ anyOf: [expect.objectContaining({ type: "object" }), { type: "null" }] })
    expect(profile?.profile?.properties?.selectedOrganizationId).toEqual({ type: "string" })
    expect(profile?.profile?.properties?.hasPersonalAccount).toEqual({ type: "boolean" })
    const pass = profile?.kiloPass?.anyOf?.find((item) => item.type === "object")?.properties
    expect(pass?.nextBillingAt).toEqual({ anyOf: [{ type: "string" }, { type: "null" }] })
    expect(profile?.currentOrgId).toEqual({ anyOf: [{ type: "string" }, { type: "null" }] })

    const auth = response(KiloGatewayPaths.authStatus)?.properties
    expect(auth).toEqual({
      authenticated: { type: "boolean" },
      type: { type: "string", enum: ["api", "oauth"] },
    })
  })

  test("keeps transcription prompts in the public contract", () => {
    const spec = OpenApi.fromApi(PublicApi)
    const body = spec.paths[KiloGatewayPaths.audioTranscriptions]?.post?.requestBody as Body | undefined
    const schema = body?.content?.["application/json"]?.schema
    expect(schema?.properties?.prompt).toEqual({ type: "string" })
  })
})
