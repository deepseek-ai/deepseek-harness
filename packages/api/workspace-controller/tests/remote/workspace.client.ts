/**
 * The Remote side of one Workspace registry under test: default answers for
 * every `workspace/*` command a `ClientWorkspaceModel` calls, builders for the
 * rows and frames of the `workspace/follow` stream, and a script that hands
 * each physical generation of that stream to its own script. The stream's
 * boot-time opening baseline lives in `remoteDefaultResponses`.
 */
import { ok, type RemoteTable, type StreamScript } from '@deepseek-ai/dsh-remote-mock'
import type { RemoteFailure, RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {
  WorkspaceArchiveSessionRequest,
  WorkspaceArchiveValue,
  WorkspaceCreateRequest,
  WorkspaceCreateValue,
  WorkspaceDeleteRequest,
  WorkspaceDeleteValue,
  WorkspaceFollowFrame,
  WorkspaceId,
  WorkspaceInsertBeforeRequest,
  WorkspaceInsertSessionBeforeRequest,
  WorkspaceOrderValue,
  WorkspacePinSessionRequest,
  WorkspacePinValue,
  WorkspaceRenameRequest,
  WorkspaceUnarchiveSessionRequest,
  WorkspaceUnpinSessionRequest,
  WorkspaceValue,
  WorkspaceView,
} from '../../src/types.ts'

/** The Workspace state stream endpoint. */
export const FOLLOW = 'workspace/follow'

/** The opening frame of one follow generation. */
export type WorkspaceBaselineFrame = Extract<WorkspaceFollowFrame, { type: 'baseline' }>

/**
 * The failure branch of a Remote result.
 * @param error - the owner-declared failure.
 * @returns the result.
 */
export function err<T>(error: RemoteFailure): RemoteResult<T> {
  return { ok: false, error }
}

/**
 * One Workspace row whose id doubles as its title and path segment.
 * @param id - Workspace id.
 * @param overrides - fields replacing the derived ones.
 * @returns the row.
 */
export function workspace(id: string, overrides: Partial<WorkspaceView> = {}): WorkspaceView {
  return {
    workspaceId: id as WorkspaceId,
    path: `/work/${id}`,
    title: id,
    sessionIds: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

/**
 * A baseline frame holding the named Workspaces and no archived or pinned Sessions.
 * @param ids - Workspace ids in registry order.
 * @returns the frame.
 */
export function baseline(...ids: readonly string[]): WorkspaceBaselineFrame {
  return {
    type: 'baseline',
    value: { items: ids.map(id => workspace(id)), archivedSessionIds: [], pinnedSessionIds: [] },
  }
}

/**
 * `workspace/follow` script running the n-th open on the n-th script; an open
 * past the last script fails the stream.
 * @param generations - one script per physical generation, in open order.
 * @returns the script.
 */
export function followGenerations(generations: readonly StreamScript[]): StreamScript {
  let opened = 0
  return (args, stream) => {
    const generation = generations[opened++]
    if (generation === undefined) throw new Error('no scripted Workspace follow generation')
    return generation(args, stream)
  }
}

/** Default answers: every command accepted and echoed back as the row or set it names. */
export const workspaceWorld: RemoteTable = {
  unary: {
    'workspace/initializeDefault': (): RemoteResult<WorkspaceValue> => ok({ workspace: workspace('default') }),
    'workspace/create': (request: WorkspaceCreateRequest): RemoteResult<WorkspaceCreateValue> => ok({
      workspace: workspace('created', { path: request.path }), created: true,
    }),
    'workspace/rename': (request: WorkspaceRenameRequest): RemoteResult<WorkspaceValue> => ok({
      workspace: workspace(String(request.workspaceId), { title: request.title }),
    }),
    'workspace/delete': (_request: WorkspaceDeleteRequest): RemoteResult<WorkspaceDeleteValue> => ok({ deleted: true }),
    'workspace/insertBefore': (request: WorkspaceInsertBeforeRequest): RemoteResult<WorkspaceOrderValue> => ok({ workspaceIds: [request.workspaceId] }),
    'workspace/insertSessionBefore': (request: WorkspaceInsertSessionBeforeRequest): RemoteResult<WorkspaceValue> => ok({
      workspace: workspace(String(request.workspaceId), { sessionIds: [request.sessionId] }),
    }),
    'workspace/archiveSession': (request: WorkspaceArchiveSessionRequest): RemoteResult<WorkspaceArchiveValue> => ok({ archivedSessionIds: [request.sessionId] }),
    'workspace/unarchiveSession': (_request: WorkspaceUnarchiveSessionRequest): RemoteResult<WorkspaceArchiveValue> => ok({ archivedSessionIds: [] }),
    'workspace/pinSession': (request: WorkspacePinSessionRequest): RemoteResult<WorkspacePinValue> => ok({ pinnedSessionIds: [request.sessionId] }),
    'workspace/unpinSession': (_request: WorkspaceUnpinSessionRequest): RemoteResult<WorkspacePinValue> => ok({ pinnedSessionIds: [] }),
  },
}
