type PluginSpec = string | [string, Record<string, unknown>]

export type Features = {
  sandboxControls: boolean
}

export function configFeatures(): Features {
  return {
    sandboxControls: process.platform !== "win32",
  }
}
