import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { rollbackDesktopChannel } from '../scripts/desktop-rollback.ts'
import type { DesktopPublishOperations } from '../scripts/desktop-publish.ts'
import type { DesktopUploadPlan } from '../scripts/desktop-upload-plan.ts'

function fixture() {
  const objects = new Map([['bin/old.exe', 'old installer'], ['feed/nightly.yml', 'version: 2.0.0\n']])
  const writes: string[] = []
  const plan: DesktopUploadPlan = {
    environment: 'test', target: 'win-x64', version: '1.0.0', bucket: 'fixture', publicUrl: 'https://example.com', secretIdEnvName: 'ID', secretKeyEnvName: 'KEY',
    artifacts: [
      { key: 'bin/old.exe', path: '', filename: 'old.exe', contentType: 'application/octet-stream', channelMetadata: false, contents: 'old installer' },
      { key: 'feed/nightly.yml', path: '', filename: 'nightly.yml', contentType: 'application/yaml', channelMetadata: true, contents: 'version: 1.0.0\n' },
    ],
  }
  const operations: DesktopPublishOperations = {
    transport: {
      async read(key) {
        const contents = objects.get(key)
        return contents === undefined ? null : { contents, size: Buffer.byteLength(contents), sha512: createHash('sha512').update(contents).digest('base64') }
      },
      async put(artifact, _digest, forbidOverwrite) {
        expect(forbidOverwrite).toBe(false)
        writes.push(artifact.key)
        objects.set(artifact.key, artifact.contents!)
      },
    },
    async record() {},
    async tag() { throw new Error('must not create a tag') },
  }
  return { plan, operations, writes, objects }
}

it('previews the exact YAML change without writes', async () => {
  const f = fixture()
  const result = await rollbackDesktopChannel(f.plan, '2.0.0', false, f.operations)
  expect(result).toMatchObject({ status: 'preview', feeds: [{ before: 'version: 2.0.0\n', after: 'version: 1.0.0\n' }] })
  expect(f.writes).toEqual([])
})

it('only restores the YAML after checking the historical binary', async () => {
  const f = fixture()
  await expect(rollbackDesktopChannel(f.plan, '2.0.0', true, f.operations)).resolves.toMatchObject({ status: 'complete' })
  expect(f.writes).toEqual(['feed/nightly.yml'])
  expect(f.objects.get('bin/old.exe')).toBe('old installer')
})

it.each(['missing-file', 'changed-file', 'changed-channel'] as const)('rejects %s without writes', async (problem) => {
  const f = fixture()
  if (problem === 'missing-file') f.objects.delete('bin/old.exe')
  if (problem === 'changed-file') f.objects.set('bin/old.exe', 'changed')
  if (problem === 'changed-channel') f.objects.set('feed/nightly.yml', 'version: 3.0.0\n')
  await expect(rollbackDesktopChannel(f.plan, '2.0.0', true, f.operations)).rejects.toThrow()
  expect(f.writes).toEqual([])
})

it('restores nightly when latest already matches and resumes a partially restored pair', async () => {
  for (const latestAlreadyMatches of [true, false]) {
    const f = fixture()
    const nightly = f.plan.artifacts[1]!
    const plan = { ...f.plan, artifacts: [...f.plan.artifacts, { ...nightly, key: 'feed/latest.yml', filename: 'latest.yml' }] }
    f.objects.set('feed/latest.yml', latestAlreadyMatches ? nightly.contents! : 'version: 2.0.0\n')
    if (!latestAlreadyMatches) {
      const put = f.operations.transport.put.bind(f.operations.transport)
      const interrupted = { ...f.operations, transport: { ...f.operations.transport,
        async put(...args: Parameters<typeof put>) {
          if (args[0].key === 'feed/latest.yml') throw new Error('fixture interruption')
          return put(...args)
        },
      } }
      await expect(rollbackDesktopChannel(plan, '2.0.0', true, interrupted)).rejects.toThrow('fixture interruption')
    }
    await expect(rollbackDesktopChannel(plan, '2.0.0', true, f.operations)).resolves.toMatchObject({ status: 'complete' })
    expect(f.objects.get('feed/nightly.yml')).toBe(nightly.contents)
    expect(f.objects.get('feed/latest.yml')).toBe(nightly.contents)
    expect(f.writes.filter(key => key === 'feed/nightly.yml')).toHaveLength(1)
  }
})
