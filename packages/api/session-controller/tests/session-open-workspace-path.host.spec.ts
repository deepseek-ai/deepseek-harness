import { resolve } from 'node:path'
import * as nativeCommand from '@deepseek-ai/dsh-native-command'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import FsLocal from '@deepseek-ai/dsh-fs-local'
import { onTestFinished } from 'vitest'
import { describe, expect, it, vi } from 'vitest'
import {
  createSessionTestController,
  createSessionTestRemote,
} from './test-remote.ts'

async function context(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(FsLocal)
  onTestFinished(() => ctx.fiber.dispose())
  return ctx
}

describe('session/openWorkspacePath', () => {
  it('reports the deployment opener capability independently of a Session', async () => {
    const ctx = await context()
    const remote = createSessionTestRemote(ctx, {
      defaultModelSelection: () => ({ provider: 'p', model: 'm' }),
      cwd: '/default',
      canOpenPath: () => false,
    })

    await expect(remote.canOpenWorkspacePath()).resolves.toEqual({ ok: true, value: false })
  })

  it('derives opener availability from config, an injected opener, or the platform probe', async () => {
    const configured = createSessionTestRemote(await context(), {
      defaultModelSelection: () => ({ provider: 'p', model: 'm' }),
      cwd: '/default',
      nativeOpen: false,
    })
    await expect(configured.canOpenWorkspacePath()).resolves.toEqual({ ok: true, value: false })

    const injected = createSessionTestRemote(await context(), {
      defaultModelSelection: () => ({ provider: 'p', model: 'm' }),
      cwd: '/default',
      openPath: () => Promise.resolve(),
    })
    await expect(injected.canOpenWorkspacePath()).resolves.toEqual({ ok: true, value: true })

    const detected = createSessionTestRemote(await context(), {
      defaultModelSelection: () => ({ provider: 'p', model: 'm' }),
      cwd: '/default',
    })
    await expect(detected.canOpenWorkspacePath()).resolves.toMatchObject({ ok: true })
  })

  it('hands a Client-resolved workspace path to the Host opener unchanged', async () => {
    const ctx = await context()
    const openPath = vi.fn((_path: string, _signal: AbortSignal) => Promise.resolve())
    const remote = createSessionTestRemote(ctx, {
      defaultModelSelection: () => ({ provider: 'p', model: 'm' }),
      cwd: '/default',
      openPath,
    })
    const signal = new AbortController().signal

    await expect(remote.openWorkspacePath({ path: '/workspace/project/src/a.ts' }, signal))
      .resolves.toEqual({ ok: true, value: { opened: true } })
    expect(openPath).toHaveBeenCalledWith(resolve('/workspace/project/src/a.ts'), signal)
    expect(ctx.agents.list()).toEqual([])
  })

  it('normalizes relative and absolute Host-resolvable paths', async () => {
    const ctx = await context()
    const openPath = vi.fn((_path: string, _signal: AbortSignal) => Promise.resolve())
    const remote = createSessionTestRemote(ctx, {
      defaultModelSelection: () => ({ provider: 'p', model: 'm' }),
      cwd: '/default',
      openPath,
    })

    await remote.openWorkspacePath({ path: '/workspace/result.html' })
    await remote.openWorkspacePath({ path: 'result.html' })
    expect(openPath.mock.calls.map(call => call[0])).toEqual([resolve('/workspace/result.html'), resolve('result.html')])
  })

  it('rejects empty paths before opening anything', async () => {
    const ctx = await context()
    const openPath = vi.fn((_path: string, _signal: AbortSignal) => Promise.resolve())
    const remote = createSessionTestRemote(ctx, {
      defaultModelSelection: () => ({ provider: 'p', model: 'm' }),
      cwd: '/default',
      openPath,
    })

    await expect(remote.openWorkspacePath({ path: '' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'gateway/bad-request' } })
    expect(openPath).not.toHaveBeenCalled()
  })

  it('preserves native opener failure and cancellation results', async () => {
    const ctx = await context()
    const openPath = vi.fn((_path: string, _signal: AbortSignal) =>
      Promise.reject(new Error('Command failed: powershell.exe -EncodedCommand private-script-text')))
    const remote = createSessionTestRemote(ctx, {
      defaultModelSelection: () => ({ provider: 'p', model: 'm' }),
      cwd: '/default',
      openPath,
    })

    await expect(remote.openWorkspacePath({ path: 'result.html' }))
      .resolves.toMatchObject({
        ok: false,
        error: { code: 'gateway/internal', message: 'path open failed' },
      })

    const aborted = new AbortController()
    aborted.abort(new Error('gateway/cancelled'))
    await expect(remote.openWorkspacePath({ path: 'result.html' }, aborted.signal))
      .resolves.toMatchObject({ ok: false, error: { code: 'gateway/cancelled' } })
  })

  it('classifies opener cancellation and non-Error failures', async () => {
    const ctx = await context()
    const aborted = new AbortController()
    const openPath = vi.fn()
      .mockImplementationOnce(async () => {
        aborted.abort(new Error('gateway/cancelled'))
        throw new Error('opening stopped')
      })
      .mockRejectedValueOnce('desktop unavailable')
    const controller = createSessionTestController(ctx, {
      defaultModelSelection: () => ({ provider: 'p', model: 'm' }),
      cwd: '/default',
      openPath,
    })

    await expect(controller.openWorkspacePath({ path: 'first.html' }, aborted.signal))
      .rejects.toMatchObject({ code: 'gateway/cancelled' })
    await expect(controller.openWorkspacePath({
      path: 'second.html',
    }, new AbortController().signal)).rejects.toMatchObject({
      code: 'gateway/internal', message: 'path open failed',
    })
  })
})


it('reports Host file-manager metadata and dispatches reveal separately from default-app open', async () => {
  const ctx = await context()
  const revealPath = vi.fn(async (_path: string, _signal: AbortSignal) => {})
  const openPath = vi.fn(async (_path: string, _signal: AbortSignal) => {})
  const controller = createSessionTestController(ctx, {
    defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/default', openPath, revealPath,
  })
  try {
    expect(controller.workspaceDesktop()).toMatchObject({ available: true, name: expect.any(String) as string })
    const signal = new AbortController().signal
    await controller.openWorkspacePath({ path: '/workspace/report.txt', action: 'reveal' }, signal)
    expect(revealPath).toHaveBeenCalledWith(resolve('/workspace/report.txt'), signal)
    expect(openPath).not.toHaveBeenCalled()
  } finally { await ctx.fiber.dispose() }
})

it('uses the native reveal adapter without a test override and respects unsupported desktop metadata', async () => {
  const ctx = await context()
  const reveal = vi.spyOn(nativeCommand, 'revealNativePath').mockResolvedValue(undefined)
  const manager = vi.spyOn(nativeCommand, 'nativeFileManager').mockReturnValue(null)
  try {
    const controller = createSessionTestController(ctx, {
      defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/default', nativeOpen: true,
    })
    expect(controller.workspaceDesktop()).toMatchObject({ available: false, fileManager: null })
    await controller.openWorkspacePath({ path: '/report.txt', action: 'reveal' }, new AbortController().signal)
    expect(reveal).toHaveBeenCalledOnce()
  } finally { manager.mockRestore(); reveal.mockRestore(); await ctx.fiber.dispose() }
})


it.each(['open', 'reveal'] as const)('rejects an unmapped remote path before native %s', async (action) => {
  const ctx = await context()
  const mapping = vi.spyOn(ctx.fs, 'processPathFromHostPath').mockReturnValue(undefined)
  onTestFinished(() => { mapping.mockRestore() })
  const openPath = vi.fn(async () => {})
  const revealPath = vi.fn(async () => {})
  const controller = createSessionTestController(ctx, {
    defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/default', openPath, revealPath,
  })
  await expect(controller.openWorkspacePath({ path: '/remote/report.html', ...(action === 'reveal' ? { action } : {}) }, new AbortController().signal))
    .rejects.toMatchObject({ code: 'gateway/bad-request', message: 'Path has no verified Host path' })
  expect(openPath).not.toHaveBeenCalled()
  expect(revealPath).not.toHaveBeenCalled()
})

it('rejects a filesystem mapping that resolves to another process path', async () => {
  const ctx = await context()
  const mapping = vi.spyOn(ctx.fs, 'processPath').mockReturnValue('/different/report.html')
  onTestFinished(() => { mapping.mockRestore() })
  const openPath = vi.fn(async () => {})
  const controller = createSessionTestController(ctx, {
    defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/default', openPath,
  })
  await expect(controller.openWorkspacePath({ path: '/report.html' }, new AbortController().signal))
    .rejects.toMatchObject({ code: 'gateway/bad-request', message: 'Path has no verified Host path' })
  expect(openPath).not.toHaveBeenCalled()
})

it('dispatches default-app opening to the association adapter', async () => {
  const ctx = await context()
  const open = vi.spyOn(nativeCommand, 'openNativeAssociatedPath').mockResolvedValue(undefined)
  onTestFinished(() => { open.mockRestore() })
  const controller = createSessionTestController(ctx, {
    defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/default', nativeOpen: true,
  })
  const signal = new AbortController().signal
  await controller.openWorkspacePath({ path: '/report.html' }, signal)
  expect(open).toHaveBeenCalledWith(resolve('/report.html'), signal)
})


it('uses the same path verification for handler queries and explicit application opening', async () => {
  const ctx = await context()
  const applications = [{ id: '/Applications/Music.app', name: 'Music', default: true, icon: null }]
  const fileApplications = vi.fn(async () => applications)
  const openFileApplication = vi.fn(async () => {})
  const controller = createSessionTestController(ctx, {
    defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/default', nativeOpen: true,
    fileApplications, openFileApplication,
  })
  const signal = new AbortController().signal
  expect(await controller.workspacePathApplications({ path: '/file.mp3' }, signal)).toEqual(applications)
  await controller.openWorkspacePath({ path: '/file.mp3', application: applications[0]!.id }, signal)
  expect(openFileApplication).toHaveBeenCalledWith(expect.stringContaining('file.mp3'), applications[0]!.id, signal)
  const mapping = vi.spyOn(ctx.fs, 'processPathFromHostPath').mockReturnValue(undefined)
  onTestFinished(() => { mapping.mockRestore() })
  await expect(controller.workspacePathApplications({ path: '/remote.mp3' }, signal)).rejects.toThrow('verified Host path')
  await expect(controller.openWorkspacePath({ path: '/remote.mp3', application: applications[0]!.id }, signal)).rejects.toThrow('verified Host path')
  expect(fileApplications).toHaveBeenCalledOnce()
  expect(openFileApplication).toHaveBeenCalledOnce()
})


it('avoids desktop queries when unavailable and rejects an empty query path', async () => {
  const fileApplications = vi.fn(async () => [])
  const unavailable = createSessionTestController(await context(), {
    defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/default', nativeOpen: false, fileApplications,
  })
  expect(await unavailable.workspacePathApplications({ path: '/file.mp3' }, new AbortController().signal)).toEqual([])
  const available = createSessionTestController(await context(), {
    defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/default', nativeOpen: true, fileApplications,
  })
  await expect(available.workspacePathApplications({ path: '' }, new AbortController().signal)).rejects.toMatchObject({ code: 'gateway/bad-request' })
  expect(fileApplications).not.toHaveBeenCalled()
})


it('returns bounded query failures and classifies cancellation through the Remote', async () => {
  const lifetime = new AbortController()
  const fileApplications = vi.fn()
    .mockRejectedValueOnce(new Error('Command failed: osascript -e private-script-text'))
    .mockImplementationOnce(async () => {
      lifetime.abort()
      throw new Error('native query stopped')
    })
  const remote = createSessionTestRemote(await context(), {
    defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/default', nativeOpen: true, fileApplications,
  })
  await expect(remote.workspacePathApplications({ path: '/file.mp3' })).resolves.toMatchObject({
    ok: false, error: { code: 'gateway/internal', message: 'file application query failed' },
  })
  await expect(remote.workspacePathApplications({ path: '/file.mp3' }, lifetime.signal)).resolves.toMatchObject({
    ok: false, error: { code: 'gateway/cancelled' },
  })
})
