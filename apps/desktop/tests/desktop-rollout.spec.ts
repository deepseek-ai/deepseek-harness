import { execFile, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { teo } from 'tencentcloud-sdk-nodejs-teo'
import { createDesktopUploadPlan } from '../scripts/desktop-upload-plan.ts'
import { desktopBuildRecordFilename, desktopWebsiteInstallerUrl } from '../scripts/desktop-auto-update-environment.mjs'
import { dump, load } from 'js-yaml'
import { expect, it, vi } from 'vitest'
import { prepareDesktopRollout, rolloutDesktopRelease } from '../scripts/desktop-rollout.ts'
import * as cosTransport from '../scripts/desktop-publish-cos.ts'
import * as websitePublisher from '../scripts/publish-website-ci.ts'
import { prepareDesktopRolloutCi, publishDesktopRolloutCi } from '../scripts/publish-desktop-rollout-ci.ts'
import { createDesktopPublicationRecord } from '../scripts/desktop-publish-record.ts'
import { readRetainedDesktopManifest, type DesktopRetainedManifest } from '../scripts/desktop-release-store.ts'
import { resolveRetainedDesktopPublication } from '../scripts/resolve-retained-desktop-publish-ci.ts'
import type { DesktopPublishEvent, DesktopRemoteObject, DesktopPublishTransport } from '../scripts/desktop-publish.ts'

const digest = (contents: string) => ({
  size: Buffer.byteLength(contents), sha512: createHash('sha512').update(contents).digest('base64'),
})

async function fixture(target: 'mac-arm64' | 'mac-x64' | 'win-x64' = 'mac-arm64',
  preset: 'production' | 'test' = 'production', channel: 'nightly' | 'stable' = 'nightly') {
  const root = await mkdtemp(join(tmpdir(), 'desktop-rollout-'))
  try {
    const directory = join(root, 'releases', '42', '1')
    await mkdir(directory, { recursive: true })
    const version = '0.2.2-rc.1'
    const payload = `deepseek-harness-${version}-${target}.${target === 'win-x64' ? 'exe' : 'zip'}`
    const contents = dump({ version, files: [{ url: payload, ...digest('installer') }],
      path: payload, sha512: digest('installer').sha512, releaseDate: '2026-11-04T00:00:00.000Z' })
    const filename = `${channel}${target === 'win-x64' ? '' : '-mac'}.yml`
    const manifest: DesktopRetainedManifest = { schemaVersion: 1, source: {
      repository: 'owner/repo', runId: '42', attempt: '1', commit: 'a'.repeat(40), workflowCommit: 'b'.repeat(40),
      sourceRef: 'dsh-v0.2.2-rc.1', runnerName: 'runner', target, preset, channel,
      productVersion: version, version, testReleaseId: preset === 'test' ? 'a'.repeat(32) : null, qualification: target === 'win-x64' ? 'signed' : 'notarized',
    }, files: [{ name: filename, ...digest(contents) }, { name: payload, ...digest('installer') }] }
    await writeFile(join(directory, filename), contents)
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest))
    const environment = { DSH_DESKTOP_AUTO_UPDATE_ENV: preset, DOWNLOAD_PROD_COS_BUCKET: 'bucket-123',
      DOWNLOAD_TEST_ORIGIN: 'https://test.example.com', DOWNLOAD_TEST_COS_BUCKET: 'test-123', DOWNLOAD_TEST_RELEASE_ID: 'a'.repeat(32) }
    const plan = await prepareDesktopRollout(directory, manifest, environment)
    return { root, directory, manifest, plan, filename, environment }
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error }
}

function transport(contents: string) {
  let remote: DesktopRemoteObject | null = { contents, ...digest(contents) }
  const reads: string[] = []
  const writes: string[] = []
  const events: DesktopPublishEvent[] = []
  const api: DesktopPublishTransport = {
    async read(key, channel) { expect(channel).toBe(true); reads.push(key); return remote },
    async put(artifact, expected, forbidden) {
      expect(forbidden).toBe(false)
      expect(artifact.channelMetadata).toBe(true)
      expect(digest(artifact.contents!)).toEqual(expected)
      writes.push(artifact.contents!)
      remote = { contents: artifact.contents!, ...expected }
    },
  }
  return { api, reads, writes, events, record: async (event: DesktopPublishEvent) => { events.push(event) },
    replace(value: DesktopRemoteObject | null) { remote = value },
  }
}

it.each([
  ['mac-arm64', 'production', 'nightly'], ['win-x64', 'production', 'nightly'],
  ['mac-x64', 'production', 'stable'], ['mac-arm64', 'test', 'nightly'], ['win-x64', 'test', 'stable'],
] as const)('promotes %s %s %s from 10 to 30 to 100 without installer files or binary requests', async (target, preset, channel) => {
  const f = await fixture(target, preset, channel)
  try {
    const original = load(f.plan.expected) as Record<string, unknown>
    const mock = transport(dump({ ...original, stagingPercentage: 10 }))
    const operations = { transport: mock.api, record: mock.record }
    expect(await rolloutDesktopRelease(f.plan, 30, operations)).toEqual({ before: 10, after: 30 })
    expect(await rolloutDesktopRelease(f.plan, 100, operations)).toEqual({ before: 30, after: 100 })
    expect(await rolloutDesktopRelease(f.plan, 100, operations)).toEqual({ before: 100, after: 100 })
    expect(await rolloutDesktopRelease(f.plan, undefined, operations)).toEqual({ before: 100, after: 100 })
    expect(mock.writes).toHaveLength(2)
    expect(new Set(mock.reads)).toEqual(new Set([f.plan.upload.artifacts[0]!.key]))
    for (const [index, value] of mock.writes.entries()) {
      expect(load(value)).toEqual({ ...original, stagingPercentage: index === 0 ? 30 : 100 })
    }
    expect(mock.events.filter(event => event.type === 'put-intent')).toHaveLength(2)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

it.each(['missing', 'version', 'url', 'hash', 'size', 'policy', 'percentage', 'decrease', 'race', 'unconfirmed'] as const)(
  'rejects %s without blindly retrying a write', async (scenario) => {
    const f = await fixture()
    try {
      const metadata = load(f.plan.expected) as {
        version: string
        files: Array<{ url: string; sha512: string; size: number }>
        stagingPercentage?: number
        [key: string]: unknown
      }
      metadata.stagingPercentage = 10
      if (scenario === 'version') metadata.version = '9.0.0'
      if (scenario === 'url') metadata.files[0]!.url = 'https://example.com/other.zip'
      if (scenario === 'hash') metadata.files[0]!.sha512 = digest('different').sha512
      if (scenario === 'size') metadata.files[0]!.size++
      if (scenario === 'policy') metadata.minimumVersion = '9.0.0'
      if (scenario === 'percentage') metadata.stagingPercentage = 101
      const mock = transport(dump(metadata))
      if (scenario === 'missing') mock.replace(null)
      let reads = 0
      const api = { ...mock.api, async read(key: string, channel: boolean) {
        reads++
        if (scenario === 'race' && reads === 2) mock.replace(null)
        if (scenario === 'unconfirmed' && reads === 3) mock.replace(null)
        return mock.api.read(key, channel)
      } }
      await expect(rolloutDesktopRelease(f.plan, scenario === 'decrease' ? 5 : 30,
        { transport: api, record: mock.record })).rejects.toThrow()
      expect(mock.writes).toHaveLength(scenario === 'unconfirmed' ? 1 : 0)
    } finally { await rm(f.root, { recursive: true, force: true }) }
  })

it('rejects changed retained YAML before reading remote metadata', async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.directory, f.filename), 'version: 9.0.0')
    await expect(prepareDesktopRollout(f.directory, f.manifest, f.environment)).rejects.toThrow(/differs from manifest/u)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

it('requires initial publication evidence and prepares approval without installer or credential files', async () => {
  const f = await fixture()
  try {
    const config = join(f.root, 'config')
    await mkdir(join(config, 'publishing'), { recursive: true })
    await writeFile(join(config, 'publishing/production.json'), JSON.stringify({
      bucket: 'bucket-123', origin: 'https://download.deepseek.com', credentialsFile: join(f.root, 'absent-secret'),
      githubApp: { clientId: 'app', privateKeyFile: join(f.root, 'absent-key') },
    }))
    const route = { ...f.manifest.source, runnerLabel: 'dsh-runner' }
    const env = { RUNNER_NAME: 'runner', GITHUB_REPOSITORY: 'owner/repo', DSH_PACKAGING_CONFIG_DIR: config,
      DESKTOP_PUBLISH_ROUTE: JSON.stringify(route), DESKTOP_ROLLOUT_PERCENTAGE: '30', DESKTOP_UPLOAD_WEBSITE: 'false' }
    await expect(prepareDesktopRolloutCi(env)).rejects.toThrow(/initial COS/u)
    const record = await createDesktopPublicationRecord(join(f.root, 'upload-records'), {
      repository: 'owner/repo', runId: '42', attempt: '1',
      destination: `bucket-123/${f.plan.upload.publicUrl}nightly`, actor: 'operator',
      operation: 'publish', reason: 'fixture', stagingPercentage: 10,
    })
    await record.record({ type: 'feeds-complete' })
    const context = await prepareDesktopRolloutCi(env)
    expect(context.target).toBe(30)
    expect((await prepareDesktopRolloutCi({ ...env, DESKTOP_ROLLOUT_PERCENTAGE: '100' })).approval).not.toBe(context.approval)
    await expect(prepareDesktopRolloutCi({ ...env, DESKTOP_ROLLOUT_PERCENTAGE: '' })).rejects.toThrow(/select a percentage/u)
    await expect(prepareDesktopRolloutCi({ ...env, DESKTOP_ROLLOUT_PERCENTAGE: 'NaN' })).rejects.toThrow(/integer/u)
    await expect(prepareDesktopRolloutCi({ ...env, RUNNER_NAME: 'other' })).rejects.toThrow(/original machine/u)
    await expect(prepareDesktopRolloutCi({ ...env, DESKTOP_UPLOAD_WEBSITE: 'true' })).rejects.toThrow(/production and/u)
    expect((await prepareDesktopRolloutCi({ ...env, DESKTOP_ROLLOUT_PERCENTAGE: '',
      DESKTOP_UPLOAD_WEBSITE: 'true', DOWNLOAD_PROD_EO_ZONE_ID: 'zone-example' })).website).toBe(true)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

it('keeps rollout approval and website recovery separate without tag creation or full package verification', async () => {
  const text = await readFile('.github/workflows/desktop-rollout.yml', 'utf8')
  const workflow = load(text) as {
    name: string
    on: { workflow_dispatch: { inputs: Record<string, { required?: boolean; default?: unknown }> } }
    jobs: Record<string, { environment?: unknown; env?: Record<string, string>; needs?: string[] }>
  }
  expect(workflow.name).toBe('Publish Desktop · Rollout & Website')
  expect(workflow.on.workflow_dispatch.inputs.package_run_attempt!.required).toBe(true)
  expect(workflow.on.workflow_dispatch.inputs.upload_website!.default).toBe(false)
  expect(workflow.on.workflow_dispatch.inputs.rollout_percentage!.default).toBe('')
  expect(workflow.jobs.publish!.environment).toContain('desktop-production')
  expect(workflow.jobs['upload-website-installer']!.needs).toContain('publish')
  expect(workflow.jobs['purge-website-installer']!.needs).toContain('upload-website-installer')
  expect(text).not.toMatch(/create-github-app-token|publish-desktop-ci.ts|resolve-retained-desktop-publish-ci.ts/u)
  expect(text).toContain('publish-desktop-rollout-ci.ts route')
  expect(workflow.jobs.publish!.env!.DESKTOP_UPLOAD_WEBSITE).toBe('${{ inputs.upload_website }}')
  expect(text).toContain('steps.website.outputs.rollout-record')
})

it.each(['apply', 'changed-approval', 'replaced-feed', 'website'] as const)('checks approval, current feed and audit at the %s entrypoint', async (scenario) => {
  const f = await fixture()
  try {
    const config = join(f.root, 'config')
    const credentialsFile = join(f.root, 'credentials.json')
    await mkdir(join(config, 'publishing'), { recursive: true })
    await writeFile(credentialsFile, JSON.stringify({ secretId: 'fixture', secretKey: 'fixture' }))
    await writeFile(join(config, 'publishing/production.json'), JSON.stringify({
      bucket: 'bucket-123', origin: 'https://download.deepseek.com', credentialsFile,
      githubApp: { clientId: 'app', privateKeyFile: join(f.root, 'absent-key') },
    }))
    const record = await createDesktopPublicationRecord(join(f.root, 'upload-records'), {
      repository: 'owner/repo', runId: '42', attempt: '1', actor: 'operator',
      destination: `bucket-123/${f.plan.upload.publicUrl}nightly`, operation: 'publish', reason: 'fixture',
    })
    await record.record({ type: 'feeds-complete' })
    const env = { RUNNER_NAME: 'runner', GITHUB_REPOSITORY: 'owner/repo', DSH_PACKAGING_CONFIG_DIR: config,
      DESKTOP_PUBLISH_ROUTE: JSON.stringify({ ...f.manifest.source, runnerLabel: 'dsh-runner' }),
      DESKTOP_ROLLOUT_PERCENTAGE: scenario === 'website' ? '' : '30', DESKTOP_UPLOAD_WEBSITE: scenario === 'website' ? 'true' : 'false',
      DOWNLOAD_PROD_EO_ZONE_ID: 'zone-fixture', GITHUB_OUTPUT: join(f.root, 'output'), GITHUB_STEP_SUMMARY: join(f.root, 'summary') }
    const context = await prepareDesktopRolloutCi(env)
    await publishDesktopRolloutCi('check', env)
    expect(await readFile(env.GITHUB_OUTPUT, 'utf8')).toContain(`approval=${context.approval}`)
    if (scenario === 'website') {
      const summary = await readFile(env.GITHUB_STEP_SUMMARY, 'utf8')
      expect(summary).toContain('官网安装包面向所有下载用户，不受自动更新放量比例限制')
      expect(summary).toContain('固定下载地址无防降级保护，发布较早版本会替换较新安装包')
    }
    const mock = transport(dump({ ...(load(f.plan.expected) as object), stagingPercentage: 10 }))
    if (scenario === 'replaced-feed') mock.replace(null)
    const createTransport = vi.spyOn(cosTransport, 'desktopPublishCos').mockReturnValue(mock.api)
    const website = vi.spyOn(websitePublisher, 'publishWebsiteCi').mockImplementation(async (mode) => {
      expect(mode).toBe('upload')
      expect(mock.reads).toHaveLength(1)
      expect(mock.writes).toHaveLength(0)
    })
    vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    const approved = { ...env, DESKTOP_ROLLOUT_APPROVAL: scenario === 'changed-approval' ? 'changed' : context.approval }
    const execution = publishDesktopRolloutCi(scenario === 'website' ? 'website-upload' : 'apply', approved)
    if (scenario === 'changed-approval' || scenario === 'replaced-feed') {
      await expect(execution).rejects.toThrow(scenario === 'changed-approval' ? 'approved inputs' : 'feed is missing')
      expect(mock.writes).toHaveLength(0)
      expect(website).not.toHaveBeenCalled()
      if (scenario === 'changed-approval') expect(createTransport).not.toHaveBeenCalled()
    } else {
      await execution
      expect(mock.writes).toHaveLength(scenario === 'apply' ? 1 : 0)
      expect(website).toHaveBeenCalledTimes(scenario === 'website' ? 1 : 0)
      const output = await readFile(env.GITHUB_OUTPUT, 'utf8')
      const key = scenario === 'website' ? 'rollout-record=' : 'record='
      const directory = output.split('\n').find(line => line.startsWith(key))!.slice(key.length)
      expect(JSON.parse(await readFile(join(directory, 'result.json'), 'utf8'))).toMatchObject({ status: 'complete' })
      expect(await readFile(join(directory, 'events.jsonl'), 'utf8')).toContain(scenario === 'apply' ? 'put-verified' : 'object-present')
      expect(await readFile(env.GITHUB_STEP_SUMMARY, 'utf8')).toContain(scenario === 'apply' ? '10% → 30%' : '10% → 10%')
    }
  } finally { vi.restoreAllMocks(); await rm(f.root, { recursive: true, force: true }) }
})

it('routes without package binaries only for the explicit metadata-only reader and keeps reviewer checks', async () => {
  const f = await fixture()
  try {
    const env = { RUNNER_NAME: 'runner', GITHUB_REPOSITORY: 'owner/repo', DSH_PACKAGING_CONFIG_DIR: join(f.root, 'config'),
      DESKTOP_PACKAGE_SELECTION: JSON.stringify({ runnerName: 'runner',
        run: { id: 42, run_attempt: 1, head_sha: f.manifest.source.workflowCommit, path: '.github/workflows/macos-package.yml',
          conclusion: 'success', event: 'workflow_dispatch', repository: { full_name: 'owner/repo' } },
        jobs: [{ name: 'package', runner_name: 'runner', conclusion: 'success', labels: ['self-hosted', 'dsh-runner'] }],
        routes: { runner: { label: 'dsh-runner', target: 'mac-arm64' } },
      }) }
    const api = async (path: string) => path.includes('/environments/')
      ? { protection_rules: [{ type: 'required_reviewers', reviewers: [{}] }] } : { sha: f.manifest.source.commit }
    await expect(resolveRetainedDesktopPublication(env, api)).rejects.toThrow()
    expect(await resolveRetainedDesktopPublication(env, api, readRetainedDesktopManifest)).toMatchObject({
      runId: '42', attempt: '1', runnerName: 'runner', preset: 'production',
    })
    await expect(resolveRetainedDesktopPublication(env, async path => path.includes('/environments/')
      ? { protection_rules: [] } : api(path), readRetainedDesktopManifest)).rejects.toThrow('requires configured reviewers')
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

it('runs the real route CLI without gh and emits the selected route and preset', async () => {
  const f = await fixture()
  const requests: Array<{ url: string | undefined; token: string | undefined }> = []
  const server = createServer((request, response) => {
    requests.push({ url: request.url, token: request.headers.authorization })
    response.writeHead(200, { 'content-type': 'application/json', connection: 'close' })
    response.end(JSON.stringify(request.url?.includes('/environments/')
      ? { protection_rules: [{ type: 'required_reviewers', reviewers: [{}] }] } : { sha: f.manifest.source.commit }))
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
    })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('expected TCP listener')
    const output = join(f.root, 'route-output')
    const selection = { runnerName: 'runner',
      run: { id: 42, run_attempt: 1, head_sha: f.manifest.source.workflowCommit, path: '.github/workflows/macos-package.yml',
        conclusion: 'success', event: 'workflow_dispatch', repository: { full_name: 'owner/repo' } },
      jobs: [{ name: 'package', runner_name: 'runner', conclusion: 'success', labels: ['self-hosted', 'dsh-runner'] }],
      routes: { runner: { label: 'dsh-runner', target: 'mac-arm64' } },
    }
    const result = await promisify(execFile)(process.execPath,
      ['--import', 'tsx/esm', 'apps/desktop/scripts/publish-desktop-rollout-ci.ts', 'route'], {
        timeout: 30_000, env: {
          ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path')), PATH: '',
          GH_TOKEN: 'fixture-token', GITHUB_API_URL: `http://127.0.0.1:${address.port}`, GITHUB_OUTPUT: output,
          RUNNER_NAME: 'runner', GITHUB_REPOSITORY: 'owner/repo', DSH_PACKAGING_CONFIG_DIR: join(f.root, 'config'),
          DESKTOP_PACKAGE_SELECTION: JSON.stringify(selection),
        },
      })
    expect(result.stderr).toBe('')
    const lines = (await readFile(output, 'utf8')).trim().split('\n')
    expect(lines[1]).toBe('preset=production')
    expect(JSON.parse(lines[0]!.slice('route='.length))).toMatchObject({ runId: '42', attempt: '1', target: 'mac-arm64' })
    expect(requests.map(request => request.url)).toEqual([
      `/repos/owner/repo/commits/${f.manifest.source.commit}`,
      `/repos/owner/repo/commits/${encodeURIComponent(`refs/tags/${f.manifest.source.sourceRef}`)}`,
      '/repos/owner/repo/environments/desktop-production',
    ])
    expect(requests.every(request => request.token === 'Bearer fixture-token')).toBe(true)
  } finally {
    server.closeAllConnections()
    if (server.listening) {
      await new Promise<void>((resolve, reject) => server.close((error) => { if (error) reject(error); else resolve() }))
    }
    await rm(f.root, { recursive: true, force: true })
  }
})

it.each(['mac-arm64', 'win-x64'] as const)('accepts %s metadata produced by the original full upload planner', async (target) => {
  const f = await fixture(target)
  try {
    const base = `deepseek-harness-${f.manifest.source.version}-${target}`
    const extension = target === 'win-x64' ? 'exe' : 'zip'
    await writeFile(join(f.directory, `${base}.${extension}`), 'installer')
    await writeFile(join(f.directory, `${base}.${extension}.blockmap`), 'blockmap')
    if (target !== 'win-x64') await writeFile(join(f.directory, `${base}.dmg`), 'installer')
    await writeFile(join(f.directory, desktopBuildRecordFilename(target)), JSON.stringify({
      schemaVersion: 1, target, version: f.manifest.source.version, channel: 'nightly',
      environment: 'production', publicUrl: f.plan.upload.publicUrl, commit: f.manifest.source.commit, dirty: false,
    }))
    const original = await createDesktopUploadPlan(target, { artifactsRoot: f.directory, environment: f.environment,
      packagedProductVersion: f.manifest.source.version, stagingPercentage: 10 })
    const feed = original.artifacts.find(artifact => artifact.channelMetadata)!
    const mock = transport(feed.contents!)
    expect(await rolloutDesktopRelease(f.plan, 30, { transport: mock.api, record: mock.record }))
      .toEqual({ before: 10, after: 30 })
    expect(load(mock.writes[0]!)).toEqual({ ...(load(feed.contents!) as object), stagingPercentage: 30 })
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

it.each(['missing-yaml', 'wrong-approval', 'not-uploaded', 'wrong-zone', 'not-selected'] as const)(
  'preserves independent website purge recovery for %s', async (scenario) => {
    const f = await fixture()
    try {
      const config = join(f.root, 'config')
      const credentialsFile = join(f.root, 'credentials.json')
      await mkdir(join(config, 'publishing'), { recursive: true })
      await writeFile(credentialsFile, JSON.stringify({ secretId: 'fixture-id', secretKey: 'fixture-key' }))
      await writeFile(join(config, 'publishing/production.json'), JSON.stringify({
        bucket: 'bucket-123', origin: 'https://download.deepseek.com', credentialsFile,
        githubApp: { clientId: 'app', privateKeyFile: join(f.root, 'absent-key') },
      }))
      await rm(join(f.directory, f.filename))
      const directory = join(f.root, 'upload-records', 'website-99-mac-arm64')
      await mkdir(directory, { recursive: true })
      const approval = websitePublisher.websiteApproval(await readRetainedDesktopManifest(join(f.root, 'releases'), '42', '1'), 'bucket-123')
      const publicUrl = desktopWebsiteInstallerUrl('mac-arm64')
      await writeFile(join(directory, 'state.json'), JSON.stringify({ approval,
        upload: scenario === 'not-uploaded' ? 'pending' : 'uploaded', purgeAttempt: '1',
        purge: { zoneId: 'zone-fixture', publicUrl, submittedAt: '2026-11-04T00:00:00.000Z',
          jobId: 'existing-job', status: 'processing' },
      }))
      const submit = vi.spyOn(teo.v20220901.Client.prototype, 'CreatePurgeTask').mockRejectedValue(new Error('unexpected purge submission'))
      const query = vi.spyOn(teo.v20220901.Client.prototype, 'DescribePurgeTasks').mockResolvedValue({
        TotalCount: 1, Tasks: [{ JobId: 'existing-job', Target: publicUrl, Type: 'purge_url', Status: 'success' }],
      })
      vi.spyOn(process.stdout, 'write').mockReturnValue(true)
      const execution = publishDesktopRolloutCi('website-purge', {
        RUNNER_NAME: 'runner', GITHUB_REPOSITORY: 'owner/repo', GITHUB_RUN_ID: '99', GITHUB_RUN_ATTEMPT: '2',
        DSH_PACKAGING_CONFIG_DIR: config, DESKTOP_PUBLISH_ROUTE: JSON.stringify({ ...f.manifest.source, runnerLabel: 'dsh-runner' }),
        DESKTOP_UPLOAD_WEBSITE: scenario === 'not-selected' ? 'false' : 'true',
        DESKTOP_WEBSITE_APPROVAL: scenario === 'wrong-approval' ? 'changed' : approval,
        DOWNLOAD_PROD_EO_ZONE_ID: scenario === 'wrong-zone' ? 'zone-changed' : 'zone-fixture',
      })
      if (scenario === 'missing-yaml') {
        await execution
        expect(query).toHaveBeenCalledOnce()
        expect(JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'))).toMatchObject({ purge: { status: 'success' } })
      } else {
        await expect(execution).rejects.toThrow({
          'wrong-approval': 'approved build or destination changed', 'not-uploaded': 'upload completion is not confirmed',
          'wrong-zone': 'saved destination differs', 'not-selected': 'website publication was not selected',
        }[scenario])
        expect(query).not.toHaveBeenCalled()
      }
      expect(submit).not.toHaveBeenCalled()
    } finally { vi.restoreAllMocks(); await rm(f.root, { recursive: true, force: true }) }
  })

it('executes the master guard and keeps all rollout preflights ahead of dependency installation', async () => {
  const workflow = load(await readFile('.github/workflows/desktop-rollout.yml', 'utf8')) as {
    jobs: Record<string, { steps: Array<{ id?: string; run?: string; uses?: string; env?: Record<string, string> }> }>
  }
  const route = workflow.jobs.route!.steps
  const command = route[0]!.run!
  for (const ref of ['refs/heads/master', 'refs/heads/stale-feature']) {
    const result = spawnSync(process.execPath, ['-e', command.slice('node -e "'.length, -1)], {
      env: { ...process.env, GITHUB_REF: ref }, encoding: 'utf8', timeout: 30_000,
    })
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(ref === 'refs/heads/master' ? 0 : 1)
  }
  const preflight = route.findIndex(step => step.id === 'preflight')
  expect(preflight).toBeGreaterThan(0)
  expect(preflight).toBeLessThan(route.findIndex(step => step.uses?.startsWith('pnpm/')))
  expect(route.find(step => step.id === 'route')?.env?.DESKTOP_PACKAGE_ATTEMPT).toBe('${{ steps.preflight.outputs.attempt }}')
  for (const [name, job] of Object.entries(workflow.jobs)) {
    if (name === 'route') continue
    const local = job.steps.findIndex(step => step.run?.includes('preflight-desktop-publish-local.mjs'))
    expect(local).toBeGreaterThanOrEqual(0)
    expect(local).toBeLessThan(job.steps.findIndex(step => step.run === 'pnpm install --frozen-lockfile'))
  }
})
