import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { publishDesktopRelease, type DesktopPublishEvent, type DesktopPublishOperations, type DesktopRemoteObject } from '../scripts/desktop-publish.ts'
import type { DesktopUploadPlan } from '../scripts/desktop-upload-plan.ts'

function observed(contents: string): DesktopRemoteObject {
  return { contents, size: Buffer.byteLength(contents), sha512: createHash('sha512').update(contents).digest('base64') }
}
function fixture(environment: 'test' | 'production' = 'test') {
  const objects = new Map<string, DesktopRemoteObject>()
  const writes: string[] = []
  const events: DesktopPublishEvent[] = []
  let tags = 0
  const plan: DesktopUploadPlan = {
    environment, target: 'win-x64', version: '1.0.0', bucket: 'fixture', publicUrl: 'https://example.com/feed/',
    secretIdEnvName: 'ID', secretKeyEnvName: 'KEY', commit: 'a'.repeat(40), dirty: false,
    artifacts: [
      { path: '', filename: 'installer.exe', key: 'bin/installer.exe', contentType: 'application/octet-stream', channelMetadata: false, contents: 'installer' },
      { path: '', filename: 'installer.blockmap', key: 'bin/installer.blockmap', contentType: 'application/octet-stream', channelMetadata: false, contents: 'blockmap' },
      { path: '', filename: 'nightly.yml', key: 'feed/nightly.yml', contentType: 'application/yaml', channelMetadata: true, contents: 'version: 1.0.0\n' },
    ],
  }
  const operations: DesktopPublishOperations = {
    transport: {
      async read(key) { return objects.get(key) ?? null },
      async put(artifact, _digest, forbidOverwrite) {
        if (forbidOverwrite && objects.has(artifact.key)) throw new Error('already exists')
        writes.push(artifact.key)
        objects.set(artifact.key, observed(artifact.contents!))
      },
    },
    async record(event) { events.push(event) },
    async tag() { tags++ },
  }
  return { plan, operations, objects, writes, events, tags: () => tags }
}

it('uploads files before the feed and skips identical bytes on a repeat invocation', async () => {
  const f = fixture()
  await expect(publishDesktopRelease(f.plan, f.operations)).resolves.toEqual({ status: 'complete' })
  expect(f.writes).toEqual(['bin/installer.exe', 'bin/installer.blockmap', 'feed/nightly.yml'])
  await publishDesktopRelease(f.plan, f.operations)
  expect(f.writes).toHaveLength(3)
  expect(f.tags()).toBe(0)
  expect(f.events.find(event => event.key === 'feed/nightly.yml' && event.type === 'put-intent'))
    .toMatchObject({ before: null, after: 'version: 1.0.0\n' })
})

it('recovers an ambiguous binary write without repeating it or publishing the feed early', async () => {
  const f = fixture()
  const put = f.operations.transport.put.bind(f.operations.transport)
  let fail = true
  f.operations.transport.put = async (...args) => {
    await put(...args)
    if (fail) { fail = false; throw new Error('connection lost after server stored bytes') }
  }
  await expect(publishDesktopRelease(f.plan, f.operations)).rejects.toThrow(/connection lost/u)
  expect(f.objects.has('feed/nightly.yml')).toBe(false)
  await publishDesktopRelease(f.plan, f.operations)
  expect(f.writes).toEqual(['bin/installer.exe', 'bin/installer.blockmap', 'feed/nightly.yml'])
})

it('reports published but tag pending and retries only the tag', async () => {
  const f = fixture('production')
  let fail = true
  const tag = f.operations.tag.bind(f.operations)
  f.operations.tag = async () => { if (fail) throw new Error('GitHub unavailable'); await tag() }
  await expect(publishDesktopRelease(f.plan, f.operations)).resolves.toMatchObject({ status: 'published-tag-pending' })
  expect(f.events.at(-1)?.type).toBe('tag-pending')
  fail = false
  await expect(publishDesktopRelease(f.plan, f.operations)).resolves.toEqual({ status: 'complete' })
  expect(f.writes).toHaveLength(3)
  expect(f.tags()).toBe(1)
})

it.each(['binary', 'same-version-feed', 'newer-feed'] as const)('stops on %s conflict', async (kind) => {
  const f = fixture()
  if (kind === 'binary') f.objects.set('bin/installer.exe', observed('different'))
  else f.objects.set('feed/nightly.yml', observed(kind === 'newer-feed' ? 'version: 2.0.0\n' : 'version: 1.0.0\nchanged: true\n'))
  await expect(publishDesktopRelease(f.plan, f.operations)).rejects.toMatchObject({ code: kind === 'newer-feed' ? 'superseded' : 'conflict' })
  expect(f.writes).toHaveLength(0)
})

it('rejects a files-only plan and a production build without clean commit evidence', async () => {
  const f = fixture('production')
  await expect(publishDesktopRelease({ ...f.plan, artifacts: f.plan.artifacts.slice(0, 2) }, f.operations)).rejects.toMatchObject({ code: 'invalid-plan' })
  await expect(publishDesktopRelease({ ...f.plan, dirty: true }, f.operations)).rejects.toMatchObject({ code: 'invalid-plan' })
  expect(f.writes).toHaveLength(0)
})

it('stops when a channel changes between preflight and writing', async () => {
  const f = fixture()
  const put = f.operations.transport.put.bind(f.operations.transport)
  f.operations.transport.put = async (...args) => {
    await put(...args)
    f.objects.set('feed/nightly.yml', observed('version: 3.0.0\n'))
  }
  await expect(publishDesktopRelease(f.plan, f.operations)).rejects.toMatchObject({ code: 'remote-changed' })
  expect(f.writes).not.toContain('feed/nightly.yml')
})

it('does not update the channel when readback cannot confirm a binary', async () => {
  const f = fixture()
  f.operations.transport.put = async () => {}
  await expect(publishDesktopRelease(f.plan, f.operations)).rejects.toMatchObject({ code: 'verification-failed' })
  expect(f.events.some(event => event.type === 'feeds-complete')).toBe(false)
})

it('classifies corrupted remote channel metadata separately from an invalid local plan', async () => {
  const f = fixture()
  f.objects.set('feed/nightly.yml', observed('version: invalid\n'))
  await expect(publishDesktopRelease(f.plan, f.operations)).rejects.toMatchObject({ code: 'verification-failed' })
  expect(f.writes).toEqual([])
})
