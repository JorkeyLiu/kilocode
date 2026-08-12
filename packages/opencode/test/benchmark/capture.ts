/**
 * P0 stderr tee, installed at module scope (node builtins only — it must never
 * import a kilo module). Benchmark entry files import this FIRST, before
 * `./environment`, so module-load marks — e.g. `app_layer_define` /
 * `app_runtime_make` emitted while `effect/app-runtime.ts` evaluates — are
 * captured before any kilo module (instrument.ts included) runs.
 */

let lines: string[] = []
let installed = false

export function installCapture(): void {
  if (installed) return
  installed = true
  const original = process.stderr.write
  process.stderr.write = ((chunk: string | Uint8Array) => {
    original.call(process.stderr, chunk)
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")
    if (text.includes("service=p0-perf")) lines.push(text)
    return true
  }) as typeof process.stderr.write
}

/** Append-only captured p0 text lines (all records since module load). */
export function captured(): string[] {
  return lines
}

installCapture()
