/**
 * @deepseek-ai/dsh-harness-dev-context — model context for an agent that can
 * inspect and extend the DeepSeek Harness serving its Web GUI. It registers
 * path- and URL-free prompt sections and states the current implementation
 * checkout and Web GUI URL as runtime context, so a process started from
 * another checkout, port, or installation leaves the system prompt unchanged.
 * A Session whose admitted prompt holds the paragraphs that embedded those
 * values keeps them verbatim, so resuming it never rewrites its logged prompt.
 * @module @deepseek-ai/dsh-harness-dev-context
 */

import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { z as zod } from 'zod'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-web-app'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt'

/** Stable Cordis plugin name. */
export const name = 'harness-dev-context'

/** Prompt registries, the projection registry, and the Web GUI whose URL the model learns. */
export const inject = ['systemPrompt', 'sessionProjections', 'webApp']

/** This installation's root, four directories above this package's source or built entry. */
const SOURCE_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))

/** Prompt-section and runtime-context name for the implementation checkout. */
const HARNESS_SOURCE = 'harness:source'

/** Prompt-section and runtime-context name for the Web GUI orientation and its URL. */
const WEB_SURFACE = 'app:web-surface'

const HARNESS_SOURCE_GUIDANCE = 'The checkout location and current working directory are separate values and may differ; '
  + 'never infer the working directory from the checkout path. Use pwd to determine the current working directory. '
  + 'Use this checkout only to inspect or extend DSH itself.'

const HARNESS_SOURCE_PROMPT = `The runtime context names the DeepSeek Harness implementation checkout. ${HARNESS_SOURCE_GUIDANCE}`

const WEB_SURFACE_GUIDANCE = 'When the user refers to "this page", "this GUI", or "this app" without naming another target, they mean this GUI. '
  + 'The browser provides no implicit DOM, route, or screenshot context. '
  + 'The client-plugin HMR receiver is active, but client-plugin changes reload without a refresh only while '
  + '`pnpm run dev:web` is also running from this same checkout to rebuild their bundles; verify that watcher before promising automatic updates. '
  + 'Every other change — the apps/web shell and plain packages — requires rebuilding the affected Web artifacts and verifying this existing URL after a page refresh. '
  + 'Starting another server does not update this GUI. '
  + 'The apps/web Vite entry builds the shell but is not a standalone application because only dsh web injects window.__DSH_BOOT__. '
  + 'Do not start a replacement server unless the user asks; if one is needed, use a managed background job and verify its exact URL.'

const WEB_SURFACE_PROMPT = `You are interacting with the user through the DeepSeek Harness Web GUI whose URL the runtime context names. ${WEB_SURFACE_GUIDANCE}`

/**
 * Fixed text around the value in each paragraph that embedded it, frozen as
 * those releases rendered it: never edit these together with the current
 * guidance, or Sessions holding the earlier paragraphs stop matching and
 * rewrite their logged prompt.
 */
const LEGACY_SOURCE = {
  prefix: 'The DeepSeek Harness implementation checkout is at ',
  suffix: '. The checkout location and current working directory are separate values and may differ; '
    + 'never infer the working directory from this path. Use pwd to determine the current working directory. '
    + 'Use this checkout only to inspect or extend DSH itself.',
}
// The frozen copy repeats today's guidance on purpose; the two may diverge.
/* jscpd:ignore-start */
const LEGACY_WEB_SURFACE = {
  prefix: 'You are interacting with the user through the DeepSeek Harness Web GUI at ',
  suffix: '. When the user refers to "this page", "this GUI", or "this app" without naming another target, they mean this GUI. '
    + 'The browser provides no implicit DOM, route, or screenshot context. '
    + 'The client-plugin HMR receiver is active, but client-plugin changes reload without a refresh only while '
    + '`pnpm run dev:web` is also running from this same checkout to rebuild their bundles; verify that watcher before promising automatic updates. '
    + 'Every other change — the apps/web shell and plain packages — requires rebuilding the affected Web artifacts and verifying this existing URL after a page refresh. '
    + 'Starting another server does not update this GUI. '
    + 'The apps/web Vite entry builds the shell but is not a standalone application because only dsh web injects window.__DSH_BOOT__. '
    + 'Do not start a replacement server unless the user asks; if one is needed, use a managed background job and verify its exact URL.',
}
/* jscpd:ignore-end */

/** Host-only projection key of the value-bearing paragraphs a Session admitted. */
const LEGACY_PROMPT = 'harnessDevLegacyPrompt'

const legacyPromptSchema = zod.object({ source: zod.string().nullable(), web: zod.string().nullable() })

/** Value-bearing paragraphs of the latest nonempty system prompt a Session committed; `null` where it has none. */
type LegacyPrompt = zod.infer<typeof legacyPromptSchema>

/** The complete single-line paragraph between `prefix` and `suffix`, or `null` when the prompt has none. */
function legacyParagraph(prompt: string, { prefix, suffix }: { prefix: string; suffix: string }): string | null {
  const start = prompt.indexOf(prefix)
  if (start < 0) return null
  const end = prompt.indexOf(suffix, start + prefix.length)
  if (end < 0) return null
  const paragraph = prompt.slice(start, end + suffix.length)
  return paragraph.includes('\n') ? null : paragraph
}

/**
 * Fold one committed event into the admitted paragraphs. Like the loop's own
 * prompt-version reading, only a single nonempty text block is a prompt
 * version; an emptied or other version keeps the previous state, because a
 * series consolidation can log only the emptied later version.
 */
function foldLegacyPrompt(state: LegacyPrompt, event: SessionEvent): LegacyPrompt {
  if (event.type !== 'system/message') return state
  const { content } = event.data.message
  const [block] = content
  if (content.length !== 1 || block?.type !== 'text' || block.text === '') return state
  const source = legacyParagraph(block.text, LEGACY_SOURCE)
  const web = legacyParagraph(block.text, LEGACY_WEB_SURFACE)
  return source === state.source && web === state.web ? state : { source, web }
}

const ADMITS_NOTHING: LegacyPrompt = { source: null, web: null }

/**
 * Register the two sections, their runtime-context values, and the
 * projection that keeps a Session's admitted paragraphs.
 * @param ctx - plugin context with every {@link inject} service.
 * @returns after the projection reader and prompt registrations are ready.
 */
export async function apply(ctx: Context): Promise<void> {
  const legacyPromptProjectionHandle = await ctx.sessionProjections.register({
    key: LEGACY_PROMPT,
    stateVersion: 1,
    stateSchema: legacyPromptSchema,
    init: () => ADMITS_NOTHING,
    apply: foldLegacyPrompt,
  })
  const admitted = (context: AssembleContext): LegacyPrompt => {
    const session = context.agent?.session
    return session === undefined ? ADMITS_NOTHING : legacyPromptProjectionHandle.stateOf(session)
  }
  ctx.systemPrompt.section({
    name: HARNESS_SOURCE,
    order: ctx.systemPrompt.getSectionOrder('HARNESS_SOURCE'),
    interpolate: false,
    text: context => admitted(context).source ?? HARNESS_SOURCE_PROMPT,
  })
  ctx.systemPrompt.context({
    name: HARNESS_SOURCE,
    order: ctx.systemPrompt.getContextOrder('HARNESS_SOURCE'),
    interpolate: false,
    text: `Current DeepSeek Harness implementation checkout: ${JSON.stringify(SOURCE_ROOT)}.`,
  })
  ctx.systemPrompt.section({
    name: WEB_SURFACE,
    order: ctx.systemPrompt.getSectionOrder('WEB_SURFACE'),
    interpolate: false,
    text: context => admitted(context).web ?? WEB_SURFACE_PROMPT,
  })
  ctx.systemPrompt.context({
    name: WEB_SURFACE,
    order: ctx.systemPrompt.getContextOrder('WEB_SURFACE'),
    interpolate: false,
    text: () => `Current DeepSeek Harness Web GUI URL: ${JSON.stringify(ctx.webApp.getAdvertisedUrl())}.`,
  })
}
