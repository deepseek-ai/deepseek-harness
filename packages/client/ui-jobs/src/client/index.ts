/**
 * Background-job plugin, browser half: contributes the Session panel's
 * background-jobs section. Job rows, per-row observation streams, and the
 * human kill all go through the `jobs` client service; this plugin holds no
 * transport state of its own.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { JobId } from '@deepseek-ai/dsh-jobs/brand'
import { JobsSection } from './JobsSection.tsx'
import type { JobsSectionInjected } from './JobsSection.tsx'
import type {} from '@deepseek-ai/dsh-api-job-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-session-panel/client'
import { en, ja, es, fr, de, ru, pt, NS, zh, type JobKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Background-job list copy. */
    'job': JobKey
  }
}

export type { JobsSectionProps, JobsSectionInjected } from './JobsSection.tsx'

/** Required services: the jobs rosters, observations, and kill, the slot registry, and dictionaries. */
export const inject = ['jobs', 'slots', 'locale']

/**
 * Client plugin body: register the dictionaries and the Session panel section.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'ui-jobs: dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.slots.inject(
    'conversation.session.panel.section',
    () => ctx.slots.register({
      name: 'conversation.session.panel.section',
      id: 'background-jobs',
      // After change requests (100) and subagents (200).
      order: 300,
      label: () => t('list.aria'),
      locale: NS,
      inject: (): JobsSectionInjected => ({
        hooks: { jobs: ctx.jobs.state },
        watchRows: sessionId => ctx.jobs.watchRows(sessionId),
        observe: (sessionId, id) => ctx.jobs.observe(sessionId, id),
        // The brand is nominal typing only; the row key is the registry id the
        // roster stream delivered, so the wire boundary stamps it back here.
        killJob: async (sessionId, jobId) => (await ctx.jobs.kill(sessionId, jobId as JobId)).ok,
      }),
    }, JobsSection),
  )
}
