/** SDK cleanup keeps owned Chromium distinct from externally attached Chromium. */

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { openNativeBrowser } from '../src/native.ts'
import type { NativeBrowserConfig, NativeBrowserRuntime } from '../src/native.ts'
import { fixture, nativeModel, resetFixture } from './fixtures/stagehand.ts'

vi.mock('@browserbasehq/stagehand', async importActual => ({
  ...await importActual<typeof import('@browserbasehq/stagehand')>(),
  ...await import('./fixtures/stagehand.ts'),
}))

const runtimes: NativeBrowserRuntime[] = []
const config: NativeBrowserConfig = {
  model: nativeModel, mode: 'attach', cdpEndpoint: 'http://fixture', headless: true, operationTimeoutMs: 30000, shutdownGraceMs: 5000,
}

beforeEach(() => { resetFixture() })
afterEach(async () => {
  delete fixture.stagehandClose
  await Promise.allSettled(runtimes.splice(0).map(runtime => runtime.close()))
})

it('preserves the external browser when attachment initialization fails', async () => {
  fixture.createError = new Error('Extension initialization failed')
  await expect(openNativeBrowser({ ...config, mode: 'attach', cdpEndpoint: 'http://localhost:9222' }))
    .rejects.toThrow('Extension initialization failed')
  expect(fixture.browsers).toHaveLength(1)
  expect(fixture.browsers[0]?.origin).toBe('connected')
  expect(fixture.browsers[0]?.closed).toBe(false)
  expect(fixture.browsers[0]?.pages.map(page => page.currentURL)).toEqual(['about:blank'])
})

it('leaves Chromium owned by the host when Stagehand cleanup fails', async () => {
  const runtime = await openNativeBrowser(config)
  runtimes.push(runtime)
  fixture.stagehandClose = () => { throw new Error('Stagehand cleanup failed') }
  await expect(runtime.close()).rejects.toThrow('Stagehand cleanup failed')
  expect(fixture.browsers[0]?.closed).toBe(false)
})


it('returns a native screenshot as canonical text and image content', async () => {
  const runtime = await openNativeBrowser(config)
  runtimes.push(runtime)
  expect(await runtime.execute('screenshot', { fullPage: true })).toMatchObject({
    content: [{ type: 'text', text: 'Screenshot of tab tab-1.' }, { type: 'image', mimeType: 'image/png' }],
  })
})
