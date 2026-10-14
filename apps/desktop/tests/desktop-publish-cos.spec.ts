import { expect, it } from 'vitest'
import { createDesktopCos } from '../scripts/desktop-cos.ts'
import { desktopPublishCos } from '../scripts/desktop-publish-cos.ts'
import { desktopArtifactDigest } from '../scripts/desktop-publish.ts'
import type { DesktopUploadPlan } from '../scripts/desktop-upload-plan.ts'
import { answer, cosError, startCosLoopback } from './cos-loopback.ts'

it('uses overwrite prevention, streams verified bytes, and hashes remote readback through the SDK', async () => {
  const objects = new Map<string, Buffer>()
  const server = await startCosLoopback((request, response) => {
    if (request.path.includes('versioning')) { answer(response, 200, '<VersioningConfiguration/>'); return }
    if (request.method === 'PUT') {
      expect(request.headers['x-cos-forbid-overwrite']).toBe('true')
      objects.set(request.path, request.body)
      answer(response)
    } else {
      const bytes = objects.get(request.path)
      if (bytes === undefined) answer(response, 404, cosError('NoSuchKey'))
      else answer(response, 200, bytes)
    }
  })
  try {
    const artifact = { path: '', filename: 'file.exe', key: 'bin/file.exe', contents: 'fixture bytes', contentType: 'application/octet-stream', channelMetadata: false }
    const plan: DesktopUploadPlan = {
      environment: 'test', target: 'win-x64', version: '1.0.0', bucket: 'fixture-1250000000', publicUrl: 'https://example.com/',
      secretIdEnvName: 'ID', secretKeyEnvName: 'KEY', artifacts: [artifact],
    }
    const transport = desktopPublishCos(plan, { secretId: 'fixture-id', secretKey: 'fixture-secret' }, (credentials) => {
      const client = createDesktopCos(credentials)
      server.redirect(client)
      return client
    })
    expect(await transport.read(artifact.key, false)).toBeNull()
    const digest = await desktopArtifactDigest(artifact)
    await transport.put(artifact, digest, true)
    expect(await transport.read(artifact.key, false)).toEqual(digest)
    await expect(transport.read('elsewhere/file.exe', false)).rejects.toThrow(/outside/u)
    expect(server.requests.filter(request => request.method === 'PUT')).toHaveLength(1)
  } finally { await server.close() }
})

it('propagates an oversized channel stream error through the SDK and closes the request', async () => {
  const server = await startCosLoopback((_request, response) => { answer(response, 200, Buffer.alloc(1024 * 1024 + 1, 65)) })
  try {
    const artifact = { path: '', filename: 'nightly.yml', key: 'feed/nightly.yml', contents: 'version: 1.0.0\n', contentType: 'application/yaml', channelMetadata: true }
    const plan: DesktopUploadPlan = { environment: 'test', target: 'win-x64', version: '1.0.0', bucket: 'fixture-1250000000',
      publicUrl: 'https://example.com/', secretIdEnvName: 'ID', secretKeyEnvName: 'KEY', artifacts: [artifact] }
    const transport = desktopPublishCos(plan, { secretId: 'fixture-id', secretKey: 'fixture-secret' }, (credentials) => {
      const client = createDesktopCos(credentials)
      server.redirect(client)
      return client
    })
    await expect(transport.read(artifact.key, true)).rejects.toThrow(/exceeds 1 MiB/u)
    expect(server.requests).toHaveLength(1)
  } finally { await server.close() }
})
