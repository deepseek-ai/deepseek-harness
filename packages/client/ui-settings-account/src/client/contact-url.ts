/** Feishu questionnaire context: Harness build and reported environment. */
import type { AccountUserId } from '@deepseek-ai/dsh-deepseek-account/types'
import type { SyncedConfig } from '@deepseek-ai/dsh-client-config/types'
import type { ContactConfig } from '../contact-config.ts'

/** Questionnaire destination while the Host sends none; the Host schema default. */
const ABSENT_CONTACT_FORM_URL = 'https://trtgsjkv6r.feishu.cn/share/base/form/shrcnlCoGElW7MQznGy9r3YYXcg?hide_uid=1&hide_device_info=1&hide_harness_version=1'
/** Questionnaire source option while the Host sends none; the Host schema default. */
const ABSENT_CONTACT_SOURCE = ''

/**
 * Build an external questionnaire URL without authentication credentials.
 * @param config - Host-synced questionnaire destination and source option, read at this call.
 * @param context - account, build and environment facts sampled by the caller.
 * @returns questionnaire URL with hidden, optionally prefilled context fields.
 */
export function contactUrl(config: SyncedConfig<ContactConfig>, context: {
  uid: AccountUserId | null | undefined
  version: string | undefined
  deviceInfo: string
  width: number
  height: number
  pixelRatio: number
}): string {
  const url = new URL(config.contactFormUrl.get() ?? ABSENT_CONTACT_FORM_URL)
  const ratio = Number.isFinite(context.pixelRatio) ? context.pixelRatio : 1
  const width = Math.round(context.width * ratio)
  const height = Math.round(context.height * ratio)
  const deviceInfo = [context.deviceInfo]
  if (width > 0 && height > 0) deviceInfo.push(`screen_resolution=${width}x${height}`)
  const fields = {
    uid: context.uid, source: config.contactSource.get() ?? ABSENT_CONTACT_SOURCE, harness_version: context.version,
    device_info: deviceInfo.filter(Boolean).join('; '),
  }
  for (const [name, value] of Object.entries(fields)) {
    url.searchParams.set(`hide_${name}`, '1')
    url.searchParams.delete(`prefill_${name}`)
    if (value) url.searchParams.set(`prefill_${name}`, value)
  }
  // Exclude unsupported questionnaire fields from configured URLs.
  for (const name of ['os_version', 'device_brand', 'app_locale', 'screen_resolution', 'app_version', 'device_model']) {
    url.searchParams.delete(`prefill_${name}`)
    url.searchParams.delete(`hide_${name}`)
  }
  return url.href
}
