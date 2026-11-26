import { load } from 'js-yaml'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { retainDesktopCi } from '../scripts/retain-desktop-ci.ts'
import { desktopPublicationSummary } from '../scripts/desktop-publication-summary.ts'
import { executeDesktopChannelPublications, prepareDesktopPublication } from '../scripts/publish-desktop-ci.ts'

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
      DSH_PACKAGING_CONFIG_DIR: configRoot, DSH_PACKAGING_PRESET: 'test', DSH_DESKTOP_UPDATE_CHANNEL: 'nightly',
      DESKTOP_PUBLISH_NIGHTLY: 'true',
      DESKTOP_PUBLISH_RUNNERS: JSON.stringify({ 'fixture-runner': { label: 'dsh-fixture', target: [target] } }),
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
    const preparedPlan = prepared.plan
    expect(preparedPlan).toBeDefined()
    if (preparedPlan === undefined) throw new Error('expected single-channel plan')
    expect(preparedPlan.version).toBe('1.0.0')
    expect(preparedPlan.artifacts.every(file => file.path.startsWith(retained))).toBe(true)
    expect(signatureChecks).toBe(1)
    const summary = await desktopPublicationSummary(prepared.manifest.source, prepared.plans, 'c'.repeat(64), false)
    await expect(summary).toMatchFileSnapshot(`./expected/publication-${target}.md`)
    const feed = preparedPlan.artifacts.find(file => file.channelMetadata)!
    expect(summary).toContain(createHash('sha256').update(feed.contents!).digest('hex'))
    expect(summary).toContain('https&#58;//github.com/owner/repo/actions/runs/10/attempts/2')
    expect(summary).not.toContain('example.com//')
    expect(summary).not.toContain(root)
    expect(summary).not.toContain('absent-credentials')
    for (const percentage of ['0', '10', '100']) {
      const staged = await prepareDesktopPublication({ ...env, DESKTOP_STAGING_PERCENTAGE: percentage }, signature)
      const stagedPlan = staged.plan!
      const stagedFeed = stagedPlan.artifacts.find(file => file.channelMetadata)!
      expect(load(stagedFeed.contents!)).toMatchObject({ stagingPercentage: Number(percentage) })
      expect(staged.approval).not.toBe(prepared.approval)
      expect(await desktopPublicationSummary(staged.manifest.source, staged.plans, staged.approval, false)).toContain(`${percentage}%`)
      await expect(prepareDesktopPublication({ ...env, DESKTOP_STAGING_PERCENTAGE: percentage,
        DESKTOP_APPROVED_PACKAGE: prepared.approval }, signature)).rejects.toThrow(/changed after approval/u)
    }
    for (const percentage of ['-1', '101', '1.5', 'NaN', 'Infinity', '1e1']) {
      await expect(prepareDesktopPublication({ ...env, DESKTOP_STAGING_PERCENTAGE: percentage }, signature))
        .rejects.toThrow(/integer from 0 to 100/u)
    }
    const blank = await prepareDesktopPublication({ ...env, DESKTOP_STAGING_PERCENTAGE: ' ' }, signature)
    expect(blank.approval).toBe(prepared.approval)
    await expect(prepareDesktopPublication({ ...env, DESKTOP_APPROVED_PACKAGE: 'wrong' }, signature)).rejects.toThrow(/changed after approval/u)
    await expect(prepareDesktopPublication({ ...env, RUNNER_NAME: 'other-machine' }, signature)).rejects.toThrow(/different machine/u)
    await writeFile(join(retained, `${base}.${extension}`), 'changed')
    await expect(prepareDesktopPublication(env, signature)).rejects.toThrow(/changed file/u)

  } finally { await rm(root, { recursive: true, force: true }) }
})

it('verifies signatures once when publishing a stable-marked build to both channels or website only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-dual-publish-'))
  try {
    const app = join(root, 'app')
    const configRoot = join(root, 'packaging')
    const artifacts = join(app, '.desktop-build/targets/mac-arm64/artifacts')
    await mkdir(artifacts, { recursive: true })
    await mkdir(join(configRoot, 'presets'), { recursive: true })
    await mkdir(join(configRoot, 'publishing'))
    await writeFile(join(app, 'package.json'), JSON.stringify({ version: '1.0.0' }))
    await writeFile(join(configRoot, 'presets/production.env'), 'DSH_DESKTOP_AUTO_UPDATE_ENV=production\n')
    await writeFile(join(configRoot, 'publishing/production.json'), JSON.stringify({
      edgeOneZoneId: 'zone-fixture', bucket: 'prod-1250000000', origin: 'https://download.deepseek.com',
      credentialsFile: join(root, 'absent-credentials.json'),
      githubApp: { clientId: 'app', privateKeyFile: join(root, 'absent-app.pem') },
    }))
    const commit = 'b'.repeat(40)
    const base = 'deepseek-harness-1.0.0-mac-arm64'
    const bytes = 'fixture zip bytes'
    await writeFile(join(artifacts, `${base}.zip`), bytes)
    await writeFile(join(artifacts, `${base}.zip.blockmap`), 'fixture blockmap')
    await writeFile(join(artifacts, `${base}.dmg`), 'fixture DMG')
    await writeFile(join(artifacts, 'mac-arm64-release.json'), JSON.stringify({
      schemaVersion: 1, channel: 'stable', target: 'mac-arm64', environment: 'production', version: '1.0.0', commit, dirty: false,
      publicUrl: 'https://download.deepseek.com/dsh-desk/feeds/mac-arm64/',
    }))
    await writeFile(join(artifacts, 'stable-mac.yml'), JSON.stringify({
      version: '1.0.0', files: [{ url: `${base}.zip`, size: Buffer.byteLength(bytes),
        sha512: createHash('sha512').update(bytes).digest('base64') }],
    }))
    const env = {
      DSH_PACKAGING_CONFIG_DIR: configRoot, DSH_PACKAGING_PRESET: 'production',
      DESKTOP_PUBLISH_RUNNERS: JSON.stringify({ 'fixture-runner': { label: 'dsh-fixture', target: ['mac-arm64'] } }),
      DSH_DESKTOP_TARGET_PLATFORM: 'darwin', DSH_DESKTOP_TARGET_ARCH: 'arm64',
      PACKAGE_SOURCE_REF: 'master', PACKAGE_SOURCE_SHA: commit, PACKAGE_VERSION: '1.0.0', PACKAGE_SKIP_NOTARIZATION: 'false',
      GITHUB_RUN_ID: '11', GITHUB_RUN_ATTEMPT: '1', GITHUB_REPOSITORY: 'owner/repo', GITHUB_SHA: commit, RUNNER_NAME: 'fixture-runner',
      DESKTOP_PUBLISH_ROUTE: JSON.stringify({ sourceRef: 'master', channel: 'stable', runId: '11', attempt: '1', commit, runnerName: 'fixture-runner', target: 'mac-arm64', preset: 'production' }),
    }
    await retainDesktopCi(env, app)
    await rm(app, { recursive: true })
    let signatureChecks = 0
    const dual = await prepareDesktopPublication({
      ...env, DESKTOP_PUBLISH_STABLE: 'true', DESKTOP_PUBLISH_NIGHTLY: 'true', DESKTOP_STAGING_PERCENTAGE: '20',
    }, async () => { signatureChecks++ })
    expect(signatureChecks).toBe(1)
    expect(dual.channels).toEqual(['stable', 'nightly'])
    expect(dual.plans.map(entry => entry.plan.artifacts.find(file => file.channelMetadata)!.filename))
      .toEqual(['stable-mac.yml', 'nightly-mac.yml'])
    const dualSummary = await desktopPublicationSummary(
      dual.manifest.source, dual.plans, dual.approval, true, dual.config.bucket,
    )
    expect(dualSummary).toContain('<code>stable</code>、<code>nightly</code>')
    expect(dualSummary).toContain('更新灰度比例（stable）')
    expect(dualSummary).toContain('更新灰度比例（nightly）')

    const websiteOnly = await prepareDesktopPublication({
      ...env, DESKTOP_PUBLISH_STABLE: 'false', DESKTOP_PUBLISH_NIGHTLY: 'false', DESKTOP_UPLOAD_WEBSITE: 'true',
    }, async () => { signatureChecks++ })
    expect(signatureChecks).toBe(2)
    expect(websiteOnly.plans).toEqual([])
    await expect(prepareDesktopPublication({
      ...env, DESKTOP_PUBLISH_STABLE: 'false', DESKTOP_PUBLISH_NIGHTLY: 'false', DESKTOP_UPLOAD_WEBSITE: 'false',
    }, async () => {})).rejects.toThrow('select publish_stable, publish_nightly, or upload_website')
    await expect(prepareDesktopPublication(env, async () => {}))
      .rejects.toThrow('select publish_stable, publish_nightly, or upload_website')

    // Dual-channel publish creates desktop-v<version> as soon as stable finishes even if nightly is superseded.
    const objects = new Map<string, { contents: string; size: number; sha512: string }>([
      ['dsh-desk/feeds/mac-arm64/nightly-mac.yml', {
        contents: 'version: 2.0.0\n',
        size: Buffer.byteLength('version: 2.0.0\n'),
        sha512: createHash('sha512').update('version: 2.0.0\n').digest('base64'),
      }],
    ])
    const tagCalls: string[] = []
    const publishOutput = join(root, 'publish-output')
    let outputDuringUpload = ''
    await expect(executeDesktopChannelPublications(dual, {
      ...env, DESKTOP_TAG_TOKEN: 'fixture-app-token', GITHUB_OUTPUT: publishOutput,
    }, {
      createTransport: () => ({
        async read(key) {
          outputDuringUpload = await readFile(publishOutput, 'utf8')
          return objects.get(key) ?? null
        },
        async put(artifact, digest) {
          const text = artifact.contents ?? 'uploaded'
          objects.set(artifact.key, { contents: text, ...digest })
        },
      }),
      createTag: async (repository, version, recordedCommit, token) => {
        tagCalls.push(`${repository}@${version}#${recordedCommit}:${token}`)
        return tagCalls.length === 1 ? 'created' : 'present'
      },
    })).rejects.toThrow(/newer version/u)
    expect(outputDuringUpload).toContain('record=')
    expect((await readFile(publishOutput, 'utf8')).match(/^record=/gmu)).toHaveLength(2)
    expect(tagCalls).toEqual([`owner/repo@1.0.0#${commit}:fixture-app-token`])
    expect(objects.get('dsh-desk/feeds/mac-arm64/stable-mac.yml')?.contents).toContain('version: 1.0.0')
  } finally { await rm(root, { recursive: true, force: true }) }
})
