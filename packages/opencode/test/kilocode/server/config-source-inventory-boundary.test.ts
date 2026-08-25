import { afterEach, describe, expect, test } from "bun:test"
import * as Log from "@opencode-ai/core/util/log"
import { Global } from "@opencode-ai/core/global"
import { Server } from "../../../src/server/server"
import { disposeAllInstances, tmpdir } from "../../fixture/fixture"
import { resetDatabase } from "../../fixture/db"

void Log.init({ print: false })

const original = Global.Path.config

afterEach(async () => {
  ;(Global.Path as { config: string }).config = original
  await disposeAllInstances()
  await resetDatabase()
})

function req(dir: string | undefined, input: string, init?: RequestInit) {
  return Server.Default().app.request(input, {
    ...init,
    headers: {
      ...(dir ? { "x-kilo-directory": dir } : {}),
      ...init?.headers,
    },
  })
}

async function json<T>(res: Response) {
  expect(res.status).toBe(200)
  return (await res.json()) as T
}

describe("P4.4 source-inventory boundary — removed /config/sources and sources-less overlay", () => {
  test.serial("/config/sources is unavailable (404) after removal", async () => {
    await using project = await tmpdir({ retain: true })
    const res = await req(project.path, "/config/sources")
    expect(res.status).toBe(404)
    const global = await tmpdir({ retain: true })
    ;(Global.Path as { config: string }).config = global.path
    const res2 = await req(project.path, "/config/sources?workspace=")
    expect([404, 400].includes(res2.status)).toBe(true)
  })

  test.serial("/config/overlay response has no sources property; canonical fields remain", async () => {
    await using global = await tmpdir({ retain: true })
    await using project = await tmpdir({ retain: true })
    ;(Global.Path as { config: string }).config = global.path

    const overlay = await req(project.path, "/config/overlay?scope=project")
    const body = await json<Record<string, unknown>>(overlay)

    // RC-P4.4-001 drop: overlay no longer echoes sources
    expect(Object.prototype.hasOwnProperty.call(body, "sources")).toBe(false)
    expect(body).not.toHaveProperty("sources")
    // retained overlay shape stays intact
    expect(body).toHaveProperty("effective")
    expect(body).toHaveProperty("global")
    expect(body).toHaveProperty("project")
    expect(body).toHaveProperty("targets")
    expect(body).toHaveProperty("fields")
    expect(body).toHaveProperty("collections")
  })

  test.serial("retained config-console and TUI bridge routes remain available", async () => {
    await using global = await tmpdir({ retain: true })
    await using project = await tmpdir({ retain: true })
    ;(Global.Path as { config: string }).config = global.path

    const eff = await req(project.path, "/config/effective")
    expect(eff.status).toBe(200)
    expect(await eff.json()).toBeDefined()

    const overlay = await req(project.path, "/config/overlay?scope=project")
    expect(overlay.status).toBe(200)

    const patched = await req(project.path, "/config/overlay", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "project", set: {} }),
    })
    expect(patched.status).toBe(200)
    const patchedBody = (await patched.json()) as Record<string, unknown>
    expect(Object.prototype.hasOwnProperty.call(patchedBody, "sources")).toBe(false)

    const tx = await req(project.path, "/config/transaction", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    })
    expect(tx.status).toBe(200)

    const rules = await req(project.path, "/config/rules")
    expect(rules.status).toBe(200)

    const modelState = await req(undefined, "/config/model-state")
    expect(modelState.status).toBe(200)

    const tuiConfig = await req(project.path, "/tui/config")
    expect(tuiConfig.status).toBe(200)

    const tuiKeybinds = await req(project.path, "/tui/keybinds")
    expect(tuiKeybinds.status).toBe(200)
  })
})
