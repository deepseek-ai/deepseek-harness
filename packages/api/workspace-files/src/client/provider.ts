/**
 * The `file` protocol's provider: a workspace file's metadata as a stream of
 * `RemoteResult` frames.
 *
 * An address names the file in one of two scopes. A `session` address,
 * `dsh-resource://file/session/<sessionId>/<path>`, carries an absolute path or one
 * relative to that Session's workspace root: the Host receives the path as-is and
 * resolves it against the root it holds. Only the Host's `stat.absolutePath`
 * selects the change-feed key; no Client Session summary is needed.
 * An `absolute` address, `dsh-resource://file/absolute/<path>`, carries no
 * Session and cannot authorize a Host call. An address neither scope
 * resolves yields one failure frame — `workspace-file/unsupported-address` for
 * a string outside the grammar, `workspace-file/unknown-workspace` when the
 * address carries no Session — and ends.
 *
 * The first frame is the file's `stat`; every Host-reported write yields the
 * metadata with its reported version; a reported disappearance, or a write while the
 * last stat had failed, runs `stat` again. Failures travel as `ok: false` frames, never as thrown errors: the
 * Remote face does not reject, and anything thrown inside the stream is a
 * programming error the resource model lets surface. A failed stat does not end
 * the stream: the next write stats again. One {@link ChangeFeed}
 * serves every open file of the Client.
 */
import type { ResourceProvider } from '@deepseek-ai/dsh-client-resources/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { parseFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import type { WorkspaceFileStat } from '../types.ts'
import type { ChangeFeed } from './change-feed.ts'
import type { WorkspaceFilesRemote } from './remote.ts'

/** The Session and unmodified path submitted to the Host. */
interface HostFile {
  readonly sessionId: SessionId
  /** The path the Host receives: absolute or workspace-relative. */
  readonly path: string
}

/**
 * Build the `file` provider over one Remote face and one change feed.
 * @param remote - the Remote face carrying `workspaceFiles.stat`.
 * @param changes - the per-session change fan-out.
 * @returns the provider to register into `ctx.resources`.
 */
export function createFileResourceProvider(
  remote: WorkspaceFilesRemote,
  changes: ChangeFeed,
): ResourceProvider<'file'> {
  return {
    protocol: 'file',
    async *open(address, { signal }): AsyncIterable<RemoteResult<WorkspaceFileStat>> {
      const resolved = resolve(address)
      if (!resolved.ok) {
        yield resolved
        return
      }
      const { sessionId, path } = resolved.value
      // Queue changes delivered to this Client while stat is pending.
      const notices = changes.follow(sessionId, signal)
      const stat = (): Promise<RemoteResult<WorkspaceFileStat>> => remote.workspaceFiles.stat(sessionId, path, signal)
      // Read through a call: a plain `signal.aborted` is narrowed to `false` by
      // the first check and would read as always-false after the later awaits.
      const aborted = (): boolean => signal.aborted
      // Undefined while the last stat failed: the follow is on the address, not
      // on the file, so a write can still bring the file live.
      let current: WorkspaceFileStat | undefined
      try {
        if (!await notices.ready || aborted()) return
        const first = await stat()
        if (aborted()) return
        if (first.ok) {
          notices.bind(first.value.absolutePath)
          current = first.value
          yield { ok: true, value: current }
        } else {
          yield first
        }
        for await (const notice of notices) {
          if (current === undefined) {
            // Still gone: nothing new to report.
            if (notice.kind === 'absent') continue
          } else if (notice.kind === 'changed') {
            // Frames report observations: holding this version already means the
            // consumer learns nothing new.
            if (notice.version === current.version) continue
            current = { ...current, version: notice.version }
            yield { ok: true, value: current }
            continue
          }
          // A Host notice may mean stale content.
          const again = await stat()
          if (aborted()) return
          if (!again.ok) {
            current = undefined
            yield again
            continue
          }
          notices.bind(again.value.absolutePath)
          current = again.value
          yield { ok: true, value: current }
        }
      } finally {
        notices.dispose()
      }
    },
  }
}

/**
 * Resolve one address to the Host call it stands for, or to the failure frame it earns.
 * @param address - the full address, scheme included.
 * @returns the Host file, or the `unsupported-address` / `unknown-workspace` failure.
 */
function resolve(address: string): RemoteResult<HostFile> {
  const parsed = parseFileAddress(address)
  if (parsed === undefined) return { ok: false, error: unsupportedAddress(address) }
  if (parsed.scope === 'session') {
    // The address is a string boundary: its id segment is the Session id it names.
    const sessionId = parsed.sessionId as SessionId
    return { ok: true, value: { sessionId, path: parsed.path } }
  }
  return { ok: false, error: unknownWorkspace(address) }
}

/**
 * The failure frame's error for an address this provider does not serve.
 * @param address - the offending address.
 * @returns the typed error.
 */
function unsupportedAddress(address: string): RemoteError<'workspace-file/unsupported-address'> {
  return new RemoteError(
    'workspace-file/unsupported-address',
    `${address} is not a dsh-resource://file/session/<sessionId>/<path> or dsh-resource://file/absolute/<path> address`,
    { address },
  )
}

/**
 * The failure frame's error for an absolute address with no Session.
 * @param address - the offending address.
 * @returns the typed error.
 */
function unknownWorkspace(address: string): RemoteError<'workspace-file/unknown-workspace'> {
  return new RemoteError(
    'workspace-file/unknown-workspace',
    `${address} requires a dsh-resource://file/session/<sessionId>/<path> address`,
    { address },
  )
}
