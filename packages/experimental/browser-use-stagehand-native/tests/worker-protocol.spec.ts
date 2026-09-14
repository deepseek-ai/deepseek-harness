/** Invalid host envelopes terminate only the owned Worker with a diagnostic. */

import { once } from 'node:events'
import { Worker } from 'node:worker_threads'
import { finished } from 'node:stream/promises'
import { expect, it } from 'vitest'
import { request } from '../src/worker-rpc.ts'

it('reports malformed requests before exiting its real Worker', async () => {
  const hooks = new URL('../../../../snapshots/session/browser-use-stagehand-native/native-fixture.mjs', import.meta.url)
  const entry = new URL('../src/worker.ts', import.meta.url)
  const bootstrap = [
    `import { register } from ${JSON.stringify(import.meta.resolve('tsx/esm/api'))}; register();`,
    `import { installExternalBrowserHooks } from ${JSON.stringify(hooks.href)}; installExternalBrowserHooks();`,
    `await import(${JSON.stringify(entry.href)});`,
  ].join('\n')
  const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(bootstrap)}`), {
    workerData: { model: { modelName: 'openai/gpt-5.4-mini', apiKey: 'fixture-model-key' }, mode: 'attach', cdpEndpoint: 'http://fixture', headless: true, operationTimeoutMs: 30000, shutdownGraceMs: 1000 },
    env: {}, execArgv: [], stderr: true,
  })
  let diagnostics = ''
  worker.stderr.setEncoding('utf8')
  worker.stderr.on('data', (chunk: string) => { diagnostics += chunk })
  try {
    await request(worker, 'ready')
    const exited = once(worker, 'exit')
    worker.postMessage({ method: 42, reply: false })
    expect(await exited).toEqual([1])
    await finished(worker.stderr)
    expect(diagnostics).toContain('Stagehand Worker protocol failed:')
    expect(worker.threadId).toBe(-1)
  } finally {
    await worker.terminate()
  }
})
