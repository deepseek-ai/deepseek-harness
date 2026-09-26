/** Historical child identity reduced to the fields required by a parent's catalog. */

import { SessionFormatError, SessionFormatUnsupportedMigrationError, isSessionFormatJsonObject, sessionFormatCount } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatArtifact, SessionFormatJsonObject, SessionFormatJsonValue } from '@deepseek-ai/dsh-session-format'

/**
 * Collect a child's own descriptor without requiring one before its parent catalog is read.
 * @param artifact - validated historical child artifact with its exact inherited cut.
 * @returns compact child identity and descriptor evidence with validated discovery fields for catalog completion.
 * @throws SessionFormatError when a supported own descriptor has invalid discovery fields.
 */
export function historicalChildCatalogSource(artifact: SessionFormatArtifact): SessionFormatJsonObject {
  const header = artifact.header
  if (header.origin !== 'subagent' || header.parentSession === undefined) {
    throw new SessionFormatUnsupportedMigrationError('catalog migration requires a subagent child with a direct parent')
  }
  const descriptors = artifact.events.filter(event => event.type === 'subagent/descriptor' && event.seq >= artifact.inheritedEventCount)
  const source = {
    childId: header.id, childCreatedAt: header.createdAt,
    descriptorCount: descriptors.length, descriptor: descriptors[0]?.data ?? null,
  }
  childCatalogFact(source)
  return source
}

/**
 * Validate supplemental child evidence supplied across the migration JSON interface.
 * @param value - collected child identity and optional descriptor.
 * @returns validated evidence; descriptor interpretation is deferred until parent membership is known.
 */
export function childCatalogSource(value: SessionFormatJsonValue): SessionFormatJsonObject {
  if (!isSessionFormatJsonObject(value) || typeof value['childId'] !== 'string'
    || !Object.hasOwn(value, 'descriptor')) {
    throw new SessionFormatUnsupportedMigrationError('catalog migration requires historical child identity and descriptor evidence')
  }
  sessionFormatCount(value['childCreatedAt'], 'catalog child creation time')
  sessionFormatCount(value['descriptorCount'], 'child descriptor count')
  return value
}

/**
 * Interpret only the discovery fields of known historical descriptors.
 * @param source - validated child evidence.
 * @returns a catalog fact, or undefined without exactly one supported own descriptor.
 */
export function childCatalogFact(source: SessionFormatJsonObject): SessionFormatJsonObject | undefined {
  const id = source['childId'] as string
  const descriptor = source['descriptor']
  const count = source['descriptorCount'] as number
  const known = isSessionFormatJsonObject(descriptor) && [1, 2, 3].includes(descriptor['version'] as number)
  if (count !== 1 || !known) return undefined
  if (typeof descriptor['provider'] !== 'string') {
    throw new SessionFormatUnsupportedMigrationError(`${childCatalogSubject(source)} has an invalid subagent descriptor provider`)
  }
  if (descriptor['version'] !== 1 && descriptor['mode'] !== 'continuable' && descriptor['mode'] !== 'one-shot') {
    throw new SessionFormatUnsupportedMigrationError(`${childCatalogSubject(source)} has an invalid subagent descriptor mode`)
  }
  return catalogFact({
    version: 0, childId: id, childCreatedAt: source['childCreatedAt'] as number,
    // V1 described only continuable children and carried no mode field.
    mode: descriptor['version'] === 1 ? 'continuable' : descriptor['mode'] as SessionFormatJsonValue,
    ...(descriptor['label'] === undefined ? {} : { label: descriptor['label'] }),
  }, childCatalogSubject(source))
}

/**
 * Validate the historical fields used for catalog membership without interpreting extensions.
 * @param value - catalog payload or prepared historical discovery fact.
 * @param subject - event type or child identity used in rejection diagnostics.
 * @returns validated catalog payload.
 */
export function catalogFact(value: SessionFormatJsonValue, subject = 'subagent/catalog'): SessionFormatJsonObject {
  if (!isSessionFormatJsonObject(value) || (value['version'] !== 0 && value['version'] !== 1)
    || typeof value['childId'] !== 'string'
    || (value['mode'] !== 'continuable' && value['mode'] !== 'one-shot' && value['mode'] !== 'unknown')
    || (value['version'] === 0 && value['mode'] === 'unknown')
    || (value['mode'] === 'continuable' && typeof value['label'] !== 'string')
    || (value['label'] !== undefined && typeof value['label'] !== 'string')) {
    throw new SessionFormatError(`${subject} requires a supported versioned catalog fact`)
  }
  sessionFormatCount(value['childCreatedAt'], 'catalog child creation time')
  return value
}

/**
 * Name the child and its optional storage-owned location in a migration diagnostic.
 * @param source - validated supplemental child evidence.
 * @returns a child identity with its source path when persistence supplied one.
 */
export function childCatalogSubject(source: SessionFormatJsonObject): string {
  return `Session ${source['childId'] as string}${typeof source['sourcePath'] === 'string' ? ` (raw log: ${source['sourcePath']})` : ''}`
}
