import { createSessionFormatCatalog } from '@deepseek-ai/dsh-session-format'
import type {
  SessionFormatArtifact,
  SessionFormatCurrentEncoder,
  SessionFormatRecovery,
} from '@deepseek-ai/dsh-session-format'
import { releasedV0SessionFormatCodec, releasedV1SessionFormatCodec } from '../codec.ts'
import { sessionFormatV0ToV1 } from '../migration.ts'
import { assertReleasedV1Header } from '../validation.ts'
import {
  assertReleasedV1Artifact,
  assertReleasedV1MigrationSource,
} from './validation.ts'

const unusedEncoder: SessionFormatCurrentEncoder = {
  /* v8 ignore next -- this restore-only test facade never encodes a header. */
  encodeHeader: header => header,
  /* v8 ignore next -- this restore-only test facade never encodes an event. */
  encodeEvent: event => event,
}

const catalog = createSessionFormatCatalog({
  currentVersion: 1,
  codecs: [releasedV0SessionFormatCodec, releasedV1SessionFormatCodec],
  currentEncoder: unusedEncoder,
  migrations: [sessionFormatV0ToV1],
  restoreCurrent(artifact) {
    assertReleasedV1Artifact(artifact)
    return artifact
  },
  restoreTransformedCurrent(artifact) {
    assertReleasedV1MigrationSource(artifact)
    return artifact
  },
  /* v8 ignore next 3 -- this restore-only test facade never performs a header-only read. */
  restoreCurrentHeader(header) {
    assertReleasedV1Header(header)
    return header
  },
})

function restore(
  header: unknown,
  rows: readonly unknown[],
  recovery: SessionFormatRecovery,
  validation: 'transformed' | 'current',
): SessionFormatArtifact {
  const current = catalog.createRestore(header, { recovery, validation })
  for (const row of rows) current.decodeRow(row)
  return current.finish()
}

/**
 * Restore released v0 rows through the production decoder and v0-to-v1 stage.
 * @param header - released v0 physical header.
 * @param rows - released v0 physical rows.
 * @param recovery - strict or recoverable row policy.
 * @returns the transformed released v1 artifact.
 */
export function restoreV0ToV1(
  header: unknown,
  rows: readonly unknown[],
  recovery: SessionFormatRecovery = 'strict',
): SessionFormatArtifact {
  return restore(header, rows, recovery, 'transformed')
}

/**
 * Restore released v1 rows through the production decoder and current collector.
 * @param header - released v1 physical header.
 * @param rows - released v1 physical rows.
 * @param recovery - strict or recoverable row policy.
 * @returns the restored released v1 artifact.
 */
export function restoreV1(
  header: unknown,
  rows: readonly unknown[],
  recovery: SessionFormatRecovery = 'strict',
): SessionFormatArtifact {
  return restore(header, rows, recovery, 'current')
}
