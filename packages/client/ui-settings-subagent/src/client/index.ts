/**
 * The Subagent settings page, browser half: the delegation limits over the
 * `subagent` namespace and the models agents may choose over the
 * `subagent-model-selection` namespace, on one page with one save. The page
 * registers into the Plugins page's `plugins.item` slot while the Host serves
 * either namespace and shows the sections it serves.
 */

// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the ctx.configForms Context merge. Cross-plugin collaboration
// goes through the service, never a value import (client bundle purity gate).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: the Plugins page's SlotMap merge (the 'plugins.item' entry).
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the ctx.remote Context merge and the forwarded-event key face.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { SubagentCard } from './SubagentCard.tsx'
import { subagentCardFace } from './subagent-card-controller.ts'
import { SubagentLimitsCardController } from './subagent-limits-card-controller.ts'
import {
  SUBAGENT_MODEL_SELECTION_NS, SubagentModelSelectionCardController,
} from './subagent-model-selection-card-controller.ts'
import { en, zh, type SubagentSettingsLocaleKey } from './locales.ts'

export type { SubagentCardProps } from './SubagentCard.tsx'
export type { SubagentCardFace } from './subagent-card-controller.ts'
export type { SubagentLimitsCardFace, SubagentLimitsCardState, SubagentLimitsSettings } from './subagent-limits-card-controller.ts'
export type {
  SubagentModelSelectionCardFace, SubagentModelSelectionCardState, SubagentModelSelectionSettings,
} from './subagent-model-selection-card-controller.ts'
export type { SubagentSettingsLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Subagent settings page copy. */
    'settings.subagent': SubagentSettingsLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.subagent'

/**
 * Namespace of the delegation limits. Spelled here rather than imported: a
 * client package must not depend on a Host package.
 */
export const SUBAGENT_NS = 'subagent'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'remote', 'remote.session', 'configForms']

/**
 * Mount the Subagent settings page while the Host serves either of its namespaces.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-subagent: dictionaries')
  const limits = new SubagentLimitsCardController(ctx.configForms.get(SUBAGENT_NS))
  ctx.effect(() => () => { limits.dispose() }, 'ui-settings-subagent: limits form subscription')
  const models = new SubagentModelSelectionCardController(
    ctx.configForms.get(SUBAGENT_MODEL_SELECTION_NS),
    ctx,
  )
  const limitsFace = limits.inject()
  const modelsFace = models.inject()
  // The model catalogue is not part of any settings section: adapters come and
  // go, and a document commit elsewhere can change which routes are stored.
  ctx.effect(
    () => ctx.remote.$on('llm/adapters-updated', () => { models.refreshCatalog() }),
    'ui-settings-subagent: adapter invalidations',
  )
  ctx.effect(
    () => ctx.remote.$on('settings/document-updated', () => { models.refreshCatalog() }),
    'ui-settings-subagent: settings invalidations',
  )
  ctx.effect(
    () => ctx.on('connection/reset', () => { models.resetConnection() }),
    'ui-settings-subagent: connection generation',
  )
  ctx.effect(() => () => { models.dispose() }, 'ui-settings-subagent: model preference')
  ctx.effect(() => ctx.configForms.whileServed([SUBAGENT_NS, SUBAGENT_MODEL_SELECTION_NS], () => ctx.slots.inject('plugins.item', () => ctx.slots.register({
    name: 'plugins.item',
    id: 'subagent',
    order: 30,
    label: () => t('subagentTitle'),
    locale: NS,
    inject: () => subagentCardFace(limitsFace, modelsFace),
  }, SubagentCard))), 'ui-settings-subagent: page')
}
