/** Actions entrypoint for independently recoverable website upload and cache purge jobs. */
import { createHash, randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { z } from 'zod'
import { readDesktopPublishConfig, readDesktopUploadCredentials } from './desktop-publish-config.ts'
import { desktopReleasesRoot } from './retain-desktop-ci.ts'
import { readRetainedDesktopManifest, retainedDesktopPath } from './desktop-release-store.ts'
import { prepareWebsiteInstaller, uploadWebsiteInstaller } from './desktop-website-installer.ts'
import { desktopPublishCos } from './desktop-publish-cos.ts'
import { withDesktopChannelLock } from './desktop-publish-record.ts'
import { recoverDesktopPurge, type DesktopPurgeRecord } from './desktop-purge-recovery.ts'
import { desktopPublicationFailure } from './desktop-publication-failure.ts'

const routeSchema = z.object({ runId: z.string().regex(/^[1-9]\d*$/u), attempt: z.string().regex(/^[1-9]\d*$/u),
  commit: z.string().regex(/^[a-f0-9]{40}$/u), runnerName: z.string(), runnerLabel: z.string(), sourceRef: z.string(),
  channel: z.enum(['nightly', 'stable']), target: z.enum(['mac-arm64', 'mac-x64', 'win-x64']), preset: z.literal('production') })
const purgeSchema = z.object({ zoneId: z.string(), publicUrl: z.url(), submittedAt: z.iso.datetime(),
  jobId: z.string().regex(/^[\w.-]{1,128}$/u).optional(),
  status: z.enum(['pending', 'processing', 'success', 'failed', 'timeout', 'canceled', 'unknown']),
  observedAt: z.iso.datetime().optional(), diagnostic: z.string().optional() })
const stateSchema = z.object({ approval: z.string(), upload: z.enum(['pending', 'upload-intent', 'uploaded']),
  uploadConfirmed: z.boolean().optional(), purge: purgeSchema.optional(), purgeAttempt: z.string().optional() })

/**
 * Bind website approval to the retained manifest and exact production bucket.
 * @param manifest Retained build metadata already matched to GitHub evidence.
 * @param bucket Production COS destination.
 * @returns Non-secret digest passed through the production approval job.
 */
export function websiteApproval(manifest: unknown, bucket: string): string {
  return createHash('sha256').update(JSON.stringify({ manifest, bucket })).digest('hex')
}

/**
 * Upload a fixed installer or recover its cache purge, using a publication-run-owned journal.
 * @param mode Explicit website operation; purge never opens or uploads installer bytes.
 * @param env Actions identity, approved build and machine configuration.
 * @returns Resolves on success or a prominently reported unknown purge result.
 */
export async function publishWebsiteCi(mode: 'upload' | 'purge', env: NodeJS.ProcessEnv): Promise<void> {
  const route = routeSchema.parse(JSON.parse(env.DESKTOP_PUBLISH_ROUTE || '{}'))
  if (env.RUNNER_NAME !== route.runnerName || !/^[1-9]\d*$/u.test(env.GITHUB_RUN_ID || '')
    || !/^[1-9]\d*$/u.test(env.GITHUB_RUN_ATTEMPT || '')) throw new Error('website publication: invalid Actions identity or original machine')
  const root = desktopReleasesRoot(env)
  const manifest = await readRetainedDesktopManifest(root, route.runId, route.attempt)
  const config = await readDesktopPublishConfig(env.DSH_PACKAGING_CONFIG_DIR!, 'production')
  const approval = websiteApproval(manifest, config.bucket)
  if (!env.DESKTOP_WEBSITE_APPROVAL || env.DESKTOP_WEBSITE_APPROVAL !== approval) throw new Error('website publication: approved build or destination changed')
  const zoneId = env.DOWNLOAD_PROD_EO_ZONE_ID
  if (!zoneId || !/^zone-[a-z0-9]+$/u.test(zoneId)) throw new Error('website publication: configure DOWNLOAD_PROD_EO_ZONE_ID before uploading')
  const directory = join(dirname(root), 'upload-records', `website-${env.GITHUB_RUN_ID}-${route.target}`)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const stateFile = join(directory, 'state.json')
  let state: z.infer<typeof stateSchema> = { approval, upload: 'pending' }
  try { state = stateSchema.parse(JSON.parse(await readFile(stateFile, 'utf8'))) }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }
  if (state.approval !== approval) throw new Error('website publication: journal belongs to another approved build')
  const save = async () => {
    const temporary = join(directory, `.state-${randomUUID()}.json`)
    await writeFile(temporary, `${JSON.stringify(state)}\n`, { flag: 'wx', mode: 0o600, flush: true })
    await rename(temporary, stateFile)
  }
  if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, `record=${directory}\n`)
  const credentials = await readDesktopUploadCredentials(config)
  if (mode === 'upload') {
    const installer = await prepareWebsiteInstaller(retainedDesktopPath(root, route.runId, route.attempt), manifest, route,
      env.GITHUB_REPOSITORY || '', config.bucket)
    try {
      const outcome = await withDesktopChannelLock(join(dirname(root), 'publish-locks'), `${config.bucket}/${installer.plan.artifacts[0]!.key}`, async () => {
        const previouslyUploaded = state.uploadConfirmed === true || state.upload === 'uploaded'
        return uploadWebsiteInstaller(installer, credentials, desktopPublishCos(installer.plan, credentials), async (event) => {
          state = event === 'upload-intent'
            ? { approval: state.approval, upload: event, uploadConfirmed: previouslyUploaded }
            : { ...state, upload: event, uploadConfirmed: true }
          await save()
        }, { previouslyUploaded })
      })
      const disposition = outcome === 'present' ? 'identical remote bytes and download filename confirmed; skipped' : 'uploaded'
      const text = `Website installer ${disposition}: ${installer.plan.publicUrl}; version ${installer.plan.version}\n`
      process.stdout.write(text)
      if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, text)
    } finally { await installer.handle.close() }
    return
  }
  if (state.upload !== 'uploaded') throw new Error('website publication: upload completion is not confirmed; recover the upload job first')
  const { desktopWebsiteInstallerUrl } = await import('./desktop-auto-update-environment.mjs')
  const publicUrl = desktopWebsiteInstallerUrl(route.target)
  const { teo } = await import('tencentcloud-sdk-nodejs-teo')
  const client = new teo.v20220901.Client({ credential: credentials, region: '',
    profile: { httpProfile: { endpoint: 'teo.tencentcloudapi.com', reqTimeout: 30 } } })
  const previousAttempt = state.purgeAttempt
  const result = await recoverDesktopPurge({ ...credentials, zoneId, publicUrl }, state.purge, client, {
    intervalMs: 10_000, waitMs: 300_000,
    allowResubmit: previousAttempt !== undefined && previousAttempt !== env.GITHUB_RUN_ATTEMPT,
    now: Date.now, sleep,
    save: async (purge: DesktopPurgeRecord) => {
      const accepted = purge.jobId && purge.jobId !== state.purge?.jobId
      state = { ...state, purge, purgeAttempt: env.GITHUB_RUN_ATTEMPT }
      await save()
      if (accepted) process.stdout.write(`Website cache purge accepted: ${publicUrl}; task ${purge.jobId}\n`)
    },
  })
  const details = `${publicUrl}\nTask: ${result.jobId ?? 'unknown'}\nObserved: ${result.observedAt}\n${result.diagnostic ?? ''}\n`
  if (result.status === 'unknown') {
    const acceptance = result.jobId ? '刷新已提交，执行结果未确认' : '刷新提交未确认，可能尚未提交'
    process.stdout.write(`::warning title=官网缓存刷新结果未确认::官网资源已上传；${acceptance}。请核对 EdgeOne 任务记录后人工恢复。\n${details}`)
    if (env.GITHUB_STEP_SUMMARY) {
      let existing = ''
      try { existing = await readFile(env.GITHUB_STEP_SUMMARY, 'utf8') }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }
      await writeFile(env.GITHUB_STEP_SUMMARY, `# ⚠ 官网资源已上传，缓存刷新结果未确认\n\n${acceptance}\n\n${details}${existing ? `\n${existing}` : ''}`)
    }
  } else {
    process.stdout.write(`Website cache purge completed\n${details}`)
    if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, `Website cache purge completed\n\n${details}`)
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
  try {
    const mode = process.argv[2]
    if (process.argv.length !== 3 || (mode !== 'upload' && mode !== 'purge')) throw new Error('Usage: publish-website-ci.ts upload|purge')
    await publishWebsiteCi(mode, process.env)
  } catch (error) {
    process.stderr.write(`${JSON.stringify(desktopPublicationFailure(error, 'website publication'))}\n`)
    process.exitCode = 1
  }
}
