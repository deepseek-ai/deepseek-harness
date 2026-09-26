/** Serve change summaries and comparisons, and open declared or changed workspace files verified by the viewed Session's filesystem. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-api-workspace-files'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-session-query'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { CHANGES_DIFF_PATH, CHANGES_OPEN_PATH, CHANGED_FILES_PATH, type ChangesSummary } from './changes.ts'
import { isPresentedData, isPresentedFile, PRESENT_OPEN_PATH, PRESENT_HOST_PATH, type PresentedHost } from './presented.ts'

/**
 * Register the deliverables routes inside Connection's authentication fence:
 * desktop metadata, change summaries and comparisons, declared-file actions,
 * and changed-file opening.
 * @param ctx - Session lookup, change summaries, native opener, and route lifetime.
 */
export function registerPresentOpen(ctx: Context): void {
  ctx.connection.fetch.register({
    path: PRESENT_HOST_PATH, methods: ['GET'], requestBody: 'buffered',
    fetch: () => Promise.resolve(Response.json(ctx.sessionController.workspaceDesktop() satisfies PresentedHost,
      { headers: { 'cache-control': 'no-store' } })),
  })
  ctx.connection.fetch.register({
    path: CHANGED_FILES_PATH, methods: ['GET'], requestBody: 'buffered',
    fetch: request => Promise.resolve(handleChangesSummary(ctx, request)),
  })
  const lifetime = new AbortController()
  const pending = new Set<Promise<Response>>()
  ctx.effect(() => async () => {
    lifetime.abort()
    await Promise.allSettled(pending)
  })
  const routes = [
    [PRESENT_OPEN_PATH, ['GET', 'POST'], handlePresentOpen], [CHANGES_OPEN_PATH, ['GET', 'POST'], handleChangesOpen], [CHANGES_DIFF_PATH, ['GET'], handleChangesDiff],
  ] as const
  for (const [path, methods, handler] of routes) {
    ctx.connection.fetch.register({
      path,
      methods: [...methods],
      requestBody: 'buffered',
      fetch: (request) => {
        const task = handler(ctx, new Request(request, {
          signal: AbortSignal.any([request.signal, lifetime.signal]),
        }))
        pending.add(task)
        void task.then(() => { pending.delete(task) }, () => { pending.delete(task) })
        return task
      },
    })
  }
}

const NUMERIC = /^\d+$/

function coordinate(value: string | null): number | undefined {
  return value !== null && NUMERIC.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : undefined
}

/** Translate lookup and filesystem failures into the not-found or failure status the browser retries from. */
function failureStatus(error: unknown): number {
  const remote = remoteErrorOf(error)
  const missing = remote?.code === 'session/not-found' || remote?.code === 'workspace-file/not-found'
    || remote?.code === 'workspace-file/not-regular-file' || error instanceof Error && 'code' in error
    && (error.code === 'SESSION_QUERY_SESSION_NOT_FOUND' || error.code === 'SESSION_QUERY_EVENT_NOT_FOUND'
      || error.code === 'ENOENT' || error.code === 'ENOTDIR')
  return missing ? 404 : 500
}

/**
 * Read the addressed event once the Host desktop is known to be available.
 * @returns the event with its Session header, or the refusal to answer with.
 */
async function readTarget(ctx: Context, request: Request, id: string, seq: number): Promise<Awaited<ReturnType<Context['sessionQuery']['readEvent']>> | Response> {
  request.signal.throwIfAborted()
  if (!ctx.sessionController.workspaceDesktop().available) return new Response('Host desktop unavailable.', { status: 409 })
  return ctx.sessionQuery.readEvent({ sessionId: id as SessionId, seq: seq as SessionSeq, before: 0, after: 0 }, request.signal)
}

/**
 * Open one verified Host path. A file is verified through the Session
 * filesystem; a directory is verified by the Host filesystem mapping alone.
 * @returns the HTTP status to answer with.
 */
async function openVerified(ctx: Context, request: Request, path: string, action: 'open' | 'reveal'): Promise<Response> {
  const { fs } = ctx
  const mapped = fs.processPathFromHostPath(path)
  if (mapped === undefined || fs.processPath(await fs.resolve(mapped, { signal: request.signal })) !== path) {
    return new Response('Path has no verified Host path.', { status: 422 })
  }
  request.signal.throwIfAborted()
  if (request.method === 'GET') {
    return Response.json(await ctx.sessionController.workspacePathApplications({ path }, request.signal),
      { headers: { 'cache-control': 'no-store' } })
  }
  const application = new URL(request.url).searchParams.get('application')
  await ctx.sessionController.openWorkspacePath({ path, ...(action === 'reveal' ? { action }
    : application === null ? {} : { application }) }, request.signal)
  return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } })
}

async function handlePresentOpen(ctx: Context, request: Request): Promise<Response> {
  const query = new URL(request.url).searchParams
  const action = query.get('action') ?? 'open'
  if (action !== 'open' && action !== 'reveal') return new Response('Invalid file action.', { status: 400 })
  const id = query.get('sessionId')
  const seq = coordinate(query.get('seq'))
  const index = coordinate(query.get('index'))
  if (!id || seq === undefined || index === undefined) return new Response('Invalid Presented file coordinates.', { status: 400 })
  try {
    const read = await readTarget(ctx, request, id, seq)
    if (read instanceof Response) return read
    const { target, session } = read
    const file = target.type === 'deliverables/presented' && isPresentedData(target.data) ? target.data.files[index] : undefined
    if (!isPresentedFile(file)) return new Response('Presented file not found in this Session result.', { status: 404 })
    request.signal.throwIfAborted()
    const { absolutePath: path } = await ctx.workspaceFiles.stat({
      sessionId: id as SessionId,
      workspaceRoot: session.cwd ?? ctx.sandboxPolicy.workspaceRoot,
    }, file.path, request.signal)
    return await openVerified(ctx, request, path, action)
  } catch (error: unknown) {
    request.signal.throwIfAborted()
    return new Response('Presented file unavailable.', { status: failureStatus(error) })
  }
}

/** The summary one `workspace/changes` event announced, without the Host working directory; 404 once the Host no longer serves it. */
function handleChangesSummary(ctx: Context, request: Request): Response {
  const query = new URL(request.url).searchParams
  const id = query.get('sessionId')
  const seq = coordinate(query.get('seq'))
  if (!id || seq === undefined) return new Response('Invalid change summary coordinates.', { status: 400 })
  const summary = ctx.workspaceChanges.summary(id as SessionId, seq)
  if (summary === undefined) return new Response('Change summary unavailable.', { status: 404 })
  const { turn, files, total, added, deleted } = summary
  return Response.json({ turn, files, total, added, deleted } satisfies ChangesSummary, { headers: { 'cache-control': 'no-store' } })
}

/** A changed file's coordinates from a route query, or the 400 to answer with. */
function changedFileCoordinates(request: Request): { id: SessionId; seq: number; index: number } | Response {
  const query = new URL(request.url).searchParams
  const id = query.get('sessionId')
  const seq = coordinate(query.get('seq'))
  const index = coordinate(query.get('index'))
  if (!id || seq === undefined || index === undefined) return new Response('Invalid changed file coordinates.', { status: 400 })
  return { id: id as SessionId, seq, index }
}

/** One listed file's comparison; 404 once the Host no longer serves the summary or the index names no file. */
async function handleChangesDiff(ctx: Context, request: Request): Promise<Response> {
  const coordinates = changedFileCoordinates(request)
  if (coordinates instanceof Response) return coordinates
  const { id, seq, index } = coordinates
  try {
    const diff = await ctx.workspaceChanges.diff(id, seq, index, request.signal)
    if (diff === undefined) return new Response('Change comparison unavailable.', { status: 404 })
    return Response.json(diff, { headers: { 'cache-control': 'no-store' } })
  } catch (error: unknown) {
    request.signal.throwIfAborted()
    return new Response('Change comparison unavailable.', { status: failureStatus(error) })
  }
}

async function handleChangesOpen(ctx: Context, request: Request): Promise<Response> {
  const action = new URL(request.url).searchParams.get('action') ?? 'open'
  if (action !== 'open' && action !== 'reveal') return new Response('Invalid file action.', { status: 400 })
  const coordinates = changedFileCoordinates(request)
  if (coordinates instanceof Response) return coordinates
  const { id, seq, index } = coordinates
  try {
    request.signal.throwIfAborted()
    if (!ctx.sessionController.workspaceDesktop().available) return new Response('Host desktop unavailable.', { status: 409 })
    const changes = ctx.workspaceChanges.summary(id, seq)
    if (changes === undefined) return new Response('Change summary unavailable.', { status: 404 })
    const workspaceRoot = changes.cwd
    const file = changes.files[index]
    if (file === undefined) return new Response('Changed file not found in this summary.', { status: 404 })
    const { absolutePath: path } = await ctx.workspaceFiles.stat({ sessionId: id, workspaceRoot }, file.path, request.signal)
    return await openVerified(ctx, request, path, action)
  } catch (error: unknown) {
    request.signal.throwIfAborted()
    return new Response('Changed file unavailable.', { status: failureStatus(error) })
  }
}
