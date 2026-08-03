#!/usr/bin/env bun

// Explicit refresh of the canonical committed models snapshot from models.dev.
// This is the only build-snapshot network path; normal builds never fetch.

import { refreshModelsSnapshot } from "./models-snapshot"

const url = process.env.KILO_MODELS_URL || "https://models.dev"
const stats = await refreshModelsSnapshot(url)
console.log(
  `Refreshed committed models snapshot from ${url}/api.json (${stats.providers} providers, ${stats.models} models)`,
)
