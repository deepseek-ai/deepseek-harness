/**
 * Workspace Controller client plugin, state stream, and command facade driven
 * through the assembled Gateway client: every `workspace/*` call crosses the
 * roster's own Connection and is answered by endpoint name.
 */

import { describe, expect, onTestFinished, vi } from 'vitest'
import { RemoteStreamCarrierError, type ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { frames, openStream, type RemoteMock, type StreamScript } from '@deepseek-ai/dsh-remote-mock'
import { createClientTest, type TestClient, webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import {
  ClientWorkspaceModel,
  createWorkspaceStateStream,
  WorkspaceController,
  WorkspaceCreateError,
  type WorkspaceFollowSink,
} from '../src/client/index.ts'
import type { WorkspaceFollowFrame, WorkspaceId } from '../src/types.ts'
import { FOLLOW, baseline, err, followGenerations, workspace, workspaceWorld } from './remote/workspace.client.ts'

const SELF = '@deepseek-ai/dsh-api-workspace-controller'
/** The plugin as the web bundle composes it: itself plus the Gateway client, the Connection, and the Typert registry. */
const PLUGIN_ROSTER = webApp.closure([SELF])
/** A stream or model built by hand talks through the Gateway client alone. */
const API_ROSTER = webApp.closure(['@deepseek-ai/dsh-api-gateway'])
const pluginTest = createClientTest({ roster: PLUGIN_ROSTER })
const it = createClientTest({ roster: API_ROSTER })
/** The first client boot pays the cold module transform of the plugin cone. */
const COLD_BOOT_TIMEOUT_MS = 60_000

const wid = (id: string): WorkspaceId => id as WorkspaceId
const sid = (id: string): SessionId => SessionId(id)

/** Boot the plugin with `follow` answering its state stream. */
async function pluginClient(mock: RemoteMock, start: () => Promise<TestClient>, follow: StreamScript): Promise<TestClient> {
  mock.stream(FOLLOW, follow)
  return start()
}

/** Boot the Gateway client with the Workspace command answers registered, so `remote.workspace` is provided. */
async function gatewayClient(mock: RemoteMock, start: () => Promise<TestClient>): Promise<{ remote: ClientRemote; client: TestClient }> {
  mock.load(workspaceWorld)
  const client = await start()
  return { remote: client.ctx.remote, client }
}

const carrierLoss = (message: string): StreamScript => (_args, stream) => {
  stream.fail(new RemoteStreamCarrierError(message))
}

function accepts(overrides: Partial<WorkspaceFollowSink> = {}): WorkspaceFollowSink {
  const ignore = (): void => {}
  return {
    replaceBaseline: ignore,
    upsertView: ignore,
    removeView: ignore,
    replaceOrder: ignore,
    replaceArchived: ignore,
    ...overrides,
  }
}

function streamStates(mock: RemoteMock): string[] {
  return mock.log.streams(FOLLOW).map(row => row.state)
}

describe('Workspace Controller Client apply', () => {
  pluginTest('provides the Workspace service and stops its follow generation with the plugin fiber', async ({ mock, start }) => {
    const client = await pluginClient(mock, start, openStream([baseline('mounted')]))
    await vi.waitFor(() => {
      expect(client.ctx.workspaces.list.getSnapshot()).toMatchObject({
        phase: 'ready',
        state: 'idle',
        items: [{ workspaceId: 'mounted' }],
      })
    })

    await client.unload(SELF)

    expect(streamStates(client.mock)).toEqual(['cancelled'])
    expect(client.ctx.get('workspaces')).toBeUndefined()
  }, COLD_BOOT_TIMEOUT_MS)

  pluginTest('reopens the follow and re-provides the service across a Loader rebuild', async ({ mock, start }) => {
    const client = await pluginClient(mock, start, openStream([baseline('mounted')]))
    await vi.waitFor(() => {
      expect(client.ctx.workspaces.list.getSnapshot()).toMatchObject({ phase: 'ready', items: [{ workspaceId: 'mounted' }] })
    })
    const before = client.ctx.workspaces

    await client.reload(SELF)

    expect(streamStates(client.mock)).toEqual(['cancelled', 'open'])
    expect(client.ctx.workspaces).not.toBe(before)
    await vi.waitFor(() => {
      expect(client.ctx.workspaces.list.getSnapshot()).toMatchObject({ phase: 'ready', items: [{ workspaceId: 'mounted' }] })
    })
  })

  pluginTest('publishes exhausted carrier retries as a gateway/internal error state', async ({ mock, start }) => {
    // Neither generation reaches an accepted baseline, so the retry budget runs
    // out and the escaping carrier failure crosses the stream boundary marked.
    const client = await pluginClient(mock, start, followGenerations([
      carrierLoss('generation lost'),
      carrierLoss('generation lost again'),
    ]))
    await vi.waitFor(() => {
      expect(client.ctx.workspaces.list.getSnapshot()).toMatchObject({
        state: 'error',
        error: { code: 'gateway/internal', message: 'generation lost again' },
      })
    })
    expect(streamStates(client.mock)).toEqual(['failed', 'failed'])
  })

  pluginTest('marks carrier loss while retrying and publishes a later protocol failure', async ({ mock, start }) => {
    const carrierFailure = vi.spyOn(ClientWorkspaceModel.prototype, 'handleCarrierFailure')
    const streamFailure = vi.spyOn(ClientWorkspaceModel.prototype, 'handleStreamFailure')
    onTestFinished(() => {
      carrierFailure.mockRestore()
      streamFailure.mockRestore()
    })
    const client = await pluginClient(mock, start, followGenerations([
      (_args, stream) => {
        stream.push(baseline('old'))
        stream.fail(new RemoteStreamCarrierError('generation lost'))
      },
      openStream([baseline('fresh'), baseline('duplicate')]),
    ]))
    await vi.waitFor(() => {
      expect(client.ctx.workspaces.list.getSnapshot()).toMatchObject({
        phase: 'ready',
        state: 'error',
        items: [{ workspaceId: 'fresh' }],
        error: { code: 'gateway/internal', message: 'Workspace state stream emitted more than one opening snapshot' },
      })
    })

    expect(carrierFailure).toHaveBeenCalledOnce()
    expect(streamFailure).toHaveBeenCalledOnce()
  })
})

describe('Workspace state stream', () => {
  it('delivers one baseline followed by increments', async ({ mock, start }) => {
    const { remote } = await gatewayClient(mock, start)
    const opening = baseline('one')
    const view = opening.value.items[0]!
    const increments: WorkspaceFollowFrame[] = [
      { type: 'upsert', workspace: view },
      { type: 'remove', workspaceId: view.workspaceId },
      { type: 'order', workspaceIds: [view.workspaceId] },
      { type: 'archived', archivedSessionIds: [sid('session-one')] },
    ]
    mock.stream(FOLLOW, openStream([opening, ...increments]))
    const replaceBaseline = vi.fn<WorkspaceFollowSink['replaceBaseline']>()
    const upsertView = vi.fn<WorkspaceFollowSink['upsertView']>()
    const removeView = vi.fn<WorkspaceFollowSink['removeView']>()
    const replaceOrder = vi.fn<WorkspaceFollowSink['replaceOrder']>()
    const replaceArchived = vi.fn<WorkspaceFollowSink['replaceArchived']>()
    const stream = createWorkspaceStateStream(remote, {
      accept: accepts({ replaceBaseline, upsertView, removeView, replaceOrder, replaceArchived }),
      failed: vi.fn(),
    })

    stream.start()
    stream.start()
    await vi.waitFor(() => { expect(replaceArchived).toHaveBeenCalledOnce() })

    expect(replaceBaseline).toHaveBeenCalledWith(opening.value)
    expect(upsertView).toHaveBeenCalledWith(view)
    expect(removeView).toHaveBeenCalledWith(view.workspaceId)
    expect(replaceOrder).toHaveBeenCalledWith([view.workspaceId])
    expect(replaceArchived).toHaveBeenCalledWith(['session-one'])
    await stream.dispose()
    expect(streamStates(mock)).toEqual(['cancelled'])
  })

  it('retains the old state across carrier loss and applies the replacement baseline', async ({ mock, start }) => {
    const { remote } = await gatewayClient(mock, start)
    const carrier = new RemoteStreamCarrierError('socket lost')
    mock.stream(FOLLOW, followGenerations([
      (_args, stream) => {
        stream.push(baseline('old'))
        stream.fail(carrier)
      },
      openStream([baseline('fresh')]),
    ]))
    const replaceBaseline = vi.fn<WorkspaceFollowSink['replaceBaseline']>()
    const carrierFailed = vi.fn()
    const failed = vi.fn()
    const stream = createWorkspaceStateStream(remote, {
      accept: accepts({ replaceBaseline }),
      carrierFailed,
      failed,
    })

    stream.start()
    await vi.waitFor(() => { expect(replaceBaseline).toHaveBeenCalledTimes(2) })

    expect(replaceBaseline.mock.calls.map(([value]) => value.items[0]?.title)).toEqual(['old', 'fresh'])
    expect(carrierFailed).toHaveBeenCalledWith(carrier)
    expect(failed).not.toHaveBeenCalled()
    await stream.dispose()
  })

  it('classifies a normal end after the opening baseline as carrier loss', async ({ mock, start }) => {
    const { remote } = await gatewayClient(mock, start)
    mock.stream(FOLLOW, followGenerations([
      frames([baseline('old')]),
      openStream([baseline('fresh')]),
    ]))
    const replaceBaseline = vi.fn<WorkspaceFollowSink['replaceBaseline']>()
    const carrierFailed = vi.fn()
    const stream = createWorkspaceStateStream(remote, {
      accept: accepts({ replaceBaseline }),
      carrierFailed,
      failed: vi.fn(),
    })

    stream.start()
    await vi.waitFor(() => { expect(replaceBaseline).toHaveBeenCalledTimes(2) })
    expect(carrierFailed.mock.calls[0]?.[0]).toMatchObject({
      message: 'Workspace state stream ended without a terminal result',
    })
    await stream.dispose()
  })

  it('suppresses callback failure after disposal begins', async ({ mock, start }) => {
    const { remote } = await gatewayClient(mock, start)
    mock.stream(FOLLOW, frames([baseline()]))
    const failed = vi.fn()
    let closing: Promise<void> | undefined
    const stream = createWorkspaceStateStream(remote, {
      accept: accepts({
        replaceBaseline: () => {
          closing = stream.dispose()
          throw new Error('disposed callback')
        },
      }),
      failed,
    })

    stream.start()
    await vi.waitFor(() => { expect(closing).toBeDefined() })
    await closing
    expect(failed).not.toHaveBeenCalled()
  })

  it.for([
    {
      name: 'an increment before the baseline',
      items: [{ type: 'remove', workspaceId: wid('one') }] as WorkspaceFollowFrame[],
      message: 'update before its opening snapshot',
    },
    {
      name: 'a duplicate baseline',
      items: [baseline(), baseline()] as WorkspaceFollowFrame[],
      message: 'more than one opening snapshot',
    },
    {
      name: 'a normal end before the baseline',
      items: [] as WorkspaceFollowFrame[],
      message: 'ended before its opening snapshot',
    },
  ])('reports $name as a terminal failure', async ({ items, message }, { mock, start }) => {
    const { remote } = await gatewayClient(mock, start)
    mock.stream(FOLLOW, frames(items))
    const failed = vi.fn()
    const stream = createWorkspaceStateStream(remote, { accept: accepts(), failed })

    stream.start()
    await vi.waitFor(() => { expect(failed).toHaveBeenCalledOnce() })
    const failure: unknown = failed.mock.calls[0]?.[0]
    expect(failure).toBeInstanceOf(Error)
    if (!(failure instanceof Error)) throw new Error('expected Workspace stream failure')
    expect(failure.message).toContain(message)
    // A protocol failure is terminal: no retry opens a second generation.
    expect(mock.log.requests(FOLLOW)).toHaveLength(1)
    await stream.dispose()
  })

  it('restarts a live generation without reporting cancellation as failure', async ({ mock, start }) => {
    const { remote } = await gatewayClient(mock, start)
    mock.stream(FOLLOW, followGenerations([
      openStream([baseline('first')]),
      openStream([baseline('second')]),
    ]))
    const replaceBaseline = vi.fn<WorkspaceFollowSink['replaceBaseline']>()
    const failed = vi.fn()
    const stream = createWorkspaceStateStream(remote, {
      accept: accepts({ replaceBaseline }),
      failed,
    })

    stream.start()
    await vi.waitFor(() => { expect(replaceBaseline).toHaveBeenCalledOnce() })
    stream.restart()
    await vi.waitFor(() => { expect(replaceBaseline).toHaveBeenCalledTimes(2) })
    expect(failed).not.toHaveBeenCalled()
    expect(streamStates(mock)).toEqual(['cancelled', 'open'])
    await stream.dispose()
  })
})

describe('WorkspaceController', () => {
  it('publishes the model source and exposes successful Workspace commands', async ({ mock, start }) => {
    const { remote, client } = await gatewayClient(mock, start)
    const model = new ClientWorkspaceModel(remote.workspace)
    model.replaceBaseline({ items: [workspace('one')], archivedSessionIds: [] })
    const controller = new WorkspaceController(client.ctx, model)

    expect(controller.list).toBe(model)
    expect(client.ctx.workspaces.list).toBe(model)
    await expect(controller.create({ path: '/work/created' })).resolves.toMatchObject({ workspaceId: 'created' })
    await expect(controller.rename(wid('one'), 'renamed')).resolves.toMatchObject({ title: 'renamed' })
    await expect(controller.insertBefore(wid('one'))).resolves.toBeUndefined()
    await expect(controller.insertSessionBefore(wid('one'), sid('session'))).resolves.toMatchObject({
      sessionIds: ['session'],
    })
    await expect(controller.archiveSession(sid('session'))).resolves.toBeUndefined()
    await expect(controller.unarchiveSession(sid('session'))).resolves.toBeUndefined()
    await expect(controller.delete(wid('one'))).resolves.toBeUndefined()
    // Each command crosses the wire as one positional request object.
    expect(mock.log.requests('workspace/create')).toEqual([{ path: '/work/created' }])
    expect(mock.log.requests('workspace/rename')).toEqual([{ workspaceId: 'one', title: 'renamed' }])
    expect(mock.log.requests('workspace/insertBefore')).toEqual([{ workspaceId: 'one' }])
    expect(mock.log.requests('workspace/insertSessionBefore')).toEqual([{ workspaceId: 'one', sessionId: 'session' }])
    expect(mock.log.requests('workspace/archiveSession')).toEqual([{ sessionId: 'session' }])
    expect(mock.log.requests('workspace/unarchiveSession')).toEqual([{ sessionId: 'session' }])
    expect(mock.log.requests('workspace/delete')).toEqual([{ workspaceId: 'one' }])
  })

  it('maps generated business failures to the command facade errors', async ({ mock, start }) => {
    const { remote, client } = await gatewayClient(mock, start)
    const controller = new WorkspaceController(client.ctx, new ClientWorkspaceModel(remote.workspace))
    const missingWorkspace = new RemoteError('workspace/not-found', 'gone', { workspaceId: wid('missing') })
    const missingSession = new RemoteError('session/not-found', 'missing session', { sessionId: sid('session') })

    mock.remote.workspace.create.mockResolvedValueOnce(err(new RemoteError('workspace/invalid-path', 'missing path', { path: '/missing' })))
    const create = controller.create({ path: '/missing' })
    await expect(create).rejects.toBeInstanceOf(WorkspaceCreateError)
    await expect(create).rejects.toThrow('workspace create failed: workspace/invalid-path: missing path')

    mock.remote.workspace.rename.mockResolvedValueOnce(err(missingWorkspace))
    await expect(controller.rename(wid('missing'), 'name')).rejects.toThrow('workspace rename failed: workspace/not-found: gone')
    mock.remote.workspace.delete.mockResolvedValueOnce(err(missingWorkspace))
    await expect(controller.delete(wid('missing'))).rejects.toThrow('workspace delete failed: workspace/not-found: gone')
    mock.remote.workspace.insertBefore.mockResolvedValueOnce(err(missingWorkspace))
    await expect(controller.insertBefore(wid('missing'))).rejects.toThrow('workspace reorder failed: workspace/not-found: gone')
    mock.remote.workspace.archiveSession.mockResolvedValueOnce(err(missingSession))
    await expect(controller.archiveSession(sid('session')))
      .rejects.toThrow('workspace session archive failed: session/not-found: missing session')
    mock.remote.workspace.unarchiveSession.mockResolvedValueOnce(err(missingSession))
    await expect(controller.unarchiveSession(sid('session')))
      .rejects.toThrow('workspace session unarchive failed: session/not-found: missing session')
    mock.remote.workspace.insertSessionBefore.mockResolvedValueOnce(err(new RemoteError(
      'workspace/move-invalid', 'invalid move', { workspaceId: wid('missing'), sessionId: sid('session') },
    )))
    await expect(controller.insertSessionBefore(wid('missing'), sid('session')))
      .rejects.toThrow('workspace move failed: workspace/move-invalid: invalid move')
  })

  it('receives a carrier throw as the client\'s gateway/internal fold, never as a rejection', async ({ mock, start }) => {
    const { remote, client } = await gatewayClient(mock, start)
    const controller = new WorkspaceController(client.ctx, new ClientWorkspaceModel(remote.workspace))

    mock.remote.workspace.create.mockImplementation(() => Promise.reject(new Error('create wire down')))
    const create = controller.create({ path: '/work/created' })
    await expect(create).rejects.toBeInstanceOf(WorkspaceCreateError)
    await expect(create).rejects.toThrow(
      'workspace create failed: gateway/internal: client api: workspace/create failed: create wire down',
    )
    expect(mock.log.calls('workspace/create').map(call => call.state)).toEqual(['failed'])
  })
})
