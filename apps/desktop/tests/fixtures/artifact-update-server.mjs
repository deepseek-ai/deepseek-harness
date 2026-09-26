/** Loopback delivery of read-only executable inputs with correct hashes and optional transfer corruption. */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { dump } from 'js-yaml'

/**
 * Hash an executable without modifying or buffering the complete file.
 * @param {string} file Input file.
 * @returns {Promise<string>} Base64 SHA-512.
 */
export async function artifactDigest(file) {
  const hash = createHash('sha512')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('base64')
}

/**
 * Serve supplied executables through a synthetic Nightly feed on a private port.
 * @param {{ signed: string, unsigned: string, old?: string, signedBlockmap?: string, oldBlockmap?: string }} files Read-only input paths.
 * @returns {Promise<object>} Feed controls, request evidence, input hashes, and awaited close.
 */
export async function createArtifactUpdateServer(files) {
  const artifacts = Object.fromEntries(await Promise.all(Object.entries(files).map(async ([name, file]) =>
    [name, { file, size: (await stat(file)).size, sha512: await artifactDigest(file) }])))
  const requests = []
  const failures = []
  const transfers = new Set()
  let selected = 'signed'
  let corrupt = false
  let fault
  let origin
  const server = createServer((request, response) => {
    const path = new URL(request.url, origin).pathname
    const artifact = artifacts[selected]
    const damage = corrupt
    const record = { path, artifact: selected, corrupt: damage, range: request.headers.range, bytes: 0 }
    requests.push(record)
    response.setHeader('Cache-Control', 'no-store')
    if (path === '/nightly.yml') {
      response.setHeader('Content-Type', 'application/yaml')
      response.end(dump({ version: '1.0.1-nightly.1', files: [{
        url: `${origin}/payload-1.0.1-nightly.1.exe`, size: artifact.size, sha512: artifact.sha512,
      }], path: 'payload-1.0.1-nightly.1.exe', sha512: artifact.sha512 }))
      return
    }
    const blockmap = path === '/payload-1.0.0.exe.blockmap' ? artifacts.oldBlockmap
      : path === '/payload-1.0.1-nightly.1.exe.blockmap' ? artifacts.signedBlockmap : undefined
    if (blockmap && !(fault === 'missing-old-blockmap' && blockmap === artifacts.oldBlockmap)) {
      response.writeHead(200, { 'Content-Length': blockmap.size })
      track(pipeline(createReadStream(blockmap.file), response))
      return
    }
    if (path !== '/payload-1.0.1-nightly.1.exe') { response.writeHead(404).end(); return }
    const range = request.headers.range
    if (range && fault === 'reject-ranges') { response.writeHead(416).end(); return }
    const ranges = range?.replace(/^bytes=/u, '').split(',').map(part => part.trim().split('-').map(Number))
    if (ranges?.some(([start, end]) => !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
      || start < 0 || end < start || end >= artifact.size)) { response.writeHead(416).end(); return }
    record.bytes = ranges?.reduce((sum, [start, end]) => sum + end - start + 1, 0) ?? artifact.size
    const boundary = 'desktop-update-qualification'
    const headers = { 'Content-Type': 'application/octet-stream', 'Accept-Ranges': 'bytes' }
    if (!ranges) headers['Content-Length'] = artifact.size
    else if (ranges.length === 1) {
      headers['Content-Range'] = `bytes ${ranges[0][0]}-${ranges[0][1]}/${artifact.size}`
      headers['Content-Length'] = record.bytes
    }
    else headers['Content-Type'] = `multipart/byteranges; boundary=${boundary}`
    response.writeHead(ranges ? 206 : 200, headers)
    async function* body() {
      for (const [start, end] of ranges ?? [[0, artifact.size - 1]]) {
        if (ranges?.length > 1) yield Buffer.from(`--${boundary}\r\nContent-Type: application/octet-stream\r\nContent-Range: bytes ${start}-${end}/${artifact.size}\r\n\r\n`)
        yield* createReadStream(artifact.file, { start, end })
        if (ranges?.length > 1) yield Buffer.from('\r\n')
      }
      if (ranges?.length > 1) yield Buffer.from(`--${boundary}--\r\n`)
    }
    let first = true
    const transform = new Transform({ transform(chunk, encoding, callback) {
      if (damage && first) chunk[0] ^= 1
      first = false
      callback(null, chunk)
    } })
    track(pipeline(Readable.from(body()), transform, response))
  })
  function track(promise) {
    const transfer = promise
      .catch(error => { failures.push(String(error)) })
      .finally(() => transfers.delete(transfer))
    transfers.add(transfer)
  }
  const listening = once(server, 'listening')
  server.listen(0, '127.0.0.1')
  await listening
  origin = `http://127.0.0.1:${server.address().port}`
  return {
    url: `${origin}/`, requests, failures, artifacts,
    select(name, damage = false, failure) { selected = name; corrupt = damage; fault = failure },
    async close() {
      const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      server.closeAllConnections()
      await Promise.all([closed, ...transfers])
    },
  }
}
