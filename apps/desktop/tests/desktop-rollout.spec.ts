import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
      const directory = output.split('\n').find(line => line.startsWith('record='))!.slice(7)
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
