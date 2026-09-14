/** The attachment entry validates its messages and leaves external Chromium open. */

import type { MessagePort } from 'node:worker_threads'
import { afterEach, expect, it, vi } from 'vitest'
import { request } from '../src/worker-rpc.ts'

const transport = vi.hoisted(() => ({ port: null as MessagePort | null, data: {} as unknown }))
vi.mock('node:worker_threads', async importActual => ({
  ...await importActual<typeof import('node:worker_threads')>(),
  get parentPort() { return transport.port },
  get workerData() { return transport.data },
}))
vi.mock('@browserbasehq/stagehand', async importActual => ({
  ...await import('./fixtures/stagehand.ts'),
  StagehandClientCreateConfigSchema: (await importActual<typeof import('@browserbasehq/stagehand')>()).StagehandClientCreateConfigSchema,
}))

let peer: MessagePort | undefined
afterEach(() => { transport.port?.close(); peer?.close(); transport.port = null; peer = undefined })

async function prepare() {
  vi.resetModules()
  const { MessageChannel } = await vi.importActual<typeof import('node:worker_threads')>('node:worker_threads')
  const channel = new MessageChannel()
  transport.port = channel.port1
  peer = channel.port2
  transport.data = { model: { modelName: 'openai/gpt-5.4-mini', apiKey: 'fixture-model-key' }, mode: 'attach', cdpEndpoint: 'http://fixture', headless: true, operationTimeoutMs: 30000, shutdownGraceMs: 5000 }
  const { fixture, resetFixture } = await import('@browserbasehq/stagehand') as unknown as typeof import('./fixtures/stagehand.ts')
  resetFixture()
  return { fixture, peer }
}

it('dispatches browser arguments using the independently configured native model', async () => {
  const { fixture, peer } = await prepare()
  await import('../src/worker.ts')
  await request(peer, 'ready')
  expect(await request(peer, 'navigate', { url: 'https://fixture.example' })).toMatchObject({ content: [{ type: 'text' }] })
  expect(await request(peer, 'extract', { instruction: 'Read the heading' })).toMatchObject({ content: [{ type: 'text' }] })
  await expect(request(peer, 'navigate', { url: 'invalid' })).rejects.toThrow()
  await expect(request(peer, 'unavailable')).rejects.toThrow()
  await request(peer, 'close')
  expect(fixture.models).toEqual([{ modelName: 'openai/gpt-5.4-mini', apiKey: 'fixture-model-key' }])
  expect(fixture.browsers[0]?.stagehandClosed).toBe(true)
  expect(fixture.browsers[0]?.closed).toBe(false)
})

it('reports initialization failure without closing an external browser', async () => {
  const { fixture, peer } = await prepare()
  fixture.createError = new Error('Fixture extension unavailable')
  await import('../src/worker.ts')
  await expect(request(peer, 'ready')).rejects.toThrow('Fixture extension unavailable')
  expect(fixture.browsers[0]?.closed).toBe(false)
})

it('rejects startup outside a Worker', async () => {
  vi.resetModules()
  await expect(import('../src/worker.ts')).rejects.toThrow('requires a Worker parent')
})
