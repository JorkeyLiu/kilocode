import path from "path"
import { fileURLToPath } from "url"
import { parseModelsSnapshot } from "../src/kilocode/provider/models-snapshot-shape" // kilocode_change
import { loadModelsSnapshot } from "./kilocode/models-snapshot" // kilocode_change

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

process.chdir(dir)

// kilocode_change start - offline by default: read the committed snapshot unless
// MODELS_DEV_API_JSON overrides locally; network refresh is an explicit separate step
const { text, source } = await loadModelsSnapshot()
export const modelsData = JSON.stringify(parseModelsSnapshot(text).data)
// kilocode_change end
console.log(`Loaded models snapshot from ${source} (no network)`) // kilocode_change
