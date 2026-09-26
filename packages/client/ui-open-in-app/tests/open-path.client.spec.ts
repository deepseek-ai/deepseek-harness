/** Path controller behavior: the once-per-page desktop read and the open/reveal outcomes over the Session Remote. */

import { describe, expect, it, vi } from 'vitest'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionOpenWorkspacePathRequest } from '@deepseek-ai/dsh-api-session-controller/types'
import { OpenInAppPathController, type OpenInAppPathRemote } from '../src/client/open-path.ts'

type SessionRemote = OpenInAppPathRemote['session']

function remoteOf(over: Partial<SessionRemote> = {}): OpenInAppPathRemote {
  return {
    session: {
      workspacePathApplications: async () => ({ ok: true, value: [] }),
      canOpenWorkspacePath: async () => ({ ok: true, value: true }),
      openWorkspacePath: async () => ({ ok: true, value: { opened: true } }),
      ...over,
    },
  }
}

describe('OpenInAppPathController desktop availability', () => {
  it('starts unanswered and shares one read across concurrent loads', async () => {
    const canOpenWorkspacePath = vi.fn(async () => ({ ok: true as const, value: true }))
    const controller = new OpenInAppPathController(remoteOf({ canOpenWorkspacePath }))
    expect(controller.desktop.getSnapshot()).toBeNull()
    await Promise.all([controller.load(), controller.load()])
    await controller.load()
    expect(canOpenWorkspacePath).toHaveBeenCalledOnce()
    expect(controller.desktop.getSnapshot()).toBe(true)
  })

  it('publishes no desktop for a refusing Host, a failed answer, and a rejecting carrier', async () => {
    const refusing = new OpenInAppPathController(remoteOf({ canOpenWorkspacePath: async () => ({ ok: true, value: false }) }))
    await refusing.load()
    expect(refusing.desktop.getSnapshot()).toBe(false)

    const failed = new OpenInAppPathController(remoteOf({
      canOpenWorkspacePath: async () => ({ ok: false, error: new RemoteError('gateway/internal', 'boom', {}) }),
    }))
    await failed.load()
    expect(failed.desktop.getSnapshot()).toBe(false)

    const rejecting = new OpenInAppPathController(remoteOf({ canOpenWorkspacePath: () => Promise.reject(new Error('down')) }))
    await rejecting.load()
    expect(rejecting.desktop.getSnapshot()).toBe(false)
  })
})

describe('OpenInAppPathController gestures', () => {
  it('sends the default-application open without an action and the reveal with one', async () => {
    const openWorkspacePath = vi.fn(async (_request: SessionOpenWorkspacePathRequest, _signal?: AbortSignal) =>
      ({ ok: true as const, value: { opened: true as const } }))
    const controller = new OpenInAppPathController(remoteOf({ openWorkspacePath }))
    expect(await controller.openPath('/w/clip.mp4', 'open')).toBeNull()
    expect(await controller.openPath('/w/clip.mp4', 'reveal')).toBeNull()
    expect(openWorkspacePath.mock.calls.map(call => call[0])).toEqual([
      { path: '/w/clip.mp4' },
      { path: '/w/clip.mp4', action: 'reveal' },
    ])
  })

  it('names the failed gesture for a refused answer and for a rejecting carrier', async () => {
    const refused = new OpenInAppPathController(remoteOf({
      openWorkspacePath: async () => ({ ok: false, error: new RemoteError('gateway/internal', 'boom', {}) }),
    }))
    expect(await refused.openPath('/w/clip.mp4', 'open')).toBe('openError')
    expect(await refused.openPath('/w/clip.mp4', 'reveal')).toBe('revealError')

    const rejecting = new OpenInAppPathController(remoteOf({ openWorkspacePath: () => Promise.reject(new Error('down')) }))
    expect(await rejecting.openPath('/w/clip.mp4', 'open')).toBe('openError')
  })
})


it('queries current handlers and carries an explicit application without changing the default gesture', async () => {
  const applications = [{ id: '/Applications/Music.app', name: 'Music', default: true, icon: null }]
  const query = vi.fn(async () => ({ ok: true as const, value: applications }))
  const open = vi.fn(async () => ({ ok: true as const, value: { opened: true } }))
  const controller = new OpenInAppPathController(remoteOf({ workspacePathApplications: query, openWorkspacePath: open }))
  const signal = new AbortController().signal
  expect(await controller.applications('/file.mp3', signal)).toEqual(applications)
  expect(query).toHaveBeenCalledWith({ path: '/file.mp3' }, signal)
  await controller.openPath('/file.mp3', 'open', '/Applications/Music.app')
  expect(open).toHaveBeenLastCalledWith({ path: '/file.mp3', application: '/Applications/Music.app' })
  await controller.openPath('/file.mp3', 'open')
  expect(open).toHaveBeenLastCalledWith({ path: '/file.mp3' })
})


it('distinguishes failed association queries from an empty application list', async () => {
  const remote = remoteOf({ workspacePathApplications: async () => ({ ok: false, error: new RemoteError('gateway/internal', 'unavailable', {}) }) })
  const controller = new OpenInAppPathController(remote)
  expect(await controller.applications('/file.mp3', new AbortController().signal)).toBeNull()
  const rejecting = new OpenInAppPathController(remoteOf({ workspacePathApplications: async () => { throw new Error('disconnected') } }))
  expect(await rejecting.applications('/file.mp3', new AbortController().signal)).toBeNull()
})
