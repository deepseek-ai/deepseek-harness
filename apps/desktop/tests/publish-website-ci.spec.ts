import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import * as desktopCos from '../scripts/desktop-cos.ts'
import { answer, cosError, startCosLoopback } from './cos-loopback.ts'
import { teo } from 'tencentcloud-sdk-nodejs-teo'
import { publishWebsiteCi, websiteApproval } from '../scripts/publish-website-ci.ts'

vi.mock('node:timers/promises', () => ({ setTimeout: async () => {} }))
afterEach(() => vi.restoreAllMocks())

it.each(['accepted', 'unconfirmed', 'upload', 'put', 'uploaded', 'stable', 'approval'] as const)('preserves publication recovery for %s', async (scenario) => {
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
    const route = { runId: '12', attempt: '1', commit: 'a'.repeat(40), sourceRef: 'master', channel: scenario === 'stable' ? 'stable' : 'nightly',
      runnerName: 'mini', runnerLabel: 'dsh-mini', target: 'mac-arm64', preset: 'production' }
    const manifest = { schemaVersion: 1, source: { repository: 'owner/repo', runId: '12', attempt: '1', commit: route.commit,
      workflowCommit: route.commit, sourceRef: 'master', channel: route.channel, runnerName: 'mini', target: 'mac-arm64',
      preset: 'production', productVersion: '1.0.0', version: '1.0.0', testReleaseId: null, qualification: 'notarized' },
    files: [{ name: 'deepseek-harness-1.0.0-mac-arm64.dmg', size: 1, sha512: createHash('sha512').update('x').digest('base64') }] }
    await writeFile(join(root, 'releases', '12', '1', 'manifest.json'), JSON.stringify(manifest))
    const approval = websiteApproval(manifest, 'production-123')
    await writeFile(join(records, 'state.json'), JSON.stringify({ approval, upload: 'uploaded' }))
    const env = { RUNNER_NAME: 'mini', GITHUB_REPOSITORY: 'owner/repo', GITHUB_RUN_ID: '99',
      GITHUB_RUN_ATTEMPT: '1', DSH_PACKAGING_CONFIG_DIR: config, DESKTOP_PUBLISH_ROUTE: JSON.stringify(route),
      DESKTOP_WEBSITE_APPROVAL: approval, DOWNLOAD_PROD_EO_ZONE_ID: 'zone-fixture', GITHUB_OUTPUT: join(root, 'output') }
    if (scenario === 'upload' || scenario === 'put' || scenario === 'uploaded' || scenario === 'stable' || scenario === 'approval') {
      await writeFile(join(root, 'releases', '12', '1', manifest.files[0]!.name), 'x')
      if (scenario === 'upload' || scenario === 'put') await rm(join(records, 'state.json'))
      let stored = scenario !== 'put'
      const server = await startCosLoopback((request, response) => {
        if (request.method === 'PUT') {
          expect(request.body.toString()).toBe('x')
          stored = true
          answer(response)
          return
        }
        if (!stored) answer(response, 404, cosError('NoSuchKey'))
        else answer(response, 200, 'x')
      })
      const original = desktopCos.createDesktopCos
      vi.spyOn(desktopCos, 'createDesktopCos').mockImplementation((credentials) => {
        const client = original(credentials)
        server.redirect(client)
        return client
      })
      try {
        if (scenario === 'approval') {
          await expect(publishWebsiteCi('upload', { ...env, DESKTOP_WEBSITE_APPROVAL: 'changed' })).rejects.toThrow('approved build or destination changed')
          expect(server.requests).toHaveLength(0)
        } else {
          const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
          await publishWebsiteCi('upload', env)
          expect(output.mock.calls.map(call => String(call[0])).join('')).toContain(scenario === 'upload'
            ? 'identical remote bytes confirmed; skipped' : scenario === 'put' ? 'Website installer uploaded:' : 'previous upload confirmed by journal; skipped')
          if (scenario === 'upload') expect(server.requests[0]!.path).toBe('/desktop/dsh-latest-macos-arm64.dmg')
          expect(server.requests.map(request => request.method)).toEqual(scenario === 'upload' ? ['GET'] : scenario === 'put' ? ['GET', 'PUT', 'GET'] : [])
          expect(JSON.parse(await readFile(join(records, 'state.json'), 'utf8'))).toMatchObject({ approval, upload: 'uploaded' })
          expect(await readFile(env.GITHUB_OUTPUT, 'utf8')).toContain(`record=${records}`)
        }
      } finally { await server.close() }
      return
    }
    const submit = vi.spyOn(teo.v20220901.Client.prototype, 'CreatePurgeTask').mockResolvedValue({ JobId: 'job-1' })
    const query = vi.spyOn(teo.v20220901.Client.prototype, 'DescribePurgeTasks').mockRejectedValue(new Error('fixture-key'))
    if (scenario === 'unconfirmed') submit.mockRejectedValue(new Error('lost response'))
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
    await expect(await readFile(summary, 'utf8')).toMatchFileSnapshot(`./expected/website-purge-${scenario}.md`)
    expect(await readFile(summary, 'utf8')).not.toContain('fixture-key')
  } finally { await rm(root, { recursive: true, force: true }) }
})
