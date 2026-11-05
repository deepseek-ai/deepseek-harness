/** Localized display names for standard reasoning levels, without changing provider IDs or custom names. */
import type { ModelReasoningEffort } from '@deepseek-ai/dsh-api-remotes/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'

/**
 * Translate standard IDs only when the provider's name repeats that ID, ignoring case.
 * @param effort - Provider-owned level ID and display name.
 * @param t - The model namespace translator.
 * @returns The localized standard name, or the provider's unchanged custom or unknown name.
 */
export function effortDisplayName(effort: Pick<ModelReasoningEffort, 'id' | 'name'>, t: PropsLocale<'model'>['t']): string {
  if (effort.name.toLowerCase() !== effort.id) return effort.name
  switch (effort.id) {
    case 'off': return t('effort.off')
    case 'minimal': return t('effort.minimal')
    case 'low': return t('effort.low')
    case 'medium': return t('effort.medium')
    case 'high': return t('effort.high')
    case 'xhigh': return t('effort.xhigh')
    case 'max': return t('effort.max')
    // Providers may advertise other IDs; their names remain provider-owned.
    default: return effort.name
  }
}
