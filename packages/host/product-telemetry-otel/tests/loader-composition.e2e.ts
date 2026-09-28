import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { expect, it, onTestFinished } from 'vitest'
import { runLoaderSmoke, LOADER_SMOKE_TEST_TIMEOUT_MS } from '@deepseek-ai/dsh-loader-smoke'

it('exports the explicitly submitted event through the headless Loader composition', async () => {
  let captures: unknown
  const driver = resolve(import.meta.dirname, 'fixtures/driver.ts')
  await runLoaderSmoke({
    label: 'product telemetry composition',
    tempDirPrefix: 'product-telemetry-',
    binScript: driver,
    libBinScript: driver,
    configPath: resolve(import.meta.dirname, 'fixtures/telemetry.patch.yml'),
    tsconfigPath: resolve(import.meta.dirname, '../../../../tsconfig.base.json'),
    inspect: async (cwd) => { captures = JSON.parse(await readFile(resolve(cwd, 'captures.json'), 'utf8')) },
  })
  expect(captures).toMatchObject([{
    channel: 'dsh_otel_report', compression: 'gzip',
    body: { resourceLogs: [{ scopeLogs: [{ logRecords: [{ eventName: 'telemetry.synthetic', body: { stringValue: 'Synthetic test' } }] }] }] },
  }])
  expect(JSON.stringify(captures).match(/"eventName"/g)).toHaveLength(1)
}, LOADER_SMOKE_TEST_TIMEOUT_MS)

it.each(['headers', 'body', 'retry'] as const)('exits naturally while the collector stalls %s', async (stall) => {
  let requests = 0
  const server = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      requests++
      if (stall === 'body') res.writeHead(200).write('{')
      if (stall === 'retry') res.writeHead(503, { 'retry-after': '60' }).end()
    })
  })
  onTestFinished(async () => {
    const closed = once(server, 'close')
    server.close()
    server.closeAllConnections()
    await closed
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('collector has no port')
  const driver = resolve(import.meta.dirname, 'fixtures/shutdown.ts')
  await runLoaderSmoke({
    label: `product telemetry shutdown during ${stall}`,
    tempDirPrefix: 'product-telemetry-shutdown-',
    binScript: driver,
    libBinScript: driver,
    configPath: resolve(import.meta.dirname, 'fixtures/shutdown.patch.yml'),
    tsconfigPath: resolve(import.meta.dirname, '../../../../tsconfig.base.json'),
    processTimeoutMs: 10_000,
    env: {
      DSH_APP_VERSION: 'synthetic-release',
      DSH_PRODUCT_TELEMETRY_TEST_ENDPOINT: `http://127.0.0.1:${address.port}/v1/logs`,
    },
  })
  expect(requests).toBe(1)
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
