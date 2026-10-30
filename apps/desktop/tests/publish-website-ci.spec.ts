import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { teo } from 'tencentcloud-sdk-nodejs-teo'
import { publishWebsiteCi, websiteApproval } from '../scripts/publish-website-ci.ts'

vi.mock('node:timers/promises', () => ({ setTimeout: async () => {} }))
afterEach(() => vi.restoreAllMocks())

it('returns successfully with a visible warning and durable unknown state after two failed queries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'website-ci-'))
  try {
    const config = join(root, 'packaging')
    const records = join(root, 'upload-records', 'website-99-mac-arm64')
    await mkdir(join(config, 'publishing'), { recursive: true })
    await mkdir(join(root, 'releases', '12', '1'), { recursive: true })
    await mkdir(records, { recursive: true })
    const credentialsFile = join(root, 'credentials.json')
    await writeFile(credentialsFile, JSON.stringify({ secretId: 'fixture-id', secretKey: 'fixture-key' }))
    await writeFile(join(config, 'publishing', 'production.json'), JSON.stringify({
      bucket: 'production-123', origin: 'https://download.deepseek.com', credentialsFile,
      githubApp: { clientId: 'app', privateKeyFile: join(root, 'app.pem') },
    }))
    const route = { runId: '12', attempt: '1', commit: 'a'.repeat(40), sourceRef: 'master', channel: 'nightly',
      runnerName: 'mini', runnerLabel: 'dsh-mini', target: 'mac-arm64', preset: 'production' }
    const manifest = { schemaVersion: 1, source: { repository: 'owner/repo', runId: '12', attempt: '1', commit: route.commit,
      workflowCommit: route.commit, sourceRef: 'master', channel: 'nightly', runnerName: 'mini', target: 'mac-arm64',
      preset: 'production', productVersion: '1.0.0', version: '1.0.0', testReleaseId: null, qualification: 'notarized' },
    files: [{ name: 'installer.dmg', size: 1, sha512: createHash('sha512').update('x').digest('base64') }] }
    await writeFile(join(root, 'releases', '12', '1', 'manifest.json'), JSON.stringify(manifest))
    const approval = websiteApproval(manifest, 'production-123')
    await writeFile(join(records, 'state.json'), JSON.stringify({ approval, upload: 'uploaded' }))
    const submit = vi.spyOn(teo.v20220901.Client.prototype, 'CreatePurgeTask').mockResolvedValue({ JobId: 'job-1' })
    const query = vi.spyOn(teo.v20220901.Client.prototype, 'DescribePurgeTasks').mockRejectedValue(new Error('fixture-key'))
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-30T00:00:00.000Z'))
    const summary = join(root, 'summary.md')
    await publishWebsiteCi('purge', { RUNNER_NAME: 'mini', GITHUB_REPOSITORY: 'owner/repo', GITHUB_RUN_ID: '99',
      GITHUB_RUN_ATTEMPT: '1', DSH_PACKAGING_CONFIG_DIR: config, DESKTOP_PUBLISH_ROUTE: JSON.stringify(route),
      DESKTOP_WEBSITE_APPROVAL: approval, DOWNLOAD_PROD_EO_ZONE_ID: 'zone-fixture', GITHUB_STEP_SUMMARY: summary })
    expect(submit).toHaveBeenCalledOnce()
    expect(query).toHaveBeenCalledTimes(2)
    expect(output.mock.calls.map(call => String(call[0])).join('')).toContain('::warning title=官网缓存刷新结果未确认::')
    expect(JSON.parse(await readFile(join(records, 'state.json'), 'utf8'))).toMatchObject({ upload: 'uploaded', purge: { status: 'unknown' } })
    await expect(await readFile(summary, 'utf8')).toMatchFileSnapshot('./expected/website-purge-unknown.md')
    expect(await readFile(summary, 'utf8')).not.toContain('fixture-key')
  } finally { await rm(root, { recursive: true, force: true }) }
})
