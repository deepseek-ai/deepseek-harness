/** Loader composition with a loopback collector and one explicit synthetic event. */
import { createServer } from 'node:http'
import { once } from 'node:events'
import { gunzipSync } from 'node:zlib'
import { writeFile } from 'node:fs/promises'
import type {} from '@deepseek-ai/dsh-host-product-telemetry-otel'
import { bootProductionProfile } from '../../../../test-support/loader-smoke/tests/fixtures/production-profile.ts'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('product telemetry fixture requires an overlay')
const captures: unknown[] = []
const server = createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', chunk => chunks.push(chunk as Buffer))
  req.on('end', () => {
    const bytes = Buffer.concat(chunks)
    const body: unknown = JSON.parse(gunzipSync(bytes).toString())
    captures.push({ channel: req.headers['x-channel'], compression: req.headers['content-encoding'], body })
    res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
  })
})
try {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('collector has no port')
  process.env.DSH_APP_VERSION = 'synthetic-release'
  process.env.DSH_PRODUCT_TELEMETRY_TEST_ENDPOINT = `http://127.0.0.1:${address.port}/v1/logs`
  const ctx = await bootProductionProfile({ binName: 'product-telemetry-test', profile: 'headless', overlayPaths: [configPath] })
  try {
    const telemetry = ctx.get('productTelemetry')
    if (telemetry === undefined) throw new Error('product telemetry did not activate')
    telemetry.emit({ eventName: 'telemetry.synthetic', timestamp: 1_800_000_000_000, body: 'Synthetic test', attributes: { synthetic: true } })
  } finally {
    await ctx.fiber.dispose()
  }
  await writeFile('captures.json', JSON.stringify(captures))
} finally {
  const closed = once(server, 'close')
  server.close()
  server.closeAllConnections()
  await closed
}
