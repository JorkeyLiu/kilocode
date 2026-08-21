import type { Argv } from "yargs"
import { cmd } from "./cmd"
import path from "path"

/**
 * Hidden internal storage cutover command.
 * Not a public product surface. Resolve same data path as normal runtime,
 * acquire cross-process lease before any DB work, emit actionable JSON.
 * Hidden via describe:false so help omits it and no SDK generation picks it up.
 */
export const InternalStorageCommand = cmd<{}, { op: string; dataRoot?: string; archivePath?: string; archiveID?: string }>({
  command: "__internal-storage-cutover <op>",
  describe: false as unknown as string,
  builder: (yargs: Argv) =>
    yargs
      .positional("op", {
        describe: "cutover | recover | rollback",
        type: "string",
        demandOption: true,
      } as any)
      .option("data-root", {
        type: "string",
        describe: "data root dir (defaults to production path)",
      })
      .option("archive-path", {
        type: "string",
        describe: "archive path for rollback",
      })
      .option("archive-id", {
        type: "string",
        describe: "archive id for cutover",
      } as any)
      .strict(false) as Argv<any>,
  handler: async (args: any) => {
    const op = String(args.op)
    // Resolve dataRoot same as normal runtime, without loading AppLayer
    let dataRoot: string
    if (args.dataRoot) {
      dataRoot = path.resolve(String(args.dataRoot))
    } else {
      const { Database } = await import("@opencode-ai/core/database/database")
      const file = Database.path()
      if (file === ":memory:") throw new Error("in-memory DB not supported for internal cutover")
      dataRoot = path.dirname(path.resolve(file))
    }

    // No AppLayer loaded before this point - acquire lease inside cutover/rollback modules

    if (op === "cutover") {
      const archiveID = args.archiveID ? String(args.archiveID) : undefined
      const { runCutover } = await import("@opencode-ai/core/cutover/cutover")
      const res = await runCutover({ dataRoot, archiveID })
      console.log(JSON.stringify({ ok: true, op, archiveID: res.archiveID, archivePath: res.archivePath }))
      return
    }
    if (op === "recover") {
      const { recoverCutover } = await import("@opencode-ai/core/cutover/cutover")
      const { recoverRollback } = await import("@opencode-ai/core/cutover/rollback")
      await recoverCutover(dataRoot)
      await recoverRollback(dataRoot)
      console.log(JSON.stringify({ ok: true, op }))
      return
    }
    if (op === "rollback") {
      const archivePath = args.archivePath ? String(args.archivePath) : args._?.[1] ? String(args._[1]) : undefined
      if (!archivePath) throw new Error("rollback requires --archive-path <path>")
      const { verifyAndRollback } = await import("@opencode-ai/core/cutover/rollback")
      const res = await verifyAndRollback({ dataRoot, archivePath: path.resolve(archivePath) })
      console.log(JSON.stringify({ ok: true, op, rollbackArchivePath: res.rollbackArchivePath }))
      return
    }
    throw new Error(`unknown op ${op} - expected cutover|recover|rollback`)
  },
})
