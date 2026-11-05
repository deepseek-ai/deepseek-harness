/** Actions entrypoint for promoting an already published Desktop package without full package verification. */
import { createHash } from 'node:crypto'
import { appendFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import { readDesktopPublishConfig, readDesktopUploadCredentials } from './desktop-publish-config.ts'
import { desktopReleasesRoot } from './retain-desktop-ci.ts'
import { readRetainedDesktopManifest, retainedDesktopPath } from './desktop-release-store.ts'
import { resolveRetainedDesktopPublication, retainedDesktopPublishApi } from './resolve-retained-desktop-publish-ci.ts'
import { createDesktopPublicationRecord, findDesktopPublication, withDesktopChannelLock } from './desktop-publish-record.ts'
import { prepareDesktopRollout, rolloutDesktopRelease } from './desktop-rollout.ts'
import { desktopPublishCos } from './desktop-publish-cos.ts'
import { publishWebsiteCi, websiteApproval } from './publish-website-ci.ts'
import { desktopPublicationFailure } from './desktop-publication-failure.ts'
import { desktopWebsiteInstallerUrl } from './desktop-auto-update-environment.mjs'

const routeSchema = z.object({
  runId: z.string().regex(/^[1-9]\d*$/u), attempt: z.string().regex(/^[1-9]\d*$/u),
  commit: z.string().regex(/^[a-f0-9]{40}$/u), sourceRef: z.string(), runnerName: z.string(), runnerLabel: z.string(),
  target: z.enum(['mac-arm64', 'mac-x64', 'win-x64']), channel: z.enum(['nightly', 'stable']),
  preset: z.enum(['test', 'production']),
})

/**
 * Prepare approval using only identity, initial publication evidence and retained update metadata.
 * @param env Original machine settings, resolved route and manual rollout inputs.
 * @returns Metadata-only plan and approval digest; no upload credentials are read.
 */
export async function prepareDesktopRolloutCi(env: NodeJS.ProcessEnv) {
  const route = routeSchema.parse(JSON.parse(env.DESKTOP_PUBLISH_ROUTE || '{}'))
  if (route.runnerName !== env.RUNNER_NAME) throw new Error('desktop rollout: original machine required')
  const input = env.DESKTOP_ROLLOUT_PERCENTAGE?.trim() || ''
  if (input !== '' && (!/^\d+$/u.test(input) || Number(input) > 100)) {
    throw new Error('desktop rollout: percentage must be an integer from 0 to 100')
  }
  const target = input === '' ? undefined : Number(input)
  const website = env.DESKTOP_UPLOAD_WEBSITE === 'true'
  if (target === undefined && !website) throw new Error('desktop rollout: select a percentage or website publication')
  if (website && (route.preset !== 'production' || !/^zone-[a-z0-9]+$/u.test(env.DOWNLOAD_PROD_EO_ZONE_ID || ''))) {
    throw new Error('desktop rollout: website publication requires production and DOWNLOAD_PROD_EO_ZONE_ID')
  }
  const root = desktopReleasesRoot(env)
  const manifest = await readRetainedDesktopManifest(root, route.runId, route.attempt)
  const source = manifest.source
  for (const field of ['runId', 'attempt', 'commit', 'sourceRef', 'runnerName', 'target', 'channel', 'preset'] as const) {
    if (source[field] !== route[field]) throw new Error('desktop rollout: route differs from retained package')
  }
  if (source.repository !== env.GITHUB_REPOSITORY
    || source.qualification !== (source.target === 'win-x64' ? 'signed' : 'notarized')) {
    throw new Error('desktop rollout: repository or release qualification mismatch')
  }
  const config = await readDesktopPublishConfig(env.DSH_PACKAGING_CONFIG_DIR!, source.preset)
  const environment = source.preset === 'test'
    ? { DSH_DESKTOP_AUTO_UPDATE_ENV: 'test', DOWNLOAD_TEST_ORIGIN: config.origin,
      DOWNLOAD_TEST_RELEASE_ID: source.testReleaseId ?? '', DOWNLOAD_TEST_COS_BUCKET: config.bucket }
    : { DSH_DESKTOP_AUTO_UPDATE_ENV: 'production', DOWNLOAD_PROD_COS_BUCKET: config.bucket }
  const plan = await prepareDesktopRollout(retainedDesktopPath(root, route.runId, route.attempt), manifest, environment)
  const destination = `${config.bucket}/${plan.upload.publicUrl}${source.channel}`
  const recordsRoot = join(dirname(root), 'upload-records')
  if (!await findDesktopPublication(recordsRoot, { repository: source.repository,
    runId: route.runId, attempt: route.attempt, destination })) {
    throw new Error('desktop rollout: initial COS feed publication is not confirmed for this package')
  }
  const approval = createHash('sha256').update(JSON.stringify({ manifest, plan, target, website,
    zoneId: website ? env.DOWNLOAD_PROD_EO_ZONE_ID : undefined })).digest('hex')
  return { route, root, recordsRoot, config, manifest, plan, target, website, destination, approval }
}

/**
 * Dispatch a lightweight check, rollout, website upload or website cache recovery.
 * @param mode Explicit operation from the trusted workflow.
 * @param env Actions environment with approved original package identity.
 * @returns Resolves after the selected operation and its durable audit complete.
 */
export async function publishDesktopRolloutCi(mode: 'check' | 'apply' | 'website-upload' | 'website-purge',
  env: NodeJS.ProcessEnv): Promise<void> {
  if (mode === 'website-purge') {
    if (env.DESKTOP_UPLOAD_WEBSITE !== 'true') throw new Error('desktop rollout: website publication was not selected')
    // The existing website approval and uploaded journal authorize cache recovery without retained feed files.
    await publishWebsiteCi('purge', env)
    return
  }
  const context = await prepareDesktopRolloutCi(env)
  const { route, root, recordsRoot, config, manifest, plan, target, website, destination, approval } = context
  if (mode === 'check') {
    if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT,
      `approval=${approval}\nwebsite-approval=${websiteApproval(manifest, config.bucket)}\nwebsite-destination=${createHash('sha256').update(`${config.bucket}/${route.target}`).digest('hex')}\nlabel=${manifest.source.version} / ${route.channel} / ${route.target} → ${target === undefined ? 'website only' : `${target}%`}\n`)
    if (env.GITHUB_STEP_SUMMARY && !env.DESKTOP_ROLLOUT_APPROVAL) await appendFile(env.GITHUB_STEP_SUMMARY,
      `## 桌面放量与官网发布确认\n\n打包运行：${route.runId} / 第 ${route.attempt} 次；版本：${manifest.source.version}；平台：${route.target}；环境 / 渠道：${route.preset} / ${route.channel}。\n\n目标放量比例：${target === undefined ? '保持当前比例' : `${target}%`}。执行时从 COS 核对当前比例，不允许降低比例。\n\n官网：${website ? desktopWebsiteInstallerUrl(route.target) + '（上传安装包并刷新缓存）' : '不变'}。${website ? '官网安装包面向所有下载用户，不受自动更新放量比例限制，也不要求放量达到 100%。固定下载地址无防降级保护，发布较早版本会替换较新安装包。' : ''}\n\n已确认首次 COS 发布记录；不重新计算全部安装包哈希或校验签名。\n`)
    return
  }
  if (env.DESKTOP_ROLLOUT_APPROVAL !== approval) throw new Error('desktop rollout: approved inputs or retained metadata changed')
  if (mode.startsWith('website-') && !website) throw new Error('desktop rollout: website publication was not selected')
  const credentials = await readDesktopUploadCredentials(config)
  await withDesktopChannelLock(join(dirname(root), 'publish-locks'), destination, async () => {
    const journal = await createDesktopPublicationRecord(recordsRoot, {
      repository: manifest.source.repository, runId: route.runId, attempt: route.attempt,
      actor: env.GITHUB_TRIGGERING_ACTOR || env.GITHUB_ACTOR || 'unknown', destination,
      operation: 'rollout', reason: mode, stagingPercentage: mode === 'apply' ? target : undefined,
    })
    if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, `${mode === 'website-upload' ? 'rollout-record' : 'record'}=${journal.directory}\n`)
    try {
      const result = await rolloutDesktopRelease(plan, mode === 'apply' ? target : undefined,
        { transport: desktopPublishCos(plan.upload, credentials), record: event => journal.record(event) })
      if (mode === 'website-upload') await publishWebsiteCi('upload', env)
      await journal.record({ type: 'complete' })
      await journal.finish('complete')
      const summary = `Desktop rollout: ${manifest.source.version} / ${route.channel} / ${route.target}: ${result.before}% → ${result.after}%\n`
      process.stdout.write(summary)
      if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, summary)
    } catch (error) {
      await journal.record({ type: 'failed', failure: desktopPublicationFailure(error, 'desktop rollout') })
      await journal.finish('failed')
      throw error
    }
  })
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
  try {
    const mode = process.argv[2]
    if (mode === 'route' && process.argv.length === 3) {
      if (!process.env.GITHUB_OUTPUT) throw new Error('desktop rollout: Actions output required')
      const route = await resolveRetainedDesktopPublication(
        process.env, retainedDesktopPublishApi(process.env), readRetainedDesktopManifest)
      await appendFile(process.env.GITHUB_OUTPUT, `route=${JSON.stringify(route)}\npreset=${route.preset}\n`)
    } else {
      const parsed = z.enum(['check', 'apply', 'website-upload', 'website-purge']).parse(mode)
      if (process.argv.length !== 3) throw new Error('desktop rollout: expected one operation')
      await publishDesktopRolloutCi(parsed, process.env)
    }
  } catch (error) {
    process.stderr.write(`${JSON.stringify(desktopPublicationFailure(error, 'desktop rollout'))}\n`)
    process.exitCode = 1
  }
}
