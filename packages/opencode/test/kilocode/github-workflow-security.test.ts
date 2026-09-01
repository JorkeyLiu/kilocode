import { describe, expect, test } from "bun:test"
import path from "path"
import * as fs from "fs/promises"
import { isValidModelID, isValidEnvName, isValidProviderID, validateWorkflowInputs, buildWorkflowContent, buildGithubWorkflowEnv } from "../../src/kilocode/github-workflow"
import { tmpdir } from "../fixture/fixture"

describe("github workflow validators — locked patterns (LOCK-006 safety)", () => {
  test("valid provider/model/env pass", () => {
    expect(isValidProviderID("my-provider")).toBe(true)
    expect(isValidProviderID("my_provider")).toBe(true)
    expect(isValidProviderID("a1")).toBe(true)
    expect(isValidModelID("my-model")).toBe(true)
    expect(isValidModelID("my_model-1.0/foo")).toBe(true)
    expect(isValidModelID("Model_A-1.0/b")).toBe(true)
    expect(isValidModelID("a")).toBe(true)
    expect(isValidModelID("A1._/-")).toBe(true)
    expect(isValidEnvName("MY_VAR")).toBe(true)
    expect(isValidEnvName("lower_var")).toBe(true)
    expect(isValidEnvName("MixedCase123")).toBe(true)
    expect(isValidEnvName("_private")).toBe(true)
    expect(isValidEnvName("A")).toBe(true)
    expect(() => validateWorkflowInputs("my-provider", "my-model_1.0/foo", ["MY_VAR", "OTHER_API_KEY"])).not.toThrow()
    const content = buildWorkflowContent("my-provider", "my-model_1.0/foo", ["MY_VAR"])
    expect(content).toContain("my-provider/my-model_1.0/foo")
    expect(content).toContain("MY_VAR: ${{ secrets.MY_VAR }}")
  })

  test("invalid provider rejected", () => {
    const bad = ["", "BadUpper", "a".repeat(129), "bad\nprovider", "bad:provider", "bad/provider", "${{ secrets.MY }}", "bad hash", 'bad"quote', "bad'quote"]
    for (const p of bad) expect(isValidProviderID(p)).toBe(false)
    for (const p of bad) expect(() => validateWorkflowInputs(p, "good-model", [])).toThrow()
    for (const p of bad) expect(() => buildWorkflowContent(p, "good-model", [])).toThrow()
  })

  test("invalid model rejected — newline, colon, hash, quotes, YAML expr", () => {
    const bad = ["", "a".repeat(129), "bad\nmodel", "bad:colon", "bad#hash", 'bad"quote', "bad'quote", "bad ${{ secrets }}", "bad:model", "/leading", "bad\nnewline", "bad:evil"]
    for (const m of bad) expect(isValidModelID(m)).toBe(false)
    for (const m of bad) expect(() => validateWorkflowInputs("my-provider", m, [])).toThrow()
    for (const m of bad) expect(() => buildWorkflowContent("my-provider", m, [])).toThrow()
    // valid hyphen/underscore/dot/slash pass
    expect(isValidModelID("a-b_c.d/e")).toBe(true)
    expect(isValidModelID("A-1_B.2/C")).toBe(true)
  })

  test("invalid env rejected — must not silently omit secrets", () => {
    const bad = ["", "123bad", "bad-env", "bad env", "BAD-VAR", "bad\nvar", "bad${{}}", "bad:colon", "bad#hash", 'bad"quote', "a".repeat(129)]
    for (const e of bad) expect(isValidEnvName(e)).toBe(false)
    for (const e of bad) expect(() => buildGithubWorkflowEnv("my-provider", [e])).toThrow()
    for (const e of bad) expect(() => validateWorkflowInputs("my-provider", "my-model", [e])).toThrow()
    for (const e of bad) expect(() => buildWorkflowContent("my-provider", "my-model", [e])).toThrow()
    // valid lower/upper env pass
    expect(isValidEnvName("lower")).toBe(true)
    expect(isValidEnvName("UPPER")).toBe(true)
    expect(isValidEnvName("Mixed_123")).toBe(true)
  })

  test("malicious workflow input cannot create a file — fail-closed before write", async () => {
    await using tmp = await tmpdir()
    const out = path.join(tmp.path, ".github", "workflows", "kilo.yml")
    // valid write should succeed
    const good = buildWorkflowContent("my-provider", "my-model", ["GOOD_VAR"])
    await fs.mkdir(path.dirname(out), { recursive: true })
    await fs.writeFile(out, good)
    expect(await fs.stat(out).then(() => true).catch(() => false)).toBe(true)
    await fs.rm(out)
    // malicious should throw before file write and leave no file
    const malicious = [
      { p: "my-provider", m: "bad\nmodel", e: ["GOOD_VAR"] },
      { p: "my-provider", m: "bad:colon", e: ["GOOD_VAR"] },
      { p: "my-provider", m: "my-model", e: ["BAD-ENV"] },
      { p: "bad\nprovider", m: "my-model", e: [] },
      { p: "my-provider", m: '${{ secrets.MY }}', e: [] },
    ]
    for (const c of malicious) {
      let threw = false
      try {
        const content = buildWorkflowContent(c.p, c.m, c.e)
        await fs.writeFile(out, content)
      } catch {
        threw = true
      }
      expect(threw).toBe(true)
      expect(await fs.stat(out).then(() => true).catch(() => false)).toBe(false)
    }
  })

  test("amazon-bedrock and kilo env handling respects validation", () => {
    expect(buildGithubWorkflowEnv("amazon-bedrock", ["SHOULD_BE_EMPTY"])).toBe("")
    // amazon-bedrock with invalid env still throws
    expect(() => buildGithubWorkflowEnv("amazon-bedrock", ["BAD-ENV"])).toThrow()
    const kilo = buildGithubWorkflowEnv("kilo", [])
    expect(kilo).toContain("KILO_API_KEY")
    expect(kilo).toContain("KILO_ORG_ID")
  })
})
