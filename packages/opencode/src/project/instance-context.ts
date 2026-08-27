import { LocalContext } from "@/util/local-context"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Filesystem } from "@/util/filesystem"
import type * as Project from "./project"

export interface InstanceContext {
  directory: string
  worktree: string
  project: Project.Info
}

export const context = LocalContext.create<InstanceContext>("instance")

/**
 * Check if a path is within the project boundary.
 * Returns true if path is inside ctx.directory OR ctx.worktree.
 * Paths within the worktree but outside the working directory should not trigger external_directory permission.
 */
export function canonicalRoot(directory: string, worktree?: string): string {
  return worktree && worktree !== "/" ? worktree : directory
}

export function rootFromContext(ctx: InstanceContext): string {
  return canonicalRoot(ctx.directory, ctx.worktree)
}

export function containsPath(filepath: string, ctx: InstanceContext): boolean {
  if (FSUtil.contains(ctx.directory, filepath)) return true
  // Non-git projects set worktree to "/" which would match ANY absolute path.
  // Skip worktree check in this case to preserve external_directory permissions.
  if (ctx.worktree === "/") return false
  return FSUtil.contains(ctx.worktree, filepath)
}

export async function resolveWorktree(directory: string): Promise<string | undefined> {
  try {
    const proc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], {
      cwd: directory,
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    })
    const [text, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    if (code !== 0) return undefined
    const out = text.trim()
    if (!out) return undefined
    return Filesystem.resolve(out)
  } catch {
    return undefined
  }
}

export async function resolveCanonicalRoot(directory: string): Promise<string> {
  const worktree = await resolveWorktree(directory)
  return canonicalRoot(directory, worktree)
}
