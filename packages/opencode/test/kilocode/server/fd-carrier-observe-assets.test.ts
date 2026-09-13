import { afterEach, describe, expect } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { PassThrough } from "node:stream"
import { Effect } from "effect"
import { Server } from "../../../src/server/server"
import { Global } from "@opencode-ai/core/global"
import { GlobalBus } from "../../../src/bus/global"
import { awaitRebuilds } from "../../../src/kilocode/server/config-rebuild"
import { JsonRpcPeer } from "../../../src/private-worker/peer"
import { createFdCarrier } from "../../../src/kilocode/server/fd-carrier"
import { FD_PROTOCOL_NAME } from "../../../src/kilocode/server/fd-carrier-protocol"
import { AppLayer } from "../../../src/effect/app-runtime"
import { GenerationGate } from "../../../src/kilocode/server/generation-gate"
import { InstanceStore } from "../../../src/project/instance-store"
import { awaitWithTimeout, pollWithTimeout, testEffectShared } from "../../lib/effect"
import { tmpdir, disposeAllInstances } from "../../fixture/fixture"
import { markProjectConfigReady, markPluginDependenciesReady } from "../../fixture/plugin"
import { resetDatabase } from "../../fixture/db"

const it = testEffectShared(AppLayer)
const originalGlobal = Global.Path.config

afterEach(async () => {
  ;(Global.Path as { config: string }).config = originalGlobal
  GlobalBus.removeAllListeners("event")
  await Effect.runPromise(awaitRebuilds().pipe(Effect.ignore))
  await disposeAllInstances()
  await resetDatabase()
})

const linked = () => {
  const extToCarrier = new PassThrough()
  const carrierToExt = new PassThrough()
  const carrier = createFdCarrier(extToCarrier, carrierToExt)
  const ext = new JsonRpcPeer({ reader: carrierToExt, writer: extToCarrier })
  return { carrier, ext }
}

const init = (ext: JsonRpcPeer) =>
  ext.request("initialize", {
    protocol: { name: FD_PROTOCOL_NAME, major: 1, minor: 0 },
    clientInfo: { name: "kilo-vscode", version: "7.4.11" },
    capabilities: ["config/convergence/acquire", "config/convergence/resolve"],
  })

const observeReq = (id: string, descriptors: unknown, extra: Record<string, unknown> = {}) => ({
  v: 1,
  observeId: id,
  opId: id,
  requestId: id,
  idempotencyKey: id,
  descriptors,
  ...extra,
})

const projectFile = (dir: string) => path.join(dir, ".kilo", "kilo.jsonc")

const atomicWrite = (file: string, value: Record<string, unknown>) => {
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify({ $schema: "https://app.kilo.ai/config.json", ...value }, null, 2), "utf8")
  fs.renameSync(tmp, file)
}

const seedProject = async (dir: string, value: Record<string, unknown>) => {
  await markProjectConfigReady(dir)
  atomicWrite(projectFile(dir), value)
  await markProjectConfigReady(dir)
}

const agentFile = (dir: string, id: string) => path.join(dir, ".kilo", "agent", `${id}.md`)
const commandFile = (dir: string, id: string) => path.join(dir, ".kilo", "command", `${id}.md`)
const skillDir = (dir: string, name: string, base: "skill" | "skills" = "skill") => path.join(dir, ".kilo", base, name)
const skillFile = (dir: string, name: string, base: "skill" | "skills" = "skill") => path.join(skillDir(dir, name, base), "SKILL.md")

const writeAgent = (dir: string, id: string, body: string) => {
  fs.mkdirSync(path.dirname(agentFile(dir, id)), { recursive: true })
  fs.writeFileSync(agentFile(dir, id), `---\ndescription: ${id} fixture.\n---\n${body}\n`, "utf8")
}

const writeCommand = (dir: string, id: string, body: string) => {
  fs.mkdirSync(path.dirname(commandFile(dir, id)), { recursive: true })
  fs.writeFileSync(commandFile(dir, id), `---\ndescription: ${id} fixture.\n---\n${body}\n`, "utf8")
}

const writeSkill = (dir: string, name: string, body: string, base: "skill" | "skills" = "skill") => {
  fs.mkdirSync(skillDir(dir, name, base), { recursive: true })
  fs.writeFileSync(skillFile(dir, name, base), `---\nname: ${name}\ndescription: ${name} fixture.\n---\n${body}\n`, "utf8")
}

const getJson = async (dir: string, input: string) => {
  const res = await Server.Default().app.request(input, { headers: { "x-kilo-directory": dir } })
  if (res.status !== 200) return [] as Array<{ name: string }>
  try {
    return (await res.json()) as Array<{ name: string }>
  } catch {
    return [] as Array<{ name: string }>
  }
}

const hasName = async (dir: string, input: string, name: string) => {
  try {
    const list = await getJson(dir, input)
    return list.some((e) => e.name === name)
  } catch {
    return false
  }
}

describe("fd-carrier asset observe cold convergence", () => {
  it.live("asset observe accepted cold; agent add visible after rebuild", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
      const dir = tmp.path
      yield* Effect.promise(() => seedProject(dir, { permission: { bash: "allow" } }))
      const store = yield* InstanceStore.Service
      yield* store.load({ directory: dir })
      const pair = linked()
      try {
        yield* Effect.promise(() => init(pair.ext))
        yield* Effect.sync(() => writeAgent(dir, "ext-agent", "Hello external."))
        const obs: unknown = yield* Effect.promise(() =>
          pair.ext.request(
            "config/convergence/observe",
            observeReq(`asset-add-${Date.now()}`, [{ kind: "asset", asset: "agent", scope: "project", directory: dir, id: "ext-agent" }]),
          ),
        )
        expect((obs as { outcome: string }).outcome).toBe("cold")
        yield* awaitWithTimeout(awaitRebuilds(), "agent observe rebuild never settled")
        yield* pollWithTimeout(
          Effect.gen(function* () {
            const agents = yield* Effect.promise(() => getJson(dir, "/agent"))
            return agents.some((a) => a.name === "ext-agent") ? (true as const) : undefined
          }),
          "agent add never visible",
        )
      } finally {
        pair.carrier.dispose()
        pair.ext.dispose()
      }
    }),
  )

  it.live("agent modify and delete visible after asset observe", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
      const dir = tmp.path
      yield* Effect.promise(() => seedProject(dir, { permission: { bash: "allow" } }))
      yield* Effect.sync(() => writeAgent(dir, "mod-agent", "v1"))
      const store = yield* InstanceStore.Service
      yield* store.load({ directory: dir })
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const ok = yield* Effect.promise(() => hasName(dir, "/agent", "mod-agent"))
          return ok ? (true as const) : undefined
        }),
        "initial agent never visible",
      )
      const pair = linked()
      try {
        yield* Effect.promise(() => init(pair.ext))
        yield* Effect.sync(() => writeAgent(dir, "mod-agent", "v2 changed"))
        const mod: unknown = yield* Effect.promise(() =>
          pair.ext.request(
            "config/convergence/observe",
            observeReq(`asset-mod-${Date.now()}`, [{ kind: "asset", asset: "agent", scope: "project", directory: dir, id: "mod-agent" }]),
          ),
        )
        expect((mod as { outcome: string }).outcome).toBe("cold")
        yield* awaitWithTimeout(awaitRebuilds(), "agent modify rebuild never settled")
        fs.unlinkSync(agentFile(dir, "mod-agent"))
        const del: unknown = yield* Effect.promise(() =>
          pair.ext.request(
            "config/convergence/observe",
            observeReq(`asset-del-${Date.now()}`, [{ kind: "asset", asset: "agent", scope: "project", directory: dir, id: "mod-agent" }]),
          ),
        )
        expect((del as { outcome: string }).outcome).toBe("cold")
        yield* awaitWithTimeout(awaitRebuilds(), "agent delete rebuild never settled")
        yield* pollWithTimeout(
          Effect.gen(function* () {
            const agents = yield* Effect.promise(() => getJson(dir, "/agent"))
            return !agents.some((a) => a.name === "mod-agent") ? (true as const) : undefined
          }),
          "agent delete never visible",
        )
      } finally {
        pair.carrier.dispose()
        pair.ext.dispose()
      }
    }),
  )

  it.live("command add and delete visible after asset observe", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
      const dir = tmp.path
      yield* Effect.promise(() => seedProject(dir, { permission: { bash: "allow" } }))
      const store = yield* InstanceStore.Service
      yield* store.load({ directory: dir })
      const pair = linked()
      try {
        yield* Effect.promise(() => init(pair.ext))
        yield* Effect.sync(() => writeCommand(dir, "ext-cmd", "echo hi $ARGUMENTS"))
        const obs: unknown = yield* Effect.promise(() =>
          pair.ext.request(
            "config/convergence/observe",
            observeReq(`cmd-add-${Date.now()}`, [{ kind: "asset", asset: "command", scope: "project", directory: dir, id: "ext-cmd" }]),
          ),
        )
        expect((obs as { outcome: string }).outcome).toBe("cold")
        yield* awaitWithTimeout(awaitRebuilds(), "command observe rebuild never settled")
        yield* pollWithTimeout(
          Effect.gen(function* () {
            const commands = yield* Effect.promise(() => getJson(dir, "/command"))
            return commands.some((c) => c.name === "ext-cmd") ? (true as const) : undefined
          }),
          "command add never visible",
        )
        fs.unlinkSync(commandFile(dir, "ext-cmd"))
        const del: unknown = yield* Effect.promise(() =>
          pair.ext.request(
            "config/convergence/observe",
            observeReq(`cmd-del-${Date.now()}`, [{ kind: "asset", asset: "command", scope: "project", directory: dir, id: "ext-cmd" }]),
          ),
        )
        expect((del as { outcome: string }).outcome).toBe("cold")
        yield* awaitWithTimeout(awaitRebuilds(), "command delete rebuild never settled")
        yield* pollWithTimeout(
          Effect.gen(function* () {
            const commands = yield* Effect.promise(() => getJson(dir, "/command"))
            return !commands.some((c) => c.name === "ext-cmd") ? (true as const) : undefined
          }),
          "command delete never visible",
        )
      } finally {
        pair.carrier.dispose()
        pair.ext.dispose()
      }
    }),
  )

  it.live("skill add and delete visible after asset observe", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
      const dir = tmp.path
      yield* Effect.promise(() => seedProject(dir, { permission: { bash: "allow" } }))
      const store = yield* InstanceStore.Service
      yield* store.load({ directory: dir })
      const pair = linked()
      try {
        yield* Effect.promise(() => init(pair.ext))
        yield* Effect.sync(() => writeSkill(dir, "ext-skill", "# ext"))
        const obs: unknown = yield* Effect.promise(() =>
          pair.ext.request(
            "config/convergence/observe",
            observeReq(`skill-add-${Date.now()}`, [{ kind: "asset", asset: "skill", scope: "project", directory: dir, id: "ext-skill" }]),
          ),
        )
        expect((obs as { outcome: string }).outcome).toBe("cold")
        yield* awaitWithTimeout(awaitRebuilds(), "skill observe rebuild never settled")
        yield* pollWithTimeout(
          Effect.gen(function* () {
            const skills = yield* Effect.promise(() => getJson(dir, "/skill"))
            return skills.some((s) => s.name === "ext-skill") ? (true as const) : undefined
          }),
          "skill add never visible",
        )
        fs.rmSync(skillDir(dir, "ext-skill"), { recursive: true, force: true })
        const del: unknown = yield* Effect.promise(() =>
          pair.ext.request(
            "config/convergence/observe",
            observeReq(`skill-del-${Date.now()}`, [{ kind: "asset", asset: "skill", scope: "project", directory: dir, id: "ext-skill" }]),
          ),
        )
        expect((del as { outcome: string }).outcome).toBe("cold")
        yield* awaitWithTimeout(awaitRebuilds(), "skill delete rebuild never settled")
        yield* pollWithTimeout(
          Effect.gen(function* () {
            const skills = yield* Effect.promise(() => getJson(dir, "/skill"))
            return !skills.some((s) => s.name === "ext-skill") ? (true as const) : undefined
          }),
          "skill delete never visible",
        )
      } finally {
        pair.carrier.dispose()
        pair.ext.dispose()
      }
    }),
  )

  it.live("plural skill add and delete visible after asset observe", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
      const dir = tmp.path
      yield* Effect.promise(() => seedProject(dir, { permission: { bash: "allow" } }))
      const store = yield* InstanceStore.Service
      yield* store.load({ directory: dir })
      const pair = linked()
      try {
        yield* Effect.promise(() => init(pair.ext))
        yield* Effect.sync(() => writeSkill(dir, "pl-skill", "# plural", "skills"))
        const obs: unknown = yield* Effect.promise(() =>
          pair.ext.request(
            "config/convergence/observe",
            observeReq(`pskill-add-${Date.now()}`, [{ kind: "asset", asset: "skill", scope: "project", directory: dir, id: "pl-skill" }]),
          ),
        )
        expect((obs as { outcome: string }).outcome).toBe("cold")
        yield* awaitWithTimeout(awaitRebuilds(), "plural skill observe rebuild never settled")
        yield* pollWithTimeout(
          Effect.gen(function* () {
            const skills = yield* Effect.promise(() => getJson(dir, "/skill"))
            return skills.some((s) => s.name === "pl-skill") ? (true as const) : undefined
          }),
          "plural skill add never visible",
        )
        fs.rmSync(skillDir(dir, "pl-skill", "skills"), { recursive: true, force: true })
        const del: unknown = yield* Effect.promise(() =>
          pair.ext.request(
            "config/convergence/observe",
            observeReq(`pskill-del-${Date.now()}`, [{ kind: "asset", asset: "skill", scope: "project", directory: dir, id: "pl-skill" }]),
          ),
        )
        expect((del as { outcome: string }).outcome).toBe("cold")
        yield* awaitWithTimeout(awaitRebuilds(), "plural skill delete rebuild never settled")
        yield* pollWithTimeout(
          Effect.gen(function* () {
            const skills = yield* Effect.promise(() => getJson(dir, "/skill"))
            return !skills.some((s) => s.name === "pl-skill") ? (true as const) : undefined
          }),
          "plural skill delete never visible",
        )
      } finally {
        pair.carrier.dispose()
        pair.ext.dispose()
      }
    }),
  )

  it.live("skill guards cover both SKILL.md candidates; flat skill symlink is not authoritative", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
      const dir = tmp.path
      yield* Effect.promise(() => seedProject(dir, { permission: { bash: "allow" } }))
      const external = yield* Effect.promise(() => tmpdir({ retain: true }))
      const pair = linked()
      try {
        yield* Effect.promise(() => init(pair.ext))
        const evilSrc = path.join(external.path, "SKILL.md")
        fs.writeFileSync(evilSrc, "---\nname: evil\n---\nevil\n", "utf8")
        for (const base of ["skill", "skills"] as const) {
          const targetDir = path.join(dir, ".kilo", base, "evil")
          fs.mkdirSync(targetDir, { recursive: true })
          const leaf = path.join(targetDir, "SKILL.md")
          let linkedLeaf = false
          try {
            fs.symlinkSync(evilSrc, leaf)
            linkedLeaf = true
          } catch {
            // Windows without privilege: skip this candidate.
          }
          if (linkedLeaf) {
            const err = yield* Effect.promise(() =>
              pair.ext
                .request("config/convergence/observe", observeReq(`sklink-${base}-${Date.now()}`, [{ kind: "asset", asset: "skill", scope: "project", directory: dir, id: "evil" }]))
                .then(
                  () => "ok",
                  (e: unknown) => String((e as { code?: unknown }).code ?? e),
                ),
            )
            expect(err).toBe("-32602")
            fs.unlinkSync(leaf)
          }
        }
        // A symlink at the non-authoritative flat skill path is not guarded:
        // the same descriptor still converges cold from the real candidates.
        const flatLeaf = path.join(dir, ".kilo", "skill", "flatevil.md")
        try {
          fs.symlinkSync(evilSrc, flatLeaf)
        } catch {
          // Windows without privilege: skip flat assertion setup.
        }
        if (fs.existsSync(flatLeaf)) {
          const ok: unknown = yield* Effect.promise(() =>
            pair.ext.request("config/convergence/observe", observeReq(`skflat-${Date.now()}`, [{ kind: "asset", asset: "skill", scope: "project", directory: dir, id: "flatevil" }])),
          )
          expect((ok as { outcome: string }).outcome).toBe("cold")
          yield* awaitWithTimeout(awaitRebuilds(), "flat skill observe rebuild never settled")
          fs.unlinkSync(flatLeaf)
        }
      } finally {
        pair.carrier.dispose()
        pair.ext.dispose()
      }
    }),
  )

  it.live("invalid asset id, symlink, and data fields rejected", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
      const dir = tmp.path
      yield* Effect.promise(() => seedProject(dir, { permission: { bash: "allow" } }))
      const external = yield* Effect.promise(() => tmpdir({ retain: true }))
      const pair = linked()
      try {
        yield* Effect.promise(() => init(pair.ext))
        for (const badId of ["../evil", "a/b", "", ".", "..", "bad name"]) {
          const err = yield* Effect.promise(() =>
            pair.ext
              .request(
                "config/convergence/observe",
                observeReq(`bad-${Date.now()}-${Math.random()}`, [{ kind: "asset", asset: "agent", scope: "project", directory: dir, id: badId }]),
              )
              .then(
                () => "ok",
                (e: unknown) => String((e as { code?: unknown }).code ?? e),
              ),
          )
          expect(err).toBe("-32602")
        }
        const agentDir = path.join(dir, ".kilo", "agent")
        fs.mkdirSync(agentDir, { recursive: true })
        const evilSrc = path.join(external.path, "evil.md")
        fs.writeFileSync(evilSrc, "---\ndescription: evil.\n---\nevil\n", "utf8")
        const leaf = path.join(agentDir, "evil.md")
        try {
          fs.symlinkSync(evilSrc, leaf)
        } catch {
          // Windows without privilege: skip symlink assertion, still check data fields below.
        }
        if (fs.existsSync(leaf)) {
          const linkErr = yield* Effect.promise(() =>
            pair.ext
              .request("config/convergence/observe", observeReq(`link-${Date.now()}`, [{ kind: "asset", asset: "agent", scope: "project", directory: dir, id: "evil" }]))
              .then(
                () => "ok",
                (e: unknown) => String((e as { code?: unknown }).code ?? e),
              ),
          )
          expect(linkErr).toBe("-32602")
          fs.unlinkSync(leaf)
        }
        for (const forbidden of ["bytes", "hash", "outcome", "content", "text", "body", "data"]) {
          const err = yield* Effect.promise(() =>
            pair.ext
              .request(
                "config/convergence/observe",
                observeReq(`f-${Date.now()}-${forbidden}`, [{ kind: "asset", asset: "agent", scope: "project", directory: dir, id: "x" }], {
                  [forbidden]: "x",
                }),
              )
              .then(
                () => "ok",
                (e: unknown) => String((e as { code?: unknown }).code ?? e),
              ),
          )
          expect(err).toBe("-32602")
        }
      } finally {
        pair.carrier.dispose()
        pair.ext.dispose()
      }
    }),
  )

  it.live("repeated same-state asset observe stays cold; ack does not wait for drain", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
      const dir = tmp.path
      yield* Effect.promise(() => seedProject(dir, { permission: { bash: "allow" } }))
      const store = yield* InstanceStore.Service
      yield* store.load({ directory: dir })
      const gate = yield* GenerationGate.Service
      const pair = linked()
      try {
        yield* Effect.promise(() => init(pair.ext))
        yield* Effect.sync(() => writeAgent(dir, "repeat-agent", "v1"))
        const desc = [{ kind: "asset", asset: "agent", scope: "project", directory: dir, id: "repeat-agent" }]
        const releaseHeld = yield* gate.acquire(dir)
        const first: unknown = yield* Effect.promise(() =>
          pair.ext.request("config/convergence/observe", observeReq(`rep1-${Date.now()}`, desc)),
        )
        expect((first as { outcome: string }).outcome).toBe("cold")
        expect(gate.isBarrierActive(dir)).toBe(true)
        const repeat: unknown = yield* Effect.promise(() =>
          pair.ext.request("config/convergence/observe", observeReq(`rep2-${Date.now()}`, desc)),
        )
        expect((repeat as { outcome: string }).outcome).toBe("cold")
        yield* releaseHeld
        yield* awaitWithTimeout(awaitRebuilds(), "repeat asset rebuild never settled")
        expect(gate.isBarrierActive(dir)).toBe(false)
        yield* pollWithTimeout(
          Effect.gen(function* () {
            const agents = yield* Effect.promise(() => getJson(dir, "/agent"))
            return agents.some((a) => a.name === "repeat-agent") ? (true as const) : undefined
          }),
          "repeat asset never visible",
        )
      } finally {
        pair.carrier.dispose()
        pair.ext.dispose()
      }
    }),
  )

  it.live("global asset observe is cold", () =>
    Effect.gen(function* () {
      const global = yield* Effect.promise(() => tmpdir({ retain: true }))
      ;(Global.Path as { config: string }).config = global.path
      fs.writeFileSync(path.join(global.path, "kilo.jsonc"), JSON.stringify({ $schema: "https://app.kilo.ai/config.json" }), "utf8")
      yield* Effect.promise(() => markPluginDependenciesReady(global.path))
      const tmp = yield* Effect.promise(() => tmpdir({ git: true, retain: true }))
      const dir = tmp.path
      yield* Effect.promise(() => seedProject(dir, { permission: { bash: "allow" } }))
      const store = yield* InstanceStore.Service
      yield* store.load({ directory: dir })
      const pair = linked()
      try {
        yield* Effect.promise(() => init(pair.ext))
        const obs: unknown = yield* Effect.promise(() =>
          pair.ext.request("config/convergence/observe", observeReq(`g-${Date.now()}`, [{ kind: "asset", asset: "agent", scope: "global", id: "g-agent" }])),
        )
        expect((obs as { outcome: string }).outcome).toBe("cold")
        yield* awaitWithTimeout(awaitRebuilds(), "global asset rebuild never settled")
      } finally {
        pair.carrier.dispose()
        pair.ext.dispose()
      }
    }),
  )
})
