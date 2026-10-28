import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { retainDesktopCi } from '../scripts/retain-desktop-ci.ts'
import { desktopPublicationSummary } from '../scripts/desktop-publication-summary.ts'
import { prepareDesktopPublication } from '../scripts/publish-desktop-ci.ts'

it.each(['mac-arm64', 'win-x64'] as const)('preflights a complete retained %s build without credentials or source checkout manifests', async (target) => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-preflight-'))
  try {
    const app = join(root, 'app')
    const configRoot = join(root, 'packaging')
    const artifacts = join(app, '.desktop-build/targets', target, 'artifacts')
    await mkdir(artifacts, { recursive: true })
    await mkdir(join(configRoot, 'presets'), { recursive: true })
    await mkdir(join(configRoot, 'publishing'))
    await writeFile(join(app, 'package.json'), JSON.stringify({ version: '1.0.0' }))
    const releaseId = 'a'.repeat(32)
    await writeFile(join(configRoot, 'presets/test.env'), `DSH_DESKTOP_AUTO_UPDATE_ENV=test\nDOWNLOAD_TEST_RELEASE_ID=${releaseId}\n`)
    await writeFile(join(configRoot, 'publishing/test.json'), JSON.stringify({
      bucket: 'fixture-1250000000', origin: 'https://EXAMPLE.com:443/', credentialsFile: join(root, 'absent-credentials.json'),
    }))
    const commit = 'b'.repeat(40)
    const base = `deepseek-harness-1.0.0-${target}`
    const extension = target === 'win-x64' ? 'exe' : 'zip'
    const bytes = 'fixture installer bytes'
    await writeFile(join(artifacts, `${base}.${extension}`), bytes)
    await writeFile(join(artifacts, `${base}.${extension}.blockmap`), 'fixture blockmap')
    if (target !== 'win-x64') await writeFile(join(artifacts, `${base}.dmg`), 'fixture DMG')
    await writeFile(join(artifacts, `${target}-release.json`), JSON.stringify({
      schemaVersion: 1, target, environment: 'test', version: '1.0.0', commit, dirty: false,
      publicUrl: `https://example.com/dsh-desk/${releaseId}/feeds/${target}/`,
    }))
    await writeFile(join(artifacts, target === 'win-x64' ? 'nightly.yml' : 'nightly-mac.yml'), JSON.stringify({
      version: '1.0.0', files: [{ url: `${base}.${extension}`, size: Buffer.byteLength(bytes),
        sha512: createHash('sha512').update(bytes).digest('base64') }],
    }))
    const env = {
      DSH_PACKAGING_CONFIG_DIR: configRoot, DSH_PACKAGING_PRESET: 'test',
      DSH_DESKTOP_TARGET_PLATFORM: target === 'win-x64' ? 'win32' : 'darwin', DSH_DESKTOP_TARGET_ARCH: target === 'win-x64' ? 'x64' : 'arm64',
      PACKAGE_SOURCE_REF: 'master', PACKAGE_SOURCE_SHA: 'b'.repeat(40), PACKAGE_VERSION: '1.0.0', PACKAGE_SIGNING: 'signed', PACKAGE_SKIP_NOTARIZATION: 'false',
      GITHUB_RUN_ID: '10', GITHUB_RUN_ATTEMPT: '2', GITHUB_REPOSITORY: 'owner/repo', GITHUB_SHA: commit, RUNNER_NAME: 'fixture-runner',
      DESKTOP_PUBLISH_ROUTE: JSON.stringify({ sourceRef: 'master', channel: 'nightly', runId: '10', attempt: '2', commit, runnerName: 'fixture-runner', target, preset: 'test' }),
    }
    const retained = await retainDesktopCi(env, app)
    await rm(app, { recursive: true })
    let signatureChecks = 0
    const signature = async () => { signatureChecks++ }
    const prepared = await prepareDesktopPublication(env, signature)
    expect(prepared.plan.version).toBe('1.0.0')
    expect(prepared.plan.artifacts.every(file => file.path.startsWith(retained))).toBe(true)
    expect(signatureChecks).toBe(1)
    const summary = await desktopPublicationSummary(prepared.manifest.source, prepared.plan, 'c'.repeat(64))
    await expect(summary).toMatchFileSnapshot(`./expected/publication-${target}.md`)
    const feed = prepared.plan.artifacts.find(file => file.channelMetadata)!
    expect(summary).toContain(createHash('sha256').update(feed.contents!).digest('hex'))
    expect(summary).toContain('https&#58;//github.com/owner/repo/actions/runs/10/attempts/2')
    expect(summary).not.toContain('example.com//')
    expect(summary).not.toContain(root)
    expect(summary).not.toContain('absent-credentials')
    await expect(prepareDesktopPublication({ ...env, DESKTOP_APPROVED_PACKAGE: 'wrong' }, signature)).rejects.toThrow(/changed after approval/u)
    await expect(prepareDesktopPublication({ ...env, RUNNER_NAME: 'other-machine' }, signature)).rejects.toThrow(/different machine/u)
    await writeFile(join(retained, `${base}.${extension}`), 'changed')
    await expect(prepareDesktopPublication(env, signature)).rejects.toThrow(/changed file/u)
    expect(signatureChecks).toBe(2)
  } finally { await rm(root, { recursive: true, force: true }) }
})
