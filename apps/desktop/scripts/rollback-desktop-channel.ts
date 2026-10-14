/** Manual channel restoration: read-only preview unless --execute is explicitly present. */
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { z } from 'zod'
import { prepareDesktopPublication } from './publish-desktop-ci.ts'
import { readDesktopUploadCredentials } from './desktop-publish-config.ts'
import { desktopPublishCos } from './desktop-publish-cos.ts'
import { createDesktopPublicationRecord, withDesktopChannelLock } from './desktop-publish-record.ts'
import { rollbackDesktopChannel } from './desktop-rollback.ts'
import { desktopPublicationFailure } from './desktop-publication-failure.ts'

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
  let phase = 'rollback arguments and local publication verification'
  try {
    const { values } = parseArgs({ options: {
      record: { type: 'string' }, 'expected-version': { type: 'string' },
      reason: { type: 'string' }, execute: { type: 'boolean', default: false },
    } })
    if (!values.record || !values['expected-version'] || !values.reason?.trim()) {
      throw new Error('Usage: rollback-desktop-channel.ts --record <successful-publication-directory> --expected-version <online-version> --reason <reason> [--execute]')
    }
    const operation = z.object({ repository: z.string(), runId: z.string(),
      attempt: z.string(), destination: z.string(), operation: z.literal('publish') })
      .parse(JSON.parse(await readFile(join(values.record, 'operation.json'), 'utf8')))
    z.object({ status: z.enum(['complete', 'published-tag-pending']) })
      .parse(JSON.parse(await readFile(join(values.record, 'result.json'), 'utf8')))
    const { plan, config, root, manifest } = await prepareDesktopPublication(process.env)
    const route = z.object({ runId: z.string(), attempt: z.string() }).parse(JSON.parse(process.env.DESKTOP_PUBLISH_ROUTE || '{}'))
    const destination = `${plan.bucket}/${plan.publicUrl}${manifest.source.channel}`
    if (operation.runId !== route.runId || operation.attempt !== route.attempt
      || operation.repository !== process.env.GITHUB_REPOSITORY || operation.destination !== destination) {
      throw new Error('desktop rollback: successful publication record does not match the selected package')
    }
    const credentials = await readDesktopUploadCredentials(config)
    phase = 'rollback channel lock and audit creation'
    await withDesktopChannelLock(join(dirname(root), 'publish-locks'), destination, async () => {
      const journal = await createDesktopPublicationRecord(join(dirname(root), 'upload-records'), {
        ...operation, actor: process.env.USER || process.env.USERNAME || 'unknown', operation: 'rollback', reason: values.reason!,
      })
      process.stdout.write(`desktop rollback: audit ${journal.directory}\n`)
      let complete = false
      try {
        phase = 'historical object verification and channel restoration'
        const outcome = await rollbackDesktopChannel(plan, values['expected-version']!, values.execute!, {
          transport: desktopPublishCos(plan, credentials), record: event => journal.record(event),
          tag: async () => { throw new Error('desktop rollback never changes tags') },
        })
        process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`)
        complete = true
      } catch (error) {
        await journal.record({ type: 'failed', failure: desktopPublicationFailure(error, phase) })
        throw error
      } finally { await journal.finish(complete ? (values.execute ? 'complete' : 'preview') : 'failed') }
    })
  } catch (error) {
    process.stderr.write(`${JSON.stringify(desktopPublicationFailure(error, phase))}\n`)
    process.exitCode = 1
  }
}
