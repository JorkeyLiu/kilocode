#!/usr/bin/env bun

import { $ } from "bun"
import fs from "fs"
import os from "os"
import path from "path"
import { spawnSync } from "child_process"
import { fileURLToPath } from "url"
import { createRequire } from "module" // kilocode_change

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")
const require = createRequire(import.meta.url) // kilocode_change

process.chdir(dir)

import { Script } from "@opencode-ai/script"
import pkg from "../package.json"
// kilocode_change start
import { stageBubblewrap } from "./kilocode/bubblewrap"
import { KiloSandboxWorker } from "./kilocode/kilo-sandbox-worker"
import { KiloSandboxNetwork } from "./kilocode/kilo-sandbox-network"
// kilocode_change end

const singleFlag = process.argv.includes("--single")
const baselineFlag = process.argv.includes("--baseline")
const skipInstall = process.argv.includes("--skip-install")
const sourcemapsFlag = process.argv.includes("--sourcemaps")

// kilocode_change start - codebase indexing
async function copyTreeSitterWasms(outputDir: string) {
  const runtimeWasmPath = require.resolve("web-tree-sitter/tree-sitter.wasm")
  const languagePackagePath = require.resolve("tree-sitter-wasms/package.json")
  const languageWasmDir = path.join(path.dirname(languagePackagePath), "out")
  const targetDir = path.join(outputDir, "tree-sitter")

  await fs.promises.mkdir(targetDir, { recursive: true })
  await fs.promises.copyFile(runtimeWasmPath, path.join(targetDir, "tree-sitter.wasm"))

  const languageWasmFiles = (await fs.promises.readdir(languageWasmDir)).filter((file) => file.endsWith(".wasm"))

  await Promise.all(
    languageWasmFiles.map((file) => fs.promises.copyFile(path.join(languageWasmDir, file), path.join(targetDir, file))),
  )

  console.log(`copied ${languageWasmFiles.length + 1} tree-sitter wasm files to ${targetDir}`)
}

// Kilo dropped the packages/app web UI. Kept here as a commented reference so the
// deliberate divergence stays visible rather than treating a re-add as a clean re-introduction.
// const createEmbeddedWebUIBundle = async () => {
//   console.log(`Building Web UI to embed in the binary`)
//   const appDir = path.join(import.meta.dirname, "../../app")
//   const dist = path.join(appDir, "dist")
//   await $`bun run --cwd ${appDir} build`
//   const files = (await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: dist })))
//     .map((file) => file.replaceAll("\\", "/"))
//     .filter((file) => !file.endsWith(".map"))
//     .sort()
//   const imports = files.map((file, i) => {
//     const spec = path.relative(dir, path.join(dist, file)).replaceAll("\\", "/")
//     return `import file_${i} from ${JSON.stringify(spec.startsWith(".") ? spec : `./${spec}`)} with { type: "file" };`
//   })
//   const entries = files.map((file, i) => `  ${JSON.stringify(file)}: file_${i},`)
//   return [
//     `// Import all files as file_$i with type: "file"`,
//     ...imports,
//     `// Export with original mappings`,
//     `export default {`,
//     ...entries,
//     `}`,
//   ].join("\n")
// }
// kilocode_change end

const allTargets: {
  os: string
  arch: "arm64" | "x64"
  abi?: "musl"
  avx2?: false
}[] = [
  {
    os: "linux",
    arch: "arm64",
  },
  {
    os: "linux",
    arch: "x64",
  },
  {
    os: "linux",
    arch: "x64",
    avx2: false,
  },
  {
    os: "linux",
    arch: "arm64",
    abi: "musl",
  },
  {
    os: "linux",
    arch: "x64",
    abi: "musl",
  },
  {
    os: "linux",
    arch: "x64",
    abi: "musl",
    avx2: false,
  },
  {
    os: "darwin",
    arch: "arm64",
  },
  {
    os: "darwin",
    arch: "x64",
  },
  {
    os: "darwin",
    arch: "x64",
    avx2: false,
  },
  {
    os: "win32",
    arch: "arm64",
  },
  {
    os: "win32",
    arch: "x64",
  },
  {
    os: "win32",
    arch: "x64",
    avx2: false,
  },
]

const targets = singleFlag
  ? allTargets.filter((item) => {
      if (item.os !== process.platform || item.arch !== process.arch) {
        return false
      }

      // When building for the current platform, prefer a single native binary by default.
      // Baseline binaries require additional Bun artifacts and can be flaky to download.
      if (item.avx2 === false) {
        return baselineFlag
      }

      // also skip abi-specific builds for the same reason
      if (item.abi !== undefined) {
        return false
      }

      return true
    })
  : allTargets

await $`rm -rf dist`
// kilocode_change start
const kiloSandboxWorker = await KiloSandboxWorker.bundle()
const kiloSandboxNetwork = await KiloSandboxNetwork.bundle()
// kilocode_change end

const binaries: Record<string, string> = {}
if (!skipInstall) {
  await $`bun install --os="*" --cpu="*" @opentui/core@${pkg.dependencies["@opentui/core"]}`
  await $`bun install --os="*" --cpu="*" @parcel/watcher@${pkg.dependencies["@parcel/watcher"]}`
}
for (const item of targets) {
  const name = [
    pkg.name,
    // changing to win32 flags npm for some reason
    item.os === "win32" ? "windows" : item.os,
    item.arch,
    item.avx2 === false ? "baseline" : undefined,
    item.abi === undefined ? undefined : item.abi,
  ]
    .filter(Boolean)
    .join("-")

  console.log(`building ${name}`)
  await $`mkdir -p dist/${name}/bin`
  // kilocode_change start
  const bwrap =
    item.os === "linux" && process.env.KILO_SKIP_BUNDLED_BWRAP !== "1"
      ? await stageBubblewrap(item.arch, path.resolve(dir, `dist/${name}/bin`))
      : undefined
  // kilocode_change end

  // Bounded cut: public full `bin/kilo` removed; only `bin/kilo-serve` is produced.
  // Full-specific parser/TUI worker, Solid transform, and full smoke/patchelf are
  // intentionally not built. Source CLI (src/index.ts / TUI tree) is retained on
  // disk for SDK generation and local dev -- see local-bin source wrapper -- but
  // compiled full binary is no longer an output. Hidden cutover + serve resources
  // (tree-sitter wasm, sandbox worker/network, bwrap) are retained.
  const sessionExportWorkerPath = "./src/kilocode/session-export/worker.ts"

  // kilocode_change start - lightweight serve-only backend for VS Code cold
  // start. Static graph is serve-entry.ts + ServeCommand + shared bootstrap
  // only: no full yargs command tree, no TUI worker. Same defines and
  // sandbox/tree-sitter sibling layout as the full binary so serve semantics
  // (flags, fd carrier, watchdog, shutdown) stay identical.
  await Bun.build({
    conditions: ["bun", "node"],
    tsconfig: "./tsconfig.json",
    plugins: [
      {
        name: "jsonc-parser-esm",
        setup(build) {
          build.onResolve({ filter: /^jsonc-parser$/ }, () => {
            const pkg = require.resolve("jsonc-parser/package.json")
            return { path: path.join(path.dirname(pkg), "lib", "esm", "main.js") }
          })
        },
      },
    ],
    sourcemap: Script.release ? "none" : "external",
    external: ["node-gyp"],
    format: "esm",
    minify: true,
    splitting: false,
    compile: {
      autoloadBunfig: false,
      autoloadDotenv: false,
      autoloadTsconfig: true,
      autoloadPackageJson: true,
      target: name.replace(pkg.name, "bun") as any,
      outfile: `dist/${name}/bin/kilo-serve`,
      execArgv: [`--user-agent=kilo/${Script.version}`, "--use-system-ca", "--"],
      windows: {},
    },
    files: {},
    entrypoints: ["./src/serve-entry.ts", sessionExportWorkerPath],
    define: {
      KILO_VERSION: `'${Script.version}'`,
      KILO_SESSION_EXPORT_WORKER_PATH: sessionExportWorkerPath,
      KILO_SANDBOX_MUTATION_WORKER_PATH: JSON.stringify(KiloSandboxWorker.filename),
      KILO_SANDBOX_NETWORK_RELAY_PATH: item.os === "linux" ? JSON.stringify(KiloSandboxNetwork.relay) : "undefined",
      KILO_SANDBOX_SECCOMP_PATH: item.os === "linux" ? JSON.stringify(KiloSandboxNetwork.seccomp) : "undefined",
      KILO_CHANNEL: `'${Script.channel}'`,
      KILO_LIBC: item.os === "linux" ? `'${item.abi ?? "glibc"}'` : "",
      KILO_BWRAP_SHA256: bwrap ? `'${bwrap}'` : "undefined",
      KILO_BUILD_KIND: Script.release ? `'release'` : `'source'`,
      ...(item.os === "linux" ? { "process.env.OPENTUI_LIBC": JSON.stringify(item.abi ?? "glibc") } : {}),
    },
  })
  // kilocode_change end

  // kilocode_change start
  await copyTreeSitterWasms(path.resolve(dir, `dist/${name}/bin`))
  await KiloSandboxWorker.copy(kiloSandboxWorker, path.resolve(dir, `dist/${name}/bin`))
  if (item.os === "linux") {
    await KiloSandboxNetwork.copy(kiloSandboxNetwork, path.resolve(dir, `dist/${name}/bin`), item.arch)
  }

  if (item.os === "linux") {
    const interpreters: Record<string, string> = {
      x64: "/lib64/ld-linux-x86-64.so.2",
      arm64: "/lib/ld-linux-aarch64.so.1",
      "x64-musl": "/lib/ld-musl-x86_64.so.1",
      "arm64-musl": "/lib/ld-musl-aarch64.so.1",
    }
    const key = item.abi === "musl" ? `${item.arch}-musl` : item.arch
    const interpreter = interpreters[key]
    if (interpreter) {
      // Serve-only interpreter patch; full `bin/kilo` is no longer produced.
      try {
        await $`patchelf --set-interpreter ${interpreter} dist/${name}/bin/kilo-serve`
        console.log(`patched interpreter for ${name}/kilo-serve -> ${interpreter}`)
      } catch {
        console.warn(`patchelf not available, skipping interpreter fix for ${name}/kilo-serve`)
      }
    }
  }
  // kilocode_change end

  // Smoke test: only run if binary is for current platform — serve-only.
  // Help/version must exit 0 without bootstrap/shutdown side effects (no DB,
  // migration, provider auth, telemetry, or owned files). Diagnostics are
  // explicit: exit plus stdout/stderr tails are always logged, and failures
  // include full output instead of a suppressed non-zero code.
  if (item.os === process.platform && item.arch === process.arch && !item.abi) {
    const servePath = `dist/${name}/bin/kilo-serve`
    console.log(`Running smoke test: ${servePath} --version`)
    try {
      const versionRes = await $`${servePath} --version`.nothrow().quiet()
      const vOut = String((versionRes as any).stdout ?? "").trim()
      const vErr = String((versionRes as any).stderr ?? "").trim()
      console.log(`--version exit=${(versionRes as any).exitCode} stdout=${vOut.slice(0, 500)} stderr=${vErr.slice(0, 500)}`)
      if ((versionRes as any).exitCode !== 0) {
        throw new Error(
          `kilo-serve --version exited ${(versionRes as any).exitCode} stdout=${vOut.slice(0, 2000)} stderr=${vErr.slice(0, 2000)}`,
        )
      }
      if (!vOut) {
        throw new Error(`kilo-serve --version produced empty stdout stderr=${vErr.slice(0, 2000)}`)
      }
      console.log(`Serve smoke test passed: ${vOut}`)

      const checkHelp = async (helpArgs: string[], wants: string[]) => {
        const label = helpArgs.join(" ")
        const helpRes = spawnSync(servePath, helpArgs, { encoding: "utf8", timeout: 15_000 })
        const out = String(helpRes.stdout ?? "")
        const err = String(helpRes.stderr ?? "")
        const combined = out + err
        console.log(
          `serve ${label} exit=${helpRes.status} stdout=${out.trim().slice(0, 500)} stderr=${err.trim().slice(0, 500)}`,
        )
        if (helpRes.status !== 0) {
          throw new Error(
            `kilo-serve ${label} exited ${helpRes.status} stdout=${out.slice(0, 2000)} stderr=${err.slice(0, 2000)}`,
          )
        }
        for (const want of wants) {
          if (!combined.includes(want)) {
            throw new Error(
              `kilo-serve ${label} missing expected help output ${want} stdout=${out.slice(0, 2000)} stderr=${err.slice(0, 2000)}`,
            )
          }
        }
        if (/disposing all instances|telemetry|trackCli|kilo\.db/i.test(combined)) {
          throw new Error(
            `kilo-serve ${label} shows bootstrap/shutdown side effects stdout=${out.slice(0, 2000)} stderr=${err.slice(0, 2000)}`,
          )
        }
      }

      await checkHelp(["serve", "--help"], ["serve", "--port"])
      console.log("Serve help smoke test passed")
      await checkHelp(["--help"], ["serve"])
      console.log("Top-level help smoke test passed")

      // Isolated help run proves no owned files/provider work: fresh XDG roots
      // must stay free of DB/log artifacts after help exits.
      const smokeTmp = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-serve-help-smoke-"))
      try {
        const isoEnv: NodeJS.ProcessEnv = {
          ...process.env,
          XDG_DATA_HOME: path.join(smokeTmp, "data"),
          XDG_CACHE_HOME: path.join(smokeTmp, "cache"),
          XDG_CONFIG_HOME: path.join(smokeTmp, "config"),
          XDG_STATE_HOME: path.join(smokeTmp, "state"),
          KILO_DB: ":memory:",
        }
        delete (isoEnv as any).KILO_DATA_DIR
        const iso = spawnSync(servePath, ["serve", "--help"], {
          encoding: "utf8",
          timeout: 15_000,
          env: isoEnv,
        })
        const isoCombined = String(iso.stdout ?? "") + String(iso.stderr ?? "")
        console.log(`isolated serve --help exit=${iso.status} output=${isoCombined.trim().slice(0, 500)}`)
        if (iso.status !== 0) {
          throw new Error(
            `isolated kilo-serve serve --help exited ${iso.status} stdout=${String(iso.stdout ?? "").slice(0, 2000)} stderr=${String(iso.stderr ?? "").slice(0, 2000)}`,
          )
        }
        const leftovers: string[] = []
        const walk = (dir: string) => {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name)
            if (entry.isDirectory()) walk(full)
            else if (!/\.DS_Store$/.test(entry.name)) leftovers.push(path.relative(smokeTmp, full))
          }
        }
        if (fs.existsSync(smokeTmp)) walk(smokeTmp)
        const owned = leftovers.filter((f) => /(\.db$|\.log$|\.sqlite|\.lease\.json|\.marker\.json)/i.test(f))
        if (owned.length > 0) {
          throw new Error(`isolated help created owned files: ${owned.slice(0, 20).join(", ")}`)
        }
      } finally {
        fs.rmSync(smokeTmp, { recursive: true, force: true })
      }
      console.log("Isolated help no-owned-files smoke test passed")
    } catch (e) {
      console.error(`Smoke test failed for ${name}:`, e)
      const err = e as any
      if (err?.stdout !== undefined || err?.stderr !== undefined) {
        console.error(`smoke stdout: ${String(err.stdout ?? "").slice(0, 4000)}`)
        console.error(`smoke stderr: ${String(err.stderr ?? "").slice(0, 4000)}`)
      }
      process.exit(1)
    }
  }

  // Clean stale full binary from output (previous builds / dev artifacts) and
  // legacy tui folder; do not produce or retain `bin/kilo`.
  await $`rm -rf ./dist/${name}/bin/kilo`.nothrow().quiet()
  await $`rm -rf ./dist/${name}/bin/kilo.exe`.nothrow().quiet()
  await $`rm -rf ./dist/${name}/bin/tui`.nothrow().quiet()
  // kilocode_change start
  if (item.os === "linux") {
    const content = await Promise.all([
      Bun.file(path.resolve(dir, "../../LICENSE")).text(),
      Bun.file(path.resolve(dir, `dist/${name}/bin/licenses/sandbox-runtime/LICENSE`)).text(),
      ...(bwrap
        ? ["NOTICE", "COPYING", "MUSL-COPYRIGHT"].map((file) =>
            Bun.file(path.resolve(dir, `dist/${name}/bin/licenses/bubblewrap/${file}`)).text(),
          )
        : []),
    ])
    await Bun.write(`dist/${name}/LICENSE`, content.join("\n\n---\n\n"))
  }
  // kilocode_change end
  await Bun.file(`dist/${name}/package.json`).write(
    JSON.stringify(
      {
        name,
        version: Script.version,
        license: item.os === "linux" ? "SEE LICENSE IN LICENSE" : pkg.license, // kilocode_change
        preferUnplugged: true,
        os: [item.os],
        cpu: [item.arch],
        // kilocode_change start
        keywords: pkg.keywords,
        private: pkg.private,
        repository: {
          type: "git",
          url: "https://github.com/Kilo-Org/kilocode",
        },
        // kilocode_change end
        ...(item.abi ? { libc: [item.abi] } : {}),
      },
      null,
      2,
    ),
  )
  binaries[name] = Script.version
}

if (Script.release) {
  // VSCode-only target: CLI public archive `gh release upload` removed. Build-cli stays
  // as serve-only artifact supplier to VSIX via the kilo-cli.tar.zst internal artifact,
  // not via per-platform kilo-*.tar.gz/zip GH release assets. No public archive upload.
  console.log("Skipping CLI archive gh release upload (VSCode-only target: VSIX is the release artifact)")
}

export { binaries }
