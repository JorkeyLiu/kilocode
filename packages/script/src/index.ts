import { $ } from "bun"
import semver from "semver"
import path from "path"

const rootPkgPath = path.resolve(import.meta.dir, "../../../package.json")
const rootPkg = await Bun.file(rootPkgPath).json()
const expectedBunVersion = rootPkg.packageManager?.split("@")[1]

if (!expectedBunVersion) {
  throw new Error("packageManager field not found in root package.json")
}

// relax version requirement
const expectedBunVersionRange = `^${expectedBunVersion}`

if (!semver.satisfies(process.versions.bun, expectedBunVersionRange)) {
  throw new Error(`This script requires bun@${expectedBunVersionRange}, but you are using bun@${process.versions.bun}`)
}
// kilocode_change start
const env = {
  KILO_CHANNEL: process.env["KILO_CHANNEL"],
  KILO_BUMP: process.env["KILO_BUMP"],
  KILO_VERSION: process.env["KILO_VERSION"],
  KILO_RELEASE: process.env["KILO_RELEASE"],
  KILO_PRE_RELEASE: process.env["KILO_PRE_RELEASE"],
}
// kilocode_change end
export function sanitizeChannel(raw: string): string {
  return raw.trim().replace(/[^0-9A-Za-z-]/g, "-") || "detached"
}

const CHANNEL = await (async () => {
  if (env.KILO_CHANNEL) return env.KILO_CHANNEL // kilocode_change
  // kilocode_change start - publish to "rc" channel for pre-releases
  if (env.KILO_PRE_RELEASE === "true") return "rc"
  // kilocode_change end
  if (env.KILO_BUMP) return "latest" // kilocode_change
  if (env.KILO_VERSION && !env.KILO_VERSION.startsWith("0.0.0-")) return "latest" // kilocode_change
  return await $`git branch --show-current`.text().then((x) => sanitizeChannel(x)) // kilocode_change
})()
const IS_PREVIEW = CHANNEL !== "latest"

// kilocode_change start - shared helpers for version computation
export function parseVersion(input: string) {
  const match = input.trim().match(/^v?(\d+)\.(\d+)\.(\d+)$/)
  if (!match) return
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    value: `${match[1]}.${match[2]}.${match[3]}`,
  }
}

export function compareVersion(
  a: NonNullable<ReturnType<typeof parseVersion>>,
  b: NonNullable<ReturnType<typeof parseVersion>>,
) {
  if (a.major !== b.major) return a.major - b.major
  if (a.minor !== b.minor) return a.minor - b.minor
  return a.patch - b.patch
}

export function bumpVersion(current: string, type: string) {
  const version = parseVersion(current)
  if (!version) throw new Error(`Invalid version: ${current}`)
  const t = type.toLowerCase()
  if (t === "major") return `${version.major + 1}.0.0`
  if (t === "minor") return `${version.major}.${version.minor + 1}.0`
  return `${version.major}.${version.minor}.${version.patch + 1}`
}

export function highestFromTags(tags: string[]): string {
  const versions = tags.flatMap((tag) => {
    const v = parseVersion(tag)
    if (!v) return []
    return [v]
  })
  const highest = versions.sort(compareVersion).at(-1)
  if (!highest) {
    const repo = process.env.GH_REPO?.trim()
    const hint = repo ? ` --repo ${repo}` : ` (GH_REPO not set, inferred from git remote)`
    throw new Error(
      `No valid semver releases found via 'gh release list${hint}'. ` +
        `Create an initial GitHub release with a semver tag (e.g. v0.1.0) or set KILO_VERSION to bypass. ` +
        `Looked at ${tags.length} tags, none matched vMAJOR.MINOR.PATCH.`,
    )
  }
  return highest.value
}

export type Release = { tagName: string; isDraft: boolean; isPrerelease: boolean }

export const RELEASE_LIMIT = 1000

export function highestFromReleases(
  releases: Release[],
  opts: { includePrerelease?: boolean } = {},
): string {
  const includePrerelease = opts.includePrerelease ?? false
  const filtered = releases.filter((r) => {
    if (r.isDraft) return false
    if (!includePrerelease && r.isPrerelease) return false
    return !!parseVersion(r.tagName)
  })
  const versions = filtered.flatMap((r) => {
    const v = parseVersion(r.tagName)
    if (!v) return []
    return [v]
  })
  const highest = versions.sort(compareVersion).at(-1)
  if (!highest) {
    const repo = process.env.GH_REPO?.trim()
    const hint = repo ? ` --repo ${repo}` : ` (GH_REPO not set, inferred from git remote)`
    const kind = includePrerelease ? "non-draft" : "non-draft non-prerelease"
    throw new Error(
      `No valid semver releases found via 'gh release list${hint}'. ` +
        `Create an initial GitHub release with a semver tag (e.g. v0.1.0) or set KILO_VERSION to bypass. ` +
        `Looked at ${releases.length} releases, ${filtered.length} matched ${kind} vMAJOR.MINOR.PATCH.`,
    )
  }
  return highest.value
}

export type GhRunner = (limit: number, repo: string | undefined) => Promise<Release[]>

export async function fetchHighest(
  opts: { includePrerelease?: boolean; runner?: GhRunner } = {},
): Promise<string> {
  const repo = process.env.GH_REPO?.trim() || undefined
  const includePrerelease = opts.includePrerelease ?? false
  let data: Release[]
  try {
    if (opts.runner) {
      data = await opts.runner(RELEASE_LIMIT, repo)
    } else if (repo) {
      data = (await $`gh release list --json tagName,isDraft,isPrerelease --limit ${RELEASE_LIMIT} --repo ${repo}`.json()) as Release[]
    } else {
      data = (await $`gh release list --json tagName,isDraft,isPrerelease --limit ${RELEASE_LIMIT}`.json()) as Release[]
    }
  } catch (cause) {
    const repoHint = repo ? ` --repo ${repo} (GH_REPO=${repo})` : ` (GH_REPO not set, inferred from git remote)`
    const detail = cause instanceof Error ? cause.message : String(cause)
    throw new Error(
      `Failed to list GitHub releases via 'gh release list${repoHint}'. ` +
        `Ensure gh CLI is installed and authenticated (GH_TOKEN) and the repository is accessible. ` +
        `To bypass version lookup, set KILO_VERSION explicitly (e.g. KILO_VERSION=1.2.3). Cause: ${detail}`,
    )
  }
  const releases = Array.isArray(data) ? data : []
  if (releases.length === RELEASE_LIMIT) {
    const repoHint = repo ? ` --repo ${repo} (GH_REPO=${repo})` : ` (GH_REPO not set, inferred from git remote)`
    throw new Error(
      `GitHub release list hit --limit ${RELEASE_LIMIT}${repoHint}; pagination may be truncated (exactly ${RELEASE_LIMIT} results). ` +
        `Cannot prove exhaustive coverage — fail closed. ` +
        `To bypass version lookup, set KILO_VERSION explicitly (e.g. KILO_VERSION=1.2.3). ` +
        `If pagination API cannot be proven exhaustive, increase limit or implement pagination.`,
    )
  }
  return highestFromReleases(releases, { includePrerelease })
}

export async function computeVersion(opts: {
  env: typeof env
  channel: string
  isPreview: boolean
  fetchHighest: (o?: { includePrerelease?: boolean }) => Promise<string>
}): Promise<string> {
  if (opts.env.KILO_VERSION) return opts.env.KILO_VERSION
  if (opts.isPreview) {
    if (opts.env.KILO_BUMP && opts.env.KILO_PRE_RELEASE === "true") {
      const current = await opts.fetchHighest({ includePrerelease: true })
      return bumpVersion(current, opts.env.KILO_BUMP.toLowerCase())
    }
    return `0.0.0-${opts.channel}-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}`
  }
  const version = await opts.fetchHighest({ includePrerelease: false })
  return bumpVersion(version, opts.env.KILO_BUMP?.toLowerCase() ?? "patch")
}
// kilocode_change end

const VERSION = await computeVersion({ env, channel: CHANNEL, isPreview: IS_PREVIEW, fetchHighest })

// kilocode_change start
const team = [
  "actions-user",
  "alexkgold",
  "arimesser",
  "arkadiykondrashov",
  "bturcotte520",
  "chrarnoldus",
  "codingelves",
  "dependabot[bot]",
  "dosire",
  "Drixled",
  "DScdng",
  "emilieschario",
  "eshurakov",
  "evanjacobson",
  "Helix-Kilo",
  "iscekic",
  "jeanduplessis",
  "jobrietbergen",
  "johnnyeric",
  "jrf0110",
  "kilo-code-bot",
  "kilo-code-bot[bot]",
  "kilo-maintainer[bot]",
  "kilocode-bot",
  "kiloconnect-lite[bot]",
  "kiloconnect[bot]",
  "kirillk",
  "lambertjosh",
  "marius-kilocode",
  "olearycrew",
  "pandemicsyn",
  "pedroheyerdahl",
  "RSO",
  "sbreitenother",
  "St0rmz1",
  "suhailkc2025",
]
// kilocode_change end

export const Script = {
  get channel() {
    return CHANNEL
  },
  get version() {
    return VERSION
  },
  get preview() {
    return IS_PREVIEW
  },
  get release(): boolean {
    return !!env.KILO_RELEASE
  },
  get team() {
    return team
  },
}
console.log(`kilo script`, JSON.stringify(Script, null, 2)) // kilocode_change
