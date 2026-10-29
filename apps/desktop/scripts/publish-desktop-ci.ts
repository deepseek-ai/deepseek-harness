/** Publish a retained package selected by the preparation job; --check never reads secrets or contacts COS. */
import { createHash } from 'node:crypto'
import { appendFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import { readDesktopPublishConfig, readDesktopUploadCredentials } from './desktop-publish-config.ts'
import { desktopReleasesRoot } from './retain-desktop-ci.ts'
import { retainedDesktopPath, verifyRetainedDesktopRelease } from './desktop-release-store.ts'
import { verifyRetainedDesktopSignatures } from './verify-retained-desktop.ts'
import { createDesktopUploadPlan } from './desktop-upload-plan.ts'
import { desktopPublishCos } from './desktop-publish-cos.ts'
import { createDesktopPublicationRecord, wasDesktopAttemptPublished, withDesktopChannelLock } from './desktop-publish-record.ts'
import { publishDesktopRelease } from './desktop-publish.ts'
import { desktopPublicationFailure } from './desktop-publication-failure.ts'
import { desktopPublicationSummary } from './desktop-publication-summary.ts'
import { publishDesktopTag } from './desktop-publish-tag.ts'
import { desktopPublishQualificationError } from './desktop-publish-qualification.mjs'

const routeSchema = z.object({ runId: z.string(), attempt: z.string(), commit: z.string(), runnerName: z.string(),
  sourceRef: z.string(), channel: z.enum(['nightly', 'latest']),
  target: z.enum(['mac-arm64', 'mac-x64', 'win-x64']), preset: z.enum(['test', 'production']) })

/**
 * Check retained bytes, original machine, destination and signatures before reading any upload secret.
 * @param env Router output and machine configuration directory.
 * @param verifySignatures Platform verifier; tests inject a verifier for fixture bytes.
 * @returns Validated local publication context; no network operation is performed.
 */
export async function prepareDesktopPublication(env: NodeJS.ProcessEnv, verifySignatures = verifyRetainedDesktopSignatures) {
  const route = routeSchema.parse(JSON.parse(env.DESKTOP_PUBLISH_ROUTE || '{}'))
  if (route.runnerName !== env.RUNNER_NAME) throw new Error('desktop publish: task was dispatched to a different machine')
  const root = desktopReleasesRoot(env)
  const manifest = await verifyRetainedDesktopRelease(root, route.runId, route.attempt)
  const source = manifest.source
  if (source.repository !== env.GITHUB_REPOSITORY || source.runnerName !== route.runnerName || source.target !== route.target
    || source.channel !== route.channel || source.sourceRef !== route.sourceRef || source.commit !== route.commit
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
  const plan = await createDesktopUploadPlan(source.target, { artifactsRoot: directory,
    packagedProductVersion: source.productVersion, environment: { ...environment, DSH_DESKTOP_UPDATE_CHANNEL: source.channel } })
  if (plan.version !== source.version || plan.commit !== source.commit || plan.dirty !== false) throw new Error('desktop publish: completion record differs from retained source or has uncommitted changes')
  await verifySignatures(directory, manifest, config)
  const approval = createHash('sha256').update(JSON.stringify({ manifest, plan })).digest('hex')
  if (env.DESKTOP_APPROVED_PACKAGE && env.DESKTOP_APPROVED_PACKAGE !== approval) throw new Error('desktop publish: package or destination changed after approval')
  return { route, manifest, config, plan, root, approval }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
  let phase = 'local package, destination and signature verification'
  try {
    const mode = process.argv[2]
    if (process.argv.length !== 3 || (mode !== '--check' && mode !== '--publish')) throw new Error('Usage: publish-desktop-ci.ts --check|--publish')
    const env = process.env
    const { route, manifest, config, plan, root, approval } = await prepareDesktopPublication(env)
    if (mode === '--publish' && !env.DESKTOP_APPROVED_PACKAGE) throw new Error('desktop publish: approved package digest is required')
    if (mode === '--check') {
      if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, `approval=${approval}\nlabel=${plan.version} → ${manifest.source.channel} / ${plan.target} / ${plan.environment}\n`)
      if (env.GITHUB_STEP_SUMMARY && !env.DESKTOP_APPROVED_PACKAGE) await appendFile(env.GITHUB_STEP_SUMMARY,
        await desktopPublicationSummary(manifest.source, plan, approval))
      if (env.GITHUB_OUTPUT && config.githubApp) await appendFile(env.GITHUB_OUTPUT,
        `app-client-id=${config.githubApp.clientId}\napp-key-file=${config.githubApp.privateKeyFile}\n`)
      process.stdout.write(`desktop publish: verified ${plan.target} ${plan.version}; no credentials read or COS requests made\n`)
    } else {
      if (plan.environment === 'production' && !env.DESKTOP_TAG_TOKEN) throw new Error('desktop publish: GitHub App token is required before production upload')
      phase = 'upload credential loading'
      const credentials = await readDesktopUploadCredentials(config)
      const destination = `${plan.bucket}/${plan.publicUrl}${manifest.source.channel}`
      const recordsRoot = join(dirname(root), 'upload-records')
      phase = 'channel lock and publication journal acquisition'
      await withDesktopChannelLock(join(dirname(root), 'publish-locks'), destination, async () => {
        const published = await wasDesktopAttemptPublished(recordsRoot,
          { repository: manifest.source.repository, runId: route.runId, attempt: route.attempt, destination })
        const journal = await createDesktopPublicationRecord(recordsRoot, {
          repository: manifest.source.repository, runId: route.runId, attempt: route.attempt,
          actor: env.GITHUB_TRIGGERING_ACTOR || env.GITHUB_ACTOR || 'unknown',
          destination, operation: 'publish', reason: 'Actions publication',
        })
        if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, `record=${journal.directory}\n`)
        let status: 'complete' | 'failed' | 'published-tag-pending' = 'failed'
        try {
          phase = 'remote object reconciliation and publication'
          const tag = async () => { await publishDesktopTag(manifest.source.repository,
            plan.version, route.commit, env.DESKTOP_TAG_TOKEN || '') }
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
              transport: desktopPublishCos(plan, credentials), record: event => journal.record(event),
              tag,
            })
          status = result.status
          if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY,
            `\nDesktop publication: **${status}**\n\n${plan.target} ${plan.version}\n\nSource: ${route.runId}, attempt ${route.attempt}\n`)
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
  } catch (error) {
    process.stderr.write(`${JSON.stringify(desktopPublicationFailure(error, phase))}\n`)
    process.exitCode = 1
  }
}
