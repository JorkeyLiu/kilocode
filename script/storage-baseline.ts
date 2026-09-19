#!/usr/bin/env bun
// repo-local wrapper for S0 storage baseline — delegates to the opencode script to keep one implementation
import path from "path"
const target = path.join(import.meta.dir, "../packages/opencode/script/storage-baseline.ts")
await import(target)
