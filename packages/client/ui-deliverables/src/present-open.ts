/** Open declared source files verified by the viewed Session's filesystem. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-api-workspace-files'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-session-query'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { isPresentedData, isPresentedFile, PRESENT_OPEN_PATH, PRESENT_HOST_PATH, type PresentedHost } from './presented.ts'

/**
 * Register native opening inside Connection's authentication fence.
 * @param ctx - Session lookup, native opener, and route lifetime.
 */
export function registerPresentOpen(ctx: Context): void {
  ctx.connection.fetch.register({
    path: PRESENT_HOST_PATH, methods: ['GET'], requestBody: 'buffered',
    fetch: () => Promise.resolve(Response.json(ctx.sessionController.workspaceDesktop() satisfies PresentedHost,
      { headers: { 'cache-control': 'no-store' } })),
  })
  const lifetime = new AbortController()
  const pending = new Set<Promise<Response>>()
  ctx.effect(() => async () => {
    lifetime.abort()
    await Promise.allSettled(pending)
  })
  ctx.connection.fetch.register({
    path: PRESENT_OPEN_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: (request) => {
      const task = handlePresentOpen(ctx, new Request(request, {
        signal: AbortSignal.any([request.signal, lifetime.signal]),
      }))
      pending.add(task)
      void task.then(() => { pending.delete(task) }, () => { pending.delete(task) })
      return task
    },
  })
}

async function handlePresentOpen(ctx: Context, request: Request): Promise<Response> {
  const query = new URL(request.url).searchParams
  const action = query.get('action') ?? 'open'
  if (action !== 'open' && action !== 'reveal') return new Response('Invalid file action.', { status: 400 })
  const id = query.get('sessionId')
  const seq = query.get('seq')
  const index = query.get('index')
  if (!id || seq === null || index === null || !/^\d+$/.test(seq) || !/^\d+$/.test(index)
    || !Number.isSafeInteger(Number(seq)) || !Number.isSafeInteger(Number(index))) {
    return new Response('Invalid Presented file coordinates.', { status: 400 })
  }
  try {
    request.signal.throwIfAborted()
    if (!ctx.sessionController.workspaceDesktop().available) return new Response('Host desktop unavailable.', { status: 409 })
    const { target, session } = await ctx.sessionQuery.readEvent({
      sessionId: id as SessionId, seq: Number(seq) as SessionSeq, before: 0, after: 0,
    }, request.signal)
    const file = target.type === 'deliverables/presented' && isPresentedData(target.data) ? target.data.files[Number(index)] : undefined
    if (!isPresentedFile(file)) return new Response('Presented file not found in this Session result.', { status: 404 })
    request.signal.throwIfAborted()
    const { fs, workspaceFiles } = ctx
    const { absolutePath: path } = await workspaceFiles.stat({
      sessionId: id as SessionId,
      workspaceRoot: session.cwd ?? ctx.sandboxPolicy.workspaceRoot,
    }, file.path, request.signal)
    const mapped = fs.processPathFromHostPath(path)
    if (mapped === undefined || fs.processPath(await fs.resolve(mapped, { signal: request.signal })) !== path) {
      return new Response('Presented file has no verified Host path.', { status: 422 })
    }
    request.signal.throwIfAborted()
    await ctx.sessionController.openWorkspacePath({ path, ...(action === 'reveal' ? { action } : {}) }, request.signal)
    return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } })
  } catch (error: unknown) {
    request.signal.throwIfAborted()
    const remote = remoteErrorOf(error)
    const missing = remote?.code === 'session/not-found' || remote?.code === 'workspace-file/not-found'
      || remote?.code === 'workspace-file/not-regular-file' || error instanceof Error && 'code' in error
      && (error.code === 'SESSION_QUERY_SESSION_NOT_FOUND' || error.code === 'SESSION_QUERY_EVENT_NOT_FOUND'
        || error.code === 'ENOENT' || error.code === 'ENOTDIR')
    return new Response('Presented file unavailable.', { status: missing ? 404 : 500 })
  }
}
