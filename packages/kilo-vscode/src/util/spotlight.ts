import * as fs from "fs"
import * as path from "path"

const marker = ".metadata_never_index"

function exists(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false
  return "code" in err && err.code === "EEXIST"
}

function message(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

export async function markNoIndex(dir: string, log: (msg: string) => void): Promise<void> {
  if (process.platform !== "darwin") return
  const file = path.join(dir, marker)
  await fs.promises.writeFile(file, "", { flag: "wx" }).catch((err) => {
    if (exists(err)) return
    log(`Warning: Failed to mark ${dir} as Spotlight-excluded: ${message(err)}`)
  })
}

export async function markWorkspace(root: string, log: (msg: string) => void): Promise<void> {
  await markNoIndex(root, log)
}
