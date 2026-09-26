/** Platform Web profile and wallet queries projected for account UI consumers. */
import { z } from 'zod'
import type { AccountBonusNotification, AccountBonusOrderId, AccountDetails, AccountProfile, AccountUserId } from '@deepseek-ai/dsh-deepseek-account/types'
import { AccountUnauthorizedError, PlatformAuthError, requestAccount, requestBonusNotified, requestUnnotifiedBonuses } from './protocol.ts'

const user = z.object({
  id: z.string().nullish(),
  email: z.string(), mobile: z.string().optional(), mobile_number: z.string().optional(),
  id_profile: z.object({ name: z.string().nullable(), picture: z.string().nullish() }).nullish(),
})
// balance and amount arrive as strings that Platform's Web client passes to big.js, whose decimal
// grammar also accepts an omitted integer or fraction part and a decimal exponent (0E-16, 1e+3).
const decimal = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i
const wallet = z.object({
  currency: z.enum(['CNY', 'USD']), balance: z.string().regex(decimal),
})
const summary = z.object({ normal_wallets: z.array(wallet), bonus_wallets: z.array(wallet) })
const bonus = z.object({
  order_id: z.uuid(), campaign: z.string(), amount: z.string().regex(decimal),
  currency: z.enum(['CNY', 'USD']), granted_at: z.string(), expires_at: z.string(), msg: z.string(),
})
// The shared response reader already unwraps biz_data, so the payload is the bonus list itself.
const unnotified = z.array(bonus)

/** Project Platform user data without retaining credentials or unneeded fields.
 * @param value - current or exchange user response.
 * @returns UI account profile.
 */
export function profile(value: unknown): AccountProfile {
  const parsed = user.safeParse(value)
  if (!parsed.success) throw new PlatformAuthError('protocol')
  const { email, mobile, mobile_number: mobileNumber, id_profile: identity } = parsed.data
  return {
    id: parsed.data.id == null ? null : parsed.data.id as AccountUserId,
    avatarUrl: identity?.picture || null,
    name: identity?.name || null, contact: mobile || mobileNumber || email || null,
  }
}

const queries: { [K in keyof AccountDetails]: {
  path: '/auth-api/v0/users/current' | '/api/v0/users/get_user_summary'
  parse: (value: unknown) => AccountDetails[K]
} } = {
  profile: { path: '/auth-api/v0/users/current', parse: value => ({ status: 'ready', value: profile(value) }) },
  balance: { path: '/api/v0/users/get_user_summary', parse: (value) => {
    const parsed = summary.safeParse(value)
    if (!parsed.success) throw new PlatformAuthError('protocol')
    return { status: 'ready', value: parsed.data.normal_wallets, bonusWallets: parsed.data.bonus_wallets }
  } },
}

/**
 * Read one Platform account field without waiting for the other query.
 * @param field - profile or recharge and bonus wallet balances.
 * @param origin - configured origin matching the stored grant issuer.
 * @param token - stored authorization token; response tokens are discarded.
 * @param signal - request and credential lifetime.
 * @param headers - validated deployment headers for the configured origin.
 * @returns sanitized query outcome; failure never becomes a zero balance.
 * @throws AccountUnauthorizedError when Platform rejects the stored token with HTTP 401 or response code 40003.
 */
export async function readAccountDetail<K extends keyof AccountDetails>(field: K, origin: string, token: string,
  signal: AbortSignal, headers: Record<string, string>): Promise<AccountDetails[K]> {
  const query = queries[field]
  try { return query.parse(await requestAccount(origin, query.path, token, signal, headers)) }
  catch (error) {
    if (error instanceof AccountUnauthorizedError) throw error
    return { status: 'failed' }
  }
}

/**
 * Read the unnotified bonus list for one captured credential.
 * @param origin - configured origin matching the stored grant issuer.
 * @param token - captured account grant; the caller has already bound it to the account.
 * @param signal - credential lifetime and request timeout.
 * @param headers - deployment and client identity headers for the configured origin.
 * @returns notifications in Platform order; a malformed payload is a protocol failure.
 */
export async function readUnnotifiedBonuses(origin: string, token: string,
  signal: AbortSignal, headers: Record<string, string>): Promise<readonly AccountBonusNotification[]> {
  const parsed = unnotified.safeParse(await requestUnnotifiedBonuses(origin, token, signal, headers))
  if (!parsed.success) throw new PlatformAuthError('protocol')
  return parsed.data.map(row => ({
    orderId: row.order_id as AccountBonusOrderId, campaign: row.campaign, amount: row.amount,
    currency: row.currency, grantedAt: row.granted_at, expiresAt: row.expires_at, message: row.msg,
  }))
}

/**
 * Record one displayed bonus as notified with the credential it was read under.
 * @param origin - configured origin matching the stored grant issuer.
 * @param token - captured account grant; the caller has already bound it to the account.
 * @param orderId - granted bonus order the user saw.
 * @param signal - credential lifetime and request timeout.
 * @param headers - deployment and client identity headers for the configured origin.
 * @returns after Platform records the acknowledgement; HTTP and business failures throw.
 */
export async function sendBonusNotified(origin: string, token: string, orderId: AccountBonusOrderId,
  signal: AbortSignal, headers: Record<string, string>): Promise<void> {
  await requestBonusNotified(origin, token, orderId, signal, headers)
}
