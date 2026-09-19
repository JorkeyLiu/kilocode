import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import * as Log from "@opencode-ai/core/util/log"
import { UI } from "./cli/ui"
import { Installation } from "./installation"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { NamedError } from "@opencode-ai/core/util/error"
import { FormatError } from "./cli/error"
import { ServeCommand } from "./cli/cmd/serve"
import { EOL } from "os"
import { errorMessage } from "./util/error"
import { Heap } from "./cli/heap"
import { ensureProcessMetadata } from "@opencode-ai/core/util/opencode-process"
import { isRecord } from "@/util/record"
import { KiloBootstrap } from "@/kilocode/cli/bootstrap"
import { installFatalHandlers } from "@/kilocode/fatal-handler"
import * as P0Perf from "@/kilocode/perf/instrument"

// Lightweight serve-only entry for the VS Code extension backend.
// Static graph: yargs + ServeCommand + shared bootstrap helper only. It must
// not import the full CLI command tree (full index entry, setup command
// registration, TUI/run/agent/... commands). Serve semantics
// (Server.listen, fd carrier, watchdog, signals, network flags, port line)
// are reused from ServeCommand — never copied here.
P0Perf.mark("cli_entry", { id: String(process.pid) })

const processMetadata = ensureProcessMetadata("main")

installFatalHandlers()

const args = hideBin(process.argv)

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

    const bootstrapTimer = P0Perf.span("cli_bootstrap")
    await KiloBootstrap.bootstrap()
    bootstrapTimer.end()
  })
  .usage("")
  .completion("completion", "generate shell completion script")
  .command(ServeCommand)
  .demandCommand(1, "kilo-serve only runs the serve command")
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
  await KiloBootstrap.shutdown()

  // Some subprocesses don't react properly to SIGTERM and similar signals.
  // Most notably, some docker-container-based MCP servers don't handle such signals unless
  // run using `docker run --init`.
  // Explicitly exit to avoid any hanging subprocesses.
  process.exit()
}
