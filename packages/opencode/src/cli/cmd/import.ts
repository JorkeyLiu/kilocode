import type { Session as SDKSession, Message, Part } from "@kilocode/sdk/v2"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Session } from "@/session/session"
import { CliError, effectCmd } from "../effect-cmd"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable, MessageTable, PartTable } from "@opencode-ai/core/session/sql"
import { SessionRevision } from "@opencode-ai/core/session/revision"
import { InstanceRef } from "@/effect/instance-ref"
import { EOL } from "os"
import path from "path"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect, Schema } from "effect"
import { eq } from "drizzle-orm"
import * as Log from "@opencode-ai/core/util/log" // kilocode_change
import type { InstanceContext } from "@/project/instance-context"
import { isDeepStrictEqual } from "node:util"
import { SessionID, MessageID, PartID } from "@/session/schema"
import { ProjectV2 } from "@opencode-ai/core/project"

const log = Log.create({ service: "import" }) // kilocode_change

const decodeMessageInfo = Schema.decodeUnknownSync(SessionV1.Info)
const decodePart = Schema.decodeUnknownSync(SessionV1.Part)

/**
 * Apply the CLI import aggregate mutation within a database transaction:
 * session row + all messages + all parts. Returns `{ changed }` indicating
 * whether any semantic mutation occurred (caller advances revision after
 * this returns when `existing && changed`).
 *
 * Extracted so the command handler and tests share the same production code path.
 */
export function applyImportAggregate(opts: {
  session: { id: string; project_id: string; directory: string; path?: string }
  messages: ExportData["messages"]
}) {
  return Database.Service.use(({ db }) =>
    db.transaction((tx) =>
      Effect.gen(function* () {
        let changed = false
        const sid = SessionID.make(opts.session.id)

        const existing = yield* tx.select().from(SessionTable).where(eq(SessionTable.id, sid)).get()

        if (existing) {
          if (
            existing.project_id !== opts.session.project_id ||
            existing.directory !== opts.session.directory ||
            existing.path !== opts.session.path
          ) {
            changed = true
            yield* tx
              .update(SessionTable)
              .set({
                project_id: ProjectV2.ID.make(opts.session.project_id),
                directory: opts.session.directory,
                path: opts.session.path,
              })
              .where(eq(SessionTable.id, sid))
              .run()
          }
        } else {
          changed = true
          yield* tx
            .insert(SessionTable)
            .values({
              id: sid,
              project_id: ProjectV2.ID.make(opts.session.project_id),
              slug: "import",
              directory: opts.session.directory,
              path: opts.session.path,
              title: "CLI Import",
              version: "v2",
              time_created: Date.now(),
              time_updated: Date.now(),
              revision: 0,
            })
            .run()
        }

        for (const msg of opts.messages) {
          const msgInfo = decodeMessageInfo(msg.info)
          const { id, sessionID: _, ...msgData } = msgInfo

          const existingMsg = yield* tx.select().from(MessageTable).where(eq(MessageTable.id, id)).get()

          if (existingMsg) {
            if (existingMsg.session_id !== sid) {
              throw new Error(`Message ${id} belongs to session ${existingMsg.session_id}, not ${sid}`)
            }
            if (!isDeepStrictEqual(existingMsg.data, msgData)) {
              changed = true
              yield* tx
                .update(MessageTable)
                .set({ data: msgData as never })
                .where(eq(MessageTable.id, id))
                .run()
            }
          } else {
            changed = true
            yield* tx
              .insert(MessageTable)
              .values({
                id,
                session_id: sid,
                time_created: msgInfo.time?.created ?? Date.now(),
                data: msgData as never,
              })
              .run()
          }

          for (const part of msg.parts) {
            const partInfo = decodePart(part)
            const { id: partId, sessionID: _s, messageID, ...partData } = partInfo

            if (messageID !== id) {
              throw new Error(`Part ${partId} references message ${messageID}, not its containing message ${id}`)
            }

            const existingPart = yield* tx.select().from(PartTable).where(eq(PartTable.id, partId)).get()

            if (existingPart) {
              if (existingPart.message_id !== MessageID.make(messageID)) {
                throw new Error(`Part ${partId} belongs to message ${existingPart.message_id}, not ${messageID}`)
              }
              if (existingPart.session_id !== sid) {
                throw new Error(`Part ${partId} belongs to session ${existingPart.session_id}, not ${sid}`)
              }
              if (!isDeepStrictEqual(existingPart.data, partData)) {
                changed = true
                yield* tx
                  .update(PartTable)
                  .set({ data: partData as never })
                  .where(eq(PartTable.id, partId))
                  .run()
              }
            } else {
              changed = true
              yield* tx
                .insert(PartTable)
                .values({
                  id: partId,
                  message_id: MessageID.make(messageID),
                  session_id: sid,
                  data: partData,
                })
                .run()
            }
          }
        }

        // Advance revision exactly once when the aggregate carried a real mutation
        // and an existing session row was present.
        if (changed && existing) {
          yield* SessionRevision.advanceTx(sid, tx)
        }

        return { changed }
      }),
    ),
  )
}

/** Discriminated union returned by the ShareNext API (GET /api/shares/:id/data) */
export type ShareData =
  | { type: "session"; data: SDKSession }
  | { type: "message"; data: Message }
  | { type: "part"; data: Part }
  | { type: "session_diff"; data: unknown }
  | { type: "model"; data: unknown }

// kilocode_change start
/** Extract share ID from a Kilo share URL like https://app.kilo.ai/s/abc123 */
export function parseShareUrl(url: string): string | null {
  const match = url.match(/^https?:\/\/app\.kilo\.ai\/s\/([a-zA-Z0-9_-]+)$/)
  return match ? match[1] : null
}
// kilocode_change end

export function shouldAttachShareAuthHeaders(shareUrl: string, accountBaseUrl: string): boolean {
  try {
    return new URL(shareUrl).origin === new URL(accountBaseUrl).origin
  } catch {
    return false
  }
}

/**
 * Transform ShareNext API response (flat array) into the nested structure for local file storage.
 *
 * The API returns a flat array: [session, message, message, part, part, ...]
 * Local storage expects: { info: session, messages: [{ info: message, parts: [part, ...] }, ...] }
 *
 * This groups parts by their messageID to reconstruct the hierarchy before writing to disk.
 */
export function transformShareData(shareData: ShareData[]): {
  info: SDKSession
  messages: Array<{ info: Message; parts: Part[] }>
} | null {
  const sessionItem = shareData.find((d) => d.type === "session")
  if (!sessionItem) return null

  const messageMap = new Map<string, Message>()
  const partMap = new Map<string, Part[]>()

  for (const item of shareData) {
    if (item.type === "message") {
      messageMap.set(item.data.id, item.data)
    } else if (item.type === "part") {
      if (!partMap.has(item.data.messageID)) {
        partMap.set(item.data.messageID, [])
      }
      partMap.get(item.data.messageID)!.push(item.data)
    }
  }

  if (messageMap.size === 0) return null

  return {
    info: sessionItem.data,
    messages: Array.from(messageMap.values()).map((msg) => ({
      info: msg,
      parts: partMap.get(msg.id) ?? [],
    })),
  }
}

// kilocode_change start
export function ingestBootstrapWarning(sessionId: string, error: unknown) {
  const details = error instanceof Error ? error.message : String(error)
  return `Warning: imported session ${sessionId} locally, but ingest bootstrap failed: ${details}`
}

async function ingestBootstrap(sessionId: string) {
  const { KiloSessions } = await import("../../kilo-sessions/kilo-sessions")
  return KiloSessions.bootstrap(sessionId)
}

export async function bootstrapImportedSessionIngest(
  sessionId: string,
  input?: {
    bootstrap?: (sessionId: string) => Promise<unknown>
    warn?: (message: string) => void
  },
) {
  const run = input?.bootstrap ?? ingestBootstrap
  const warn =
    input?.warn ??
    ((message: string) => {
      process.stderr.write(message)
      process.stderr.write(EOL)
    })

  log.info("ingest bootstrap started", { sessionId })
  await run(sessionId)
    .then(() => {
      log.info("ingest bootstrap completed", { sessionId })
    })
    .catch((error) => {
      log.error("ingest bootstrap failed", { sessionId, error })
      warn(ingestBootstrapWarning(sessionId, error))
    })
}
// kilocode_change end

type ExportData = { info: SDKSession; messages: Array<{ info: Message; parts: Part[] }> }

export const ImportCommand = effectCmd({
  command: "import <file>",
  describe: "import session data from JSON file or URL",
  builder: (yargs) =>
    yargs.positional("file", {
      describe: "path to JSON file or share URL",
      type: "string",
      demandOption: true,
    }),
  handler: Effect.fn("Cli.import")(function* (args) {
    const ctx = yield* InstanceRef
    if (!ctx) return yield* Effect.die("InstanceRef not provided")
    return yield* runImport(args.file, ctx)
  }),
})

const runImport = Effect.fn("Cli.import.body")(function* (file: string, ctx: InstanceContext) {
  const fs = yield* FSUtil.Service
  const { db } = yield* Database.Service

  let exportData: ExportData | undefined

  const isUrl = file.startsWith("http://") || file.startsWith("https://")

  if (isUrl) {
    // kilocode_change start - Migrate to upstream ShareNext architecture #10281
    const slug = parseShareUrl(file)
    if (!slug) {
      process.stdout.write(`Invalid URL format. Expected: https://app.kilo.ai/s/<id>`)
      process.stdout.write(EOL)
      return
    }

    const base = process.env["KILO_SESSION_INGEST_URL"] ?? "https://ingest.kilosessions.ai"
    const response = yield* Effect.tryPromise({
      try: () => fetch(`${base}/session/${encodeURIComponent(slug)}`),
      catch: (e) =>
        new CliError({
          message: `Failed to fetch share data: ${e instanceof Error ? e.message : String(e)}`,
        }),
    })

    if (!response.ok) {
      process.stdout.write(`Failed to fetch share data: ${response.statusText}`)
      process.stdout.write(EOL)
      return
    }

    const data = yield* Effect.tryPromise({
      try: () => response.json() as Promise<ExportData>,
      catch: () => new CliError({ message: "Share data was not valid JSON" }),
    })

    if (!data || typeof data !== "object" || !data.info || !data.messages || !Array.isArray(data.messages)) {
      process.stdout.write(`Share not found or empty: ${slug}`)
      process.stdout.write(EOL)
      return
    }

    exportData = data
    // kilocode_change end
  } else {
    exportData = (yield* fs.readJson(file).pipe(Effect.orElseSucceed(() => undefined))) as
      | NonNullable<typeof exportData>
      | undefined
    if (!exportData) {
      process.stdout.write(`File not found: ${file}`)
      process.stdout.write(EOL)
      return
    }
  }

  if (!exportData) {
    process.stdout.write(`Failed to read session data`)
    process.stdout.write(EOL)
    return
  }

  const info = Schema.decodeUnknownSync(Session.Info)({
    ...exportData.info,
    projectID: ctx.project.id,
    directory: ctx.directory,
    path: path.relative(path.resolve(ctx.worktree), ctx.directory).replaceAll("\\", "/"),
  }) as Session.Info
  const row = Session.toRow(info)

  // One atomic aggregate mutation: session + all messages + all parts in a single
  // transaction. A new session starts at revision 0; an existing row advances once
  // only when at least one semantic change occurs. Exact retry is a true no-op.
  yield* applyImportAggregate({
    session: { id: row.id, project_id: row.project_id, directory: row.directory, path: row.path },
    messages: exportData.messages,
  }).pipe(Effect.orDie)

  // kilocode_change start
  yield* Effect.promise(() => bootstrapImportedSessionIngest(exportData!.info.id))
  // kilocode_change end

  process.stdout.write(`Imported session: ${exportData.info.id}`)
  process.stdout.write(EOL)
})
