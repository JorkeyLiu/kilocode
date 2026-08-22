import path from "path"
import { randomUUID } from "crypto"

export function deriveArchive(dataRoot: string) {
  const abs = path.resolve(dataRoot)
  const parent = path.dirname(abs)
  const base = path.basename(abs)
  const archiveRoot = path.join(parent, `${base}-archive`)
  const p4 = path.join(archiveRoot, "p4.2")
  return { abs, parent, base, archiveRoot, p4 }
}

export function makeArchiveID(): string {
  const utc = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "Z")
  const ts = utc.replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/, "$1$2$3T$4$5$6Z")
  return `${ts}-${randomUUID()}`
}
