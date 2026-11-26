/** Actions entrypoint for promoting an already published Desktop package without full package verification. */
import { createHash } from 'node:crypto'
import { appendFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import { readDesktopPublishConfig, readDesktopUploadCredentials, requireDesktopEdgeOneZoneId } from './desktop-publish-config.ts'
import { desktopReleasesRoot } from './desktop-releases-root.ts'
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

function booleanEnv(env: NodeJS.ProcessEnv, name: string): boolean {
  const value = env[name]
  if (value === undefined || value === 'false') return false
  if (value === 'true') return true
  throw new Error(`desktop rollout: ${name} must be "true" or "false"`)
}

function selectedRolloutChannels(
  env: NodeJS.ProcessEnv,
  target: number | undefined,
  website: boolean,
): readonly ('nightly' | 'stable')[] {
  const channels = [
    ...(booleanEnv(env, 'DESKTOP_ROLLOUT_STABLE') ? ['stable' as const] : []),
    ...(booleanEnv(env, 'DESKTOP_ROLLOUT_NIGHTLY') ? ['nightly' as const] : []),
  ]
  if (channels.length === 0 && !website) {
    throw new Error('desktop rollout: select rollout_stable, rollout_nightly, or upload_website')
  }
  if (channels.length > 0 && target === undefined) {
    throw new Error('desktop rollout: percentage is required when rollout channels are selected')
  }
  if (channels.length === 0 && target !== undefined) {
    throw new Error('desktop rollout: select rollout_stable or rollout_nightly when specifying a percentage')
  }
  return channels
}

/**
 * Prepare approval using only identity, initial publication evidence (when channels are selected) and retained metadata.
 * @param env Original machine settings, resolved route and manual rollout inputs.
 * @returns Metadata-only plans and approval digest; no upload credentials are read.
 */
export async function prepareDesktopRolloutCi(env: NodeJS.ProcessEnv) {
  const route = routeSchema.parse(JSON.parse(env.DESKTOP_PUBLISH_ROUTE || '{}'))
  if (route.runnerName !== env.RUNNER_NAME) throw new Error('desktop rollout: original machine required')
  const input = env.DESKTOP_ROLLOUT_PERCENTAGE?.trim() || ''
  if (input !== '' && (!/^\d+$/u.test(input) || Number(input) > 100)) {
    throw new Error('desktop rollout: percentage must be an integer from 0 to 100')
  }
  const target = input === '' ? undefined : Number(input)
  const website = booleanEnv(env, 'DESKTOP_UPLOAD_WEBSITE')
  const channels = selectedRolloutChannels(env, target, website)
  if (website && route.preset !== 'production') {
    throw new Error('desktop rollout: website publication requires production')
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
  const config = await readDesktopPublishConfig(z.string().parse(env.DSH_PACKAGING_CONFIG_DIR), source.preset)
  const zoneId = website ? requireDesktopEdgeOneZoneId(config) : undefined
  if (website) {
    const installerFilename = `deepseek-harness-${source.version}-${source.target}.${source.target === 'win-x64' ? 'exe' : 'dmg'}`
    if (!manifest.files.some(file => file.name === installerFilename)) {
      throw new Error('desktop rollout: selected installer is absent from build manifest')
    }
  }
  const environment = source.preset === 'test'
    ? { DSH_DESKTOP_AUTO_UPDATE_ENV: 'test', DOWNLOAD_TEST_ORIGIN: config.origin,
      DOWNLOAD_TEST_RELEASE_ID: source.testReleaseId ?? '', DOWNLOAD_TEST_COS_BUCKET: config.bucket }
    : { DSH_DESKTOP_AUTO_UPDATE_ENV: 'production', DOWNLOAD_PROD_COS_BUCKET: config.bucket }
  const recordsRoot = join(dirname(root), 'upload-records')
  const plans = []
  for (const channel of channels) {
    const plan = await prepareDesktopRollout(retainedDesktopPath(root, route.runId, route.attempt), manifest, environment, channel)
    const destination = `${config.bucket}/${plan.upload.publicUrl}${channel}`
    if (!await findDesktopPublication(recordsRoot, { repository: source.repository,
      runId: route.runId, attempt: route.attempt, destination })) {
      throw new Error(`desktop rollout: initial COS feed publication is not confirmed for channel ${channel}`)
    }
    plans.push({ channel, plan, destination })
  }
  const approval = createHash('sha256').update(JSON.stringify({ manifest, plans, target, website,
    zoneId })).digest('hex')
  return {
    route, root, recordsRoot, config, manifest,
    channels, plans, plan: plans[0]?.plan, destination: plans[0]?.destination,
    target, website, approval,
  }
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
  const { route, root, recordsRoot, config, manifest, channels, plans, target, website, approval } = context
  const rolloutRequested = plans.length > 0
  if (mode === 'check') {
    const channelLabel = channels.length > 0 ? channels.join('+') : 'website'
    const websiteDest = createHash('sha256').update(`${config.bucket}/${route.target}`).digest('hex')
    const label = `${manifest.source.version} / ${channelLabel} / ${route.target} → ${rolloutRequested ? `${target}%` : 'website only'}`
    if (env.GITHUB_OUTPUT) {
      await appendFile(env.GITHUB_OUTPUT, [
        `rollout-requested=${rolloutRequested}`,
        `approval=${approval}`,
        `website-approval=${websiteApproval(manifest, config.bucket)}`,
        `website-destination=${websiteDest}`,
        `label=${label}`,
        '',
      ].join('\n'))
    }
    if (env.GITHUB_STEP_SUMMARY && !env.DESKTOP_ROLLOUT_APPROVAL) {
      const targetLine = rolloutRequested
        ? `${target}%（执行时从 COS 核对当前比例，不允许降低比例）`
        : '不适用（仅发布官网安装包）'
      const websiteNote = website
        ? '官网安装包面向所有下载用户，不受自动更新放量比例限制，也不要求先行发布自动更新渠道或放量达到 100%。固定下载地址无防降级保护，发布较早版本会替换较新安装包。'
        : ''
      const checkLine = rolloutRequested
        ? '已按所选渠道确认首次 COS 发布记录；不重新计算全部安装包哈希或校验签名。'
        : '仅官网发布跳过渠道首次发布记录校验；执行上传时校验生产安装包大小与 SHA-512。'
      await appendFile(env.GITHUB_STEP_SUMMARY, [
        '## 桌面放量与官网发布确认',
        '',
        `打包运行：${route.runId} / 第 ${route.attempt} 次；版本：${manifest.source.version}；平台：${route.target}；环境：${route.preset}；`
          + `包内渠道标记：${manifest.source.channel}；放量目标渠道：${rolloutRequested ? channels.join('、') : '不调整渠道（仅发布官网）'}。`,
        '',
        `目标放量比例：${targetLine}。`,
        '',
        `官网：${website ? `${desktopWebsiteInstallerUrl(route.target)}（上传安装包并刷新缓存）` : '不变'}。${websiteNote}`,
        '',
        checkLine,
        '',
      ].join('\n'))
    }
    return
  }
  if (env.DESKTOP_ROLLOUT_APPROVAL !== approval) throw new Error('desktop rollout: approved inputs or retained metadata changed')
  if (mode.startsWith('website-') && !website) throw new Error('desktop rollout: website publication was not selected')
  if (mode === 'website-upload') {
    await publishWebsiteCi('upload', env)
    return
  }
  if (plans.length === 0) throw new Error('desktop rollout: no rollout channel was selected')
  const credentials = await readDesktopUploadCredentials(config)
  const directories: string[] = []
  for (const { channel, plan, destination } of plans) {
    await withDesktopChannelLock(join(dirname(root), 'publish-locks'), destination, async () => {
      const journal = await createDesktopPublicationRecord(recordsRoot, {
        repository: manifest.source.repository, runId: route.runId, attempt: route.attempt,
        actor: env.GITHUB_TRIGGERING_ACTOR || env.GITHUB_ACTOR || 'unknown', destination,
        operation: 'rollout', reason: `${mode} (${channel})`, stagingPercentage: target,
      })
      directories.push(journal.directory)
      if (env.GITHUB_OUTPUT) {
        await appendFile(env.GITHUB_OUTPUT,
          `record=${journal.directory}\nrecords<<EOF\n${directories.map(dir => `${dir}/`).join('\n')}\nEOF\n`)
      }
      try {
        const result = await rolloutDesktopRelease(plan, target,
          { transport: desktopPublishCos(plan.upload, credentials), record: event => journal.record(event) })
        await journal.record({ type: 'complete' })
        await journal.finish('complete')
        const summary = `Desktop rollout: ${manifest.source.version} / ${channel} / ${route.target}: ${result.before}% → ${result.after}%\n`
        process.stdout.write(summary)
        if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, summary)
      } catch (error) {
        await journal.record({ type: 'failed', failure: desktopPublicationFailure(error, 'desktop rollout') })
        await journal.finish('failed')
        throw error
      }
    })
  }
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
