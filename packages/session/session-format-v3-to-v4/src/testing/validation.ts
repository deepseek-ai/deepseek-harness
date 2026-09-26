import { SessionFormatEventCollector } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatArtifact } from '@deepseek-ai/dsh-session-format'
import { releasedV4SessionFormatCodec } from '../codec.ts'

/**
 * Validate an artifact through the native codec without vocabulary-aware restoration.
 * @param artifact - current-generation artifact to encode and decode.
 */
export function assertReleasedV4Artifact(artifact: SessionFormatArtifact): void {
  const codec = releasedV4SessionFormatCodec
  const decoder = codec.createDecoder(codec.encodeHeader(artifact.header, artifact.inheritedEventCount), 'strict')
  const output = new SessionFormatEventCollector()
  for (const event of artifact.events) decoder.decodeRow(codec.encodeEvent(event), output)
  decoder.finish(output)
}
