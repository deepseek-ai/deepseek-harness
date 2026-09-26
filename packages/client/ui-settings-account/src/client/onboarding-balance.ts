/** Available onboarding credit includes both purchased and granted wallets. */
import { Big } from 'big.js'
import type { AccountSnapshot } from './AccountSection.tsx'

/**
 * Check purchased and granted credit without treating a pending query as zero.
 * @param balance - current account balance result.
 * @returns whether either wallet group has positive credit.
 */
export function hasOnboardingCredit(balance: NonNullable<AccountSnapshot['details']>['balance']): boolean {
  return balance?.status === 'ready' && [...balance.value, ...balance.bonusWallets].some(wallet => new Big(wallet.balance).gt(0))
}
