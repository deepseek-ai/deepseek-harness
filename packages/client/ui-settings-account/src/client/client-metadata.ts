/**
 * Platform client identity for one account call. The Host turns these fields
 * into the Platform request headers, so the browser sends the UI language and
 * the local UTC offset rather than any credential.
 * @module @deepseek-ai/dsh-client-ui-settings-account/src/client/client-metadata
 */
import type { AccountClientMetadata } from '@deepseek-ai/dsh-deepseek-account/types'

/**
 * Build the request identity for one account call.
 * @param locale - active UI language; the Host reduces it to the Platform wire locale.
 * @param version - client build version inlined by the bundle.
 * @returns the metadata the account Remote methods carry.
 * @throws Error when the build carries no version, instead of reporting an empty one.
 */
export function accountClientMetadata(locale: string, version: string | undefined): AccountClientMetadata {
  if (version === undefined || version === '') throw new Error('account: this client build carries no DSH_CLIENT_VERSION')
  return {
    version,
    locale,
    // Date.getTimezoneOffset reports minutes west of UTC; Platform wants seconds east.
    timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
  }
}
