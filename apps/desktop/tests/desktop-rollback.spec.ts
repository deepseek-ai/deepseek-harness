import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { rollbackDesktopChannel } from '../scripts/desktop-rollback.ts'
import { prepareDesktopPublication } from '../scripts/publish-desktop-ci.ts'
import { retainDesktopCi } from '../scripts/retain-desktop-ci.ts'
import type { DesktopPublishOperations } from '@deepseek-ai/dsh-desktop-publisher/desktop-publish.ts'
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

it('restores nightly when stable already matches and resumes a partially restored pair', async () => {
  for (const stableAlreadyMatches of [true, false]) {
    const f = fixture()
    const nightly = f.plan.artifacts[1]!
    const plan = { ...f.plan, artifacts: [...f.plan.artifacts, { ...nightly, key: 'feed/stable.yml', filename: 'stable.yml' }] }
    f.objects.set('feed/stable.yml', stableAlreadyMatches ? nightly.contents! : 'version: 2.0.0\n')
    if (!stableAlreadyMatches) {
      const put = f.operations.transport.put.bind(f.operations.transport)
      const interrupted = { ...f.operations, transport: { ...f.operations.transport,
        async put(...args: Parameters<typeof put>) {
          if (args[0].key === 'feed/stable.yml') throw new Error('fixture interruption')
          return put(...args)
        },
      } }
      await expect(rollbackDesktopChannel(plan, '2.0.0', true, interrupted)).rejects.toThrow('fixture interruption')
    }
    await expect(rollbackDesktopChannel(plan, '2.0.0', true, f.operations)).resolves.toMatchObject({ status: 'complete' })
    expect(f.objects.get('feed/nightly.yml')).toBe(nightly.contents)
    expect(f.objects.get('feed/stable.yml')).toBe(nightly.contents)
    expect(f.writes.filter(key => key === 'feed/nightly.yml')).toHaveLength(1)
  }
})

it('reconstructs a nightly rollback plan from a stable-marked retained package', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-cross-rollback-'))
  try {
    const app = join(root, 'app')
    const configRoot = join(root, 'packaging')
    const artifacts = join(app, '.desktop-build/targets/win-x64/artifacts')
    await mkdir(artifacts, { recursive: true })
    await mkdir(join(configRoot, 'presets'), { recursive: true })
    await mkdir(join(configRoot, 'publishing'))
    await writeFile(join(app, 'package.json'), JSON.stringify({ version: '1.0.0' }))
    await writeFile(join(configRoot, 'presets/production.env'), 'DSH_DESKTOP_AUTO_UPDATE_ENV=production\n')
    await writeFile(join(configRoot, 'publishing/production.json'), JSON.stringify({
      bucket: 'prod-1250000000', origin: 'https://download.deepseek.com', credentialsFile: join(root, 'absent.json'),
      githubApp: { clientId: 'app', privateKeyFile: join(root, 'absent-app.pem') },
    }))
    const commit = 'b'.repeat(40)
    const base = 'deepseek-harness-1.0.0-win-x64'
    const exeBytes = 'signed exe bytes'
    await writeFile(join(artifacts, `${base}.exe`), exeBytes)
    await writeFile(join(artifacts, `${base}.exe.blockmap`), 'blockmap')
    await writeFile(join(artifacts, 'win-x64-release.json'), JSON.stringify({
      schemaVersion: 1, channel: 'stable', target: 'win-x64', environment: 'production', version: '1.0.0', commit, dirty: false,
      publicUrl: 'https://download.deepseek.com/dsh-desk/feeds/win-x64/',
    }))
    await writeFile(join(artifacts, 'stable.yml'), JSON.stringify({
      version: '1.0.0', files: [{ url: `${base}.exe`, size: Buffer.byteLength(exeBytes),
        sha512: createHash('sha512').update(exeBytes).digest('base64') }],
    }))
    const env = {
      DSH_PACKAGING_CONFIG_DIR: configRoot, DSH_PACKAGING_PRESET: 'production',
      DESKTOP_PUBLISH_RUNNERS: JSON.stringify({ 'fixture-runner': { label: 'dsh-fixture', target: ['win-x64'] } }),
      DSH_DESKTOP_TARGET_PLATFORM: 'win32', DSH_DESKTOP_TARGET_ARCH: 'x64',
      PACKAGE_SOURCE_REF: 'master', PACKAGE_SOURCE_SHA: commit, PACKAGE_VERSION: '1.0.0', PACKAGE_SIGNING: 'signed',
      GITHUB_RUN_ID: '15', GITHUB_RUN_ATTEMPT: '1', GITHUB_REPOSITORY: 'owner/repo', GITHUB_SHA: commit, RUNNER_NAME: 'fixture-runner',
      DESKTOP_PUBLISH_ROUTE: JSON.stringify({ sourceRef: 'master', channel: 'nightly', runId: '15', attempt: '1', commit, runnerName: 'fixture-runner', target: 'win-x64', preset: 'production' }),
    }
    await retainDesktopCi(env, app)
    await rm(app, { recursive: true })
    const prepared = await prepareDesktopPublication(env, async () => {}, { rollbackChannel: 'nightly' })
    const rollbackPlan = prepared.plan!
    expect(prepared.manifest.source.channel).toBe('stable')
    expect(`${rollbackPlan.bucket}/${rollbackPlan.publicUrl}nightly`)
      .toBe('prod-1250000000/https://download.deepseek.com/dsh-desk/feeds/win-x64/nightly')
    expect(rollbackPlan.artifacts.map(file => file.key)).toEqual([
      'dsh-desk/bin/win-x64/deepseek-harness-1.0.0-win-x64.exe',
      'dsh-desk/bin/win-x64/deepseek-harness-1.0.0-win-x64.exe.blockmap',
      'dsh-desk/feeds/win-x64/nightly.yml',
    ])
  } finally { await rm(root, { recursive: true, force: true }) }
})
