/** Publish a retained package selected by the preparation job; --check never reads secrets or contacts COS. */
import { createHash } from 'node:crypto'
import { appendFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import { readDesktopPublishConfig, readDesktopUploadCredentials, requireDesktopEdgeOneZoneId } from '@deepseek-ai/dsh-desktop-publisher/desktop-publish-config.ts'
import { desktopReleasesRoot } from './retain-desktop-ci.ts'
import { retainedDesktopPath, verifyRetainedDesktopRelease } from '@deepseek-ai/dsh-desktop-publisher/desktop-release-store.ts'
import { verifyRetainedDesktopSignatures } from './verify-retained-desktop.ts'
import { createDesktopUploadPlan } from './desktop-upload-plan.ts'
import { desktopPublishCos } from '@deepseek-ai/dsh-desktop-publisher/desktop-publish-cos.ts'
import { createDesktopPublicationRecord, wasDesktopAttemptPublished, withDesktopChannelLock } from '@deepseek-ai/dsh-desktop-publisher/desktop-publish-record.ts'
import { publishDesktopRelease, type DesktopPublishTransport } from '@deepseek-ai/dsh-desktop-publisher/desktop-publish.ts'
import { desktopPublicationFailure } from '@deepseek-ai/dsh-desktop-publisher/desktop-publication-failure.ts'
import { desktopPublicationSummary } from './desktop-publication-summary.ts'
import { publishDesktopTag } from './desktop-publish-tag.ts'
import { websiteApproval } from '@deepseek-ai/dsh-desktop-publisher/publish-website-ci.ts'
import { desktopPublishQualificationError } from '@deepseek-ai/dsh-desktop-publisher/desktop-publish-qualification.mjs'

const routeSchema = z.object({ runId: z.string(), attempt: z.string(), commit: z.string(), runnerName: z.string(),
  sourceRef: z.string(), channel: z.enum(['nightly', 'stable']),
  target: z.enum(['mac-arm64', 'mac-x64', 'win-x64']), preset: z.enum(['test', 'production']) })

function booleanEnv(env: NodeJS.ProcessEnv, name: string): boolean {
  const value = env[name]
  if (value === undefined || value === 'false') return false
  if (value === 'true') return true
  throw new Error(`desktop publish: ${name} must be "true" or "false"`)
}

function selectedPublishChannels(
  env: NodeJS.ProcessEnv,
  uploadWebsite: boolean,
  rollbackChannel: 'nightly' | 'stable' | undefined,
): readonly ('nightly' | 'stable')[] {
  if (rollbackChannel !== undefined) return [rollbackChannel]
  const channels = [
    ...(booleanEnv(env, 'DESKTOP_PUBLISH_STABLE') ? ['stable' as const] : []),
    ...(booleanEnv(env, 'DESKTOP_PUBLISH_NIGHTLY') ? ['nightly' as const] : []),
  ]
  if (channels.length === 0 && !uploadWebsite) {
    throw new Error('desktop publish: select publish_stable, publish_nightly, or upload_website')
  }
  return channels
}

/**
 * Check retained bytes, original machine, destination and signatures before reading any upload secret.
 * @param env Router output and machine configuration directory.
 * @param verifySignatures Platform verifier; tests inject a verifier for fixture bytes.
 * @param options Optional single-channel rollback target when restoring a cross-channel publication.
 * @returns Validated local publication context; no network operation is performed.
 */
export async function prepareDesktopPublication(
  env: NodeJS.ProcessEnv,
  verifySignatures = verifyRetainedDesktopSignatures,
  options: { readonly rollbackChannel?: 'nightly' | 'stable' } = {},
) {
  const percentage = env.DESKTOP_STAGING_PERCENTAGE?.trim() || ''
  if (percentage !== '' && (!/^\d+$/u.test(percentage) || Number(percentage) > 100)) {
    throw new Error('desktop publish: staging percentage must be an integer from 0 to 100')
  }
  const stagingPercentage = percentage === '' ? undefined : Number(percentage)
  const uploadWebsite = booleanEnv(env, 'DESKTOP_UPLOAD_WEBSITE')
  const route = routeSchema.parse(JSON.parse(env.DESKTOP_PUBLISH_ROUTE || '{}'))
  if (route.runnerName !== env.RUNNER_NAME) throw new Error('desktop publish: task was dispatched to a different machine')
  const channels = selectedPublishChannels(env, uploadWebsite, options.rollbackChannel)
  if (channels.length === 0 && uploadWebsite && route.preset !== 'production') {
    throw new Error('desktop publish: website publication requires production')
  }
  const root = desktopReleasesRoot(env)
  const manifest = await verifyRetainedDesktopRelease(root, route.runId, route.attempt)
  const source = manifest.source
  if (source.repository !== env.GITHUB_REPOSITORY || source.runnerName !== route.runnerName || source.target !== route.target
    || (options.rollbackChannel === undefined && source.channel !== route.channel)
    || source.sourceRef !== route.sourceRef || source.commit !== route.commit
    || source.preset !== route.preset) {
    throw new Error('desktop publish: local package differs from the routed request')
  }
  const diagnostic = desktopPublishQualificationError(source.qualification)
  if (diagnostic) throw new Error(diagnostic)
  if (source.qualification !== (source.target === 'win-x64' ? 'signed' : 'notarized')) throw new Error('desktop publish: package qualification does not match its platform')
  const config = await readDesktopPublishConfig(env.DSH_PACKAGING_CONFIG_DIR!, source.preset)
  const directory = retainedDesktopPath(root, route.runId, route.attempt)
  const environment = source.preset === 'test'
    ? { DSH_DESKTOP_AUTO_UPDATE_ENV: 'test', DOWNLOAD_TEST_ORIGIN: config.origin,
      DOWNLOAD_TEST_RELEASE_ID: source.testReleaseId ?? '', DOWNLOAD_TEST_COS_BUCKET: config.bucket }
    : { DSH_DESKTOP_AUTO_UPDATE_ENV: 'production', DOWNLOAD_PROD_COS_BUCKET: config.bucket }
  const plans = []
  for (const channel of channels) {
    const plan = await createDesktopUploadPlan(source.target, {
      artifactsRoot: directory,
      stagingPercentage,
      packagedProductVersion: source.productVersion,
      packagedChannel: source.channel,
      environment: { ...environment, DSH_DESKTOP_UPDATE_CHANNEL: channel },
    })
    if (plan.version !== source.version || plan.commit !== source.commit || plan.dirty !== false) {
      throw new Error('desktop publish: completion record differs from retained source or has uncommitted changes')
    }
    plans.push({ channel, plan })
  }
  await verifySignatures(directory, manifest, config)
  const approval = createHash('sha256').update(JSON.stringify({ manifest, plans, uploadWebsite })).digest('hex')
  if (env.DESKTOP_APPROVED_PACKAGE && env.DESKTOP_APPROVED_PACKAGE !== approval) {
    throw new Error('desktop publish: package or destination changed after approval')
  }
  return { route, manifest, config, channels, plans, plan: plans[0]?.plan, root, approval, stagingPercentage, uploadWebsite }
}

/**
 * Publish each selected target channel sequentially under its own lock, journal, and production tag check.
 * @param prepared Validated publication context from {@link prepareDesktopPublication}.
 * @param env Actions environment providing actor, summary, output, and tag token settings.
 * @param dependencies COS transport factory, tag publisher, and phase tracker; tests inject local doubles.
 * @returns Nothing after all selected channels complete; sets exitCode 1 when a published channel leaves a tag pending.
 */
export async function executeDesktopChannelPublications(
  prepared: Awaited<ReturnType<typeof prepareDesktopPublication>>,
  env: NodeJS.ProcessEnv,
  dependencies: {
    readonly createTransport: (plan: typeof prepared.plans[number]['plan']) => DesktopPublishTransport
    readonly createTag?: typeof publishDesktopTag
    readonly onPhase?: (phase: string) => void
  },
): Promise<void> {
  const { route, manifest, plans, root, stagingPercentage } = prepared
  const createTag = dependencies.createTag ?? publishDesktopTag
  const setPhase = dependencies.onPhase ?? (() => {})
  const recordsRoot = join(dirname(root), 'upload-records')
  const directories: string[] = []
  for (const { channel, plan } of plans) {
    const destination = `${plan.bucket}/${plan.publicUrl}${channel}`
    let phase = `channel lock and publication journal acquisition (${channel})`
    setPhase(phase)
    await withDesktopChannelLock(join(dirname(root), 'publish-locks'), destination, async () => {
      const published = await wasDesktopAttemptPublished(recordsRoot,
        { repository: manifest.source.repository, runId: route.runId, attempt: route.attempt, destination, stagingPercentage })
      const journal = await createDesktopPublicationRecord(recordsRoot, {
        repository: manifest.source.repository, runId: route.runId, attempt: route.attempt,
        actor: env.GITHUB_TRIGGERING_ACTOR || env.GITHUB_ACTOR || 'unknown',
        destination, stagingPercentage, operation: 'publish', reason: `Actions publication (${channel})`,
      })
      directories.push(journal.directory)
      if (env.GITHUB_OUTPUT) {
        await appendFile(env.GITHUB_OUTPUT,
          `record=${journal.directory}\nrecords<<EOF\n${directories.map(dir => `${dir}/`).join('\n')}\nEOF\n`)
      }
      let status: 'complete' | 'failed' | 'published-tag-pending' = 'failed'
      try {
        phase = `remote object reconciliation and publication (${channel})`
        setPhase(phase)
        const tag = async () => {
          await createTag(manifest.source.repository, plan.version, route.commit, env.DESKTOP_TAG_TOKEN || '')
        }
        const result = published
          ? await (async () => {
            await journal.record({ type: 'feeds-complete' })
            if (plan.environment === 'production') {
              try { await tag() } catch (cause) {
                await journal.record({ type: 'tag-pending' })
                return { status: 'published-tag-pending' as const, cause }
              }
            }
            await journal.record({ type: 'complete' })
            return { status: 'complete' as const }
          })()
          : await publishDesktopRelease(plan, {
            transport: dependencies.createTransport(plan), record: event => journal.record(event),
            tag,
          })
        status = result.status
        if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY,
          `\nDesktop publication (${channel}): **${status}**\n\n${plan.target} ${plan.version}\n\nSource: ${route.runId}, attempt ${route.attempt}\n`)
        if (result.status === 'published-tag-pending') {
          const failure = desktopPublicationFailure(result.cause, 'release tag creation')
          await journal.record({ type: 'failed', failure })
          process.stderr.write(`${JSON.stringify(failure)}\n`)
          process.exitCode = 1
        }
      } catch (error) {
        await journal.record({ type: 'failed', failure: desktopPublicationFailure(error, phase) })
        throw error
      } finally { await journal.finish(status) }
    })
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
  let phase = 'local package, destination and signature verification'
  try {
    const mode = process.argv[2]
    if (process.argv.length !== 3 || (mode !== '--check' && mode !== '--publish')) {
      throw new Error('Usage: publish-desktop-ci.ts --check|--publish')
    }
    const env = process.env
    const prepared = await prepareDesktopPublication(env)
    const { route, manifest, config, channels, plans, approval, uploadWebsite } = prepared
    if (mode === '--publish' && !env.DESKTOP_APPROVED_PACKAGE) throw new Error('desktop publish: approved package digest is required')
    if (uploadWebsite && route.preset === 'production') requireDesktopEdgeOneZoneId(config)
    const channelsRequested = plans.length > 0
    if (mode === '--check') {
      const channelLabel = channelsRequested ? channels.join('+') : 'website'
      const websiteDest = createHash('sha256').update(`${config.bucket}/${route.target}`).digest('hex')
      if (env.GITHUB_OUTPUT) {
        await appendFile(env.GITHUB_OUTPUT, [
          `channels-requested=${channelsRequested}`,
          `website-destination=${websiteDest}`,
          `website-approval=${websiteApproval(manifest, config.bucket)}`,
          `approval=${approval}`,
          `label=${manifest.source.version} → ${channelLabel} / ${route.target} / ${route.preset}`,
          '',
        ].join('\n'))
      }
      if (env.GITHUB_STEP_SUMMARY && !env.DESKTOP_APPROVED_PACKAGE) await appendFile(env.GITHUB_STEP_SUMMARY,
        await desktopPublicationSummary(manifest.source, plans, approval, uploadWebsite, config.bucket))
      if (env.GITHUB_OUTPUT && config.githubApp) await appendFile(env.GITHUB_OUTPUT,
        `app-client-id=${config.githubApp.clientId}\napp-key-file=${config.githubApp.privateKeyFile}\n`)
      process.stdout.write(`desktop publish: verified ${route.target} ${manifest.source.version}; no credentials read or COS requests made\n`)
    } else {
      if (!channelsRequested) throw new Error('desktop publish: no update channel selected for COS feed publication')
      if (route.preset === 'production' && !env.DESKTOP_TAG_TOKEN) throw new Error('desktop publish: GitHub App token is required before production upload')
      phase = 'upload credential loading'
      const credentials = await readDesktopUploadCredentials(config)
      await executeDesktopChannelPublications(prepared, env, {
        createTransport: plan => desktopPublishCos(plan, credentials),
        onPhase: (next) => { phase = next },
      })
    }
  } catch (error) {
    process.stderr.write(`${JSON.stringify(desktopPublicationFailure(error, phase))}\n`)
    process.exitCode = 1
  }
}
