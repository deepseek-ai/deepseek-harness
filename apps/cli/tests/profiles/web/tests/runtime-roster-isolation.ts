/** Experimental identity checks over independently observed built Web runtime records. */

import { fileURLToPath } from 'node:url'
import { hasExperimentalPackageReference, isExperimentalPackageName } from '../../../../../../scripts/experimental-package-policy.ts'
import { modulePackage } from './runtime-roster.ts'
import type { RuntimeRoster } from './runtime-roster.ts'

/**
 * Locate experimental package identities and experimental source/artifact paths in runtime evidence.
 * @param roster - independently collected Web runtime records.
 * @returns diagnostic evidence for every forbidden package reference.
 */
export function experimentalRuntimeReferences(roster: RuntimeRoster): string[] {
  const references = new Set([
    ...roster.entries.map(entry => entry.name),
    ...roster.plugins.flatMap(plugin => [plugin.owner ?? '', ...plugin.modules]),
    ...roster.modules,
    ...roster.client.entries.flatMap(entry => [entry.id, ...entry.inject ?? [], ...entry.external ?? []]),
    ...roster.client.batches.flatMap(batch => batch.entries),
  ])
  return [...references].filter(reference => hasExperimentalPackageReference(reference)
    || (reference.startsWith('file:') && (fileURLToPath(reference).replaceAll('\\', '/').includes('/packages/experimental/')
      || isExperimentalPackageName(modulePackage(reference) ?? '')))).sort()
}
