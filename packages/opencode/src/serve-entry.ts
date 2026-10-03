import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import * as Log from "@opencode-ai/core/util/log"
import { UI } from "./cli/ui"
import { Installation } from "./installation"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { NamedError } from "@opencode-ai/core/util/error"
import { FormatError } from "./cli/error"
import { ServeCommand } from "./cli/cmd/serve"
import { InternalStorageCommand } from "./cli/cmd/internal-storage"
import { EOL } from "os"
import { errorMessage } from "./util/error"
import { Heap } from "./cli/heap"
import { ensureProcessMetadata } from "@opencode-ai/core/util/opencode-process"
import { isRecord } from "@/util/record"
import { KiloBootstrap } from "@/kilocode/cli/bootstrap"
import { installFatalHandlers } from "@/kilocode/fatal-handler"
import * as P0Perf from "@/kilocode/perf/instrument"

// Lightweight serve-only entry for the VS Code extension backend.
// Static graph: yargs + ServeCommand + InternalStorageCommand (hidden) + shared
// bootstrap helper only. It must not import the full CLI command tree (full
// index entry, setup command registration, TUI/run/agent/... commands). Serve
// semantics (Server.listen, fd carrier, watchdog, signals, network flags, port
// line) are reused from ServeCommand — never copied here. The hidden storage
// cutover command is the sole additional yargs command and stays hidden
// (describe:false) with no SDK generation.
P0Perf.mark("cli_entry", { id: String(process.pid) })

const processMetadata = ensureProcessMetadata("main")

installFatalHandlers()

const args = hideBin(process.argv)

// kilocode_change - track hidden cutover for bootstrap/shutdown bypass (precise positional, not args.includes)
let isInternalCutover = false

// kilocode_change - help/version fast path: must not touch session/storage/telemetry/bootstrap/shutdown.
// Detected from raw args early (before yargs) so the finally shutdown gate holds
// even if yargs short-circuits middleware for --version. Middleware re-checks
// parsed help/version flags to cover alias forms.
let isHelpOnly = false
function isHelpVersionArgs(list: string[]): boolean {
  if (list.length === 0) return true
  if (list.includes("-h") || list.includes("--help") || list.includes("--version") || list.includes("-v")) return true
  if (list[0] === "help" || list[0] === "version") return true
  return false
}
isHelpOnly = isHelpVersionArgs(args)

// kilocode_change - ephemeral per-child process-resource guardian: same
// shipped executable, pre-bootstrap/DB/AppLayer. Prelaunch command
// wrapper: owns cleanup BEFORE starting the target, never an
// after-spawn sidecar. Carries no sessions, config, operations, or
// persistent ledger. Exits via its own main, never serving.
{
  const marker = "__process-guardian"
  if (process.argv.includes(marker)) {
    const { parseGuardianArgv, runGuardian } = await import("@/kilocode/process-resource/guardian")
    const parsed = parseGuardianArgv(process.argv)
    if (!parsed || !parsed.isGuardian || parsed.mode !== "wrap" || !parsed.target) {
      process.stderr.write(`[guardian] missing guardian wrap args; target not launched\n`)
      process.exit(2)
    }
    await runGuardian(parsed)
    process.exit(0)
  }
  // Publish the resolved self command for core spawners (no opencode import
  // in core): KILO_GUARDIAN_CMD JSON [cmd, ...baseArgs].
  try {
    const { publishGuardianCmd } = await import("@/kilocode/process-resource/supervise")
    publishGuardianCmd()
  } catch {}
}

if (await KiloBootstrap.runner()) process.exit()

function show(out: string) {
  const text = out.trimStart()
  if (!text.startsWith("opencode ")) {
    process.stderr.write(UI.logo() + EOL + EOL)
    process.stderr.write(text)
    return
  }
  process.stderr.write(out)
}

const constructTimer = P0Perf.span("cli_construct")
const cli = yargs(args)
  .parserConfiguration({ "populate--": true })
  .scriptName("kilo-serve")
  .wrap(100)
  .help("help", "show help")
  .alias("help", "h")
  .version("version", "show version number", InstallationVersion)
  .alias("version", "v")
  .option("print-logs", {
    describe: "print logs to stderr",
    type: "boolean",
  })
  .option("log-level", {
    describe: "log level",
    type: "string",
    choices: ["DEBUG", "INFO", "WARN", "ERROR"],
  })
  .option("pure", {
    describe: "run without external plugins",
    type: "boolean",
  })
  .middleware(async (opts) => {
    if (
      (opts as any)?.help === true ||
      (opts as any)?.version === true ||
      (opts as any)?.h === true ||
      (opts as any)?.v === true
    ) {
      isHelpOnly = true
    }
    if (isHelpOnly) {
      // Help/version output must not initialize session/storage/telemetry or
      // acquire DB/migration/provider work. Skip Log/Heap/bootstrap entirely.
      P0Perf.mark("cli_bootstrap_skip_help")
      return
    }
    if (opts.pure) {
      process.env.KILO_PURE = "1"
    }

    {
      const timer = P0Perf.span("log_init")
      await Log.init({
        print: process.argv.includes("--print-logs"),
        dev: Installation.isLocal(),
        level: (() => {
          if (opts.logLevel) return opts.logLevel as Log.Level
          if (Installation.isLocal()) return "DEBUG"
          return "INFO"
        })(),
      })
      timer.end()
    }

    {
      const timer = P0Perf.span("heap_start")
      Heap.start()
      timer.end()
    }

    process.env.AGENT = "1"
    process.env.OPENCODE = "1"
    process.env.KILO_PID = String(process.pid)

    Log.Default.info("opencode", {
      version: InstallationVersion,
      args: process.argv.slice(2),
      process_role: processMetadata.processRole,
      run_id: processMetadata.runID,
    })

    // kilocode_change - hidden cutover must bypass global bootstrap which would hold the canonical DB lease
    // before status/cutover's own lease/marker lifecycle. Match precisely via parsed positional, not args.includes.
    isInternalCutover = (opts as any)?._?.[0] === "__internal-storage-cutover"
    if (isInternalCutover) {
      // Preserve logs/metrics; skip KiloBootstrap.bootstrap (telemetry/auth/AppRuntime DB) for this hidden command.
      P0Perf.mark("cli_bootstrap_skip_internal_cutover", { meta: { op: String((opts as any)?._?.[1] ?? "") } })
    } else {
      const bootstrapTimer = P0Perf.span("cli_bootstrap")
      await KiloBootstrap.bootstrap()
      bootstrapTimer.end()
    }
  })
  .usage("")
  .completion("completion", "generate shell completion script")
  .command(ServeCommand)
  .command(InternalStorageCommand as any)
  .demandCommand(1, "kilo-serve only runs serve or hidden storage commands")
  .fail((msg, err) => {
    if (
      msg?.startsWith("Unknown argument") ||
      msg?.startsWith("Not enough non-option arguments") ||
      msg?.startsWith("Invalid values:")
    ) {
      if (err) throw err
      cli.showHelp(show)
    }
    if (err) throw err
    process.exit(1)
  })
  .strict()
constructTimer.end()

const parseTimer = P0Perf.span("cli_parse")
try {
  if (args.includes("-h") || args.includes("--help")) {
    await cli.parse(args, (err: Error | undefined, _argv: unknown, out: string) => {
      if (err) throw err
      if (!out) return
      show(out)
    })
  } else {
    await cli.parse()
  }
} catch (e) {
  let data: Record<string, any> = {}
  if (e instanceof Error) {
    Object.assign(data, {
      name: e.name,
      message: e.message,
      cause: e.cause?.toString(),
      stack: e.stack,
    })
  }

  if (e instanceof NamedError) {
    const obj = e.toObject()
    if (isRecord(obj.data)) {
      for (const [key, value] of Object.entries(obj.data)) {
        if (key === "name" || key === "stack" || key === "cause") continue
        data[key] = value
      }
    }
  }

  if (e instanceof ResolveMessage) {
    Object.assign(data, {
      name: e.name,
      message: e.message,
      code: e.code,
      specifier: e.specifier,
      referrer: e.referrer,
      position: e.position,
      importKind: e.importKind,
    })
  }
  Log.Default.error("fatal", data)
  const formatted = FormatError(e)
  if (formatted) UI.error(formatted)
  if (formatted === undefined) {
    UI.error("Unexpected error, check log file at " + Log.file() + " for more details" + EOL)
    process.stderr.write(errorMessage(e) + EOL)
  }
  process.exitCode = 1
} finally {
  parseTimer.end()
  if (isInternalCutover) {
    // kilocode_change - hidden cutover owns its own lease/marker lifecycle; skip heavy AppRuntime shutdown that would acquire DB lease
    P0Perf.mark("cli_shutdown_skip_internal_cutover")
  } else if (isHelpOnly) {
    // kilocode_change - help/version never bootstrapped; skip shutdown side effects (telemetry/disposal).
    P0Perf.mark("cli_shutdown_skip_help")
  } else {
    await KiloBootstrap.shutdown()
  }

  // Some subprocesses don't react properly to SIGTERM and similar signals.
  // Most notably, some docker-container-based MCP servers don't handle such signals unless
  // run using `docker run --init`.
  // Explicitly exit to avoid any hanging subprocesses.
  process.exit()
}
