/**
 * LOCK-007: invalid config PATCH returns a structured 400, writes nothing, and
 * emits no lifecycle events — across every save path.
 *
 * Covers the paths that historically validated only pre-existing data (or not
 * at all): project jsonc, project json, and global json. The overlay route maps
 * the deep ConfigInvalidError/ConfigJsonError to a typed 400 whose body carries
 * the file path and Zod issues, which the SDK decodes and the VS Code settings
 * panel renders.
 */
import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import * as Log from "@opencode-ai/core/util/log"
import { Global } from "@opencode-ai/core/global"
import { Server } from "../../../src/server/server"
import { Event } from "../../../src/server/event"
import { GlobalBus } from "../../../src/bus/global"
import { resetDatabase } from "../../fixture/db"
import { disposeAllInstances, tmpdir } from "../../fixture/fixture"

void Log.init({ print: false })

const original = Global.Path.config

afterEach(async () => {
  ;(Global.Path as { config: string }).config = original
  GlobalBus.removeAllListeners("event")
  await disposeAllInstances()
  await resetDatabase()
})

const app = () => Server.Default().app

function request(dir: string | undefined, input: string, init?: RequestInit) {
  return app().request(input, {
    ...init,
    headers: {
      ...(dir ? { "x-kilo-directory": dir } : {}),
      ...init?.headers,
    },
  })
}

function seedGlobalConfig(dir: string, file: string, extra?: Record<string, unknown>) {
  return Bun.write(
    path.join(dir, file),
    JSON.stringify({ $schema: "https://app.kilo.ai/config.json", permission: { bash: "allow" }, ...extra }, null, 2),
  )
}

function readGlobalConfig(globalDir: string): Record<string, unknown> {
  for (const name of ["kilo.jsonc", "kilo.json"]) {
    const fp = path.join(globalDir, name)
    try {
      const raw = fs.readFileSync(fp, "utf-8")
      return JSON.parse(raw) as Record<string, unknown>
    } catch {
      // continue
    }
  }
  throw new Error(`No global config file found in ${globalDir}`)
}

function captureEvents() {
  const received: Array<{ type: string }> = []
  const handler = (event: { payload: { type: string } }) => {
    received.push({ type: event.payload.type })
  }
  GlobalBus.on("event", handler)
  return {
    received,
    dispose: () => GlobalBus.removeListener("event", handler),
  }
}

type InvalidBody = {
  name?: string
  data?: { path?: string; issues?: unknown[]; message?: string }
}

async function patchProject(dir: string, set: Record<string, unknown>) {
  const response = await request(dir, "/config/overlay", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scope: "project", set }),
  })
  return { status: response.status, body: (await response.json().catch(() => undefined)) as InvalidBody }
}

async function patchGlobal(set: Record<string, unknown>) {
  const response = await request(undefined, "/config/overlay", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scope: "global", set }),
  })
  return { status: response.status, body: (await response.json().catch(() => undefined)) as InvalidBody }
}

describe("config validation (LOCK-007)", () => {
  test.serial("project jsonc invalid patch returns 400, writes nothing, emits nothing", async () => {
    await using global = await tmpdir()
    await using project = await tmpdir()
    await seedGlobalConfig(global.path, "kilo.jsonc")
    ;(Global.Path as { config: string }).config = global.path
    const events = captureEvents()

    try {
      const patch = await patchProject(project.path, { model: 123 })
      expect(patch.status).toBe(400)
      expect(patch.body?.name).toBe("ConfigInvalidError")
      expect(patch.body?.data?.path).toBeTruthy()
      expect(Array.isArray(patch.body?.data?.issues)).toBe(true)

      // Nothing was written (the target .kilo/kilo.jsonc must not exist).
      const target = path.join(project.path, ".kilo", "kilo.jsonc")
      expect(fs.existsSync(target)).toBe(false)
      expect(events.received.some((e) => e.type === Event.ConfigUpdated.type)).toBe(false)
      expect(events.received.some((e) => e.type === Event.Disposed.type)).toBe(false)
    } finally {
      events.dispose()
    }
  })

  test.serial("project json invalid patch returns 400 and does not corrupt the existing file", async () => {
    await using global = await tmpdir()
    await using project = await tmpdir({ config: { model: "keep/model", username: "kilo" } })
    await seedGlobalConfig(global.path, "kilo.jsonc")
    ;(Global.Path as { config: string }).config = global.path
    const events = captureEvents()

    try {
      // The tmpdir fixture writes opencode.json (a json, non-jsonc target).
      const before = fs.readFileSync(path.join(project.path, "opencode.json"), "utf-8")

      const patch = await patchProject(project.path, { model: 123 })
      expect(patch.status).toBe(400)
      expect(patch.body?.name).toBe("ConfigInvalidError")

      // The file is byte-identical: no partial write, no invalid value.
      expect(fs.readFileSync(path.join(project.path, "opencode.json"), "utf-8")).toBe(before)
      const saved = JSON.parse(before) as Record<string, unknown>
      expect(saved.model).toBe("keep/model")
      expect(events.received.some((e) => e.type === Event.ConfigUpdated.type)).toBe(false)
      expect(events.received.some((e) => e.type === Event.Disposed.type)).toBe(false)
    } finally {
      events.dispose()
    }
  })

  test.serial("global json invalid patch returns 400 and does not write", async () => {
    await using global = await tmpdir()
    await using project = await tmpdir()
    await seedGlobalConfig(global.path, "kilo.json", { model: "keep/model" })
    ;(Global.Path as { config: string }).config = global.path
    const events = captureEvents()

    try {
      const before = readGlobalConfig(global.path)
      expect(before.model).toBe("keep/model")

      const patch = await patchGlobal({ model: 123 })
      expect(patch.status).toBe(400)
      expect(patch.body?.name).toBe("ConfigInvalidError")
      expect(patch.body?.data?.path).toBeTruthy()

      const after = readGlobalConfig(global.path)
      expect(after.model).toBe("keep/model")
      expect(after.permission).toEqual({ bash: "allow" })
      expect(events.received.some((e) => e.type === Event.ConfigUpdated.type)).toBe(false)
      expect(events.received.some((e) => e.type === Event.Disposed.type)).toBe(false)
    } finally {
      events.dispose()
    }
  })

  test.serial("valid project json patch still writes through", async () => {
    await using global = await tmpdir()
    await using project = await tmpdir({ config: { model: "keep/model" } })
    await seedGlobalConfig(global.path, "kilo.jsonc")
    ;(Global.Path as { config: string }).config = global.path
    const events = captureEvents()

    try {
      const patch = await patchProject(project.path, { small_model: "another/model" })
      expect(patch.status).toBe(200)
      const saved = JSON.parse(fs.readFileSync(path.join(project.path, "opencode.json"), "utf-8")) as Record<
        string,
        unknown
      >
      expect(saved.model).toBe("keep/model")
      expect(saved.small_model).toBe("another/model")
      expect(events.received.some((e) => e.type === Event.ConfigUpdated.type)).toBe(true)
    } finally {
      events.dispose()
    }
  })
})
