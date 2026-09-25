export const Npm = {
  name: "@kilocode/cli",
  path: "@kilocode%2fcli",
}

export const Brew = {
  name: "kilo",
  tap: "Kilo-Org/tap",
  formula: "Kilo-Org/tap/kilo",
  api: "https://formulae.brew.sh/api/formula/kilo.json",
}

export const Choco = {
  name: "kilo",
  api: "https://community.chocolatey.org/api/v2/Packages?$filter=Id%20eq%20%27kilo%27%20and%20IsLatestVersion&$select=Version",
}

export const Scoop = {
  name: "kilo",
  manifest: "https://raw.githubusercontent.com/ScoopInstaller/Main/master/bucket/kilo.json",
}

// Release.install retired: Kilo Code is now VS Code extension-only
// (VSIX bundles kilo-serve); standalone installer and GH release
// archives are no longer published. See https://kilo.ai/docs
