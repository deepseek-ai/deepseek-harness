/** Resolve desktop-only file references through the active Host filesystem and Session. */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { parseFileAddress } from '@deepseek-ai/dsh-util-workspace-path'

/** Private Host-to-main answer; never exposed to renderer JavaScript. */
export interface LocalDragResource {
  readonly path: string
  readonly sha256: string
  readonly size: number
}

/**
 * Authorize an unmodified local file through the composed filesystem's actual read operations.
 * @param ctx - booted Desktop Host.
 * @param address - Session-scoped resource reference.
 * @param cancellation - caller cancellation, combined with the read deadline.
 * @returns verified Host-local path and content identity, or null for nonlocal resources.
 */
export async function localDragResource(ctx: Context, address: string, cancellation?: AbortSignal): Promise<LocalDragResource | null> {
  const resource = parseFileAddress(address)
  if (resource?.scope !== 'session') throw new Error('File drag requires a Session resource')
  const sessions = ctx.get('sessions')
  const persistence = ctx.get('sessionPersistence')
  const fs = ctx.get('fs')
  const policy = ctx.get('sandboxPolicy')
  if (fs === undefined || sessions === undefined || policy === undefined) throw new Error('File access unavailable')
  const sessionId = resource.sessionId as SessionId
  const header = sessions.get(sessionId)?.header ?? (await persistence?.stat(sessionId))?.header
  if (header === undefined) throw new Error('File drag Session unavailable')
  const signal = cancellation === undefined ? AbortSignal.timeout(10_000) : AbortSignal.any([cancellation, AbortSignal.timeout(10_000)])
  signal.throwIfAborted()
  const cwd = header.cwd ?? policy.workspaceRoot
  const entry = await fs.lstat(resource.path, { cwd }, signal)
  if (entry?.type !== 'file') return null
  const target = await fs.resolve(resource.path, { cwd, signal })
  const path = fs.processPath(target)
  const mapped = fs.processPathFromHostPath(path)
  if (mapped === undefined) return null
  const roundTrip = await fs.resolve(mapped, { signal })
  if (roundTrip.targetKey !== target.targetKey) return null
  const info = await fs.stat(target, signal)
  if (info?.type !== 'file' || info.size === undefined) return null
  const hash = createHash('sha256')
  let size = 0
  while (size < info.size) {
    signal.throwIfAborted()
    const data = await fs.readByteRange(target, { offset: size, length: Math.min(64 * 1024, info.size - size) }, signal)
    if (data.length === 0) return null
    hash.update(data)
    size += data.length
  }
  // Even empty files require a read authorization check.
  if (size === 0) await fs.readByteRange(target, { offset: 0, length: 1 }, signal)
  const after = await fs.stat(target, signal)
  signal.throwIfAborted()
  if (after?.version !== info.version || after.size !== size) return null
  return { path, size, sha256: hash.digest('hex') }
}
