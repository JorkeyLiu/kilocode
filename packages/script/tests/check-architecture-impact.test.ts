// kilocode_change - new file

import { describe, expect, test } from "bun:test"
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import os from "node:os"
import path from "node:path"
import {
  type FileChange,
  WORKTREE_ADVICE,
  classifyChanges,
  classifyFile,
  diffHasCode,
  diffHasCodeFor,
  evaluateCheck,
  hasCode,
  isCanonicalDoc,
  parseDeclaration,
  parseDiff,
  parseNameStatus,
  validateDeclaration,
  yamlHasCode,
} from "../../../script/check-architecture-impact"

const ARCH_DOC = "packages/kilo-docs/pages/contributing/architecture/cli-runtime.md"

const codeDiff = (old: string, add: string) =>
  ["diff --git a/x.ts b/x.ts", "index 000..111 100644", "--- a/x.ts", "+++ b/x.ts", "@@ -1 +1,2 @@", `-${old}`, `+${add}`].join("\n")

const commentOnlyDiff = ["@@ -1,2 +1,2 @@", "-// old note", "+// new note"].join("\n")

// ─── parseDiff ─────────────────────────────────────────────────────────────

describe("parseDiff", () => {
  test("collects added and removed lines and skips headers", () => {
    const diff = [
      "diff --git a/a.ts b/a.ts",
      "index 000..111 100644",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,3 +1,3 @@",
      "-gone",
      " shared",
      "+arrived",
      "\\ No newline at end of file",
    ].join("\n")
    expect(parseDiff(diff)).toEqual({ added: ["arrived"], removed: ["gone"] })
  })

  test("handles empty input and binary diffs", () => {
    expect(parseDiff("")).toEqual({ added: [], removed: [] })
    expect(parseDiff("Binary files a/x.png and b/x.png differ")).toEqual({ added: [], removed: [] })
  })

  test("retains added `++` and removed `--` content lines inside hunks", () => {
    // Content `++count;` produces the raw diff line `+++count;` and content
    // `--count;` produces `---count;` — these must not be mistaken for the
    // pre-hunk `+++ b/...` / `--- a/...` headers.
    const added = ["@@ -1 +1,2 @@", "-count", "+++count;"].join("\n")
    expect(parseDiff(added)).toEqual({ added: ["++count;"], removed: ["count"] })
    const removed = ["@@ -1 +1,2 @@", "---count;", "+count"].join("\n")
    expect(parseDiff(removed)).toEqual({ added: ["count"], removed: ["--count;"] })
  })

  test("pre-hunk --- / +++ headers are still skipped outside hunks", () => {
    const diff = [
      "diff --git a/x.ts b/x.ts",
      "index 000..111 100644",
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -1 +1 @@",
      "---a-line-starting-with-dashes",
      "+++a-line-starting-with-pluses",
    ].join("\n")
    expect(parseDiff(diff)).toEqual({ added: ["++a-line-starting-with-pluses"], removed: ["--a-line-starting-with-dashes"] })
  })
})

// ─── executable vs comment detection ───────────────────────────────────────

describe("hasCode / diffHasCode", () => {
  test("comment, blank, and closer-only lines are not code", () => {
    expect(hasCode(["// comment", "   ", "/* doc */", "*/", "# yaml", "}", ")"])).toBe(false)
  })

  test("block comments spanning lines are not code", () => {
    expect(hasCode(["/* open", "still comment", "*/", "// after"])).toBe(false)
  })

  test("any executable line is code", () => {
    expect(hasCode(["/* open", "*/", "const x = 1"])).toBe(true)
    expect(hasCode(["// note", "export const y = 2 // kilocode_change"])).toBe(true)
  })

  test("diffHasCode distinguishes executable from comment-only diffs", () => {
    expect(diffHasCode(codeDiff("const a = 1", "const b = 2"))).toBe(true)
    expect(diffHasCode(commentOnlyDiff)).toBe(false)
  })
})

describe("scanner-based executable detection", () => {
  test("#private fields and generator methods are code", () => {
    expect(hasCode(["#private = 1"])).toBe(true)
    expect(hasCode(["  #private = 1"])).toBe(true)
    expect(hasCode(["#private; // kilocode_change"])).toBe(true)
    expect(hasCode(["*gen() { yield 1 }"])).toBe(true)
    expect(hasCode(["  *generator() { yield this.#private }"])).toBe(true)
    expect(hasCode(["yield* this.items"])).toBe(true)
    expect(diffHasCode(codeDiff("const a = 1", "#private = 2"))).toBe(true)
  })

  test("decorators, templates, JSX, and string content are code", () => {
    expect(hasCode(["@injectable()"])).toBe(true)
    expect(hasCode(["const tpl = `text ${value}`"])).toBe(true)
    expect(hasCode(["const jsx = <div>{items.map((x) => <span>{x}</span>)}</div>"])).toBe(true)
    expect(hasCode(['const s = "// not a comment"'])).toBe(true)
  })

  test("full JSDoc blocks and example code are not code", () => {
    expect(hasCode(["/**", " * Example:", " *   const example = true", " */"])).toBe(false)
    expect(hasCode(["/** single-line doc */"])).toBe(false)
  })

  test("block-comment continuations and closers are not code", () => {
    expect(hasCode([" * continuation prose"])).toBe(false)
    expect(hasCode([" * @param x the value"])).toBe(false)
    expect(hasCode(["*/"])).toBe(false)
    expect(hasCode([" * prose", " */", " * more prose"])).toBe(false)
  })

  test("keyword-starting JSDoc continuation lines are not code", () => {
    expect(hasCode([" * this function returns the count"])).toBe(false)
    expect(hasCode([" * type: the resolved type"])).toBe(false)
    expect(hasCode([" *   const example = true"])).toBe(false)
    expect(hasCode([" * function foo is called"])).toBe(false)
    expect(hasCode([" * new default behavior"])).toBe(false)
    expect(hasCode([" * return value when set"])).toBe(false)
  })

  test("bare ` *` separator and closer lines are not code", () => {
    expect(hasCode([" *"])).toBe(false)
    expect(hasCode([" * ", " */"])).toBe(false)
    expect(hasCode([" *", " * more prose"])).toBe(false)
    expect(hasCode([" * /"])).toBe(false)
  })

  test("a bare ` *` line does not swallow the following code line", () => {
    expect(hasCode([" *", "const x = 1"])).toBe(true)
    expect(hasCode([" *", "foo = 1"])).toBe(true)
    expect(hasCode([" *", "*gen() { yield 1 }"])).toBe(true)
  })

  test("added ++ / removed -- executable lines are code", () => {
    expect(hasCode(["++count;"])).toBe(true)
    expect(hasCode(["--count;"])).toBe(true)
    expect(diffHasCode(["@@ -1 +1 @@", "+++count;"].join("\n"))).toBe(true)
    expect(diffHasCode(["@@ -1 +1 @@", "---count;"].join("\n"))).toBe(true)
    expect(diffHasCode(["@@ -1 +1,2 @@", "-old", "+++count;"].join("\n"))).toBe(true)
  })

  test("generator, multiplication, and yield-star code stays code", () => {
    expect(hasCode(["a * b"])).toBe(true)
    expect(hasCode(["*gen() { yield 1 }"])).toBe(true)
    expect(hasCode(["  *generator() { yield this.#private }"])).toBe(true)
    expect(hasCode(["yield* this.items"])).toBe(true)
  })

  test("JSX comments are not code", () => {
    expect(hasCode(["{/* JSX comment */}"])).toBe(false)
    expect(hasCode(["{/*", "  multi line", "*/}"])).toBe(false)
  })

  test("blank and closer-only changes are not code", () => {
    expect(hasCode([""])).toBe(false)
    expect(hasCode(["   "])).toBe(false)
    expect(hasCode(["}"])).toBe(false)
    expect(hasCode(["});", ","])).toBe(false)
    expect(diffHasCode(["@@ -1 +1 @@", "-}", "+}"].join("\n"))).toBe(false)
  })

  test("code after a JSDoc continuation line still counts", () => {
    expect(hasCode([" * @param x", "const real = 1"])).toBe(true)
    expect(hasCode(["/* open", "*/", "const x = 1"])).toBe(true)
  })
})

describe("Kotlin and YAML source detection", () => {
  test("Kotlin executable lines are code through the TS scanner", () => {
    expect(hasCode(["class KiloBackendCliManager(private val service: Service) {"])).toBe(true)
    expect(hasCode(["@Inject"])).toBe(true)
    expect(hasCode(["val manager = KiloBackendCliManager(...)"])).toBe(true)
    expect(hasCode(['val x = "$value"'])).toBe(true)
    expect(hasCode(["data class Workspace(val id: String, val path: Path) {"])).toBe(true)
  })

  test("Kotlin comment-only lines are not code", () => {
    expect(hasCode(["// Kotlin line comment"])).toBe(false)
    expect(hasCode(["/* Kotlin block */"])).toBe(false)
    expect(hasCode(["/**", " * Kotlin KDoc prose", " */"])).toBe(false)
    expect(hasCode([" * KDoc continuation"])).toBe(false)
  })

  test("diffHasCodeFor routes Kotlin through the scanner and YAML through the comment detector", () => {
    const ktCode = ["diff --git a/x.kt b/x.kt", "@@ -1 +1,2 @@", "-// old", "+fun main() {}"].join("\n")
    expect(diffHasCodeFor("packages/shared/src/main/kotlin/ai/example/Foo.kt", ktCode)).toBe(true)
    const ktComment = ["diff --git a/x.kt b/x.kt", "@@ -1 +1,2 @@", "-// old", "+// new"].join("\n")
    expect(diffHasCodeFor("packages/shared/src/main/kotlin/ai/example/Foo.kt", ktComment)).toBe(false)
  })

  test("yamlHasCode treats blank and full-line # as comments, everything else as code", () => {
    expect(yamlHasCode(["# full-line comment", "  # indented comment", "", "   "])).toBe(false)
    expect(yamlHasCode(["# comment", "on: push"])).toBe(true)
    expect(yamlHasCode(["# comment", "  on: push"])).toBe(true)
    expect(yamlHasCode(["name: \"Release #123\""])).toBe(true)
  })

  test("diffHasCodeFor uses the YAML detector for .yml and .yaml files", () => {
    const code = ["@@ -1,2 +1,3 @@", "-# old", "+on: push", "+jobs: {}"].join("\n")
    const comment = ["@@ -1,2 +1,2 @@", "-# old note", "+# new note"].join("\n")
    expect(diffHasCodeFor(".github/workflows/foo.yml", code)).toBe(true)
    expect(diffHasCodeFor(".github/workflows/foo.yml", comment)).toBe(false)
    expect(diffHasCodeFor(".github/workflows/foo.yaml", comment)).toBe(false)
    expect(diffHasCodeFor(".github/workflows/foo.yaml", code)).toBe(true)
    // Non-YAML files keep using the scanner.
    expect(diffHasCodeFor("packages/opencode/src/server/event.ts", codeDiff("a", "b"))).toBe(true)
  })
})

// ─── path classification ───────────────────────────────────────────────────

describe("classifyFile / classifyChanges", () => {
  test("high executable change in runtime lifecycle path", () => {
    const sig = classifyFile("packages/opencode/src/kilocode/server/drain-control.ts", codeDiff("const a = 1", "const b = 2"))
    expect(sig).toEqual([{ tier: "high", kind: "runtime-lifecycle", file: "packages/opencode/src/kilocode/server/drain-control.ts" }])
  })

  test("comment-only change on a high path produces no signal", () => {
    expect(classifyFile("packages/opencode/src/kilocode/server/drain-control.ts", commentOnlyDiff)).toEqual([])
    expect(classifyFile("packages/opencode/src/config/config.ts", commentOnlyDiff)).toEqual([])
  })

  test("added ++ / removed -- on a high path signals high", () => {
    const added = ["@@ -1 +1,2 @@", "+++count;"].join("\n")
    const removed = ["@@ -1 +1,2 @@", "---count;"].join("\n")
    expect(classifyFile("packages/opencode/src/kilocode/server/drain-control.ts", added)[0]?.tier).toBe("high")
    expect(classifyFile("packages/opencode/src/kilocode/server/drain-control.ts", removed)[0]?.tier).toBe("high")
  })

  test("keyword JSDoc and bare-star continuation changes on a high path produce no signal", () => {
    const diff = ["@@ -1 +1,3 @@", "+ * this is new prose", "+ *", "+ * type: string"].join("\n")
    expect(classifyFile("packages/opencode/src/kilocode/server/drain-control.ts", diff)).toEqual([])
    expect(classifyFile("packages/opencode/src/config/config.ts", diff)).toEqual([])
  })

  test("test-name-only change on a high path produces no signal", () => {
    expect(classifyFile("packages/opencode/test/kilocode/server/drain-control.test.ts", codeDiff('test("old", () => {', 'test("new", () => {'))).toEqual([])
  })

  test("executable config schema change is high", () => {
    const sig = classifyFile("packages/opencode/src/config/config.ts", codeDiff("const a = 1", "const b = 2"))
    expect(sig[0]?.tier).toBe("high")
    expect(sig[0]?.kind).toBe("config-schema")
  })

  test("executable http api change is high", () => {
    const sig = classifyFile("packages/opencode/src/kilocode/server/httpapi/groups/kilocode.ts", codeDiff("const a = 1", "const b = 2"))
    expect(sig[0]?.tier).toBe("high")
    expect(sig[0]?.kind).toBe("http-api")
  })

  test("provider lifecycle dir and hot-config are high", () => {
    expect(classifyFile("packages/opencode/src/kilocode/provider/provider.ts", codeDiff("a", "b"))[0]?.kind).toBe("provider-lifecycle")
    expect(classifyFile("packages/opencode/src/kilocode/config/hot-keys.ts", codeDiff("a", "b"))[0]?.kind).toBe("hot-config")
  })

  test("non-source file in a high-signal dir is not a high signal", () => {
    const sig = classifyFile("packages/opencode/src/kilocode/provider/models-api.json", codeDiff("{\n", "{\n"))
    expect(sig.filter((s) => s.tier === "high")).toEqual([])
  })

  test("one high signal wins over a medium dir match", () => {
    const sig = classifyFile("packages/opencode/src/kilocode/server/generation-gate.ts", codeDiff("a", "b"))
    expect(sig).toHaveLength(1)
    expect(sig[0]?.tier).toBe("high")
  })

  test("medium paths warn", () => {
    expect(classifyFile("packages/opencode/src/server/cors.ts", codeDiff("a", "b"))[0]?.kind).toBe("middleware")
    expect(classifyFile("packages/opencode/src/bus/index.ts", codeDiff("a", "b"))[0]?.kind).toBe("event-sse")
    expect(classifyFile("packages/opencode/src/session/message.ts", codeDiff("a", "b"))[0]?.kind).toBe("session-contract")
    expect(classifyFile("packages/kilo-vscode/AGENTS.md", codeDiff("old", "new"))[0]?.kind).toBe("agent-conventions")
    expect(classifyFile("packages/opencode/src/kilocode/config/overlay.ts", codeDiff("a", "b"))[0]?.kind).toBe("arch-adjacent")
  })

  test("architecture docs are evidence, not signals", () => {
    expect(classifyFile(ARCH_DOC, codeDiff("old", "new"))).toEqual([])
    expect(isCanonicalDoc(ARCH_DOC)).toBe(true)
    expect(isCanonicalDoc("packages/kilo-docs/pages/contributing/architecture")).toBe(true)
    expect(isCanonicalDoc("packages/opencode/src/config/config.ts")).toBe(false)
  })

  test("classifyChanges aggregates without dupes per file", () => {
    const changes = [
      { path: "packages/opencode/src/kilocode/server/drain-control.ts", diff: codeDiff("a", "b") },
      { path: "packages/opencode/src/server/cors.ts", diff: codeDiff("a", "b") },
      { path: "packages/opencode/src/tool/text.ts", diff: codeDiff("a", "b") },
    ]
    const signals = classifyChanges(changes)
    expect(signals).toHaveLength(2)
    expect(signals.map((s) => s.kind).sort()).toEqual(["middleware", "runtime-lifecycle"])
  })

  test(".spec/.stories and __tests__/test/tests files never signal at any tier", () => {
    const diff = codeDiff("a", "b")
    expect(classifyFile("packages/opencode/src/effect/foo.spec.ts", diff)).toEqual([])
    expect(classifyFile("packages/opencode/src/effect/foo.stories.ts", diff)).toEqual([])
    expect(classifyFile("packages/opencode/src/kilocode/provider/__tests__/foo.ts", diff)).toEqual([])
    expect(classifyFile("packages/opencode/src/kilocode/provider/tests/foo.ts", diff)).toEqual([])
    expect(classifyFile("packages/opencode/src/kilocode/provider/test/foo.ts", diff)).toEqual([])
    expect(classifyFile("packages/opencode/test/kilocode/server/drain-control.test.ts", diff)).toEqual([])
    // Medium paths are also skipped for test files (previously they warned).
    expect(classifyFile("packages/opencode/src/server/cors.test.ts", diff)).toEqual([])
    expect(classifyFile("packages/opencode/src/bus/__tests__/events.spec.ts", diff)).toEqual([])
  })

  test("a rename pair emits at most one signal (new side wins on equal tier)", () => {
    const changes: FileChange[] = [
      { path: "packages/opencode/src/kilocode/server/drain-control.ts", diff: codeDiff("const a = 1", ""), pair: "pc-1", pairSide: "old" },
      { path: "packages/opencode/src/kilocode/server/config-rebuild.ts", diff: codeDiff("", "const a = 1"), pair: "pc-1", pairSide: "new" },
    ]
    const signals = classifyChanges(changes)
    expect(signals).toHaveLength(1)
    expect(signals[0]?.tier).toBe("high")
    expect(signals[0]?.file).toBe("packages/opencode/src/kilocode/server/config-rebuild.ts")
  })

  test("a rename pair high side beats a medium side", () => {
    const changes: FileChange[] = [
      { path: "packages/opencode/src/kilocode/server/drain-control.ts", diff: codeDiff("const a = 1", ""), pair: "pc-2", pairSide: "old" },
      { path: "packages/opencode/src/server/cors.ts", diff: codeDiff("", "const a = 1"), pair: "pc-2", pairSide: "new" },
    ]
    const signals = classifyChanges(changes)
    expect(signals).toHaveLength(1)
    expect(signals[0]?.tier).toBe("high")
    expect(signals[0]?.file).toBe("packages/opencode/src/kilocode/server/drain-control.ts")
  })

  test("a rename away from a high path signals on the old path", () => {
    const changes: FileChange[] = [
      { path: "packages/opencode/src/kilocode/server/drain-control.ts", diff: codeDiff("const a = 1", ""), pair: "pc-3", pairSide: "old" },
      { path: "src/moved.ts", diff: codeDiff("", "const a = 1"), pair: "pc-3", pairSide: "new" },
    ]
    const signals = classifyChanges(changes)
    expect(signals).toHaveLength(1)
    expect(signals[0]?.tier).toBe("high")
    expect(signals[0]?.kind).toBe("runtime-lifecycle")
    expect(signals[0]?.file).toBe("packages/opencode/src/kilocode/server/drain-control.ts")
  })
})

describe("taxonomy expansion: cross-client contracts and product surfaces", () => {
  test("VS Code cli-backend ownership surfaces are HIGH cross-client-contract", () => {
    const surfaces = [
      "packages/kilo-vscode/src/services/cli-backend/server-manager.ts",
      "packages/kilo-vscode/src/services/cli-backend/connection-service.ts",
      "packages/kilo-vscode/src/services/cli-backend/sdk-sse-adapter.ts",
    ]
    for (const f of surfaces) {
      expect(classifyFile(f, codeDiff("a", "b"))).toEqual([{ tier: "high", kind: "cross-client-contract", file: f }])
    }
  })

  test("VS Code cli-backend tests are exempt and types are MEDIUM cross-client-contract", () => {
    expect(classifyFile("packages/kilo-vscode/src/services/cli-backend/connection-service.test.ts", codeDiff("a", "b"))).toEqual([])
    expect(classifyFile("packages/kilo-vscode/src/services/cli-backend/types.ts", codeDiff("a", "b"))[0]).toEqual({
      tier: "medium",
      kind: "cross-client-contract",
      file: "packages/kilo-vscode/src/services/cli-backend/types.ts",
    })
  })

  test("future siblings in known lifecycle dirs warn MEDIUM arch-adjacent; exact owners stay HIGH", () => {
    const siblings = [
      "packages/opencode/src/kilocode/session/session-reaper.ts",
      "packages/kilo-vscode/src/services/cli-backend/session-store.ts",
    ]
    for (const f of siblings) {
      expect(classifyFile(f, codeDiff("a", "b"))).toEqual([{ tier: "medium", kind: "arch-adjacent", file: f }])
    }
    // Exact canonical owners still resolve HIGH (high beats medium).
    expect(classifyFile("packages/opencode/src/kilocode/session/generation-admission.ts", codeDiff("a", "b"))).toEqual([
      { tier: "high", kind: "runtime-lifecycle", file: "packages/opencode/src/kilocode/session/generation-admission.ts" },
    ])
    expect(classifyFile("packages/opencode/src/kilocode/session/config-snapshot.ts", codeDiff("a", "b"))[0]?.tier).toBe("high")
    expect(classifyFile("packages/kilo-vscode/src/services/cli-backend/server-manager.ts", codeDiff("a", "b"))[0]).toEqual({
      tier: "high",
      kind: "cross-client-contract",
      file: "packages/kilo-vscode/src/services/cli-backend/server-manager.ts",
    })
  })

  test("comment/test/build changes in known lifecycle dirs stay exempt", () => {
    expect(classifyFile("packages/opencode/src/kilocode/session/session-reaper.ts", commentOnlyDiff)).toEqual([])
    expect(classifyFile("packages/opencode/src/kilocode/session/session-reaper.test.ts", codeDiff("a", "b"))).toEqual([])
    expect(classifyFile("packages/opencode/src/kilocode/session/dist/session-reaper.ts", codeDiff("a", "b"))).toEqual([])
    expect(classifyFile("packages/kilo-vscode/src/services/cli-backend/session-store.test.ts", codeDiff("a", "b"))).toEqual([])
    expect(classifyFile("packages/kilo-vscode/src/services/cli-backend/out/session-store.js", codeDiff("a", "b"))).toEqual([])
  })

  test("handwritten SDK client is HIGH; generated SDK gen output is exempt", () => {
    expect(classifyFile("packages/sdk/js/src/v2/client.ts", codeDiff("a", "b"))[0]?.kind).toBe("cross-client-contract")
    expect(classifyFile("packages/sdk/js/src/v2/gen/client.gen.ts", codeDiff("a", "b"))).toEqual([])
    expect(classifyFile("packages/sdk/js/src/gen/client.gen.ts", codeDiff("a", "b"))).toEqual([])
  })

  test("shared HttpApi seam and event schema are HIGH", () => {
    const api = classifyFile("packages/opencode/src/server/routes/instance/httpapi/public.ts", codeDiff("a", "b"))
    expect(api[0]?.tier).toBe("high")
    expect(api[0]?.kind).toBe("http-api")
    const ev = classifyFile("packages/opencode/src/server/event.ts", codeDiff("a", "b"))
    expect(ev[0]?.tier).toBe("high")
    expect(ev[0]?.kind).toBe("event-sse")
  })

  test("governance checker self-change and guard scripts are HIGH workflow-inventory", () => {
    const self = classifyFile("script/check-architecture-impact.ts", codeDiff("a", "b"))
    expect(self[0]?.tier).toBe("high")
    expect(self[0]?.kind).toBe("workflow-inventory")
    expect(classifyFile("script/check-workflows.ts", codeDiff("a", "b"))[0]?.kind).toBe("workflow-inventory")
    expect(classifyFile("script/check-forbidden-strings.ts", codeDiff("a", "b"))[0]?.kind).toBe("workflow-inventory")
    // The exact effect-boundary entry keeps its kind ahead of the guard glob.
    expect(classifyFile("script/check-opencode-promise-facades.ts", codeDiff("a", "b"))[0]?.kind).toBe("effect-boundary")
    // The guard glob never crosses path segments.
    expect(classifyFile("script/nested/check-x.ts", codeDiff("a", "b"))).toEqual([])
  })

  test("active workflow YAML is HIGH; comment-only, disabled, and nested files are not", () => {
    const code = ["@@ -1,2 +1,3 @@", "-# old", "+on: push", "+jobs: {}"].join("\n")
    const comment = ["@@ -1,2 +1,2 @@", "-# old note", "+# new note"].join("\n")
    const sig = classifyFile(".github/workflows/check-architecture-impact.yml", code)
    expect(sig[0]?.tier).toBe("high")
    expect(sig[0]?.kind).toBe("workflow-inventory")
    expect(classifyFile(".github/workflows/check-architecture-impact.yaml", code)[0]?.kind).toBe("workflow-inventory")
    expect(classifyFile(".github/workflows/check-architecture-impact.yml", comment)).toEqual([])
    expect(classifyFile(".github/workflows/foo.yml.disabled", code)).toEqual([])
    expect(classifyFile(".github/workflows/disabled/foo.yml", code)).toEqual([])
  })

  test("future lifecycle filename regex matches and stays bounded", () => {
    const fence = "packages/opencode/src/kilocode/server/config-fence.ts"
    expect(classifyFile(fence, codeDiff("a", "b"))).toEqual([{ tier: "high", kind: "runtime-lifecycle", file: fence }])
    expect(classifyFile("packages/opencode/src/kilocode/server/lease-registry.ts", codeDiff("a", "b"))[0]?.kind).toBe("runtime-lifecycle")
    // Non-matching names fall to the MEDIUM arch-adjacent dir rule; nested files do not match.
    expect(classifyFile("packages/opencode/src/kilocode/server/config-failure.ts", codeDiff("a", "b"))[0]?.tier).toBe("medium")
    expect(classifyFile("packages/opencode/src/kilocode/server/routes/fence.ts", codeDiff("a", "b"))[0]?.tier).toBe("medium")
  })

  test("agent-manager is MEDIUM arch-adjacent", () => {
    const sig = classifyFile("packages/kilo-vscode/src/agent-manager/AgentManagerProvider.ts", codeDiff("a", "b"))
    expect(sig[0]?.tier).toBe("medium")
    expect(sig[0]?.kind).toBe("arch-adjacent")
  })

  test("build output directories never signal at any tier", () => {
    expect(classifyFile("packages/opencode/src/kilocode/server/dist/drain-control.ts", codeDiff("a", "b"))).toEqual([])
    expect(classifyFile("packages/kilo-vscode/out/connection-service.js", codeDiff("a", "b"))).toEqual([])
    expect(classifyFile("packages/kilo-vscode/out/classes/main/Foo.kt", codeDiff("a", "b"))).toEqual([])
  })
})

describe("parseNameStatus", () => {
  test("parses null-delimited A/M/D/R/C/T entries", () => {
    const out = [
      "R100\0old/a.ts\0new/b.ts",
      "C050\0src/x.ts\0dst/y.ts",
      "A\0new-file.ts",
      "M\0changed.ts",
      "D\0gone.ts",
    ].join("\0")
    expect(parseNameStatus(out)).toEqual([
      { status: "R", old: "old/a.ts", path: "new/b.ts" },
      { status: "C", old: "src/x.ts", path: "dst/y.ts" },
      { status: "A", path: "new-file.ts" },
      { status: "M", path: "changed.ts" },
      { status: "D", path: "gone.ts" },
    ])
  })

  test("handles empty output and unknown statuses", () => {
    expect(parseNameStatus("")).toEqual([])
    expect(parseNameStatus("X\0weird.ts")).toEqual([])
  })
})

// ─── declaration parsing ───────────────────────────────────────────────────

const updatedBody = [
  "## Summary",
  "Changes a runtime gate.",
  "",
  "## Documentation Impact",
  "- [x] Architecture docs updated",
  `  Canonical docs: ${ARCH_DOC}`,
  "- [ ] Not applicable",
  "  Rationale:",
  "",
  "## Testing",
  "Done.",
].join("\n")

const notApplicableBody = [
  "## Documentation Impact",
  "- [ ] Architecture docs updated",
  "  Canonical docs:",
  "- [x] Not applicable",
  "  Rationale: No runtime lifecycle contract changed.",
  "",
  "## Notes",
  "Nothing to see here.",
].join("\n")

describe("parseDeclaration", () => {
  test("parses a valid updated declaration", () => {
    const d = parseDeclaration(updatedBody)
    expect(d.present).toBe(true)
    expect(d.status).toBe("updated")
    expect(d.canonicalDocs).toEqual([ARCH_DOC])
    expect(d.errors).toEqual([])
  })

  test("parses a valid not-applicable declaration with rationale", () => {
    const d = parseDeclaration(notApplicableBody)
    expect(d.status).toBe("not-applicable")
    expect(d.rationale).toBe("No runtime lifecycle contract changed.")
    expect(d.errors).toEqual([])
  })

  test("missing section fails closed", () => {
    const d = parseDeclaration("## Summary\nNothing.\n")
    expect(d.present).toBe(false)
    expect(d.errors.some((e) => e.includes("Missing"))).toBe(true)
  })

  test("heading inside a code fence is not the section", () => {
    const body = ["Some text", "", "```md", "## Documentation Impact", "- [x] Architecture docs updated", "```", "", "Done."].join("\n")
    const d = parseDeclaration(body)
    expect(d.present).toBe(false)
  })

  test("a different heading level is not the section", () => {
    expect(parseDeclaration("### Documentation Impact\n- [x] Architecture docs updated\n").present).toBe(false)
  })

  test("multiple sections fail closed", () => {
    const body = [
      "## Documentation Impact",
      "- [x] Architecture docs updated",
      "  Canonical docs: a.md",
      "## Documentation Impact",
      "- [x] Not applicable",
      "  Rationale: x",
    ].join("\n")
    const d = parseDeclaration(body)
    expect(d.errors.some((e) => e.includes("2") && e.includes("exactly one"))).toBe(true)
  })

  test("both statuses checked fails closed", () => {
    const body = [
      "## Documentation Impact",
      "- [x] Architecture docs updated",
      "  Canonical docs: a.md",
      "- [x] Not applicable",
      "  Rationale: x",
    ].join("\n")
    const d = parseDeclaration(body)
    expect(d.errors.some((e) => e.includes("2 statuses are checked"))).toBe(true)
  })

  test("no status checked fails closed", () => {
    const body = ["## Documentation Impact", "- [ ] Architecture docs updated", "- [ ] Not applicable"].join("\n")
    const d = parseDeclaration(body)
    expect(d.errors.some((e) => e.includes("No status is checked"))).toBe(true)
  })

  test("an unknown checked status fails closed", () => {
    const body = ["## Documentation Impact", "- [x] Some other thing"].join("\n")
    const d = parseDeclaration(body)
    expect(d.errors.some((e) => e.includes("Unknown checked status"))).toBe(true)
  })

  test("uppercase X is a checked box", () => {
    const body = ["## Documentation Impact", "- [X] Architecture docs updated", `  Canonical docs: ${ARCH_DOC}`, "- [ ] Not applicable"].join("\n")
    const d = parseDeclaration(body)
    expect(d.status).toBe("updated")
    expect(d.errors).toEqual([])
  })

  test("checkbox text outside the section is ignored", () => {
    const body = [
      "## Documentation Impact",
      "- [x] Not applicable",
      "  Rationale: because",
      "## Other section",
      "- [x] Architecture docs updated",
      "  Canonical docs: fake.md",
    ].join("\n")
    const d = parseDeclaration(body)
    expect(d.status).toBe("not-applicable")
    expect(d.canonicalDocs).toEqual([])
    expect(d.errors).toEqual([])
  })

  test("multiline rationale is captured", () => {
    const body = [
      "## Documentation Impact",
      "- [x] Not applicable",
      "  Rationale: first line",
      "  second line still rationale",
      "- [ ] Architecture docs updated",
    ].join("\n")
    const d = parseDeclaration(body)
    expect(d.rationale).toBe("first line second line still rationale")
  })

  test("a section inside a multi-line HTML comment is ignored", () => {
    const body = [
      "<!--",
      "## Documentation Impact",
      "- [x] Not applicable",
      "  Rationale: smuggled",
      "-->",
      "",
      "Done.",
    ].join("\n")
    const d = parseDeclaration(body)
    expect(d.present).toBe(false)
    expect(d.errors.some((e) => e.includes("Missing"))).toBe(true)
  })

  test("a single-line HTML comment around the section is ignored", () => {
    const body = "<!-- ## Documentation Impact\n- [x] Architecture docs updated -->\n\nReal text"
    const d = parseDeclaration(body)
    expect(d.present).toBe(false)
    expect(d.errors.some((e) => e.includes("Missing"))).toBe(true)
  })

  test("statuses and fields inside a code fence are ignored", () => {
    const body = [
      "## Documentation Impact",
      "- [x] Not applicable",
      "  Rationale: because",
      "```",
      "- [x] Architecture docs updated",
      "  Canonical docs: fake.md",
      "```",
      "",
      "Done.",
    ].join("\n")
    const d = parseDeclaration(body)
    expect(d.status).toBe("not-applicable")
    expect(d.canonicalDocs).toEqual([])
    expect(d.errors).toEqual([])
  })

  test("an unterminated HTML comment inside a code fence does not hide a later real section", () => {
    // Fence content cannot alter HTML comment state. The `<!--`
    // inside the fence must not open a comment that swallows the section.
    const body = [
      "```",
      "<!-- unterminated comment in a fenced example",
      "```",
      "## Documentation Impact",
      "- [x] Not applicable",
      "  Rationale: real rationale",
    ].join("\n")
    const d = parseDeclaration(body)
    expect(d.present).toBe(true)
    expect(d.status).toBe("not-applicable")
    expect(d.rationale).toBe("real rationale")
    expect(d.errors).toEqual([])
  })

  test("a fenced fake section cannot swallow or duplicate a real one after it", () => {
    const body = [
      "```",
      "## Documentation Impact",
      "- [x] Not applicable",
      "  Rationale: smuggled",
      "<!-- unterminated in the same fenced example",
      "```",
      "## Documentation Impact",
      "- [x] Not applicable",
      "  Rationale: real",
    ].join("\n")
    const d = parseDeclaration(body)
    expect(d.present).toBe(true)
    expect(d.status).toBe("not-applicable")
    expect(d.rationale).toBe("real")
    expect(d.errors).toEqual([])
  })

  test("an unterminated HTML comment outside a fence hides everything after it", () => {
    const body = [
      "<!-- unterminated comment outside any fence",
      "## Documentation Impact",
      "- [x] Not applicable",
      "  Rationale: hidden",
    ].join("\n")
    const d = parseDeclaration(body)
    expect(d.present).toBe(false)
    expect(d.errors.some((e) => e.includes("Missing"))).toBe(true)
  })

  test("an HTML comment outside a fence still hides content across fence lines", () => {
    // The comment opens outside a fence, so fence content cannot close it; the
    // real section after the comment's `-->` is what the parser sees.
    const body = [
      "<!--",
      "```",
      "## Documentation Impact",
      "- [x] Not applicable",
      "```",
      "-->",
      "## Documentation Impact",
      "- [x] Not applicable",
      "  Rationale: real",
    ].join("\n")
    const d = parseDeclaration(body)
    expect(d.present).toBe(true)
    expect(d.status).toBe("not-applicable")
    expect(d.rationale).toBe("real")
  })

  test("fenced fake fields and statuses are ignored", () => {
    const body = [
      "## Documentation Impact",
      "- [x] Architecture docs updated",
      "  Canonical docs: fake.md",
      "```",
      "- [x] Not applicable",
      "  Rationale: smuggled",
      "  Canonical docs: packages/kilo-docs/pages/contributing/architecture/smuggled.md",
      "```",
      "- [ ] Not applicable",
    ].join("\n")
    const d = parseDeclaration(body)
    expect(d.status).toBe("updated")
    expect(d.canonicalDocs).toEqual(["fake.md"])
    expect(d.errors).toEqual([])
  })

  test("duplicate Rationale fields fail closed", () => {
    const body = ["## Documentation Impact", "- [x] Not applicable", "  Rationale: first", "  Rationale: second"].join("\n")
    const d = parseDeclaration(body)
    expect(d.errors.some((e) => e.includes('Duplicate "Rationale:"'))).toBe(true)
  })

  test("duplicate Canonical docs fields fail closed", () => {
    const body = [
      "## Documentation Impact",
      "- [x] Architecture docs updated",
      `  Canonical docs: ${ARCH_DOC}`,
      `  Canonical docs: ${ARCH_DOC}`,
      "- [ ] Not applicable",
    ].join("\n")
    const d = parseDeclaration(body)
    expect(d.errors.some((e) => e.includes('Duplicate "Canonical docs:"'))).toBe(true)
  })

  test("indented checkbox and field are not swallowed by a preceding field", () => {
    const body = [
      "## Documentation Impact",
      "- [x] Not applicable",
      "  Rationale: first line",
      "  - [x] Architecture docs updated",
      "  Canonical docs: fake.md",
    ].join("\n")
    const d = parseDeclaration(body)
    expect(d.status).toBe("not-applicable")
    expect(d.rationale).toBe("first line")
    expect(d.canonicalDocs).toEqual(["fake.md"])
    expect(d.errors).toEqual([])
  })
})

// ─── declaration validation against evidence ───────────────────────────────

describe("validateDeclaration", () => {
  const updated = (docs: string[]) => ({ ...parseDeclaration(updatedBody), canonicalDocs: docs })

  test("updated with changed canonical doc and matching path passes", () => {
    const { errors, warnings } = validateDeclaration(updated([ARCH_DOC]), [ARCH_DOC])
    expect(errors).toEqual([])
    expect(warnings).toEqual([])
  })

  test("updated without canonical docs value fails", () => {
    const { errors } = validateDeclaration(updated([]), [ARCH_DOC])
    expect(errors.some((e) => e.includes("non-empty `Canonical docs:`"))).toBe(true)
  })

  test("updated without any changed canonical doc fails", () => {
    const { errors } = validateDeclaration(updated([ARCH_DOC]), [])
    expect(errors.some((e) => e.includes("at least one changed canonical architecture doc"))).toBe(true)
  })

  test("updated with a non-matching declared doc fails", () => {
    const { errors } = validateDeclaration(updated(["packages/kilo-docs/pages/contributing/architecture/cloud-security.md"]), [ARCH_DOC])
    expect(errors.some((e) => e.includes("match a changed canonical architecture doc"))).toBe(true)
  })

  test("updated declaring a non-canonical path fails", () => {
    const { errors } = validateDeclaration(updated(["packages/opencode/src/config/config.ts"]), [ARCH_DOC])
    expect(errors.some((e) => e.includes("not under"))).toBe(true)
  })

  test("updated matching by bare filename passes", () => {
    const { errors } = validateDeclaration(updated(["cli-runtime.md"]), [ARCH_DOC])
    expect(errors).toEqual([])
  })

  test("not-applicable without rationale fails; with rationale passes", () => {
    const bare = parseDeclaration(["## Documentation Impact", "- [x] Not applicable"].join("\n"))
    expect(validateDeclaration(bare, []).errors.some((e) => e.includes("non-empty `Rationale:`"))).toBe(true)
    const full = parseDeclaration(notApplicableBody)
    expect(validateDeclaration(full, []).errors).toEqual([])
  })
})

// ─── orchestration ─────────────────────────────────────────────────────────

const change = (p: string, diff: string) => [{ path: p, diff }]

describe("evaluateCheck", () => {
  const high = "packages/opencode/src/kilocode/server/drain-control.ts"
  const medium = "packages/opencode/src/server/cors.ts"
  const plain = "packages/opencode/src/tool/text.ts"

  test("no signal passes", () => {
    const r = evaluateCheck({ changes: change(plain, codeDiff("a", "b")), body: notApplicableBody, worktree: false })
    expect(r.signals).toEqual([])
    expect(r.pass).toBe(true)
  })

  test("high signal with missing declaration fails", () => {
    const r = evaluateCheck({ changes: change(high, codeDiff("a", "b")), body: "## Summary\nNothing.", worktree: false })
    expect(r.signals[0]?.tier).toBe("high")
    expect(r.pass).toBe(false)
    expect(r.errors.some((e) => e.includes("High architecture impact"))).toBe(true)
  })

  test("high signal with invalid declaration fails", () => {
    const body = ["## Documentation Impact", "- [x] Not applicable"].join("\n")
    const r = evaluateCheck({ changes: change(high, codeDiff("a", "b")), body, worktree: false })
    expect(r.pass).toBe(false)
    expect(r.errors.some((e) => e.includes("non-empty `Rationale:`"))).toBe(true)
  })

  test("high signal with valid not-applicable declaration passes", () => {
    const r = evaluateCheck({ changes: change(high, codeDiff("a", "b")), body: notApplicableBody, worktree: false })
    expect(r.pass).toBe(true)
  })

  test("high signal with valid updated declaration passes", () => {
    const body = ["## Documentation Impact", "- [x] Architecture docs updated", `  Canonical docs: ${ARCH_DOC}`, "- [ ] Not applicable"].join("\n")
    const changes = [high, ARCH_DOC].map((p) => ({ path: p, diff: p === high ? codeDiff("a", "b") : "" }))
    const r = evaluateCheck({ changes, body, worktree: false })
    expect(r.pass).toBe(true)
  })

  test("comment-only change on a high path does not block", () => {
    const r = evaluateCheck({ changes: change(high, commentOnlyDiff), body: "## Summary\nNothing.", worktree: false })
    expect(r.signals).toEqual([])
    expect(r.pass).toBe(true)
  })

  test("medium signal only warns, even with a missing declaration", () => {
    const r = evaluateCheck({ changes: change(medium, codeDiff("a", "b")), body: "## Summary\nNothing.", worktree: false })
    expect(r.signals[0]?.tier).toBe("medium")
    expect(r.pass).toBe(true)
    expect(r.warnings.some((w) => w.includes("Missing"))).toBe(true)
  })

  test("worktree mode never blocks and needs no declaration", () => {
    const r = evaluateCheck({ changes: change(high, codeDiff("a", "b")), worktree: true })
    expect(r.signals[0]?.tier).toBe("high")
    expect(r.pass).toBe(true)
    expect(r.errors).toEqual([])
  })

  test("renamed canonical doc counts on both sides as evidence", () => {
    const changes: FileChange[] = [
      { path: ARCH_DOC, diff: codeDiff("old", ""), pair: "pc-9", pairSide: "old" },
      { path: "packages/kilo-docs/pages/contributing/architecture/renamed.md", diff: codeDiff("", "new"), pair: "pc-9", pairSide: "new" },
    ]
    const r = evaluateCheck({ changes, body: updatedBody, worktree: false })
    expect(r.pass).toBe(true)
    expect(r.signals).toEqual([])
  })

  test("cross-client HIGH surface blocks without a declaration and passes with one", () => {
    const xcc = "packages/kilo-vscode/src/services/cli-backend/server-manager.ts"
    const bad = evaluateCheck({ changes: change(xcc, codeDiff("a", "b")), body: "## Summary\nNothing.", worktree: false })
    expect(bad.signals[0]?.kind).toBe("cross-client-contract")
    expect(bad.pass).toBe(false)
    const good = evaluateCheck({ changes: change(xcc, codeDiff("a", "b")), body: notApplicableBody, worktree: false })
    expect(good.pass).toBe(true)
  })

  test("workflow YAML comment-only never blocks; a code change blocks without a declaration", () => {
    const comment = { path: ".github/workflows/foo.yml", diff: ["@@ -1 +1 @@", "-# old", "+# new"].join("\n") }
    expect(evaluateCheck({ changes: [comment], body: "## Summary\nNothing.", worktree: false }).signals).toEqual([])
    const code = { path: ".github/workflows/foo.yml", diff: ["@@ -1 +1,2 @@", "-# old", "+on: push"].join("\n") }
    const r = evaluateCheck({ changes: [code], body: "## Summary\nNothing.", worktree: false })
    expect(r.signals[0]?.kind).toBe("workflow-inventory")
    expect(r.pass).toBe(false)
  })

  test("MEDIUM product dirs only warn, even with a missing declaration", () => {
    for (const f of [
      "packages/kilo-vscode/src/agent-manager/AgentManagerProvider.ts",
      "packages/kilo-vscode/src/services/cli-backend/types.ts",
      "packages/opencode/src/kilocode/session/session-reaper.ts",
      "packages/kilo-vscode/src/services/cli-backend/session-store.ts",
    ]) {
      const r = evaluateCheck({ changes: change(f, codeDiff("a", "b")), body: "## Summary\nNothing.", worktree: false })
      expect(r.signals[0]?.tier).toBe("medium")
      expect(r.pass).toBe(true)
    }
  })
})

// ─── Real git integration ──────────────────────────────────────────────────
// Copies the ACTUAL script/check-architecture-impact.ts into a temp repo so
// import.meta.dir resolves ROOT to the temp repo, proving the git paths and
// CLI contract end to end.

const REPO = path.resolve(import.meta.dir, "../../..")
const CHECKER = path.join("script", "check-architecture-impact.ts")

function git(repo: string, args: string[]) {
  const res = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" })
  expect(res.status, `git ${args.join(" ")} failed: ${res.stderr}`).toBe(0)
  return res.stdout?.trim() ?? ""
}

function run(repo: string, args: string[]) {
  return spawnSync(process.execPath, [path.join(repo, CHECKER), ...args], { encoding: "utf8" })
}

function freshRepo(tag: string) {
  const repo = mkdtempSync(path.join(os.tmpdir(), tag))
  git(repo, ["init", "-q"])
  git(repo, ["config", "user.name", "Checker Test"])
  git(repo, ["config", "user.email", "checker@test.invalid"])
  git(repo, ["config", "commit.gpgsign", "false"])
  mkdirSync(path.join(repo, "script"), { recursive: true })
  copyFileSync(path.join(REPO, CHECKER), path.join(repo, CHECKER))
  // The checker imports the installed TypeScript scanner; give the copied
  // script the same module it would resolve in the real repo.
  mkdirSync(path.join(repo, "node_modules"), { recursive: true })
  symlinkSync(path.join(REPO, "node_modules/typescript"), path.join(repo, "node_modules/typescript"), "dir")
  writeFileSync(path.join(repo, ".gitignore"), "node_modules/\n")
  return repo
}

describe("check-architecture-impact CLI (real git)", () => {
  test("--help exits 0 and prints usage", () => {
    const repo = freshRepo("kilo-arch-help-")
    try {
      const res = run(repo, ["--help"])
      expect(res.status).toBe(0)
      expect(res.stdout).toContain("--pr-body-file")
      expect(res.stdout).toContain("Rationale: <why no architecture doc update is needed>")
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  }, { timeout: 30000 })

  test("--worktree reports signals as advice and never blocks", () => {
    const repo = freshRepo("kilo-arch-worktree-")
    try {
      const dir = path.join(repo, "packages/opencode/src/kilocode/server")
      mkdirSync(dir, { recursive: true })
      const f = path.join(dir, "drain-control.ts")
      writeFileSync(f, "export const base = 1\n")
      git(repo, ["add", "-A"])
      git(repo, ["commit", "-qm", "baseline"])

      let res = run(repo, ["--worktree"])
      expect(res.status).toBe(0)
      expect(res.stdout).toContain("0 architecture signal(s)")
      expect(res.stdout).toContain("local semantic assessment is the primary standard")
      expect(res.stdout).toContain("inspect the full diff")
      expect(res.stdout).toContain("no PR declaration is required")
      // Worktree advice is copy-safe: both statuses unchecked with an explicit
      // select-one instruction, matching the PR template.
      expect(res.stdout).toContain("- [ ] Architecture docs updated")
      expect(res.stdout).toContain("- [ ] Not applicable")
      expect(res.stdout).toContain("Rationale: <why no architecture doc update is needed>")
      expect(res.stdout).toContain("Select exactly one status")
      expect(res.stdout).not.toContain("- [x] Architecture docs updated")

      writeFileSync(f, "export const base = 1\nexport const newGate = 2\n")
      res = run(repo, ["--worktree"])
      expect(res.status).toBe(0)
      expect(res.stdout).toContain("[high] runtime-lifecycle")
      expect(res.stdout).toContain("drain-control.ts")

      writeFileSync(f, "export const base = 1\n// just a note\n")
      res = run(repo, ["--worktree"])
      expect(res.status).toBe(0)
      expect(res.stdout).toContain("0 architecture signal(s)")

      writeFileSync(path.join(dir, "instance-gate.ts"), "export const ng = true\n")
      res = run(repo, ["--worktree"])
      expect(res.status).toBe(0)
      expect(res.stdout).toContain("instance-gate.ts")
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  }, { timeout: 30000 })

  test("range mode: added ++count / removed --count are executable high changes", () => {
    const repo = freshRepo("kilo-arch-incdec-")
    try {
      const dir = path.join(repo, "packages/opencode/src/kilocode/server")
      mkdirSync(dir, { recursive: true })
      const f = path.join(dir, "drain-control.ts")
      writeFileSync(f, "export const count = 0\n--count;\n")
      git(repo, ["add", "-A"])
      git(repo, ["commit", "-qm", "baseline"])
      const base = git(repo, ["rev-parse", "HEAD"])

      writeFileSync(f, "export const count = 0\n++count;\n")
      git(repo, ["add", "-A"])
      git(repo, ["commit", "-qm", "pre-increment instead of pre-decrement"])
      const head = git(repo, ["rev-parse", "HEAD"])

      const body = path.join(repo, "body.md")
      writeFileSync(body, "## Documentation Impact\n- [x] Not applicable\n  Rationale: no contract changed.\n")
      const res = run(repo, ["--base", base, "--head", head, "--pr-body-file", body])
      expect(res.status).toBe(0)
      expect(res.stdout).toContain("[high] runtime-lifecycle")
      expect(res.stdout).toContain("RESULT: PASS")
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  }, { timeout: 30000 })

  test("range mode: keyword JSDoc and bare-star additions on a high path produce no signal", () => {
    const repo = freshRepo("kilo-arch-jsdoc-")
    try {
      const dir = path.join(repo, "packages/opencode/src/kilocode/server")
      mkdirSync(dir, { recursive: true })
      const f = path.join(dir, "drain-control.ts")
      writeFileSync(f, "export const base = 1\n/**\n * existing prose\n */\n")
      git(repo, ["add", "-A"])
      git(repo, ["commit", "-qm", "baseline"])
      const base = git(repo, ["rev-parse", "HEAD"])

      writeFileSync(f, "export const base = 1\n/**\n * existing prose\n * this is new prose\n *\n * type: string\n */\n")
      git(repo, ["add", "-A"])
      git(repo, ["commit", "-qm", "docblock prose"])
      const head = git(repo, ["rev-parse", "HEAD"])

      const body = path.join(repo, "body.md")
      writeFileSync(body, "## Summary\nno declaration here\n")
      const res = run(repo, ["--base", base, "--head", head, "--pr-body-file", body])
      expect(res.status).toBe(0)
      expect(res.stdout).toContain("0 architecture signal(s)")
      expect(res.stdout).toContain("RESULT: PASS")
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  }, { timeout: 30000 })

  test("range mode: generator line on a high path is executable", () => {
    const repo = freshRepo("kilo-arch-generator-")
    try {
      const dir = path.join(repo, "packages/opencode/src/kilocode/server")
      mkdirSync(dir, { recursive: true })
      const f = path.join(dir, "drain-control.ts")
      writeFileSync(f, "export const base = 1\n")
      git(repo, ["add", "-A"])
      git(repo, ["commit", "-qm", "baseline"])
      const base = git(repo, ["rev-parse", "HEAD"])

      writeFileSync(f, "export const base = 1\n*gen() { yield 1 }\n")
      git(repo, ["add", "-A"])
      git(repo, ["commit", "-qm", "generator added"])
      const head = git(repo, ["rev-parse", "HEAD"])

      const body = path.join(repo, "body.md")
      writeFileSync(body, "## Documentation Impact\n- [x] Not applicable\n  Rationale: no contract changed.\n")
      const res = run(repo, ["--base", base, "--head", head, "--pr-body-file", body])
      expect(res.status).toBe(0)
      expect(res.stdout).toContain("[high] runtime-lifecycle")
      expect(res.stdout).toContain("RESULT: PASS")
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  }, { timeout: 30000 })

  test("CI range mode fails on high impact with an invalid declaration and passes on a valid one", () => {
    const repo = freshRepo("kilo-arch-range-")
    try {
      const dir = path.join(repo, "packages/opencode/src/kilocode/server")
      mkdirSync(dir, { recursive: true })
      const f = path.join(dir, "drain-control.ts")
      writeFileSync(f, "export const base = 1\n")
      git(repo, ["add", "-A"])
      git(repo, ["commit", "-qm", "baseline"])
      const base = git(repo, ["rev-parse", "HEAD"])

      writeFileSync(f, "export const base = 1\nexport const newGate = 2\n")
      git(repo, ["add", "-A"])
      git(repo, ["commit", "-qm", "high change"])
      const head = git(repo, ["rev-parse", "HEAD"])

      const valid = path.join(repo, "valid.md")
      writeFileSync(valid, "## Documentation Impact\n- [x] Not applicable\n  Rationale: no contract changed.\n")
      const invalid = path.join(repo, "invalid.md")
      writeFileSync(invalid, "## Summary\nno declaration section here\n")

      const ok = run(repo, ["--base", base, "--head", head, "--pr-body-file", valid])
      expect(ok.status).toBe(0)
      expect(ok.stdout).toContain("[high] runtime-lifecycle")
      expect(ok.stdout).toContain("RESULT: PASS")

      const bad = run(repo, ["--base", base, "--head", head, "--pr-body-file", invalid])
      expect(bad.status).toBe(1)
      expect(bad.stderr).toContain("High architecture impact")
      expect(bad.stderr).toContain("RESULT: FAIL")
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  }, { timeout: 30000 })

  test("CI range mode validates updated declarations against changed canonical docs", () => {
    const repo = freshRepo("kilo-arch-updated-")
    try {
      const server = path.join(repo, "packages/opencode/src/kilocode/server")
      const docs = path.join(repo, "packages/kilo-docs/pages/contributing/architecture")
      mkdirSync(server, { recursive: true })
      mkdirSync(docs, { recursive: true })
      const gate = path.join(server, "drain-control.ts")
      const doc = path.join(docs, "cli-runtime.md")
      writeFileSync(gate, "export const base = 1\n")
      writeFileSync(doc, "# Runtime\nold\n")
      git(repo, ["add", "-A"])
      git(repo, ["commit", "-qm", "baseline"])

      writeFileSync(gate, "export const base = 1\nexport const newGate = 2\n")
      writeFileSync(doc, "# Runtime\nnew\n")
      git(repo, ["add", "-A"])
      git(repo, ["commit", "-qm", "high + doc"])
      const base = git(repo, ["rev-parse", "HEAD~1"])
      const head = git(repo, ["rev-parse", "HEAD"])

      const body = path.join(repo, "updated.md")
      writeFileSync(
        body,
        `## Documentation Impact\n- [x] Architecture docs updated\n  Canonical docs: ${ARCH_DOC}\n- [ ] Not applicable\n`,
      )
      const ok = run(repo, ["--base", base, "--head", head, "--pr-body-file", body])
      expect(ok.status).toBe(0)
      expect(ok.stdout).toContain("RESULT: PASS")

      // Now a high-only change with no canonical doc diff: the same declaration must fail.
      writeFileSync(gate, "export const base = 1\nexport const newGate = 2\nexport const more = 3\n")
      git(repo, ["add", "-A"])
      git(repo, ["commit", "-qm", "high only"])
      const base2 = head
      const head2 = git(repo, ["rev-parse", "HEAD"])
      const bad = run(repo, ["--base", base2, "--head", head2, "--pr-body-file", body])
      expect(bad.status).toBe(1)
      expect(bad.stderr).toContain("at least one changed canonical architecture doc")
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  }, { timeout: 30000 })

  test("refs starting with a dash are a usage error (exit 2)", () => {
    const repo = freshRepo("kilo-arch-dashref-")
    try {
      writeFileSync(path.join(repo, "x.ts"), "export const x = 1\n")
      git(repo, ["add", "-A"])
      git(repo, ["commit", "-qm", "base"])
      const res = run(repo, ["--base", "-p", "--head", "HEAD", "--pr-body-file", path.join(repo, "x.md")])
      expect(res.status).toBe(2)
      expect(res.stderr).toContain("safe ref characters")
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  }, { timeout: 30000 })

  test("missing PR body file is a usage error (exit 2)", () => {
    const repo = freshRepo("kilo-arch-nobody-")
    try {
      writeFileSync(path.join(repo, "x.ts"), "export const x = 1\n")
      git(repo, ["add", "-A"])
      git(repo, ["commit", "-qm", "base"])
      const base = git(repo, ["rev-parse", "HEAD"])
      const res = run(repo, ["--base", base, "--head", base, "--pr-body-file", path.join(repo, "does-not-exist.md")])
      expect(res.status).toBe(2)
      expect(res.stderr).toContain("Cannot read PR body file")
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  }, { timeout: 30000 })

  test("git operational failure prints a stable RESULT: FAIL and exits 1", () => {
    const repo = freshRepo("kilo-arch-giterr-")
    try {
      writeFileSync(path.join(repo, "x.ts"), "export const x = 1\n")
      writeFileSync(path.join(repo, "x.md"), "## Documentation Impact\n- [x] Not applicable\n  Rationale: x.\n")
      git(repo, ["add", "-A"])
      git(repo, ["commit", "-qm", "base"])
      const res = run(repo, ["--base", "no-such-ref", "--head", "HEAD", "--pr-body-file", path.join(repo, "x.md")])
      expect(res.status).toBe(1)
      expect(res.stderr).toContain("git operation failed")
      expect(res.stderr).toContain("RESULT: FAIL")
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  }, { timeout: 30000 })

  test("worktree rename of a high path keeps the signal on the old path", () => {
    const repo = freshRepo("kilo-arch-wt-rename-")
    try {
      const dir = path.join(repo, "packages/opencode/src/kilocode/server")
      mkdirSync(dir, { recursive: true })
      mkdirSync(path.join(repo, "src"), { recursive: true })
      const f = path.join(dir, "drain-control.ts")
      writeFileSync(f, "export const base = 1\nexport const other = 2\n")
      git(repo, ["add", "-A"])
      git(repo, ["commit", "-qm", "baseline"])
      git(repo, ["mv", "packages/opencode/src/kilocode/server/drain-control.ts", "src/moved.ts"])
      const res = run(repo, ["--worktree"])
      expect(res.status).toBe(0)
      expect(res.stdout).toContain("[high] runtime-lifecycle")
      expect(res.stdout).toContain("drain-control.ts")
      expect(res.stdout).toContain("no PR declaration is required")
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  }, { timeout: 30000 })

  test("range rename high→low signals on the old path and passes with a valid declaration", () => {
    const repo = freshRepo("kilo-arch-range-rename-away-")
    try {
      const dir = path.join(repo, "packages/opencode/src/kilocode/server")
      mkdirSync(dir, { recursive: true })
      mkdirSync(path.join(repo, "src"), { recursive: true })
      writeFileSync(path.join(dir, "drain-control.ts"), "export const a = 1\nexport const b = 2\n")
      git(repo, ["add", "-A"])
      git(repo, ["commit", "-qm", "base"])
      const base = git(repo, ["rev-parse", "HEAD"])
      git(repo, ["mv", "packages/opencode/src/kilocode/server/drain-control.ts", "src/moved.ts"])
      git(repo, ["commit", "-qm", "rename away"])
      const head = git(repo, ["rev-parse", "HEAD"])
      const body = path.join(repo, "body.md")
      writeFileSync(body, "## Documentation Impact\n- [x] Not applicable\n  Rationale: contract moved.\n")
      const res = run(repo, ["--base", base, "--head", head, "--pr-body-file", body])
      expect(res.status).toBe(0)
      expect(res.stdout).toContain("[high] runtime-lifecycle")
      expect(res.stdout).toContain("drain-control.ts")
      expect(res.stdout).toContain("RESULT: PASS")
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  }, { timeout: 30000 })

  test("range rename low→high signals on the new path", () => {
    const repo = freshRepo("kilo-arch-range-rename-in-")
    try {
      const dir = path.join(repo, "packages/opencode/src/kilocode/server")
      mkdirSync(dir, { recursive: true })
      mkdirSync(path.join(repo, "src"), { recursive: true })
      writeFileSync(path.join(repo, "src", "plain.ts"), "export const a = 1\nexport const b = 2\n")
      git(repo, ["add", "-A"])
      git(repo, ["commit", "-qm", "base"])
      const base = git(repo, ["rev-parse", "HEAD"])
      git(repo, ["mv", "src/plain.ts", "packages/opencode/src/kilocode/server/drain-control.ts"])
      git(repo, ["commit", "-qm", "rename in"])
      const head = git(repo, ["rev-parse", "HEAD"])
      const body = path.join(repo, "body.md")
      writeFileSync(body, "## Documentation Impact\n- [x] Not applicable\n  Rationale: contract added.\n")
      const res = run(repo, ["--base", base, "--head", head, "--pr-body-file", body])
      expect(res.status).toBe(0)
      expect(res.stdout).toContain("[high] runtime-lifecycle")
      expect(res.stdout).toContain("drain-control.ts")
      expect(res.stdout).toContain("RESULT: PASS")
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  }, { timeout: 30000 })

  test("range copy into a candidate path signals on the new path", () => {
    const repo = freshRepo("kilo-arch-range-copy-")
    try {
      const tool = path.join(repo, "packages/opencode/src/tool")
      const server = path.join(repo, "packages/opencode/src/kilocode/server")
      mkdirSync(tool, { recursive: true })
      mkdirSync(server, { recursive: true })
      writeFileSync(path.join(tool, "text.ts"), "export const t = 1\n")
      git(repo, ["add", "-A"])
      git(repo, ["commit", "-qm", "base"])
      const base = git(repo, ["rev-parse", "HEAD"])
      copyFileSync(path.join(tool, "text.ts"), path.join(server, "server-copy.ts"))
      git(repo, ["add", "-A"])
      git(repo, ["commit", "-qm", "copy"])
      const head = git(repo, ["rev-parse", "HEAD"])
      const body = path.join(repo, "body.md")
      writeFileSync(body, "## Documentation Impact\n- [x] Not applicable\n  Rationale: no contract change.\n")
      const res = run(repo, ["--base", base, "--head", head, "--pr-body-file", body])
      expect(res.status).toBe(0)
      expect(res.stdout).toContain("[medium] arch-adjacent")
      expect(res.stdout).toContain("server-copy.ts")
      expect(res.stdout).toContain("RESULT: PASS")
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  }, { timeout: 30000 })

  test("unstaged worktree deletion of a high path signals", () => {
    const repo = freshRepo("kilo-arch-wt-delete-")
    try {
      const dir = path.join(repo, "packages/opencode/src/kilocode/server")
      mkdirSync(dir, { recursive: true })
      const f = path.join(dir, "drain-control.ts")
      writeFileSync(f, "export const base = 1\nexport const other = 2\n")
      git(repo, ["add", "-A"])
      git(repo, ["commit", "-qm", "baseline"])
      rmSync(f)
      const res = run(repo, ["--worktree"])
      expect(res.status).toBe(0)
      expect(res.stdout).toContain("[high] runtime-lifecycle")
      expect(res.stdout).toContain("drain-control.ts")
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  }, { timeout: 30000 })

  test("worktree: workflow YAML comment changes do not signal, code changes do", () => {
    const repo = freshRepo("kilo-arch-yaml-")
    try {
      const dir = path.join(repo, ".github/workflows")
      mkdirSync(dir, { recursive: true })
      const f = path.join(dir, "ci.yml")
      writeFileSync(f, "# baseline\n")
      git(repo, ["add", "-A"])
      git(repo, ["commit", "-qm", "baseline"])

      writeFileSync(f, "# baseline\n# added note\n")
      let res = run(repo, ["--worktree"])
      expect(res.status).toBe(0)
      expect(res.stdout).toContain("0 architecture signal(s)")

      writeFileSync(f, "# baseline\n# added note\non: push\n")
      res = run(repo, ["--worktree"])
      expect(res.status).toBe(0)
      expect(res.stdout).toContain("[high] workflow-inventory")
      expect(res.stdout).toContain("ci.yml")

      // Disabled workflow files never signal, even with executable content.
      writeFileSync(path.join(dir, "old.yml.disabled"), "on: push\n")
      res = run(repo, ["--worktree"])
      expect(res.status).toBe(0)
      expect(res.stdout).toContain("[high] workflow-inventory")
      expect(res.stdout).not.toContain("old.yml.disabled")
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  }, { timeout: 30000 })

  test("range: generated SDK output never signals", () => {
    const repo = freshRepo("kilo-arch-gen-")
    try {
      const dir = path.join(repo, "packages/sdk/js/src/v2/gen")
      mkdirSync(dir, { recursive: true })
      const f = path.join(dir, "client.gen.ts")
      writeFileSync(f, "// generated\nexport const a = 1\n")
      git(repo, ["add", "-A"])
      git(repo, ["commit", "-qm", "base"])
      const base = git(repo, ["rev-parse", "HEAD"])
      writeFileSync(f, "// generated\nexport const a = 2\n")
      git(repo, ["add", "-A"])
      git(repo, ["commit", "-qm", "regen"])
      const head = git(repo, ["rev-parse", "HEAD"])
      const body = path.join(repo, "body.md")
      writeFileSync(body, "## Summary\nno declaration\n")
      const res = run(repo, ["--base", base, "--head", head, "--pr-body-file", body])
      expect(res.status).toBe(0)
      expect(res.stdout).toContain("0 architecture signal(s)")
      expect(res.stdout).toContain("RESULT: PASS")
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  }, { timeout: 30000 })

  test("large diff (>1 MiB) does not ENOBUFS with 20 MiB maxBuffer", () => {
    const repo = freshRepo("kilo-arch-large-")
    try {
      const dir = path.join(repo, "packages/opencode/src/kilocode/server")
      mkdirSync(dir, { recursive: true })
      const f = path.join(dir, "large.ts")
      writeFileSync(f, "export const a = 1\n")
      git(repo, ["add", "-A"])
      git(repo, ["commit", "-qm", "baseline"])
      const base = git(repo, ["rev-parse", "HEAD"])
      const line = "export const v = 'x'.repeat(80) // padding to grow file\n"
      const repeat = Math.ceil((1.4 * 1024 * 1024) / line.length)
      writeFileSync(f, Array(repeat).fill(line).join(""))
      git(repo, ["add", "-A"])
      git(repo, ["commit", "-qm", "large change"])
      const head = git(repo, ["rev-parse", "HEAD"])
      const body = path.join(repo, "body.md")
      writeFileSync(body, "## Documentation Impact\n- [x] Not applicable\n  Rationale: large file test, no contract change.\n")
      const res = run(repo, ["--base", base, "--head", head, "--pr-body-file", body])
      expect(res.status).toBe(0)
      expect(res.stdout).toContain("RESULT: PASS")
      expect(res.stdout).not.toContain("ENOBUFS")
      expect(res.stdout).not.toContain("maxBuffer")
      expect(res.stdout).toContain("architecture signal(s)")
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  }, { timeout: 30000 })
})

// ─── worktree advice vs PR template ─────────────────────────────────────────

describe("worktree advice", () => {
  const TEMPLATE = readFileSync(path.join(REPO, ".github", "pull_request_template.md"), "utf8")

  test("advice matches the PR template labels and placeholders exactly with an explicit select-one instruction", () => {
    expect(WORKTREE_ADVICE).toContain("- [ ] Architecture docs updated")
    expect(WORKTREE_ADVICE).toContain("- [ ] Not applicable")
    expect(WORKTREE_ADVICE).toContain("Canonical docs: packages/kilo-docs/pages/contributing/architecture/<doc>.md")
    expect(WORKTREE_ADVICE).toContain("Rationale: <why no architecture doc update is needed>")
    expect(WORKTREE_ADVICE).toContain("Select exactly one status")
    expect(WORKTREE_ADVICE).not.toContain("[x]")
  })

  test("every advice status and field line appears verbatim in the PR template", () => {
    for (const line of WORKTREE_ADVICE.split("\n").slice(2, 6)) {
      expect(TEMPLATE).toContain(line)
    }
  })

  test("local advice makes local semantic assessment the primary standard and instructs agents", () => {
    expect(WORKTREE_ADVICE).toContain("primary standard")
    expect(WORKTREE_ADVICE).toContain("inspect the full diff")
    expect(WORKTREE_ADVICE).toMatch(/read the mapped canonical docs/)
    expect(WORKTREE_ADVICE).toMatch(/update the relevant canonical docs and record the changed paths/)
    expect(WORKTREE_ADVICE).toMatch(/concrete rationale/)
    expect(WORKTREE_ADVICE).toMatch(/completion or commit-preparation result/)
    expect(WORKTREE_ADVICE).toMatch(/can be reported concisely/)
    expect(WORKTREE_ADVICE).toMatch(/pre-commit hook is advisory only/)
    expect(WORKTREE_ADVICE).toContain("When opening a PR")
    expect(WORKTREE_ADVICE).toContain("no PR declaration is required")
    // The PR section is a separate, later surface — never the local boundary.
    expect(WORKTREE_ADVICE.indexOf("When opening a PR")).toBeGreaterThan(
      WORKTREE_ADVICE.indexOf("completion or commit-preparation result"),
    )
  })

  test("a verbatim copy of the advice into a PR body fails closed, never a silent invalid declaration", () => {
    const section = WORKTREE_ADVICE.split("\n").slice(2, 6)
    const d = parseDeclaration(["## Documentation Impact", ...section].join("\n"))
    expect(d.errors.some((e) => e.includes("No status is checked"))).toBe(true)
    expect(d.errors.some((e) => e.includes("statuses are checked"))).toBe(false)
  })
})
