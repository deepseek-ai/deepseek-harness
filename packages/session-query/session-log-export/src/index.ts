/** Session-log download command and Host-owned streaming route. */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {} from '@deepseek-ai/dsh-attachment'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  DEFAULT_SESSION_LOG_COMPRESSION_LEVEL,
  flushLiveSessionLog,
  readSessionLogText,
  sessionLogExportDeps,
  sessionLogZipFilename,
  streamSessionLogZip,
  type SessionLogCompressionLevel,
  type SessionLogExportReady,
} from './archive.ts'

export {
  DEFAULT_SESSION_LOG_COMPRESSION_LEVEL,
  flushLiveSessionLog,
  readSessionLogText,
  serializeSessionLog,
  SESSION_LOG_FILENAME,
  sessionLogExportDeps,
  sessionLogZipEntries,
  sessionLogZipFilename,
  streamSessionLogZip,
} from './archive.ts'
export type {
  SessionLogCompressionLevel,
  SessionLogExportDeps,
  SessionLogExportReady,
  SessionLogZipEntry,
} from './archive.ts'

export const name = 'session-log-download'
export const inject = ['commands', 'connection']

/** Stable browser download path retained across the transport migration. */
export const SESSION_LOG_EXPORT_PATH = '/api/session.export'

/** Session-log archive policy. */
export interface Config {
  /** DEFLATE level for each ZIP entry. @default 6 */
  readonly compressionLevel?: SessionLogCompressionLevel
}

/** Validate Session-log archive configuration. */
export const Config: Schema<Config> = Schema.object({
  compressionLevel: Schema.number().step(1).min(0).max(9)
    .default(DEFAULT_SESSION_LOG_COMPRESSION_LEVEL) as Schema<SessionLogCompressionLevel>,
})

interface SessionLogConnection {
  readonly fetch: {
    register(route: {
      readonly path: string
      readonly methods: readonly ('GET' | 'HEAD')[]
      readonly requestBody: 'buffered'
      readonly fetch: (request: Request) => Promise<Response>
    }): () => Promise<void>
  }
}

const REQUESTED: CommandResult = {
  kind: 'success',
  text: 'Session log download requested.',
}

/**
 * Register the Web-only `/export` command and authenticated ZIP download route.
 * @param ctx - Host context carrying the human-command registry.
 * @param config - resolved compression policy.
 */
export function apply(ctx: Context, config: Config = {}): void {
  ctx.effect(() => ctx.commands.register({
    name: 'export',
    description: 'Download this Session log as a ZIP archive',
    handler: invocation => Promise.resolve(invocation.rawInput.trim() === ''
      ? REQUESTED
      : { kind: 'error', text: 'The Web /export command does not accept a path.' }),
  }), 'session-log-download: command')
  connectionOf(ctx).fetch.register({
    path: SESSION_LOG_EXPORT_PATH,
    methods: ['GET', 'HEAD'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const response = await sessionLogExportResponse(
        ctx,
        request,
        config.compressionLevel ?? DEFAULT_SESSION_LOG_COMPRESSION_LEVEL,
      )
      if (request.method === 'GET') return response
      await response.body?.cancel()
      return new Response(null, { status: response.status, headers: response.headers })
    },
  })
}

function connectionOf(ctx: Context): SessionLogConnection {
  return Reflect.get(ctx, 'connection') as SessionLogConnection
}

async function sessionLogExportResponse(
  ctx: Context,
  request: Request,
  compressionLevel: SessionLogCompressionLevel,
): Promise<Response> {
  const url = new URL(request.url)
  const query = Object.fromEntries(url.searchParams)
  const sessionIdValue = query['sessionId']
  const descendantsValue = query['includeDescendants']
  if (sessionIdValue === undefined || sessionIdValue.length === 0
    || (descendantsValue !== undefined && descendantsValue !== 'true' && descendantsValue !== 'false')) {
    return new Response('missing or invalid sessionId query parameter', { status: 400 })
  }
  const sessionId = brandString<SessionId>(sessionIdValue)
  const deps = sessionLogExportDeps(ctx)
  if (deps.sessionQuery === undefined
    || deps.sessionPersistence === undefined
    || deps.attachments === undefined) {
    return new Response(
      'session log export is unavailable: missing session-query, session-persistence, or attachments service',
      { status: 500 },
    )
  }
  const ready: SessionLogExportReady = {
    sessionQuery: deps.sessionQuery,
    sessionPersistence: deps.sessionPersistence,
    attachments: deps.attachments,
    sessions: deps.sessions,
  }
  let rootContent: string | undefined
  try {
    await flushLiveSessionLog(deps, sessionId, request.signal)
    rootContent = await readSessionLogText(deps.sessionPersistence, sessionId, request.signal)
    request.signal.throwIfAborted()
  } catch {
    request.signal.throwIfAborted()
    // Root preparation failure (flush, open, or read): answer 500 without
    // echoing the error, which may carry absolute host paths into the
    // browser error bar.
    return new Response('session log export failed to read the stored log', { status: 500 })
  }
  if (rootContent === undefined) {
    return new Response('session not found', { status: 404 })
  }
  const response = new Response(
    streamSessionLogZip(
      ready,
      rootContent,
      sessionId,
      descendantsValue === 'true',
      compressionLevel,
      request.signal,
    ),
    {
      headers: {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="${sessionLogZipFilename(sessionId)}"`,
      },
    },
  )
  return response
}
