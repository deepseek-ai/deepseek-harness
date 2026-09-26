/** Loopback-only update feeds and deterministic transport failures for Electron qualification. */
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { dump } from 'js-yaml'

/**
 * Allocate a private listener with request barriers and no remote publication.
 * @returns {Promise<object>} Feed URL, scenario controls, observations, and awaited disposal.
 */
export async function createUpdateServer() {
  const payload = Buffer.alloc(256 * 1024, 0x5a)
  const sha512 = createHash('sha512').update(payload).digest('base64')
  const requests = []
  const failures = []
  let mode = 'healthy'
  let version = '1.0.1-nightly.1'
  let policyMode = 'clear'
  let gate = Promise.withResolvers()
  let arrived = Promise.withResolvers()
  let origin
  const server = createServer((request, response) => {
    const path = new URL(request.url, origin).pathname
    requests.push(path)
    const selectedMode = mode
    const selectedGate = gate
    response.setHeader('Cache-Control', 'no-store')
    void (async () => {
      if (path === '/api/v0/check_client_update') {
        response.setHeader('Content-Type', 'application/json')
        if (policyMode === 'stall') return
        if (policyMode === 'failure') { response.writeHead(503).end('{"code":500}'); return }
        response.end(JSON.stringify(policyMode === 'force' ? {
          code: 40005, data: { show_content: { title: '需要更新', detail: '现有任务继续运行，请更新后继续操作。' },
            desktop_app_link: 'https://downloads.example.com/desktop' },
        } : { code: 0, data: { biz_code: 0, biz_data: null } }))
        return
      }
      if (path === '/nightly.yml') {
        if (selectedMode === 'feed-stall') return
        if (selectedMode === 'feed-404') { response.writeHead(404).end(); return }
        if (selectedMode === 'feed-408') { response.writeHead(408).end(); return }
        if (selectedMode === 'invalid-yaml') { response.end('files: ['); return }
        if (selectedMode === 'hold-check') { arrived.resolve(); await selectedGate.promise }
        response.setHeader('Content-Type', 'application/yaml')
        response.end(dump({ version, files: [{ url: `${origin}/payload.exe`, size: payload.length, sha512 }],
          path: 'payload.exe', sha512, releaseDate: '2026-09-10T00:00:00.000Z' }))
        return
      }
      if (path !== '/payload.exe' || selectedMode === 'download-404') { response.writeHead(404).end(); return }
      response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': payload.length })
      if (selectedMode === 'download-stall') { response.write(payload.subarray(0, 1024)); return }
      if (selectedMode === 'corrupt') { response.end(Buffer.alloc(payload.length, 0x21)); return }
      if (selectedMode === 'disconnect') {
        response.write(payload.subarray(0, 1024), () => response.destroy())
        return
      }
      if (selectedMode === 'hold-download') {
        response.write(payload.subarray(0, 1024))
        arrived.resolve()
        await selectedGate.promise
        if (!response.destroyed) response.end(payload.subarray(1024))
        return
      }
      response.end(payload)
    })().catch(error => { failures.push(String(error)); response.destroy() })
  })
  const listening = once(server, 'listening')
  server.listen(0, '127.0.0.1')
  await listening
  origin = `http://127.0.0.1:${server.address().port}`
  return {
    url: `${origin}/`, payload, requests, failures,
    policy(next) { policyMode = next },
    select(nextMode, nextVersion = '1.0.1-nightly.1') {
      gate.resolve()
      gate = Promise.withResolvers()
      arrived = Promise.withResolvers()
      mode = nextMode
      version = nextVersion
    },
    arrived: () => arrived.promise,
    release: () => gate.resolve(),
    async close() {
      gate.resolve()
      const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      server.closeAllConnections()
      await closed
    },
  }
}
