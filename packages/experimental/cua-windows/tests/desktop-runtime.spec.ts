/** Opt-in real desktop admission through the shipped managed subprocess provider. */
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { NativeClient } from '@deepseek-ai/dsh-cua/native-client'
import { AppResult, AppsResult, NativeAppsResult, StateResult } from '@deepseek-ai/dsh-cua/protocol'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { once } from 'node:events'
import { cp, copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { z } from 'zod'
import { expect, it, onTestFinished } from 'vitest'
import { Config } from '../src/index.ts'
import { WindowsNativeRuntime } from '../src/native-runtime.ts'

const helperPath = process.env.DSH_CUA_DESKTOP_TEST_HELPER

async function connect() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(LocalSubprocessRuntime)
  const config = { ...Config({}), helperPath: helperPath!, cwd: process.cwd() }
  const runtime = new WindowsNativeRuntime(ctx, 25, config.timeoutMs, process.platform === 'win32' ? 'pipe' : 'stdio')
  onTestFinished(() => runtime.dispose())
  const channel = runtime.connect(config)
  const client = new NativeClient(ctx, config, () => channel)
  onTestFinished(() => client.dispose())
  return { client, channel }
}

it.skipIf(!helperPath)('admits Windows desktop requests through managed WSL or native Windows processes', async () => {
  const { client } = await connect()
  const signal = new AbortController().signal
  const capabilities = await client.request('getCapabilities', {}, signal)
  expect(capabilities).toHaveProperty('permissions.accessibility', expect.any(Boolean))
  expect(capabilities).toHaveProperty('permissions.screenRecording', expect.any(Boolean))
  const apps = NativeAppsResult.parse(await client.request('listApps', {}, new AbortController().signal))
  expect(apps.length).toBeGreaterThan(0)
  for (const app of apps) {
    expect(app.identity).toBeNull()
    expect(app).not.toHaveProperty('pid')
  }
  const installed = AppsResult.parse(await client.request('findApps', { query: null, maxAppMatches: 1 }, new AbortController().signal))
  expect(installed.length).toBeGreaterThan(0)
  const matches = AppsResult.parse(await client.request('findApps', { query: installed[0]!.id, maxAppMatches: 1000 }, new AbortController().signal))
  expect(matches.some(app => app.id === installed[0]!.id)).toBe(true)
  for (const app of matches) {
    expect(app.identity).toBeNull()
    expect(app).not.toHaveProperty('pid')
  }
  for (const query of ['', null]) {
    const all = AppsResult.parse(await client.request('findApps', { query, maxAppMatches: 1 }, new AbortController().signal))
    expect(all.length).toBeGreaterThan(0)
  }
}, 60_000)

it.skipIf(!helperPath)('describes one action argument without an application or window', async () => {
  const { client } = await connect()
  const signal = new AbortController().signal
  expect(await client.request('getActionSchema', { action: 'Invoke.Invoke' }, signal)).toEqual({
    type: 'object', properties: { argument: { type: 'null' } }, required: [], additionalProperties: false,
  })
  expect(await client.request('getActionSchema', { action: 'Window.SetWindowVisualState' }, signal)).toEqual({
    type: 'object',
    properties: { argument: { type: 'string', description: 'Accepted values: Normal, Maximized, Minimized (case-sensitive).' } },
    required: ['argument'], additionalProperties: false,
  })
  expect(await client.request('getActionSchema', { action: 'Transform.Resize' }, signal)).toEqual({
    type: 'object',
    properties: { argument: {
      type: 'object',
      properties: {
        width: { type: 'number', description: 'Pixel dimension; must be positive.' },
        height: { type: 'number', description: 'Pixel dimension; must be positive.' },
      },
      required: ['width', 'height'], additionalProperties: false,
    } },
    required: ['argument'], additionalProperties: false,
  })
  expect(await client.request('getActionSchema', { action: 'MultipleView.SetCurrentView' }, signal)).toEqual({
    type: 'object',
    properties: { argument: { type: 'number', description: 'A 32-bit integer element view ID.' } },
    required: ['argument'], additionalProperties: false,
  })
  expect(await client.request('getActionSchema', { action: 'Scroll.SetScrollPercent' }, signal)).toEqual({
    type: 'object',
    properties: { argument: {
      type: 'object',
      properties: {
        horizontalPercent: { type: 'number', description: 'Scroll percentage from 0 to 100, or -1 (NoScroll) to leave the axis unchanged.' },
        verticalPercent: { type: 'number', description: 'Scroll percentage from 0 to 100, or -1 (NoScroll) to leave the axis unchanged.' },
      },
      required: ['horizontalPercent', 'verticalPercent'], additionalProperties: false,
    } },
    required: ['argument'], additionalProperties: false,
  })
  await expect(client.request('getActionSchema', { action: 'Missing.Action' }, signal))
    .rejects.toMatchObject({ code: 'UNSUPPORTED' })
}, 60_000)

const fixturePath = process.env.DSH_CUA_DESKTOP_TEST_FIXTURE
const fixtureTest = it.skipIf(process.platform !== 'win32' || !helperPath || !fixturePath)
fixtureTest('adds permission attributes without merging discovery IDs or changing an admitted HWND', { timeout: 60_000 }, async ({ signal }) => {
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-cua-attributes-'))
  onTestFinished(() => rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  const root = join(temporary, 'Example')
  const runtimeDirectory = join(root, 'app-1.2.3')
  await cp(dirname(fixturePath!), runtimeDirectory, { recursive: true })
  const launcherPath = join(root, 'Example.exe')
  const runtimePath = join(runtimeDirectory, 'Example.exe')
  await copyFile(fixturePath!, launcherPath)
  await copyFile(join(runtimeDirectory, basename(fixturePath!)), runtimePath)
  const { client } = await connect()
  const selection = AppResult.extend({ authorization: z.object({ id: z.string(), persistable: z.literal(true), iconPath: z.string(),
    attributes: z.record(z.string(), z.array(z.string())),
  }) })
  const launcher = selection.parse(await client.request('getApp', { selector: launcherPath }, signal))
  const runtime = selection.parse(await client.request('getApp', { selector: runtimePath }, signal))
  expect(runtime.authorization.id).not.toBe(launcher.authorization.id)
  expect(AppsResult.parse(await client.request('findApps', { query: runtimePath, maxAppMatches: 1 }, signal)))
    .toEqual([expect.objectContaining({ id: runtimePath })])
  const fixture = spawn(runtimePath, [], { windowsHide: true })
  const exited = once(fixture, 'exit')
  const reader = createInterface({ input: fixture.stdout })
  onTestFinished(async () => {
    const deadline = setTimeout(() => fixture.kill(), 5000)
    try { fixture.stdin.end('close\n'); await exited }
    finally { clearTimeout(deadline); reader.close() }
  })
  const first = await reader[Symbol.asyncIterator]().next()
  if (first.done) throw new Error('The desktop fixture exited before reporting its window')
  const { state: { window: windowId } } = z.object({ state: z.object({ window: z.string() }) }).parse(JSON.parse(first.value))
  const params = { appHandle: runtime.appHandle, windowId, maxElements: 20, maxDepth: 5 }
  await expect(client.request('getState', { ...params, appHandle: launcher.appHandle }, signal))
    .rejects.toMatchObject({ code: 'WINDOW_CHANGED' })
  expect(StateResult.parse(await client.request('getState', params, signal)).tree).toContain('DSH CUA owned test window')
  const listed = NativeAppsResult.parse(await client.request('listApps', {}, signal))
  expect(listed.filter(app => app.id === runtimePath)).toHaveLength(1)
  const byId = selection.parse(await client.request('getApp', { selector: runtimePath }, signal))
  expect(byId.authorization.id).toBe(runtime.authorization.id)
  const changed = once(reader, 'line')
  fixture.stdin.write('identity\n')
  await changed
  expect(StateResult.parse(await client.request('getState', params, signal)).tree).toContain('DSH CUA owned test window')
  expect(await client.request('listWindows', { appHandle: runtime.appHandle }, signal))
    .toEqual(expect.arrayContaining([expect.objectContaining({ windowId })]))
  expect(NativeAppsResult.parse(await client.request('listApps', {}, signal)))
    .toEqual(expect.arrayContaining([expect.objectContaining({ id: 'DSH.Fixture.' + windowId })]))
  const changedId = 'DSH.Fixture.' + windowId
  const changedApp = selection.parse(await client.request('getApp', { selector: changedId }, signal))
  expect(changedApp.authorization.id).not.toBe(runtime.authorization.id)
  expect(changedApp.authorization.attributes['windows.aumid']).toContain(changedId)
  expect(changedApp.authorization.attributes['windows.executablePath']).toContain(runtimePath.toUpperCase())
  expect(changedApp.authorization.attributes['windows.executablePath']).toEqual(runtime.authorization.attributes['windows.executablePath'])
  await expect(client.request('getState', { ...params, appHandle: byId.appHandle }, signal))
    .rejects.toMatchObject({ code: 'WINDOW_CHANGED' })
})

it.skipIf(process.platform !== 'win32' || !helperPath || !fixturePath)(
  'reports a UIA change from a private editor and resolves its ID in the new snapshot',
  async ({ signal }) => {
    const fixture = spawn(fixturePath!, [], { windowsHide: true })
    const exited = once(fixture, 'exit')
    const reader = createInterface({ input: fixture.stdout })
    onTestFinished(async () => {
      const deadline = setTimeout(() => fixture.kill(), 5000)
      try {
        fixture.stdin.end('close\n')
        await exited
      } finally { clearTimeout(deadline); reader.close() }
    })
    const first = await reader[Symbol.asyncIterator]().next()
    if (first.done) throw new Error('The desktop fixture exited before reporting its window')
    const { state: { window: windowId } } = z.object({ state: z.object({ window: z.string() }) }).parse(JSON.parse(first.value))
    const { client, channel } = await connect()
    const { appHandle } = AppResult.parse(await client.request('getApp', { selector: fixturePath! }, signal))
    const params = { appHandle, windowId, maxElements: 200, maxDepth: 20 }
    const read = async (showDiff: boolean) => StateResult.parse(await client.request('getState', { ...params, showDiff }, signal))
    // Interrupt after the helper produces its baseline, before the client consumes the reply.
    const interrupted = new AbortController()
    channel.stdout.prependOnceListener('data', () => { interrupted.abort() })
    await expect(client.request('getState', { ...params, showDiff: true }, interrupted.signal))
      .rejects.toMatchObject({ code: 'NATIVE_CANCELLED' })
    expect((await read(true)).tree).toMatch(/^- \[.+?\] Window\b/)
    fixture.stdin.write('change-text\n')
    let target: { snapshotId: string; elementId: string } | undefined
    await expect.poll(async () => {
      const state = await read(true)
      const elementId = /^(?:TextChanged|PropertyChanged) \[([\d/-]+)\] Edit\b.*CUA notification sample/m.exec(state.tree)?.[1]
      if (elementId) target = { snapshotId: state.snapshotId, elementId }
      return target
    }, { timeout: 10000 }).toBeDefined()
    expect(await client.request('listActions', { appHandle, windowId, ...target }, signal)).toEqual(expect.any(Array))
    expect((await read(false)).tree).toContain('CUA notification sample')
    expect((await read(true)).tree).toContain('CUA test text')
  }, 60_000)
