/** Chromium ownership spans readiness failure, cancellation, and process close. */

import { EventEmitter } from 'node:events'
import { access, rm } from 'node:fs/promises'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { NativeBrowserConfig } from '../src/native.ts'
import { launchChromium } from '../src/launch.ts'
import { nativeModel } from './fixtures/stagehand.ts'

const state = vi.hoisted(() => ({ launch: vi.fn(), path: vi.fn(() => '/fixture/chrome') }))
vi.mock('@puppeteer/browsers', () => ({
  Browser: { CHROME: 'chrome' }, ChromeReleaseChannel: { STABLE: 'stable' },
  CDP_WEBSOCKET_ENDPOINT_REGEX: /^DevTools listening on (.+)$/,
  computeSystemExecutablePath: state.path,
  launch: state.launch,
}))

const config: NativeBrowserConfig = { model: nativeModel, mode: 'launch', headless: true, operationTimeoutMs: 5000, shutdownGraceMs: 50 }
const profiles: string[] = []
beforeEach(() => { state.launch.mockReset(); state.path.mockClear() })
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(profiles.splice(0).map(profile => rm(profile, { recursive: true, force: true })))
})

function processFixture() {
  const child = new EventEmitter()
  const ready = Promise.withResolvers<string>()
  const started = Promise.withResolvers<undefined>()
  const killed = Promise.withResolvers<undefined>()
  const kill = vi.fn(() => { killed.resolve(undefined); child.emit('close', 0) })
  state.launch.mockImplementation((options: { args: string[] }) => {
    profiles.push(options.args.find(arg => arg.startsWith('--user-data-dir='))!.slice('--user-data-dir='.length))
    started.resolve(undefined)
    return { nodeProcess: child, kill, waitForLineOutput: () => ready.promise }
  })
  return { child, ready, started, killed, kill }
}

it.each([true, false])('launches with scrubbed environment and owns the profile until child close (headless %s)', async (headless) => {
  vi.stubEnv('BROWSER_LAUNCH_API_TOKEN', 'fixture-secret')
  vi.stubEnv('DSH_FIXTURE_ID', 'fixture-identity')
  vi.stubEnv('BROWSER_LAUNCH_PUBLIC', 'visible')
  const fake = processFixture()
  const opening = launchChromium({ ...config, headless, ...headless ? {} : { executablePath: '/custom/chrome' } }, new AbortController().signal)
  await fake.started.promise
  fake.ready.resolve('ws://127.0.0.1:1234/devtools/browser/fixture')
  const browser = await opening
  const options = state.launch.mock.calls[0]![0] as { executablePath: string; args: string[]; env: Record<string, string> }
  expect(options.executablePath).toBe(headless ? '/fixture/chrome' : '/custom/chrome')
  expect(options.args.includes('--headless=new')).toBe(headless)
  expect(options.args).toContain('--remote-debugging-port=0')
  expect(options.env.BROWSER_LAUNCH_PUBLIC).toBe('visible')
  expect(options.env.BROWSER_LAUNCH_API_TOKEN).toBeUndefined()
  expect(options.env.DSH_FIXTURE_ID).toBeUndefined()
  await expect(access(profiles[0]!)).resolves.toBeUndefined()
  await browser.close()
  expect(fake.kill).toHaveBeenCalledOnce()
  await expect(access(profiles[0]!)).rejects.toThrow()
})

it('cancels after spawn and waits for close before removing the profile', async () => {
  const fake = processFixture()
  fake.kill.mockImplementation(() => { fake.killed.resolve(undefined) })
  const controller = new AbortController()
  const opening = launchChromium(config, controller.signal)
  const canceled = expect(opening).rejects.toThrow('Stop acquisition')
  await fake.started.promise
  controller.abort(new Error('Stop acquisition'))
  await fake.killed.promise
  await expect(access(profiles[0]!)).resolves.toBeUndefined()
  fake.child.emit('close', 0)
  fake.ready.reject(new Error('Browser exited'))
  await canceled
  await expect(access(profiles[0]!)).rejects.toThrow()
})

it('cleans up before reporting a CDP readiness failure', async () => {
  const fake = processFixture()
  const opening = launchChromium(config, new AbortController().signal)
  const failed = expect(opening).rejects.toThrow('No debugging endpoint')
  await fake.started.promise
  fake.ready.reject(new Error('No debugging endpoint'))
  await failed
  expect(fake.kill).toHaveBeenCalledOnce()
  await expect(access(profiles[0]!)).rejects.toThrow()
})

it('removes the profile when construction fails before returning a process', async () => {
  processFixture()
  const capture = state.launch.getMockImplementation()!
  state.launch.mockImplementation((options) => { capture(options); throw new Error('Cannot spawn browser') })
  await expect(launchChromium(config, new AbortController().signal)).rejects.toThrow('Cannot spawn browser')
  await expect(access(profiles[0]!)).rejects.toThrow()
})

it('does not spawn after cancellation during profile acquisition', async () => {
  const controller = new AbortController()
  const opening = launchChromium(config, controller.signal)
  controller.abort(new Error('Canceled before spawn'))
  await expect(opening).rejects.toThrow('Canceled before spawn')
  expect(state.launch).not.toHaveBeenCalled()
})

it('preserves cleanup failure when a canceled process cannot be killed', async () => {
  const fake = processFixture()
  fake.kill.mockImplementation(() => { throw new Error('Kill denied') })
  const controller = new AbortController()
  const opening = launchChromium(config, controller.signal)
  const failed = expect(opening).rejects.toThrow('Kill denied')
  await fake.started.promise
  controller.abort(new Error('Canceled'))
  fake.ready.reject(new Error('Readiness deadline'))
  await failed
  await expect(access(profiles[0]!)).resolves.toBeUndefined()
})
