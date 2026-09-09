import { describe, it, expect } from "bun:test"
import { parseImport, buildExport, MAX_IMPORT_SIZE } from "../../webview-ui/src/components/settings/mode-io"

describe("parseImport", () => {
  it("parses a valid full definition", () => {
    const json = JSON.stringify({
      name: "reviewer",
      description: "Reviews code",
      prompt: "You review code.",
      model: "anthropic/claude-sonnet-4-20250514",
      mode: "primary",
      temperature: 0.7,
      top_p: 0.9,
      steps: 10,
    })
    const result = parseImport(json, [])
    expect(result).toEqual({
      ok: true,
      name: "reviewer",
      config: {
        description: "Reviews code",
        prompt: "You review code.",
        model: "anthropic/claude-sonnet-4-20250514",
        mode: "primary",
        temperature: 0.7,
        top_p: 0.9,
        steps: 10,
      },
    })
  })

  it("defaults mode to primary when omitted", () => {
    const json = JSON.stringify({ name: "my-agent" })
    const result = parseImport(json, [])
    expect(result).toEqual({
      ok: true,
      name: "my-agent",
      config: { mode: "primary" },
    })
  })

  it("rejects invalid JSON", () => {
    expect(parseImport("not json", [])).toEqual({ ok: false, error: "invalidJson" })
  })

  it("rejects JSON null", () => {
    expect(parseImport("null", [])).toEqual({ ok: false, error: "invalidJson" })
  })

  it("rejects JSON array", () => {
    expect(parseImport("[]", [])).toEqual({ ok: false, error: "invalidJson" })
  })

  it("rejects JSON string", () => {
    expect(parseImport('"hello"', [])).toEqual({ ok: false, error: "invalidJson" })
  })

  it("rejects JSON number", () => {
    expect(parseImport("42", [])).toEqual({ ok: false, error: "invalidJson" })
  })

  it("rejects missing name", () => {
    expect(parseImport("{}", [])).toEqual({ ok: false, error: "invalidName" })
  })

  it("rejects name starting with number", () => {
    expect(parseImport(JSON.stringify({ name: "1agent" }), [])).toEqual({ ok: false, error: "invalidName" })
  })

  it("rejects name with uppercase", () => {
    expect(parseImport(JSON.stringify({ name: "MyAgent" }), [])).toEqual({ ok: false, error: "invalidName" })
  })

  it("rejects name with spaces", () => {
    expect(parseImport(JSON.stringify({ name: "my agent" }), [])).toEqual({ ok: false, error: "invalidName" })
  })

  it("rejects duplicate name", () => {
    const json = JSON.stringify({ name: "existing" })
    expect(parseImport(json, ["existing", "other"])).toEqual({ ok: false, error: "nameTaken" })
  })

  it("rejects explicit invalid mode values (the CLI loader drops such files)", () => {
    const json = JSON.stringify({ name: "test", mode: "bogus" })
    expect(parseImport(json, [])).toEqual({ ok: false, error: "invalidField" })
  })

  it("accepts all valid mode values", () => {
    for (const mode of ["subagent", "primary", "all"] as const) {
      const json = JSON.stringify({ name: "test", mode })
      const result = parseImport(json, [])
      expect(result).toEqual({ ok: true, name: "test", config: { mode } })
    }
  })

  it("rejects wrong-typed values on present fields instead of silently dropping them", () => {
    const cases: Array<Record<string, unknown>> = [
      { description: 123 },
      { prompt: true },
      { model: [] },
      { variant: 42 },
      { temperature: "hot" },
      { top_p: "high" },
      { steps: "many" },
      { steps: 2.5 },
      { steps: 0 },
      { hidden: "yes" },
      { disable: 1 },
      { displayName: 7 },
      { source: null },
      { color: "blurple" },
      { maxSteps: -3 },
      { options: [] },
      { tools: ["read"] },
      { tools: { read: "yes" } },
      { permission: "allow" },
      { permission: 42 },
      { permission: { read: "sometimes" } },
      { permission: { bash: { "*": "ask", typo: "bogus" } } },
      { requirements: ["bun"] },
      { requirements: {} },
      { requirements: { skills: [] } },
      { requirements: { skills: ["bun", "bun"] } },
      { requirements: { skills: ["   "] } },
      { requirements: { vscode_extensions: [{ name: "Ext", id: "bad id!" }] } },
    ]
    for (const fields of cases) {
      const result = parseImport(JSON.stringify({ name: "test", ...fields }), [])
      expect(result).toEqual({ ok: false, error: "invalidField" })
    }
  })

  it("preserves null delete sentinels only where CLI NullOr allows", () => {
    const json = JSON.stringify({
      name: "test",
      description: null,
      prompt: null,
      model: null,
      variant: null,
      temperature: null,
      top_p: null,
      steps: null,
    })
    const result = parseImport(json, [])
    expect(result).toEqual({
      ok: true,
      name: "test",
      config: { description: null, prompt: null, model: null, variant: null, temperature: null, top_p: null, steps: null, mode: "primary" },
    })
  })

  it("rejects scalar permission (the CLI loader rejects it) but keeps null", () => {
    expect(parseImport(JSON.stringify({ name: "test", permission: "allow" }), [])).toEqual({
      ok: false,
      error: "invalidField",
    })
    expect(parseImport(JSON.stringify({ name: "test", permission: null }), [])).toEqual({
      ok: true,
      name: "test",
      config: { mode: "primary", permission: null },
    })
  })

  it("trims whitespace from name", () => {
    const json = JSON.stringify({ name: "  trimmed  " })
    // "trimmed" doesn't have hyphens or digits so it should be valid
    const result = parseImport(json, [])
    expect(result).toEqual({ ok: true, name: "trimmed", config: { mode: "primary" } })
  })

  it("preserves valid permission entries", () => {
    const json = JSON.stringify({
      name: "reviewer",
      permission: { read: "allow", bash: "allow", edit: "deny", mcp: "ask" },
    })
    const result = parseImport(json, [])
    expect(result).toEqual({
      ok: true,
      name: "reviewer",
      config: {
        mode: "primary",
        permission: { read: "allow", bash: "allow", edit: "deny", mcp: "ask" },
      },
    })
  })

  it("rejects permission maps with any invalid entry (no partial filtering)", () => {
    const json = JSON.stringify({
      name: "test",
      permission: { read: "allow", bad: "nope", num: 42, arr: [] },
    })
    expect(parseImport(json, [])).toEqual({ ok: false, error: "invalidField" })
  })

  it("preserves nested per-pattern permission rules", () => {
    const json = JSON.stringify({
      name: "test",
      permission: { bash: { "*": "ask", uname: "allow" }, read: "allow" },
    })
    const result = parseImport(json, [])
    expect(result).toEqual({
      ok: true,
      name: "test",
      config: {
        mode: "primary",
        permission: { bash: { "*": "ask", uname: "allow" }, read: "allow" },
      },
    })
  })

  it("rejects non-object permission field", () => {
    const json = JSON.stringify({ name: "test", permission: 42 })
    expect(parseImport(json, [])).toEqual({ ok: false, error: "invalidField" })
  })

  it("preserves CLI-legal known fields and unknown rest keys verbatim", () => {
    const json = JSON.stringify({
      name: "demo",
      description: "d",
      prompt: "hello",
      model: "custom-model",
      variant: null,
      mode: "subagent",
      temperature: 0.5,
      top_p: null,
      steps: 5,
      hidden: true,
      disable: false,
      displayName: "Demo",
      source: "project",
      color: "#FF5733",
      maxSteps: 9,
      options: { customParam: 1 },
      tools: { read: true, write: false },
      permission: { read: "allow", bash: null },
      requirements: { skills: ["bun"], vscode_extensions: [{ name: "Ext", id: "pub.ext" }] },
      disabled: true,
      foo: "bar",
    })
    const result = parseImport(json, [])
    expect(result).toEqual({
      ok: true,
      name: "demo",
      config: {
        description: "d",
        prompt: "hello",
        model: "custom-model",
        variant: null,
        mode: "subagent",
        temperature: 0.5,
        top_p: null,
        steps: 5,
        hidden: true,
        disable: false,
        displayName: "Demo",
        source: "project",
        color: "#FF5733",
        maxSteps: 9,
        options: { customParam: 1 },
        tools: { read: true, write: false },
        permission: { read: "allow", bash: null },
        requirements: { skills: ["bun"], vscode_extensions: [{ name: "Ext", id: "pub.ext" }] },
        disabled: true,
        foo: "bar",
      },
    })
  })

  it("round-trips known fields and unknown rest keys through export and import", () => {
    const imported = parseImport(
      JSON.stringify({
        name: "demo",
        description: "d",
        mode: "primary",
        color: "accent",
        hidden: false,
        options: { a: 1 },
        tools: { read: true },
        requirements: { mcps: ["fs"] },
        foo: "bar",
        disabled: true,
      }),
      [],
    )
    expect(imported.ok).toBe(true)
    if (!imported.ok) throw new Error("import failed")
    const exported = buildExport(imported.name, imported.config)
    expect(exported.color).toBe("accent")
    expect(exported.hidden).toBe(false)
    expect(exported.options).toEqual({ a: 1 })
    expect(exported.tools).toEqual({ read: true })
    expect(exported.requirements).toEqual({ mcps: ["fs"] })
    expect(exported.foo).toBe("bar")
    expect(exported.disabled).toBe(true)
    const reparsed = parseImport(JSON.stringify(exported), [])
    expect(reparsed).toEqual(imported)
  })

  it("round-trips permission through export and import", () => {
    const cfg = {
      mode: "primary" as const,
      prompt: "Review code",
      permission: { read: "allow" as const, edit: "deny" as const },
    }
    const exported = buildExport("reviewer", cfg)
    const json = JSON.stringify(exported)
    const result = parseImport(json, [])
    expect(result).toEqual({
      ok: true,
      name: "reviewer",
      config: { mode: "primary", prompt: "Review code", permission: { read: "allow", edit: "deny" } },
    })
  })
})

describe("agent credential rejection (shared rule, no agent credential mechanism)", () => {
  it("parseImport rejects credential keys top-level, nested, refs, and case variants", () => {
    const bad: Array<Record<string, unknown>> = [
      { apiKey: "sk-123" },
      { apiKey: "secret:agent-key" },
      { API_KEY: "sk-123" },
      { "api-key": "sk-123" },
      { Token: "abc" },
      { SECRET: "abc" },
      { Password: "hunter2" },
      { Credential: "abc" },
      { cookie: "abc" },
      { COOKIES: "abc" },
      { Authorization: "Bearer abc" },
      { headers: { Authorization: "Bearer abc" } },
      { options: { customParam: 1, client_secret: "abc" } },
      { "unknown deep": 1, nested: { deep: { password: "x" } } },
    ]
    for (const fields of bad) {
      expect(parseImport(JSON.stringify({ name: "test", mode: "primary", ...fields }), [])).toEqual({
        ok: false,
        error: "invalidField",
      })
    }
  })

  it("parseImport accepts null/empty credential values and benign lookalikes", () => {
    for (const fields of [{ apiKey: null }, { apiKey: "" }, { token: null }]) {
      const result = parseImport(JSON.stringify({ name: "test", ...fields }), [])
      expect(result.ok).toBe(true)
    }
    const benign = parseImport(
      JSON.stringify({
        name: "test",
        description: "Sets the Authorization header when credentialRequested is false",
        mode: "primary",
        disabled: true,
        credentialRequested: false,
      }),
      [],
    )
    expect(benign.ok).toBe(true)
  })

  it("buildExport refuses credential-bearing configs instead of writing them", () => {
    expect(() =>
      buildExport("reviewer", { mode: "primary", prompt: "hi", apiKey: "sk-123" } as never),
    ).toThrow(/must not contain credentials/)
    expect(() =>
      buildExport("reviewer", { mode: "primary", prompt: "hi", options: { token: "secret:x" } } as never),
    ).toThrow(/must not contain credentials/)
    // Clean configs still export.
    expect(buildExport("reviewer", { mode: "primary", prompt: "hi" }).prompt).toBe("hi")
  })

  it("never merges __proto__/constructor/prototype keys and never pollutes", () => {
    const hasOwn = (obj: unknown, key: string): boolean => Object.prototype.hasOwnProperty.call(obj, key)
    const imported = parseImport(JSON.stringify({ name: "test", mode: "primary", __proto__: { polluted: true } }), [])
    expect(imported.ok).toBe(true)
    if (imported.ok) {
      expect(hasOwn(imported.config, "__proto__")).toBe(false)
    }
    const exported = buildExport("test", { mode: "primary", constructor: { polluted: true } } as never)
    expect(hasOwn(exported, "constructor")).toBe(false)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
})

describe("buildExport", () => {
  it("includes name and all config fields", () => {
    const result = buildExport("reviewer", {
      description: "Reviews code",
      prompt: "You review code.",
      model: "anthropic/claude-sonnet-4-20250514",
      mode: "primary",
      temperature: 0.7,
      top_p: 0.9,
      steps: 10,
    })
    expect(result).toEqual({
      name: "reviewer",
      description: "Reviews code",
      prompt: "You review code.",
      model: "anthropic/claude-sonnet-4-20250514",
      mode: "primary",
      temperature: 0.7,
      top_p: 0.9,
      steps: 10,
    })
  })

  it("handles empty config", () => {
    expect(buildExport("minimal", {})).toEqual({ name: "minimal" })
  })
})

describe("MAX_IMPORT_SIZE", () => {
  it("is 1 MB", () => {
    expect(MAX_IMPORT_SIZE).toBe(1_048_576)
  })
})
