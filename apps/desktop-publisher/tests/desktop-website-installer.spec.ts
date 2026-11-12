import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createDesktopCos } from '@deepseek-ai/dsh-desktop-publisher/desktop-cos.ts'
import { desktopPublishCos } from '@deepseek-ai/dsh-desktop-publisher/desktop-publish-cos.ts'
import { answer, cosError, startCosLoopback } from './cos-loopback.ts'
import { prepareWebsiteInstaller, uploadWebsiteInstaller } from '@deepseek-ai/dsh-desktop-publisher/desktop-website-installer.ts'
import type { DesktopRetainedManifest } from '@deepseek-ai/dsh-desktop-publisher/desktop-release-store.ts'
import type { DesktopPublishRoute } from '@deepseek-ai/dsh-desktop-publisher/desktop-publish-route.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture(target: DesktopPublishRoute['target'] = 'mac-arm64') {
  const directory = await mkdtemp(join(tmpdir(), 'website-installer-'))
  roots.push(directory)
  const bytes = Buffer.from('final installer bytes')
  const route: DesktopPublishRoute = { runId: '12', attempt: '1', commit: 'a'.repeat(40), sourceRef: 'master',
    channel: 'nightly', runnerName: 'mini', runnerLabel: 'dsh-mini', target, preset: 'production' }
  const filename = `deepseek-harness-0.2.1-rc.5-${target}.${target === 'win-x64' ? 'exe' : 'dmg'}`
  await writeFile(join(directory, filename), bytes)
  const manifest: DesktopRetainedManifest = { schemaVersion: 1, source: {
    runId: route.runId, attempt: route.attempt, commit: route.commit, sourceRef: route.sourceRef,
    channel: route.channel, runnerName: route.runnerName, target: route.target, preset: route.preset, repository: 'owner/repo', workflowCommit: route.commit, productVersion: '0.2.1', version: '0.2.1-rc.5',
    testReleaseId: null, qualification: target === 'win-x64' ? 'signed' : 'notarized',
  }, files: [{ name: filename, size: bytes.length, sha512: createHash('sha512').update(bytes).digest('base64') }] }
  return { directory, bytes, route, manifest }
}

it.each(['mac-arm64', 'mac-x64', 'win-x64'] as const)('accepts only the final %s installer without any update files or current checkout version', async (target) => {
  const f = await fixture(target)
  f.manifest = { ...f.manifest, files: [...f.manifest.files,
    { name: 'missing-update.zip', size: 1, sha512: 'unused' }, { name: 'nightly.yml', size: 1, sha512: 'unused' }] }
  const installer = await prepareWebsiteInstaller(f.directory, f.manifest, f.route, 'owner/repo', 'production-123')
  try {
    expect(installer.plan.version).toBe('0.2.1-rc.5')
    expect(installer.plan.artifacts).toHaveLength(1)
    expect(installer.digest).toEqual({ size: f.bytes.length, sha512: f.manifest.files[0]!.sha512 })
  } finally { await installer.handle.close() }
})

it('rejects changed installer bytes', async () => {
  const f = await fixture()
  await writeFile(join(f.directory, f.manifest.files[0]!.name), 'wrong bytes')
  await expect(prepareWebsiteInstaller(f.directory, f.manifest, f.route, 'owner/repo', 'production-123')).rejects.toThrow('differs from build manifest')
})

it.each(['preset', 'qualification', 'attempt', 'commit', 'target', 'repository', 'runId', 'runnerName', 'sourceRef', 'channel'] as const)('rejects mismatched %s even when file bytes match', async (field) => {
  const f = await fixture()
  const source = { ...f.manifest.source }
  if (field === 'preset') source.preset = 'test'
  if (field === 'qualification') source.qualification = 'unnotarized'
  if (field === 'attempt') source.attempt = '2'
  if (field === 'commit') source.commit = 'b'.repeat(40)
  if (field === 'target') source.target = 'mac-x64'
  if (field === 'repository') source.repository = 'other/repo'
  if (field === 'runId') source.runId = '13'
  if (field === 'runnerName') source.runnerName = 'other'
  if (field === 'sourceRef') source.sourceRef = 'dsh-v0.2.1'
  if (field === 'channel') source.channel = 'stable'
  await expect(prepareWebsiteInstaller(f.directory, { ...f.manifest, source }, f.route, 'owner/repo', 'production-123')).rejects.toThrow('identity or production qualification mismatch')
})

it.each(['absent', 'missing-header', 'wrong-header', 'header-not-retained'] as const)('reconciles %s after audit failure without repeating the fixed-object PUT', async (initial) => {
  const f = await fixture()
  const installer = await prepareWebsiteInstaller(f.directory, f.manifest, f.route, 'owner/repo', 'production-123')
  let stored: Buffer | undefined = initial === 'absent' ? undefined : f.bytes
  const disposition = `attachment; filename="${f.manifest.files[0]!.name}"`
  let storedDisposition = initial === 'wrong-header' ? 'attachment; filename="old.dmg"' : undefined
  const server = await startCosLoopback((request, response) => {
    if (request.method === 'PUT') {
      expect(request.headers['x-cos-forbid-overwrite']).toBeUndefined()
      expect(request.headers['content-md5']).toBe(createHash('md5').update(f.bytes).digest('base64'))
      expect(request.headers['content-disposition']).toBe(disposition)
      storedDisposition = disposition
      stored = request.body
      answer(response)
    } else if (stored) answer(response, 200, stored, storedDisposition && initial !== 'header-not-retained' ? { 'content-disposition': storedDisposition } : {})
    else answer(response, 404, cosError('NoSuchKey'))
  })
  try {
    const credentials = { secretId: 'fixture-id', secretKey: 'fixture-key' }
    const createClient: typeof createDesktopCos = (credentials) => {
      const client = createDesktopCos(credentials)
      server.redirect(client)
      return client
    }
    const transport = desktopPublishCos(installer.plan, credentials, createClient)
    await expect(uploadWebsiteInstaller(installer, credentials, transport, async (event) => {
      if (event === 'uploaded') throw new Error('audit unavailable')
    }, { createClient })).rejects.toThrow(initial === 'header-not-retained' ? 'remote download filename unconfirmed' : 'audit unavailable')
    if (initial === 'header-not-retained') {
      expect(server.requests.filter(request => request.method === 'PUT')).toHaveLength(1)
      return
    }
    const events: string[] = []
    expect(await uploadWebsiteInstaller(installer, credentials, transport, async (event) => { events.push(event) }, { createClient })).toBe('present')
    expect(events).toEqual(['uploaded'])
    expect(stored).toEqual(f.bytes)
    expect(server.requests.filter(request => request.method === 'PUT')).toHaveLength(1)
  } finally { await installer.handle.close(); await server.close() }
})

it('does not replace changed bytes when recovering an already completed publication', async () => {
  const f = await fixture()
  const installer = await prepareWebsiteInstaller(f.directory, f.manifest, f.route, 'owner/repo', 'production-123')
  try {
    await expect(uploadWebsiteInstaller(installer, { secretId: 'fixture-id', secretKey: 'fixture-key' },
      { read: async () => ({ size: 1, sha512: 'different' }) }, async () => { throw new Error('unexpected write intent') },
      { createClient: () => { throw new Error('unexpected PUT') }, previouslyUploaded: true })).rejects.toThrow('recorded upload no longer matches')
  } finally { await installer.handle.close() }
})

it('rejects an unsupported source ref even when route and manifest agree', async () => {
  const f = await fixture()
  const route = { ...f.route, sourceRef: 'feature/unapproved' }
  const manifest = { ...f.manifest, source: { ...f.manifest.source, sourceRef: route.sourceRef } }
  await expect(prepareWebsiteInstaller(f.directory, manifest, route, 'owner/repo', 'production-123')).rejects.toThrow('identity or production qualification mismatch')
})
