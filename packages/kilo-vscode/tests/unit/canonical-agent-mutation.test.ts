import { afterEach, describe, expect, it } from "bun:test"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { Option, Schema } from "effect"
import { ConfigAgentV1 } from "@opencode-ai/core/v1/config/agent"
import { ConfigMarkdown } from "@opencode-ai/core/config/markdown"
import { KiloConnectionService } from "../../src/services/cli-backend/connection-service"
import { CanonicalConfigService } from "../../src/config/service"
import { Roots } from "../../src/config/paths"
import { createMemorySecretAdapter } from "../../src/config/secret-adapter"
import { createMemoryStateAdapter, createMemoryEmitterFactory } from "../../src/config/state-adapter"
import { resetVersion } from "../../src/config/materialize"
import { assembleAssetMarkdown } from "../../src/config/service-views"
import { parseMarkdown } from "../../src/config/parse"
import { validateMarkdownAsset } from "../../src/config/validate"
import { parseImport, buildExport } from "../../webview-ui/src/components/settings/mode-io"

const { KiloProvider } = await import("../../src/KiloProvider")

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

type Internals = {
  canonicalReady: boolean
  postMessage: (message: unknown) => void
  sendCanonicalAgents: () => Promise<void>
  handleCanonicalAgentMutation: (msg: Record<string, unknown>) => Promise<void>
  cleanupRetries: Map<string, unknown>
  dispose: () => void
}

async function setup(project = true): Promise<{ provider: Internals; messages: unknown[]; canonical: CanonicalConfigService }> {
  resetVersion()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-agent-mut-"))
  dirs.push(root)
  const global = path.join(root, "xdg-config", "kilo")
  const projectDir = path.join(root, "workspace")
  fs.mkdirSync(global, { recursive: true })
  if (project) fs.mkdirSync(path.join(projectDir, ".kilo"), { recursive: true })
  fs.writeFileSync(path.join(global, "kilo.jsonc"), JSON.stringify({}), "utf8")
  const secrets = createMemorySecretAdapter()
  const canonical = new CanonicalConfigService({ secrets } as never, {
    roots: new Roots(project ? projectDir : undefined, global),
    secretAdapter: secrets,
    globalState: createMemoryStateAdapter(),
    workspaceState: createMemoryStateAdapter(),
    emitterFactory: createMemoryEmitterFactory(),
  })
  await canonical.initialize()
  const connection = new KiloConnectionService({} as never)
  const raw = new KiloProvider({} as never, connection, undefined, { canonicalConfig: canonical })
  const messages: unknown[] = []
  const provider = raw as unknown as Internals
  provider.postMessage = (m) => messages.push(m)
  provider.canonicalReady = true
  return { provider, messages, canonical }
}

function stampFor(canonical: CanonicalConfigService, id: string, scope: "global" | "project", hash: string) {
  return { ...canonical.stamp, assetHash: hash }
}

function errors(messages: unknown[]) {
  return messages.filter((m) => (m as Record<string, unknown>).type === "agentMutationError") as Record<string, unknown>[]
}

function applied(messages: unknown[]) {
  return messages.filter((m) => (m as Record<string, unknown>).type === "agentMutationApplied") as Record<string, unknown>[]
}

describe("canonical custom agent create/edit/import (writeAsset CAS)", () => {
  it("create success writes project file and posts Applied+agentsLoaded", async () => {
    const { provider, messages, canonical } = await setup()
    await provider.handleCanonicalAgentMutation({
      type: "mutateAgent",
      canonical: true,
      action: "create",
      name: "helper",
      frontmatter: { name: "helper", mode: "primary", description: "Helps" },
      body: "You help.",
      scope: "project",
      expectedHash: "absent",
      stamp: stampFor(canonical, "helper", "project", "absent"),
      requestId: "req-create-1",
    })
    const ok = applied(messages)
    expect(ok).toHaveLength(1)
    expect(ok[0].requestId).toBe("req-create-1")
    expect(ok[0].canonical).toBe(true)
    await provider.sendCanonicalAgents()
    const loaded = messages.find((m) => (m as Record<string, unknown>).type === "agentsLoaded") as Record<string, unknown>
    expect(loaded).toBeDefined()
    expect(loaded.canonical).toBe(true)
    const names = ((loaded.allAgents ?? []) as Array<{ name: string }>).map((a) => a.name)
    expect(names).toContain("helper")
    provider.dispose()
    canonical.dispose()
  })

  it("duplicate create with absent hash is stale and does not overwrite", async () => {
    const { provider, messages, canonical } = await setup()
    const base = {
      type: "mutateAgent",
      canonical: true,
      action: "create",
      name: "dupe",
      frontmatter: { name: "dupe", mode: "primary" },
      body: "Original.",
      scope: "project",
      expectedHash: "absent",
      stamp: stampFor(canonical, "dupe", "project", "absent"),
      requestId: "req-1",
    }
    await provider.handleCanonicalAgentMutation({ ...base })
    messages.length = 0
    await provider.handleCanonicalAgentMutation({ ...base, requestId: "req-2" })
    const err = errors(messages)
    expect(err).toHaveLength(1)
    expect(err[0].kind).toBe("stale")
    expect(err[0].requestId).toBe("req-2")
    const read = canonical.readAsset("agent", "dupe", "project")
    expect(read.ok && read.ok === true ? (read as { body: string }).body : "").toContain("Original.")
    provider.dispose()
    canonical.dispose()
  })

  it("import success writes project file", async () => {
    const { provider, messages, canonical } = await setup()
    await provider.handleCanonicalAgentMutation({
      type: "mutateAgent",
      canonical: true,
      action: "import",
      name: "imported",
      frontmatter: { mode: "subagent", description: "Imported" },
      body: "Imported body.",
      scope: "project",
      expectedHash: "absent",
      stamp: stampFor(canonical, "imported", "project", "absent"),
      requestId: "req-import-1",
    })
    expect(applied(messages)).toHaveLength(1)
    provider.dispose()
    canonical.dispose()
  })

  it("edit with correct hash succeeds; stale hash does not write", async () => {
    const { provider, messages, canonical } = await setup()
    await provider.handleCanonicalAgentMutation({
      type: "mutateAgent",
      canonical: true,
      action: "create",
      name: "editable",
      frontmatter: { name: "editable", mode: "primary", description: "v1" },
      body: "v1 body",
      scope: "project",
      expectedHash: "absent",
      stamp: stampFor(canonical, "editable", "project", "absent"),
      requestId: "req-c",
    })
    messages.length = 0
    const hash = canonical.getAssetStamp("agent", "editable", "project")
    expect(hash).not.toBe("absent")
    await provider.handleCanonicalAgentMutation({
      type: "mutateAgent",
      canonical: true,
      action: "edit",
      name: "editable",
      frontmatter: { name: "editable", mode: "primary", description: "v2" },
      body: "v2 body",
      scope: "project",
      expectedHash: hash,
      stamp: stampFor(canonical, "editable", "project", hash),
      requestId: "req-e-ok",
    })
    expect(applied(messages)).toHaveLength(1)
    messages.length = 0
    await provider.handleCanonicalAgentMutation({
      type: "mutateAgent",
      canonical: true,
      action: "edit",
      name: "editable",
      frontmatter: { name: "editable", mode: "primary", description: "stale" },
      body: "stale body",
      scope: "project",
      expectedHash: "deadbeefdeadbeef",
      stamp: { ...canonical.stamp, assetHash: "deadbeefdeadbeef" },
      requestId: "req-e-stale",
    })
    const err = errors(messages)
    expect(err).toHaveLength(1)
    expect(err[0].kind).toBe("stale")
    const read = canonical.readAsset("agent", "editable", "project")
    if (read.ok) expect(read.body).toContain("v2 body")
    else throw new Error("expected asset")
    provider.dispose()
    canonical.dispose()
  })

  it("create with present expectedHash is stale; edit with absent hash is stale", async () => {
    const { provider, messages, canonical } = await setup()
    await provider.handleCanonicalAgentMutation({
      type: "mutateAgent",
      canonical: true,
      action: "create",
      name: "badhash",
      frontmatter: { mode: "primary" },
      body: "x",
      scope: "project",
      expectedHash: "deadbeefdeadbeef",
      stamp: { ...canonical.stamp, assetHash: "deadbeefdeadbeef" },
      requestId: "req-bad-create",
    })
    expect(errors(messages)[0].kind).toBe("stale")
    messages.length = 0
    await provider.handleCanonicalAgentMutation({
      type: "mutateAgent",
      canonical: true,
      action: "edit",
      name: "badhash",
      frontmatter: { mode: "primary" },
      body: "x",
      scope: "project",
      expectedHash: "absent",
      stamp: stampFor(canonical, "badhash", "project", "absent"),
      requestId: "req-bad-edit",
    })
    expect(errors(messages)[0].kind).toBe("stale")
    provider.dispose()
    canonical.dispose()
  })

  it("invalid action/scope/body/frontmatter/name return structured errors, never silent", async () => {
    const { provider, messages, canonical } = await setup()
    const goodStamp = stampFor(canonical, "x", "project", "absent")
    const cases: Record<string, unknown>[] = [
      { action: "delete", name: "x", frontmatter: {}, body: "b", scope: "project", expectedHash: "absent", stamp: goodStamp },
      { action: "create", name: "x", frontmatter: {}, body: "b", scope: "workspace", expectedHash: "absent", stamp: goodStamp },
      { action: "create", name: "x", frontmatter: {}, body: 42, scope: "project", expectedHash: "absent", stamp: goodStamp },
      { action: "create", name: "x", frontmatter: null, body: "b", scope: "project", expectedHash: "absent", stamp: goodStamp },
      { action: "create", name: "x", frontmatter: { name: "other" }, body: "b", scope: "project", expectedHash: "absent", stamp: goodStamp },
      { action: "create", name: "x", frontmatter: { mode: "primary" }, body: "b", scope: "project", expectedHash: "absent", stamp: { ...canonical.stamp, assetHash: "mismatch" } },
      { action: "create", name: "../evil", frontmatter: { mode: "primary" }, body: "b", scope: "project", expectedHash: "absent", stamp: goodStamp },
    ]
    let n = 0
    for (const c of cases) {
      messages.length = 0
      n++
      await provider.handleCanonicalAgentMutation({ type: "mutateAgent", canonical: true, requestId: `req-invalid-${n}`, ...c })
      const err = errors(messages)
      expect(err.length).toBe(1)
      expect(err[0].requestId).toBe(`req-invalid-${n}`)
      expect(typeof err[0].message).toBe("string")
    }
    provider.dispose()
    canonical.dispose()
  })

  it("project create without workspace returns structured error (no global fallback)", async () => {
    const { provider, messages, canonical } = await setup(false)
    await provider.handleCanonicalAgentMutation({
      type: "mutateAgent",
      canonical: true,
      action: "create",
      name: "nowhere",
      frontmatter: { mode: "primary" },
      body: "b",
      scope: "project",
      expectedHash: "absent",
      stamp: stampFor(canonical, "nowhere", "project", "absent"),
      requestId: "req-nows",
    })
    const err = errors(messages)
    expect(err).toHaveLength(1)
    expect(String(err[0].message).toLowerCase()).toContain("workspace")
    provider.dispose()
    canonical.dispose()
  })

  it("clear model/variant via null round-trips through markdown", async () => {
    const { provider, messages, canonical } = await setup()
    await provider.handleCanonicalAgentMutation({
      type: "mutateAgent",
      canonical: true,
      action: "create",
      name: "clearme",
      frontmatter: { name: "clearme", mode: "primary", model: "anthropic/claude-sonnet-4-20250514", variant: "thinking" },
      body: "b",
      scope: "project",
      expectedHash: "absent",
      stamp: stampFor(canonical, "clearme", "project", "absent"),
      requestId: "req-clear-1",
    })
    expect(applied(messages)).toHaveLength(1)
    messages.length = 0
    const hash = canonical.getAssetStamp("agent", "clearme", "project")
    await provider.handleCanonicalAgentMutation({
      type: "mutateAgent",
      canonical: true,
      action: "edit",
      name: "clearme",
      frontmatter: { name: "clearme", mode: "primary", model: null, variant: null },
      body: "b",
      scope: "project",
      expectedHash: hash,
      stamp: stampFor(canonical, "clearme", "project", hash),
      requestId: "req-clear-2",
    })
    expect(applied(messages)).toHaveLength(1)
    const read = canonical.readAsset("agent", "clearme", "project")
    if (!read.ok) throw new Error("expected asset")
    expect(read.frontmatter.model).toBeNull()
    expect(read.frontmatter.variant).toBeNull()
    provider.dispose()
    canonical.dispose()
  })
})

describe("dispatch top-level exceptions release UI pending with structured errors", () => {
  it("posts agentMutationError with the original requestId/name on handler throw (no retry)", async () => {
    const { provider, messages } = await setup()
    const internal = provider as unknown as {
      handleCanonicalAgentMutation: (msg: Record<string, unknown>) => Promise<void>
      dispatchCanonicalAgentMutation: (msg: Record<string, unknown>) => void
      dispose: () => void
    }
    internal.handleCanonicalAgentMutation = () => Promise.reject(new Error("boom"))
    internal.dispatchCanonicalAgentMutation({
      type: "mutateAgent",
      canonical: true,
      action: "edit",
      name: "helper",
      frontmatter: {},
      body: "b",
      scope: "project",
      expectedHash: "h",
      stamp: { globalHash: null, projectHash: null, materializationVersion: 0, assetHash: "h" },
      requestId: "req-dispatch-1",
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    const err = errors(messages)
    expect(err).toHaveLength(1)
    expect(err[0].requestId).toBe("req-dispatch-1")
    expect(err[0].name).toBe("helper")
    expect(err[0].message).toBe("boom")
    expect(err[0].kind).toBe("io")
    expect(err[0].canonical).toBe(true)
    internal.dispose()
  })
})

describe("schema equivalence with CLI ConfigAgentV1", () => {
  it("accepts CLI-legal requirements/color/model/permission shapes", () => {
    const text = [
      "---",
      "name: full",
      "mode: subagent",
      "model: custom-model-without-slash",
      "color: '#FF5733'",
      "permission:",
      "  read: allow",
      "  bash:",
      "    '*': ask",
      "requirements:",
      "  skills:",
      "    - bun",
      "  mcps:",
      "    - fs",
      "  vscode_extensions:",
      "    - name: Some Extension",
      "      id: publisher.some-extension",
      "tools:",
      "  read: true",
      "  write: false",
      "---",
      "Body",
      "",
    ].join("\n")
    const result = validateMarkdownAsset(text, "agent", "full.md")
    expect(result.valid).toBe(true)
  })

  it("accepts theme color literals and null permission; rejects scalar permission like the CLI loader", () => {
    for (const color of ["primary", "secondary", "accent", "success", "warning", "error", "info"]) {
      expect(validateMarkdownAsset(`---\nname: c\ncolor: ${color}\n---\nBody`, "agent", "c.md").valid).toBe(true)
    }
    expect(validateMarkdownAsset("---\nname: p\npermission: null\n---\nBody", "agent", "p.md").valid).toBe(true)
    // Probed: ConfigAgentV1.Info via ConfigParse.schema decodes a scalar
    // string as a Record (indexing its characters) and fails.
    for (const permission of ["allow", "ask", "deny"]) {
      const text = `---\nname: p\npermission: ${permission}\n---\nBody`
      expect(validateMarkdownAsset(text, "agent", "p.md").valid).toBe(false)
    }
  })

  it("rejects empty requirements, duplicate entries, bad IDs, and history modes", () => {
    expect(validateMarkdownAsset("---\nname: r\nrequirements: {}\n---\nBody", "agent", "r.md").valid).toBe(false)
    expect(
      validateMarkdownAsset("---\nname: r\nrequirements:\n  skills:\n    - bun\n    - bun\n---\nBody", "agent", "r.md").valid,
    ).toBe(false)
    expect(
      validateMarkdownAsset("---\nname: r\nrequirements:\n  skills:\n    - '   '\n---\nBody", "agent", "r.md").valid,
    ).toBe(false)
    expect(validateMarkdownAsset("---\nname: r\nmode: specialized\n---\nBody", "agent", "r.md").valid).toBe(false)
    expect(validateMarkdownAsset("---\nname: r\nmode: secondary\n---\nBody", "agent", "r.md").valid).toBe(false)
    expect(validateMarkdownAsset("---\nname: r\ncolor: blurple\n---\nBody", "agent", "r.md").valid).toBe(false)
    expect(validateMarkdownAsset("---\nname: r\npermission:\n  read: sometimes\n---\nBody", "agent", "r.md").valid).toBe(false)
    // `disabled` is an unknown rest key (CLI merges it into options), not a rejection.
    expect(validateMarkdownAsset("---\nname: r\ndisabled: true\n---\nBody", "agent", "r.md").valid).toBe(true)
  })

  it("writes CLI-legal fields; preserves unknown rest keys; drops CLI-rejected values", () => {
    const exported = buildExport("demo", {
      mode: "primary",
      prompt: "hi",
      displayName: "Demo",
      source: "project",
      color: "#FF5733",
      hidden: true,
      disable: false,
      options: { extra: 1 },
      tools: { read: true },
    } as never)
    expect(exported.displayName).toBe("Demo")
    expect(exported.source).toBe("project")
    expect(exported.color).toBe("#FF5733")
    expect(exported.options).toEqual({ extra: 1 })
    expect(exported.tools).toEqual({ read: true })
    // Unknown rest keys (including `disabled`) round-trip verbatim — they
    // are NOT first-class fields, but dropping them would lose data the CLI
    // merges into options.
    const withRest = buildExport("demo", { mode: "primary", prompt: "hi", disabled: true, foo: "bar" } as unknown as never)
    expect(withRest.disabled).toBe(true)
    expect(withRest.foo).toBe("bar")
    const withBad = buildExport("demo", { mode: "secondary", color: "blurple" } as unknown as never)
    expect(withBad.mode).toBeUndefined()
    expect(withBad.color).toBeUndefined()
  })
})

describe("mode-io CLI compatibility", () => {
  it("import/export round-trips supported fields without incompatible shapes", () => {
    const imported = parseImport(
      JSON.stringify({ name: "demo", description: "d", prompt: "hello", model: "a/b", variant: "v", mode: "subagent", temperature: 0.5, top_p: 0.9, steps: 5, permission: { read: "allow", edit: { "*": "ask" } } }),
      [],
    )
    expect(imported.ok).toBe(true)
    if (!imported.ok) throw new Error("import failed")
    const exported = buildExport(imported.name, imported.config)
    expect(exported.mode).toBe("subagent")
    expect(exported.model).toBe("a/b")
    expect(exported.variant).toBe("v")
    const reparsed = parseImport(JSON.stringify(exported), [])
    expect(reparsed.ok).toBe(true)
  })

  it("export drops string[] tools and bare-array requirements", () => {
    const exported = buildExport("demo", { mode: "primary", prompt: "hi" } as never)
    expect(exported.tools).toBeUndefined()
    expect(exported.requirements).toBeUndefined()
    const withBad = buildExport("demo", { mode: "primary", prompt: "hi", tools: ["read"], requirements: ["bun"] } as unknown as never)
    expect(withBad.tools).toBeUndefined()
    expect(withBad.requirements).toBeUndefined()
  })

  it("import rejects taken names", () => {
    const result = parseImport(JSON.stringify({ name: "taken", prompt: "hi" }), ["taken"])
    expect(result.ok).toBe(false)
  })
})

describe("extension <-> CLI markdown cross-acceptance on real files", () => {
  it("provider write then real .md read parses and CLI-decodes (requirements/color/model/permission/null)", async () => {
    const { provider, messages, canonical } = await setup()
    const frontmatter = {
      name: "cross",
      mode: "subagent",
      description: null,
      model: "custom-model",
      variant: null,
      temperature: null,
      top_p: 0.5,
      prompt: null,
      steps: null,
      color: "#123ABC",
      hidden: false,
      disable: false,
      displayName: "Cross",
      source: "project",
      options: { extra: "kept" },
      tools: { read: true, write: false },
      permission: { read: "allow", bash: { "*": "ask", uname: null } },
      requirements: { skills: ["bun"], mcps: ["fs"], vscode_extensions: [{ name: "Ext", id: "pub.ext" }] },
    }
    await provider.handleCanonicalAgentMutation({
      type: "mutateAgent",
      canonical: true,
      action: "create",
      name: "cross",
      frontmatter,
      body: "Cross body.",
      scope: "project",
      expectedHash: "absent",
      stamp: stampFor(canonical, "cross", "project", "absent"),
      requestId: "req-cross-1",
    })
    expect(applied(messages)).toHaveLength(1)
    const read = canonical.readAsset("agent", "cross", "project")
    if (!read.ok) throw new Error("expected asset")
    // Real .md on disk parses with identical frontmatter/body.
    expect(read.frontmatter.mode).toBe("subagent")
    expect(read.frontmatter.model).toBe("custom-model")
    expect(read.frontmatter.variant).toBeNull()
    expect(read.frontmatter.color).toBe("#123ABC")
    expect(read.body).toContain("Cross body.")
    // Extension strict schema accepts what it wrote.
    const raw = ((): string => {
      const dir = canonical.canonicalPaths.projectAssetDirs?.agent
      if (!dir) throw new Error("no project agent dir")
      return fs.readFileSync(path.join(dir, "cross.md"), "utf8")
    })()
    expect(validateMarkdownAsset(raw, "agent", "cross.md").valid).toBe(true)
    // CLI ConfigAgentV1 decodes the same file content.
    const parsed = parseMarkdown(raw)
    const decoded = Schema.decodeUnknownSync(ConfigAgentV1.Info)({ name: "cross", ...parsed.data, prompt: parsed.content })
    expect((decoded as Record<string, unknown>).mode).toBe("subagent")
    provider.dispose()
    canonical.dispose()
  })

  it("CLI-legal sample is accepted by the extension schema", () => {
    const cliSample = [
      "---",
      "description: Helps",
      "mode: all",
      "model: any-string-model",
      "variant: null",
      "temperature: 0.2",
      "top_p: null",
      "prompt: null",
      "steps: 8",
      "maxSteps: 8",
      "color: accent",
      "hidden: true",
      "disable: false",
      "displayName: Sample",
      "source: project",
      "options:",
      "  customParam: 1",
      "tools:",
      "  read: true",
      "permission:",
      "  read: ask",
      "requirements:",
      "  skills:",
      "    - bun",
      "---",
      "Sample body.",
      "",
    ].join("\n")
    expect(validateMarkdownAsset(cliSample, "agent", "sample.md").valid).toBe(true)
    const parsed = parseMarkdown(cliSample)
    const decoded = Schema.decodeUnknownSync(ConfigAgentV1.Info)({ name: "sample", ...parsed.data, prompt: parsed.content })
    expect((decoded as Record<string, unknown>).mode).toBe("all")
  })

  it("representative custom agent file decodes", () => {
    const markdown = assembleAssetMarkdown(
      { description: "Helps", mode: "primary", model: null, variant: null, permission: { read: "allow" }, requirements: { skills: ["bun"] }, tools: { read: true } },
      "You help.",
    )
    const parsed = parseMarkdown(markdown)
    expect(parsed.errors).toHaveLength(0)
    const validated = validateMarkdownAsset(markdown, "agent", "helper.md")
    expect(validated.valid).toBe(true)
    const config = { name: "helper", ...parsed.data, prompt: parsed.content }
    const decoded = Schema.decodeUnknownSync(ConfigAgentV1.Info)(config)
    expect((decoded as Record<string, unknown>).mode).toBe("primary")
  })
})

/**
 * Production loader path: the exact ConfigMarkdown.parse +
 * decodeUnknownOption(ConfigAgentV1.Info) call (with production options)
 * used by the CLI config-agent plugin — not just decodeUnknownSync.
 */
function decodeProductionAgent(markdown: string, name: string) {
  const parsed = ConfigMarkdown.parse(markdown)
  return Schema.decodeUnknownOption(ConfigAgentV1.Info)(
    { name, ...parsed.data, prompt: parsed.content.trim() },
    { errors: "all", propertyOrder: "original" },
  )
}

function readRawAgentMd(canonical: CanonicalConfigService, id: string): string {
  const dir = canonical.canonicalPaths.projectAssetDirs?.agent
  if (!dir) throw new Error("no project agent dir")
  return fs.readFileSync(path.join(dir, `${id}.md`), "utf8")
}

describe("production CLI loader accepts extension-written files (rest/options semantics)", () => {
  it("create with unknown keys, disabled, explicit options, null permission decodes with merged options", async () => {
    const { provider, messages, canonical } = await setup()
    await provider.handleCanonicalAgentMutation({
      type: "mutateAgent",
      canonical: true,
      action: "create",
      name: "rest",
      frontmatter: {
        name: "rest",
        mode: "primary",
        description: "Rest check",
        disable: false,
        maxSteps: 9,
        options: { explicit: "kept" },
        permission: null,
        requirements: { skills: ["bun"] },
        color: "#123ABC",
        model: "custom-model",
        tools: { read: true },
        disabled: true,
        foo: "bar",
      },
      body: "Rest body.",
      scope: "project",
      expectedHash: "absent",
      stamp: stampFor(canonical, "rest", "project", "absent"),
      requestId: "req-rest-1",
    })
    expect(applied(messages)).toHaveLength(1)
    const raw = readRawAgentMd(canonical, "rest")
    expect(validateMarkdownAsset(raw, "agent", "rest.md").valid).toBe(true)
    const decoded = decodeProductionAgent(raw, "rest")
    expect(Option.isSome(decoded)).toBe(true)
    if (Option.isNone(decoded)) throw new Error("production decode failed")
    const value = decoded.value as Record<string, unknown>
    // Unknown keys and `disabled` merge into options alongside explicit options.
    expect(value.options).toEqual({ explicit: "kept", disabled: true, foo: "bar" })
    // Null permission contributes nothing; the legacy tools record
    // normalizes into permission (read:true → read:allow). Known disable
    // stays first-class.
    expect(value.permission).toEqual({ read: "allow" })
    expect(value.disable).toBe(false)
    // maxSteps synthesizes steps; known fields decode normally.
    expect(value.steps).toBe(9)
    expect(value.mode).toBe("primary")
    expect(value.color).toBe("#123ABC")
    expect(value.model).toBe("custom-model")
    expect(value.requirements).toEqual({ skills: ["bun"] })
    provider.dispose()
    canonical.dispose()
  })

  it("edit touching only known keys preserves unknown rest keys on disk", async () => {
    const { provider, messages, canonical } = await setup()
    await provider.handleCanonicalAgentMutation({
      type: "mutateAgent",
      canonical: true,
      action: "create",
      name: "keeper",
      frontmatter: { name: "keeper", mode: "subagent", description: "v1", foo: "bar", disabled: true },
      body: "Keeper body.",
      scope: "project",
      expectedHash: "absent",
      stamp: stampFor(canonical, "keeper", "project", "absent"),
      requestId: "req-keeper-1",
    })
    expect(applied(messages)).toHaveLength(1)
    messages.length = 0
    // Simulate the coordinator edit: full retained frontmatter + one change.
    const current = canonical.readAsset("agent", "keeper", "project")
    if (!current.ok) throw new Error("expected asset")
    const hash = canonical.getAssetStamp("agent", "keeper", "project")
    await provider.handleCanonicalAgentMutation({
      type: "mutateAgent",
      canonical: true,
      action: "edit",
      name: "keeper",
      frontmatter: { ...(current.frontmatter as Record<string, unknown>), description: "v2" },
      body: current.body,
      scope: "project",
      expectedHash: hash,
      stamp: stampFor(canonical, "keeper", "project", hash),
      requestId: "req-keeper-2",
    })
    expect(applied(messages)).toHaveLength(1)
    const raw = readRawAgentMd(canonical, "keeper")
    expect(raw).toContain("description: v2")
    expect(raw).toContain("foo: bar")
    expect(raw).toContain("disabled: true")
    const decoded = decodeProductionAgent(raw, "keeper")
    expect(Option.isSome(decoded)).toBe(true)
    if (Option.isNone(decoded)) throw new Error("production decode failed")
    expect((decoded.value as Record<string, unknown>).options).toEqual({ foo: "bar", disabled: true })
    provider.dispose()
    canonical.dispose()
  })
})

describe("agent credential rejection at the host trust boundary", () => {
  it("create with plaintext credential frontmatter fails invalid without writing", async () => {
    const { provider, messages, canonical } = await setup()
    await provider.handleCanonicalAgentMutation({
      type: "mutateAgent",
      canonical: true,
      action: "create",
      name: "leaky",
      frontmatter: { name: "leaky", mode: "primary", apiKey: "sk-1234567890" },
      body: "Leaky body.",
      scope: "project",
      expectedHash: "absent",
      stamp: stampFor(canonical, "leaky", "project", "absent"),
      requestId: "req-leaky-1",
    })
    const err = errors(messages)
    expect(err).toHaveLength(1)
    expect(err[0].kind).toBe("invalid")
    expect(String(err[0].message)).toContain("must not contain credentials")
    expect(canonical.getAssetStamp("agent", "leaky", "project")).toBe("absent")
    provider.dispose()
    canonical.dispose()
  })

  it("create with a SecretStorage ref in agent frontmatter also fails invalid", async () => {
    const { provider, messages, canonical } = await setup()
    await provider.handleCanonicalAgentMutation({
      type: "mutateAgent",
      canonical: true,
      action: "create",
      name: "refy",
      frontmatter: { name: "refy", mode: "primary", options: { token: "secret:agent-key" } },
      body: "Ref body.",
      scope: "project",
      expectedHash: "absent",
      stamp: stampFor(canonical, "refy", "project", "absent"),
      requestId: "req-refy-1",
    })
    const err = errors(messages)
    expect(err).toHaveLength(1)
    expect(err[0].kind).toBe("invalid")
    expect(canonical.getAssetStamp("agent", "refy", "project")).toBe("absent")
    provider.dispose()
    canonical.dispose()
  })
})

describe("writeAsset failure and exception stamps are freshly re-read", () => {
  it("writeAsset failure posts the post-write stamp, not the pre-write one", async () => {
    const { provider, messages, canonical } = await setup()
    await provider.handleCanonicalAgentMutation({
      type: "mutateAgent",
      canonical: true,
      action: "create",
      name: "moved",
      frontmatter: { name: "moved", mode: "primary", description: "v1" },
      body: "Moved body.",
      scope: "project",
      expectedHash: "absent",
      stamp: stampFor(canonical, "moved", "project", "absent"),
      requestId: "req-moved-1",
    })
    expect(applied(messages)).toHaveLength(1)
    messages.length = 0
    const preHash = canonical.getAssetStamp("agent", "moved", "project")
    // Simulate a CAS race: the disk moves between the host pre-write stamp
    // check and the writeAsset failure.
    const dir = canonical.canonicalPaths.projectAssetDirs?.agent
    if (!dir) throw new Error("no project agent dir")
    const realWrite = canonical.writeAsset.bind(canonical)
    let movedHash = ""
    canonical.writeAsset = (async (...args: Parameters<typeof realWrite>) => {
      fs.writeFileSync(path.join(dir, "moved.md"), `${fs.readFileSync(path.join(dir, "moved.md"), "utf8")}\n<!-- external -->\n`, "utf8")
      movedHash = canonical.getAssetStamp("agent", "moved", "project")
      return { ok: false as const, kind: "stale" as const, message: "Simulated CAS race" }
    }) as typeof canonical.writeAsset
    await provider.handleCanonicalAgentMutation({
      type: "mutateAgent",
      canonical: true,
      action: "edit",
      name: "moved",
      frontmatter: { name: "moved", mode: "primary", description: "v2" },
      body: "Moved body.",
      scope: "project",
      expectedHash: preHash,
      stamp: stampFor(canonical, "moved", "project", preHash),
      requestId: "req-moved-2",
    })
    expect(movedHash).not.toBe(preHash)
    const err = errors(messages)
    expect(err).toHaveLength(1)
    expect(err[0].kind).toBe("stale")
    expect((err[0].stamp as Record<string, unknown>).assetHash).toBe(movedHash)
    provider.dispose()
    canonical.dispose()
  })

  it("writeAsset throw posts exactly one io error with a fresh stamp for known id/scope", async () => {
    const { provider, messages, canonical } = await setup()
    await provider.handleCanonicalAgentMutation({
      type: "mutateAgent",
      canonical: true,
      action: "create",
      name: "thrower",
      frontmatter: { name: "thrower", mode: "primary" },
      body: "Throw body.",
      scope: "project",
      expectedHash: "absent",
      stamp: stampFor(canonical, "thrower", "project", "absent"),
      requestId: "req-thrower-1",
    })
    expect(applied(messages)).toHaveLength(1)
    messages.length = 0
    const dir = canonical.canonicalPaths.projectAssetDirs?.agent
    if (!dir) throw new Error("no project agent dir")
    const realWrite = canonical.writeAsset.bind(canonical)
    let movedHash = ""
    canonical.writeAsset = (async (...args: Parameters<typeof realWrite>): Promise<never> => {
      fs.writeFileSync(path.join(dir, "thrower.md"), `${fs.readFileSync(path.join(dir, "thrower.md"), "utf8")}\n<!-- external -->\n`, "utf8")
      movedHash = canonical.getAssetStamp("agent", "thrower", "project")
      throw new Error("disk gone")
    }) as typeof canonical.writeAsset
    const preHash = canonical.getAssetStamp("agent", "thrower", "project")
    const internal = provider as unknown as {
      dispatchCanonicalAgentMutation: (msg: Record<string, unknown>) => void
      dispose: () => void
    }
    internal.dispatchCanonicalAgentMutation({
      type: "mutateAgent",
      canonical: true,
      action: "edit",
      name: "thrower",
      frontmatter: { name: "thrower", mode: "primary", description: "v2" },
      body: "Throw body.",
      scope: "project",
      expectedHash: preHash,
      stamp: stampFor(canonical, "thrower", "project", preHash),
      requestId: "req-thrower-2",
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(movedHash).not.toBe(preHash)
    const err = errors(messages)
    expect(err).toHaveLength(1)
    expect(err[0].kind).toBe("io")
    expect(err[0].message).toBe("disk gone")
    expect((err[0].stamp as Record<string, unknown>).assetHash).toBe(movedHash)
    provider.dispose()
    canonical.dispose()
  })

  it("exception with undeterminable id/scope posts null-asset stamp, still single", async () => {
    const { provider, messages } = await setup()
    const internal = provider as unknown as {
      handleCanonicalAgentMutation: (msg: Record<string, unknown>) => Promise<void>
      dispatchCanonicalAgentMutation: (msg: Record<string, unknown>) => void
      dispose: () => void
    }
    internal.handleCanonicalAgentMutation = () => Promise.reject(new Error("boom"))
    internal.dispatchCanonicalAgentMutation({
      type: "mutateAgent",
      canonical: true,
      action: "edit",
      frontmatter: {},
      body: "b",
      scope: "project",
      expectedHash: "h",
      stamp: { globalHash: null, projectHash: null, materializationVersion: 0, assetHash: "h" },
      requestId: "req-noname-1",
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    const err = errors(messages)
    expect(err).toHaveLength(1)
    expect(err[0].name).toBe("")
    expect((err[0].stamp as Record<string, unknown>).assetHash).toBeNull()
    internal.dispose()
  })
})
