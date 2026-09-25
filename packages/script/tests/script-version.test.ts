// kilocode_change - new file - focused unit tests for Script.version after npm removal
import { describe, expect, test, afterEach } from "bun:test"
import {
  parseVersion,
  bumpVersion,
  compareVersion,
  highestFromTags,
  highestFromReleases,
  fetchHighest,
  RELEASE_LIMIT,
  sanitizeChannel,
  computeVersion,
  type Release,
} from "../src/index.ts"

const envBase = {
  KILO_CHANNEL: undefined as string | undefined,
  KILO_BUMP: undefined as string | undefined,
  KILO_VERSION: undefined as string | undefined,
  KILO_RELEASE: undefined as string | undefined,
  KILO_PRE_RELEASE: undefined as string | undefined,
}

afterEach(() => {
  delete process.env.GH_REPO
})

describe("parseVersion", () => {
  test("parses plain and v-prefixed semver", () => {
    expect(parseVersion("1.2.3")?.value).toBe("1.2.3")
    expect(parseVersion("v1.2.3")?.value).toBe("1.2.3")
    expect(parseVersion("  v0.10.2  ")?.value).toBe("0.10.2")
  })
  test("rejects prerelease and invalid", () => {
    expect(parseVersion("1.2.3-rc.0")).toBeUndefined()
    expect(parseVersion("1.2")).toBeUndefined()
    expect(parseVersion("latest")).toBeUndefined()
    expect(parseVersion("")).toBeUndefined()
  })
})

describe("compareVersion / bumpVersion", () => {
  test("compare orders major/minor/patch", () => {
    const a = parseVersion("1.2.3")!
    const b = parseVersion("1.10.0")!
    expect(compareVersion(a, b) < 0).toBe(true)
    expect(compareVersion(b, a) > 0).toBe(true)
    expect(compareVersion(a, a)).toBe(0)
  })
  test("bump patch/minor/major case-insensitive, rejects invalid", () => {
    expect(bumpVersion("1.2.3", "patch")).toBe("1.2.4")
    expect(bumpVersion("1.2.3", "Patch")).toBe("1.2.4")
    expect(bumpVersion("1.2.3", "minor")).toBe("1.3.0")
    expect(bumpVersion("1.2.3", "MINOR")).toBe("1.3.0")
    expect(bumpVersion("1.2.3", "major")).toBe("2.0.0")
    expect(bumpVersion("1.2.3", "MAJOR")).toBe("2.0.0")
    expect(() => bumpVersion("bad", "patch")).toThrow(/Invalid version/)
  })
})

describe("highestFromTags", () => {
  test("returns highest semver, ignores invalid tags", () => {
    expect(highestFromTags(["v1.2.3", "v1.10.0", "latest", "v2.0.0"])).toBe("2.0.0")
    expect(highestFromTags(["v0.1.0", "v0.0.9"])).toBe("0.1.0")
  })
  test("fail closed with actionable message when empty or no valid tags", () => {
    let err: Error | undefined
    try {
      highestFromTags([])
    } catch (e) {
      err = e as Error
    }
    expect(err).toBeDefined()
    expect(err!.message).toContain("No valid semver releases found via 'gh release list")
    expect(err!.message).toContain("KILO_VERSION")
    // with GH_REPO set, hint includes repo
    process.env.GH_REPO = "Kilo-Org/kilocode"
    let err2: Error | undefined
    try {
      highestFromTags(["not-semver"])
    } catch (e) {
      err2 = e as Error
    }
    expect(err2!.message).toContain("--repo Kilo-Org/kilocode")
    delete process.env.GH_REPO
    // without GH_REPO, hint says inferred
    let err3: Error | undefined
    try {
      highestFromTags([])
    } catch (e) {
      err3 = e as Error
    }
    expect(err3!.message).toContain("GH_REPO not set")
  })
})

describe("computeVersion (explicit / preview / bump)", () => {
  test("explicit KILO_VERSION bypasses network", async () => {
    let called = false
    const fetcher = async () => {
      called = true
      return "9.9.9"
    }
    const v = await computeVersion({
      env: { ...envBase, KILO_VERSION: "7.4.11" },
      channel: "latest",
      isPreview: false,
      fetchHighest: fetcher,
    })
    expect(v).toBe("7.4.11")
    expect(called).toBe(false)
  })

  test("preview branch without bump returns timestamp without network", async () => {
    let called = false
    const fetcher = async () => {
      called = true
      return "1.2.3"
    }
    const v = await computeVersion({
      env: { ...envBase },
      channel: "my-feature",
      isPreview: true,
      fetchHighest: fetcher,
    })
    expect(called).toBe(false)
    expect(v).toMatch(/^0\.0\.0-my-feature-\d{12}$/)
  })

  test("preview rc bump uses fetched highest with bump", async () => {
    const fetcher = async () => "1.2.3"
    const v = await computeVersion({
      env: { ...envBase, KILO_BUMP: "patch", KILO_PRE_RELEASE: "true" },
      channel: "rc",
      isPreview: true,
      fetchHighest: fetcher,
    })
    expect(v).toBe("1.2.4")
    const vMinor = await computeVersion({
      env: { ...envBase, KILO_BUMP: "minor", KILO_PRE_RELEASE: "true" },
      channel: "rc",
      isPreview: true,
      fetchHighest: fetcher,
    })
    expect(vMinor).toBe("1.3.0")
  })

  test("preview rc without bump still uses timestamp (no fetch)", async () => {
    let called = false
    const fetcher = async () => {
      called = true
      return "1.2.3"
    }
    // KILO_PRE_RELEASE true but no KILO_BUMP -> timestamp path
    const v = await computeVersion({
      env: { ...envBase, KILO_PRE_RELEASE: "true" },
      channel: "rc",
      isPreview: true,
      fetchHighest: fetcher,
    })
    expect(called).toBe(false)
    expect(v).toMatch(/^0\.0\.0-rc-\d{12}$/)
  })

  test("non-preview bump uses fetched highest and defaults to patch", async () => {
    const fetcher = async () => "2.5.9"
    const vPatch = await computeVersion({
      env: { ...envBase },
      channel: "latest",
      isPreview: false,
      fetchHighest: fetcher,
    })
    expect(vPatch).toBe("2.5.10")
    const vMajor = await computeVersion({
      env: { ...envBase, KILO_BUMP: "major" },
      channel: "latest",
      isPreview: false,
      fetchHighest: fetcher,
    })
    expect(vMajor).toBe("3.0.0")
  })

  test("fetch failure propagates actionable error (no silent npm fallback)", async () => {
    const failing = async () => {
      throw new Error(
        `Failed to list GitHub releases via 'gh release list (GH_REPO not set, inferred from git remote)'. Ensure gh CLI is installed and authenticated (GH_TOKEN) and the repository is accessible. To bypass version lookup, set KILO_VERSION explicitly (e.g. KILO_VERSION=1.2.3). Cause: gh not found`,
      )
    }
    await expect(
      computeVersion({
        env: { ...envBase, KILO_BUMP: "patch" },
        channel: "latest",
        isPreview: false,
        fetchHighest: failing,
      }),
    ).rejects.toThrow(/Failed to list GitHub releases/)
    await expect(
      computeVersion({
        env: { ...envBase, KILO_BUMP: "patch" },
        channel: "latest",
        isPreview: false,
        fetchHighest: failing,
      }),
    ).rejects.toThrow(/KILO_VERSION/)
  })

  test("empty releases propagates highestFromTags actionable error", async () => {
    const emptyFetcher = async () => highestFromTags([])
    await expect(
      computeVersion({
        env: { ...envBase },
        channel: "latest",
        isPreview: false,
        fetchHighest: emptyFetcher,
      }),
    ).rejects.toThrow(/No valid semver releases/)
  })
})

describe("sanitizeChannel - detached HEAD fallback", () => {
  test("empty and whitespace become detached", () => {
    expect(sanitizeChannel("")).toBe("detached")
    expect(sanitizeChannel("   ")).toBe("detached")
    expect(sanitizeChannel("\n")).toBe("detached")
  })
  test("sanitizes branch names and preserves detached fallback", () => {
    expect(sanitizeChannel("main")).toBe("main")
    expect(sanitizeChannel("feature/foo")).toBe("feature-foo")
    expect(sanitizeChannel(" feat/bar:baz ")).toBe("feat-bar-baz")
  })
  test("detached channel remains preview timestamp without network", async () => {
    let called = false
    const fetcher = async () => {
      called = true
      return "9.9.9"
    }
    const v = await computeVersion({
      env: { ...envBase },
      channel: "detached",
      isPreview: true,
      fetchHighest: fetcher,
    })
    expect(called).toBe(false)
    expect(v).toMatch(/^0\.0\.0-detached-\d{12}$/)
  })
  test("detached with explicit KILO_VERSION bypasses network", async () => {
    let called = false
    const fetcher = async () => {
      called = true
      return "9.9.9"
    }
    const v = await computeVersion({
      env: { ...envBase, KILO_VERSION: "1.2.3" },
      channel: "detached",
      isPreview: true,
      fetchHighest: fetcher,
    })
    expect(v).toBe("1.2.3")
    expect(called).toBe(false)
  })
})

describe("highestFromReleases - stable vs prerelease/drafts + invalid tags", () => {
  const releases: Release[] = [
    { tagName: "v1.0.0", isDraft: false, isPrerelease: false },
    { tagName: "v1.1.0", isDraft: true, isPrerelease: false }, // draft -> ignored always
    { tagName: "v1.2.0", isDraft: false, isPrerelease: true }, // prerelease GH flag
    { tagName: "v1.2.3-rc.0", isDraft: false, isPrerelease: true }, // plain-semver prerelease string -> invalid parse, ignored
    { tagName: "v1.2.3-beta", isDraft: false, isPrerelease: false }, // invalid semver string -> ignored
    { tagName: "latest", isDraft: false, isPrerelease: false }, // invalid tag -> ignored
    { tagName: "v2.0", isDraft: false, isPrerelease: false }, // invalid -> ignored
    { tagName: "v2.0.0", isDraft: false, isPrerelease: false },
    { tagName: "v2.1.0", isDraft: false, isPrerelease: false },
  ]

  test("stable (default) excludes drafts and prerelease GH flag and invalid plain-semver", () => {
    expect(highestFromReleases(releases)).toBe("2.1.0")
    // even if prerelease version is higher, stable ignores it
    const withHigherPrerelease: Release[] = [
      ...releases,
      { tagName: "v3.0.0", isDraft: false, isPrerelease: true },
    ]
    expect(highestFromReleases(withHigherPrerelease)).toBe("2.1.0")
  })

  test("includePrerelease includes GH prerelease but still excludes drafts and invalid tags", () => {
    const withHigherPrerelease: Release[] = [
      ...releases,
      { tagName: "v3.0.0", isDraft: false, isPrerelease: true },
      { tagName: "v4.0.0", isDraft: true, isPrerelease: true }, // draft prerelease ignored
      { tagName: "v3.1.0-rc.1", isDraft: false, isPrerelease: true }, // plain-semver prerelease string ignored even when included
    ]
    expect(highestFromReleases(withHigherPrerelease, { includePrerelease: true })).toBe("3.0.0")
    // plain-semver prerelease strings never count
    const onlyPlainPrerelease: Release[] = [
      { tagName: "v1.0.0-rc.0", isDraft: false, isPrerelease: true },
      { tagName: "v1.0.0-beta", isDraft: false, isPrerelease: false },
    ]
    expect(() => highestFromReleases(onlyPlainPrerelease, { includePrerelease: true })).toThrow(/No valid semver releases/)
  })

  test("drafts are excluded in both modes", () => {
    const draftsOnly: Release[] = [
      { tagName: "v5.0.0", isDraft: true, isPrerelease: false },
      { tagName: "v5.0.1", isDraft: true, isPrerelease: true },
    ]
    expect(() => highestFromReleases(draftsOnly)).toThrow(/No valid semver releases/)
    expect(() => highestFromReleases(draftsOnly, { includePrerelease: true })).toThrow(/No valid semver releases/)
  })

  test("invalid tags are ignored, highest among valid remains", () => {
    const mixed: Release[] = [
      { tagName: "not-semver", isDraft: false, isPrerelease: false },
      { tagName: "v1.0.0-alpha", isDraft: false, isPrerelease: false },
      { tagName: "v0.9.0", isDraft: false, isPrerelease: false },
      { tagName: "v1.0.0", isDraft: false, isPrerelease: false },
    ]
    expect(highestFromReleases(mixed)).toBe("1.0.0")
  })

  test("throws actionable error with kind hint when no match", () => {
    const onlyPrerelease: Release[] = [{ tagName: "v1.0.0", isDraft: false, isPrerelease: true }]
    let err: Error | undefined
    try {
      highestFromReleases(onlyPrerelease)
    } catch (e) {
      err = e as Error
    }
    expect(err).toBeDefined()
    expect(err!.message).toContain("non-draft non-prerelease")
    expect(err!.message).toContain("KILO_VERSION")
    // includePrerelease true includes that prerelease and returns it
    expect(highestFromReleases(onlyPrerelease, { includePrerelease: true })).toBe("1.0.0")
    // empty yields non-draft hint
    let err2: Error | undefined
    try {
      highestFromReleases([], { includePrerelease: true })
    } catch (e) {
      err2 = e as Error
    }
    expect(err2).toBeDefined()
    expect(err2!.message).toContain("non-draft")
    expect(err2!.message).not.toContain("non-draft non-prerelease")
  })

  test("GH_REPO hint included in error", () => {
    process.env.GH_REPO = "Kilo-Org/kilocode"
    let err: Error | undefined
    try {
      highestFromReleases([])
    } catch (e) {
      err = e as Error
    }
    expect(err!.message).toContain("--repo Kilo-Org/kilocode")
    delete process.env.GH_REPO
    let err2: Error | undefined
    try {
      highestFromReleases([])
    } catch (e) {
      err2 = e as Error
    }
    expect(err2!.message).toContain("GH_REPO not set")
  })
})

describe("fetchHighest - injected runner and cap 1000", () => {
  test("uses injected runner and respects includePrerelease flag (no live gh)", async () => {
    const releases: Release[] = [
      { tagName: "v1.0.0", isDraft: false, isPrerelease: false },
      { tagName: "v2.0.0", isDraft: false, isPrerelease: true },
      { tagName: "v1.5.0", isDraft: true, isPrerelease: false },
      { tagName: "v1.2.3-rc.0", isDraft: false, isPrerelease: false }, // invalid plain-semver
    ]
    const runner = async (limit: number, _repo: string | undefined) => {
      expect(limit).toBe(RELEASE_LIMIT)
      expect(limit).toBe(1000)
      return releases
    }
    expect(await fetchHighest({ runner })).toBe("1.0.0") // stable
    expect(await fetchHighest({ includePrerelease: true, runner })).toBe("2.0.0") // includes prerelease
  })

  test("cap 1000 via injected runner fails closed when exactly RELEASE_LIMIT results", async () => {
    const many: Release[] = Array.from({ length: RELEASE_LIMIT }, (_, i) => ({
      tagName: `v0.0.${i}`,
      isDraft: false,
      isPrerelease: false,
    }))
    const runner = async () => many
    await expect(fetchHighest({ runner })).rejects.toThrow(/hit --limit 1000/)
    await expect(fetchHighest({ runner })).rejects.toThrow(/pagination may be truncated/)
    await expect(fetchHighest({ runner })).rejects.toThrow(/KILO_VERSION/)
    // includePrerelease also caps
    await expect(fetchHighest({ includePrerelease: true, runner })).rejects.toThrow(/hit --limit 1000/)
  })

  test("passes repo from GH_REPO to runner and succeeds under limit", async () => {
    process.env.GH_REPO = "Kilo-Org/kilocode"
    const releases: Release[] = [{ tagName: "v9.9.9", isDraft: false, isPrerelease: false }]
    let seenRepo: string | undefined
    const runner = async (_limit: number, repo: string | undefined) => {
      seenRepo = repo
      return releases
    }
    expect(await fetchHighest({ runner })).toBe("9.9.9")
    expect(seenRepo).toBe("Kilo-Org/kilocode")
    delete process.env.GH_REPO
    let seenRepo2: string | undefined = "not-set"
    const runner2 = async (_limit: number, repo: string | undefined) => {
      seenRepo2 = repo
      return releases
    }
    expect(await fetchHighest({ runner: runner2 })).toBe("9.9.9")
    expect(seenRepo2).toBeUndefined()
  })

  test("runner failure propagates actionable error", async () => {
    const failingRunner = async () => {
      throw new Error("gh not found")
    }
    await expect(fetchHighest({ runner: failingRunner })).rejects.toThrow(/Failed to list GitHub releases/)
    await expect(fetchHighest({ runner: failingRunner })).rejects.toThrow(/KILO_VERSION/)
  })

  test("below cap with no valid semver after filtering still throws via highestFromReleases", async () => {
    const releases: Release[] = [{ tagName: "v1.0.0", isDraft: true, isPrerelease: false }]
    const runner = async () => releases
    await expect(fetchHighest({ runner })).rejects.toThrow(/No valid semver releases/)
  })
})
