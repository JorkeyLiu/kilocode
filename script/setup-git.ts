#!/usr/bin/env bun

/**
 * Configures repo-local git settings for all contributors.
 *
 * `merge.conflictStyle=zdiff3` makes conflict markers include the common
 * ancestor (|||||||) alongside ours/theirs, which makes manual conflict
 * resolution dramatically easier than the default 2-way `merge` markers.
 *
 * Runs from `postinstall`. Safe to re-run — `git config` is idempotent.
 * Guarded so tarball / docker installs without a `.git` don't fail.
 */

import { $ } from "bun"

const inside = await $`git rev-parse --is-inside-work-tree`.nothrow().quiet()
if (inside.exitCode !== 0) process.exit(0)

await $`git config --local merge.conflictStyle zdiff3`.quiet()
