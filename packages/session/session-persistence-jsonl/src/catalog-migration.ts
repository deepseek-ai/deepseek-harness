/** Collect historical discovery facts without recursively preparing related current generations. */

import { stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { historicalSessionFormatCatalog, sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import { historicalChildCatalogSource } from '@deepseek-ai/dsh-session-format-v3-to-v4'
import { SessionFormatUnsupportedMigrationError } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatJsonObject } from '@deepseek-ai/dsh-session-format'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { parseGenerationLogFilename } from './format.ts'
import type { JsonlCompression } from './format.ts'
import { JsonlGenerationSourceChangedError, readDecodedJsonlSource } from './generation.ts'
import type { JsonlPhysicalIdentity } from './generation.ts'

/** Per-parent supplemental facts and the source checks required before serving or publishing them. */
interface PreparedCatalogFacts {
  readonly facts: readonly SessionFormatJsonObject[]
  readonly failures: readonly { readonly path: string; readonly error: unknown }[]
  /** @returns resolves while every inspected child still has the captured physical revision. */
  validate(): Promise<void>
}

/**
 * Collect each related child's own descriptor through existing historical codecs.
 * @param parentId - parent whose incoming migration consumes these facts.
 * @param sources - header-indexed direct children in the selected source corpus.
 * @param compression - configured source encoding.
 * @param signal - cancellation forwarded through each source read.
 * @returns compact facts and child-local failures; complete child event arrays are released after extraction.
 */
export async function prepareCatalogFacts(
  parentId: SessionId,
  sources: readonly { readonly header: SessionHeader; readonly path: string }[],
  compression: JsonlCompression,
  signal: AbortSignal,
): Promise<PreparedCatalogFacts> {
  const facts: SessionFormatJsonObject[] = []
  const failures: { path: string; error: unknown }[] = []
  const witnesses: { path: string; identity: JsonlPhysicalIdentity }[] = []
  for (const source of sources) {
    signal.throwIfAborted()
    const version = parseGenerationLogFilename(basename(source.path), compression)
    if (version === undefined) throw new SessionFormatUnsupportedMigrationError(`unrecognized historical child generation ${source.path}`)
    const witness: { path: string; identity: JsonlPhysicalIdentity } = {
      path: source.path, identity: await stat(source.path, { bigint: true }),
    }
    witnesses.push(witness)
    const unavailable = { childId: source.header.id, childCreatedAt: source.header.createdAt,
      descriptorCount: 0, descriptor: null, sourcePath: source.path }
    let restored: Awaited<ReturnType<typeof readDecodedJsonlSource>>
    try {
      restored = await readDecodedJsonlSource(source.path, version, compression, {
        createRestore: header => (version <= 3 ? historicalSessionFormatCatalog : sessionFormatCatalog).createRestore(header, {
          recovery: 'recoverable', validation: 'current',
        }),
      }, signal)
    } catch (error: unknown) {
      signal.throwIfAborted()
      failures.push({ path: source.path, error })
      facts.push(unavailable)
      continue
    }
    witness.identity = restored.identity
    const header = restored.artifact.header
    if (header.id !== source.header.id || header.createdAt !== source.header.createdAt
      || header.parentSession !== parentId || header.origin !== 'subagent'
      || ['cwd', 'isSeeded', 'delegationDepth', 'agentPreset'].some(key => header[key] !== source.header[key as keyof SessionHeader])) {
      throw new JsonlGenerationSourceChangedError(source.path)
    }
    let fact: SessionFormatJsonObject
    try {
      fact = historicalChildCatalogSource(restored.artifact)
    } catch (error: unknown) {
      failures.push({ path: source.path, error })
      facts.push(unavailable)
      continue
    }
    facts.push({ ...fact, sourcePath: source.path })
  }
  return {
    facts,
    failures,
    async validate() {
      for (const witness of witnesses) {
        const current = await stat(witness.path, { bigint: true })
        if (current.dev !== witness.identity.dev || current.ino !== witness.identity.ino
          || current.size !== witness.identity.size || current.mtimeNs !== witness.identity.mtimeNs
          || current.ctimeNs !== witness.identity.ctimeNs) throw new JsonlGenerationSourceChangedError(witness.path)
      }
    },
  }
}
