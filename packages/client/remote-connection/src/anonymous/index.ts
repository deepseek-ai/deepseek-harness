/** Generate the public classic script without an independently built browser artifact. */
import { definePairingElement } from './element.ts'
import { mountPairing } from './pairing.ts'
import type { PairingRecovery } from './pairing.ts'
import { pairingLocales, pairingMethodLabels } from './locales.ts'
import { pairingStyles } from './styles.ts'

/**
 * Serialize the self-contained browser entry and its public dictionaries and styles.
 * @param recovery - validated public timing and recovery limits.
 * @returns executable classic JavaScript with no authenticated Client dependencies.
 */
export function renderPairingScript(recovery: PairingRecovery): string {
  const data = [pairingLocales, pairingMethodLabels, pairingStyles, recovery]
    .map(value => JSON.stringify(value).replaceAll('<', '\\u003c')).join(',')
  return `(${definePairingElement.toString()})(${mountPairing.toString()},${data});`
}
