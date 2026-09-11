import { createTwoFilesPatch, diffLines } from "diff"
import { Snapshot } from "@/snapshot"

export const MAX = 500_000 // kilocode_change - shared cap for declared file diffs

export function trimDiff(diff: string): string {
  const lines = diff.split("\n")
  const contentLines = lines.filter(
    (line) =>
      (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) &&
      !line.startsWith("---") &&
      !line.startsWith("+++"),
  )

  if (contentLines.length === 0) return diff

  let min = Infinity
  for (const line of contentLines) {
    const content = line.slice(1)
    if (content.trim().length > 0) {
      const match = content.match(/^(\s*)/)
      if (match) min = Math.min(min, match[1].length)
    }
  }
  if (min === Infinity || min === 0) return diff
  const trimmedLines = lines.map((line) => {
    if (
      (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) &&
      !line.startsWith("---") &&
      !line.startsWith("+++")
    ) {
      const prefix = line[0]
      const content = line.slice(1)
      return prefix + content.slice(min)
    }
    return line
  })

  return trimmedLines.join("\n")
}

function count(before: string, after: string): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const change of diffLines(before, after)) {
    if (change.added) additions += change.count || 0
    if (change.removed) deletions += change.count || 0
  }
  return { additions, deletions }
}

// kilocode_change - single builder for declared file diffs so edit/write/apply_patch
// share one additions/deletions/patch口径. Callers pass decoded texts (BOM stripped);
// `diff` is the trimmed display patch, `filediff` carries the raw patch for storage.
export function build(
  file: string,
  before: string,
  after: string,
): { diff: string; filediff: Snapshot.FileDiff } {
  const large = before.length > MAX || after.length > MAX
  const tally = large ? { additions: 0, deletions: 0 } : count(before, after)
  const patch = large ? "" : createTwoFilesPatch(file, file, before, after)
  return {
    diff: trimDiff(patch),
    filediff: {
      file,
      patch,
      additions: tally.additions,
      deletions: tally.deletions,
    },
  }
}
