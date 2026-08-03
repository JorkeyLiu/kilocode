import { describe, expect, test } from "bun:test"
import { chmod, readFile, readdir, writeFile } from "fs/promises"
import path from "path"
import { parseModelsSnapshot } from "../../src/kilocode/provider/models-snapshot-shape"
import {
  loadModelsSnapshot,
  modelsSnapshotPath,
  refreshModelsSnapshot,
} from "../../script/kilocode/models-snapshot"
import { tmpdir } from "../fixture/fixture"

const model = (id: string) => ({
  id,
  name: id,
  release_date: "2026-01-01",
  attachment: false,
  reasoning: false,
  temperature: true,
  tool_call: true,
  limit: { context: 128000, output: 8192 },
})

const catalog = {
  acme: {
    id: "acme",
    name: "Acme",
    env: ["ACME_API_KEY"],
    models: { "acme-1": model("acme-1") },
  },
}

const refreshedCatalog = {
  acme: {
    ...catalog.acme,
    models: { ...catalog.acme.models, "acme-2": model("acme-2") },
  },
}

describe("committed models snapshot", () => {
  test("canonical path resolves to the committed full snapshot", async () => {
    const file = modelsSnapshotPath()
    const stat = await Bun.file(file).stat()
    expect(stat.size).toBeGreaterThan(1_000_000)
  })

  test("default selection reads the committed file with no network", async () => {
    const { text, source, file } = await loadModelsSnapshot({})
    expect(source).toBe("committed")
    expect(file).toBe(modelsSnapshotPath())
    const parsed = parseModelsSnapshot(text)
    expect(parsed.stats.providers).toBeGreaterThan(0)
    expect(parsed.stats.models).toBeGreaterThan(0)
  })

  test("canonical snapshot cost tiers all validate", async () => {
    const { text } = await loadModelsSnapshot({})
    const parsed = parseModelsSnapshot(text)
    const tierArrays = (Object.values(parsed.data) as Array<{ models: Record<string, { cost?: { tiers?: unknown[] } }> }>)
      .flatMap((p) => Object.values(p.models))
      .map((m) => m.cost?.tiers)
      .filter((tiers): tiers is unknown[] => Array.isArray(tiers))
    expect(tierArrays.length).toBeGreaterThanOrEqual(125)
  })

  test("MODELS_DEV_API_JSON overrides the committed snapshot locally", async () => {
    await using tmp = await tmpdir()
    const override = path.join(tmp.path, "override.json")
    await writeFile(override, JSON.stringify(catalog))
    const { text, source, file } = await loadModelsSnapshot({ MODELS_DEV_API_JSON: override })
    expect(source).toBe("override")
    expect(file).toBe(override)
    expect(parseModelsSnapshot(text).stats.providers).toBe(1)
  })
})

describe("refreshModelsSnapshot", () => {
  test("fetches, validates, and atomically replaces the snapshot", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json(refreshedCatalog),
    })
    try {
      await using tmp = await tmpdir()
      const file = path.join(tmp.path, "models.json")
      await writeFile(file, JSON.stringify(catalog))
      const stats = await refreshModelsSnapshot(`http://127.0.0.1:${server.port}`, file)
      expect(stats.models).toBeGreaterThan(0)
      expect(JSON.parse(await readFile(file, "utf8"))).toEqual(refreshedCatalog)
      const leftovers = (await readdir(tmp.path)).filter((name) => name.includes(".tmp"))
      expect(leftovers).toEqual([])
    } finally {
      server.stop(true)
    }
  })

  test("preserves the old snapshot on HTTP fetch failure", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("boom", { status: 503 }) })
    try {
      await using tmp = await tmpdir()
      const file = path.join(tmp.path, "models.json")
      const old = JSON.stringify(catalog)
      await writeFile(file, old)
      await expect(refreshModelsSnapshot(`http://127.0.0.1:${server.port}`, file)).rejects.toThrow()
      expect(await readFile(file, "utf8")).toBe(old)
    } finally {
      server.stop(true)
    }
  })

  test("aborts a stalled fetch after the timeout and preserves the old snapshot", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Promise(() => {}), // never responds
    })
    try {
      await using tmp = await tmpdir()
      const file = path.join(tmp.path, "models.json")
      const old = JSON.stringify(catalog)
      await writeFile(file, old)
      await expect(refreshModelsSnapshot(`http://127.0.0.1:${server.port}`, file, 100)).rejects.toThrow(
        /timed out after 100ms/,
      )
      expect(await readFile(file, "utf8")).toBe(old)
      const leftovers = (await readdir(tmp.path)).filter((name) => name.includes(".tmp"))
      expect(leftovers).toEqual([])
    } finally {
      server.stop(true)
    }
  })

  test("preserves the old snapshot on schema validation failure", async () => {
    const server = Bun.serve({ port: 0, fetch: () => Response.json({ broken: true }) })
    try {
      await using tmp = await tmpdir()
      const file = path.join(tmp.path, "models.json")
      const old = JSON.stringify(catalog)
      await writeFile(file, old)
      await expect(refreshModelsSnapshot(`http://127.0.0.1:${server.port}`, file)).rejects.toThrow()
      expect(await readFile(file, "utf8")).toBe(old)
    } finally {
      server.stop(true)
    }
  })

  test("rejects fetched tiers that are not an array before writing", async () => {
    const tiered = (cost: unknown) => ({
      ...catalog.acme,
      models: {
        ...catalog.acme.models,
        "acme-1": { ...model("acme-1"), cost },
      },
    })
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json({
          acme: tiered({ input: 1, output: 2, tiers: { input: 1, output: 2, tier: { type: "context", size: 1 } } }),
        }),
    })
    try {
      await using tmp = await tmpdir()
      const file = path.join(tmp.path, "models.json")
      const old = JSON.stringify(catalog)
      await writeFile(file, old)
      await expect(refreshModelsSnapshot(`http://127.0.0.1:${server.port}`, file)).rejects.toThrow(
        /cost\.tiers must be an array/,
      )
      expect(await readFile(file, "utf8")).toBe(old)
    } finally {
      server.stop(true)
    }
  })

  test("rejects structurally invalid fetched tier items before writing", async () => {
    const tiered = (cost: unknown) => ({
      ...catalog.acme,
      models: {
        ...catalog.acme.models,
        "acme-1": { ...model("acme-1"), cost },
      },
    })
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json({
          acme: tiered({ input: 1, output: 2, tiers: [{ output: 2, tier: { type: "context", size: 1 } }] }),
        }),
    })
    try {
      await using tmp = await tmpdir()
      const file = path.join(tmp.path, "models.json")
      const old = JSON.stringify(catalog)
      await writeFile(file, old)
      await expect(refreshModelsSnapshot(`http://127.0.0.1:${server.port}`, file)).rejects.toThrow(
        /cost\.tiers\[0\]\.input must be a finite number/,
      )
      expect(await readFile(file, "utf8")).toBe(old)
    } finally {
      server.stop(true)
    }
  })

  test.skipIf(typeof process.getuid === "function" && process.getuid() === 0)(
    "preserves the old snapshot on write failure",
    async () => {
      const server = Bun.serve({ port: 0, fetch: () => Response.json(refreshedCatalog) })
      try {
        await using tmp = await tmpdir()
        const file = path.join(tmp.path, "models.json")
        const old = JSON.stringify(catalog)
        await writeFile(file, old)
        await chmod(tmp.path, 0o500)
        try {
          await expect(refreshModelsSnapshot(`http://127.0.0.1:${server.port}`, file)).rejects.toThrow()
        } finally {
          await chmod(tmp.path, 0o700)
        }
        expect(await readFile(file, "utf8")).toBe(old)
      } finally {
        server.stop(true)
      }
    },
  )
})
