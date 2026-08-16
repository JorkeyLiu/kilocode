import { describe, expect, it } from "bun:test"
import {
  parsePRUrl,
  localBranchName,
  parseForEachRefOutput,
  buildBranchList,
  classifyPRError,
} from "../../src/agent-manager/git-import"

// ---------------------------------------------------------------------------
// parsePRUrl
// ---------------------------------------------------------------------------

describe("parsePRUrl", () => {
  it("parses a standard GitHub PR URL", () => {
    expect(parsePRUrl("https://github.com/Kilo-Org/kilocode/pull/6164")).toEqual({
      owner: "Kilo-Org",
      repo: "kilocode",
      number: 6164,
    })
  })

  it("handles URL without protocol", () => {
    expect(parsePRUrl("github.com/owner/repo/pull/42")).toEqual({
      owner: "owner",
      repo: "repo",
      number: 42,
    })
  })

  it("handles trailing slashes", () => {
    expect(parsePRUrl("https://github.com/o/r/pull/1///")).toEqual({
      owner: "o",
      repo: "r",
      number: 1,
    })
  })

  it("handles www.github.com", () => {
    expect(parsePRUrl("https://www.github.com/o/r/pull/99")).toEqual({
      owner: "o",
      repo: "r",
      number: 99,
    })
  })

  it("returns null for non-GitHub URLs", () => {
    expect(parsePRUrl("https://gitlab.com/owner/repo/pull/1")).toBeNull()
  })

  it("returns null for GitHub URLs without /pull/", () => {
    expect(parsePRUrl("https://github.com/owner/repo/issues/1")).toBeNull()
  })

  it("returns null for empty string", () => {
    expect(parsePRUrl("")).toBeNull()
  })

  it("returns null for garbage input", () => {
    expect(parsePRUrl("not a url at all")).toBeNull()
  })

  it("returns null when PR number is missing", () => {
    expect(parsePRUrl("https://github.com/owner/repo/pull/")).toBeNull()
  })

  it("strips whitespace", () => {
    expect(parsePRUrl("  https://github.com/o/r/pull/5  ")).toEqual({
      owner: "o",
      repo: "r",
      number: 5,
    })
  })

  it("handles URL with extra path segments after PR number", () => {
    const result = parsePRUrl("https://github.com/o/r/pull/123/files")
    expect(result).toEqual({ owner: "o", repo: "r", number: 123 })
  })

  it("rejects lookalike domains", () => {
    expect(parsePRUrl("https://evilgithub.com/owner/repo/pull/1")).toBeNull()
    expect(parsePRUrl("https://notgithub.com/owner/repo/pull/1")).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// localBranchName
// ---------------------------------------------------------------------------

describe("localBranchName", () => {
  it("returns headRefName for same-repo PR", () => {
    expect(
      localBranchName({
        headRefName: "feat/cool",
        isCrossRepository: false,
        title: "test",
      }),
    ).toBe("feat/cool")
  })

  it("prefixes with fork owner for cross-repo PR", () => {
    expect(
      localBranchName({
        headRefName: "fix/bug",
        headRepositoryOwner: { login: "Contributor" },
        isCrossRepository: true,
        title: "test",
      }),
    ).toBe("contributor/fix/bug")
  })

  it("returns headRefName if cross-repo but no owner", () => {
    expect(
      localBranchName({
        headRefName: "fix/bug",
        isCrossRepository: true,
        title: "test",
      }),
    ).toBe("fix/bug")
  })
})

// ---------------------------------------------------------------------------
// parseForEachRefOutput
// ---------------------------------------------------------------------------

describe("parseForEachRefOutput", () => {
  it("parses local and remote branches with dates", () => {
    const raw = [
      "refs/heads/main\t2025-01-15T10:00:00+00:00",
      "refs/heads/feat/a\t2025-01-14T09:00:00+00:00",
      "refs/remotes/origin/main\t2025-01-15T10:00:00+00:00",
      "refs/remotes/origin/feat/b\t2025-01-13T08:00:00+00:00",
    ].join("\n")

    const { locals, remotes, dates } = parseForEachRefOutput(raw)

    expect([...locals]).toEqual(["main", "feat/a"])
    expect([...remotes]).toEqual(["main", "feat/b"])
    expect(dates.get("main")).toBe("2025-01-15T10:00:00+00:00")
    expect(dates.get("feat/a")).toBe("2025-01-14T09:00:00+00:00")
    expect(dates.get("feat/b")).toBe("2025-01-13T08:00:00+00:00")
  })

  it("skips HEAD entries", () => {
    const raw = "refs/remotes/origin/HEAD\t2025-01-01T00:00:00+00:00\nrefs/heads/main\t2025-01-01T00:00:00+00:00"
    const { locals, remotes } = parseForEachRefOutput(raw)
    expect(remotes.has("HEAD")).toBe(false)
    expect(locals.has("main")).toBe(true)
  })

  it("skips empty lines", () => {
    const raw = "\n\nrefs/heads/main\t2025-01-01T00:00:00+00:00\n\n"
    const { locals } = parseForEachRefOutput(raw)
    expect([...locals]).toEqual(["main"])
  })

  it("handles empty output", () => {
    const { locals, remotes, dates } = parseForEachRefOutput("")
    expect(locals.size).toBe(0)
    expect(remotes.size).toBe(0)
    expect(dates.size).toBe(0)
  })

  it("local branch takes priority for date when both exist", () => {
    const raw = [
      "refs/heads/main\t2025-02-01T00:00:00+00:00",
      "refs/remotes/origin/main\t2025-01-01T00:00:00+00:00",
    ].join("\n")
    const { dates } = parseForEachRefOutput(raw)
    expect(dates.get("main")).toBe("2025-02-01T00:00:00+00:00")
  })
})

// ---------------------------------------------------------------------------
// buildBranchList
// ---------------------------------------------------------------------------

describe("buildBranchList", () => {
  it("merges local and remote into deduplicated sorted list", () => {
    const locals = new Set(["main", "feat/a"])
    const remotes = new Set(["main", "feat/b"])
    const dates = new Map([
      ["main", "2025-01-15T00:00:00+00:00"],
      ["feat/a", "2025-01-14T00:00:00+00:00"],
      ["feat/b", "2025-01-13T00:00:00+00:00"],
    ])

    const result = buildBranchList(locals, remotes, dates, "main")

    expect(result[0].name).toBe("main")
    expect(result[0].isDefault).toBe(true)
    expect(result[0].isLocal).toBe(true)
    expect(result[0].isRemote).toBe(true)

    expect(result[1].name).toBe("feat/a")
    expect(result[1].isLocal).toBe(true)
    expect(result[1].isRemote).toBe(false)

    expect(result[2].name).toBe("feat/b")
    expect(result[2].isLocal).toBe(false)
    expect(result[2].isRemote).toBe(true)
  })

  it("sorts default branch first", () => {
    const locals = new Set(["z-branch", "main"])
    const dates = new Map([
      ["z-branch", "2099-01-01T00:00:00+00:00"],
      ["main", "2020-01-01T00:00:00+00:00"],
    ])
    const result = buildBranchList(locals, new Set(), dates, "main")
    expect(result[0].name).toBe("main")
  })

  it("sorts by date descending after default", () => {
    const locals = new Set(["old", "new", "mid"])
    const dates = new Map([
      ["old", "2020-01-01T00:00:00+00:00"],
      ["new", "2025-01-01T00:00:00+00:00"],
      ["mid", "2023-01-01T00:00:00+00:00"],
    ])
    const result = buildBranchList(locals, new Set(), dates, "none")
    expect(result.map((b) => b.name)).toEqual(["new", "mid", "old"])
  })

  it("handles empty inputs", () => {
    expect(buildBranchList(new Set(), new Set(), new Map(), "main")).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// classifyPRError
// ---------------------------------------------------------------------------

describe("classifyPRError", () => {
  it("detects PR not found", () => {
    expect(classifyPRError("GraphQL: Could not resolve to a PullRequest")).toBe("not_found")
    expect(classifyPRError("not found")).toBe("not_found")
  })

  it("detects gh CLI missing", () => {
    expect(classifyPRError("gh: command not found")).toBe("gh_missing")
    expect(classifyPRError("spawn gh ENOENT")).toBe("gh_missing")
    expect(classifyPRError("'gh' is not recognized as an internal command")).toBe("gh_missing")
  })

  it("detects gh auth issue", () => {
    expect(classifyPRError("not logged into any github hosts")).toBe("gh_auth")
    expect(classifyPRError("please run `gh auth login`")).toBe("gh_auth")
  })

  it("returns unknown for unrecognized errors", () => {
    expect(classifyPRError("something went wrong")).toBe("unknown")
  })
})
