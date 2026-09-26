/** Fixed V0–V3 composition for released-edge tests, independent of the current writer. */

import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import { createSessionFormatCatalog } from '@deepseek-ai/dsh-session-format'
import { releasedV0SessionFormatCodec, releasedV1SessionFormatCodec, sessionFormatV0ToV1 } from '@deepseek-ai/dsh-session-format-v0-to-v1'
import { releasedV2SessionFormatCodec, sessionFormatV1ToV2 } from '@deepseek-ai/dsh-session-format-v1-to-v2'
import { assertReleasedV3Header, releasedV3SessionFormatCodec, restoreReleasedV3Artifact, sessionFormatV2ToV3 } from '../src/index.ts'

/** Restore the released V3 result through its complete predecessor chain. */
export const v3Catalog = createSessionFormatCatalog({
  currentVersion: 3,
  codecs: [releasedV0SessionFormatCodec, releasedV1SessionFormatCodec, releasedV2SessionFormatCodec, releasedV3SessionFormatCodec],
  currentEncoder: releasedV3SessionFormatCodec,
  migrations: [sessionFormatV0ToV1, sessionFormatV1ToV2, sessionFormatV2ToV3],
  restoreCurrent: artifact => restoreReleasedV3Artifact(artifact, KNOWN_SESSION_EVENT_TYPES),
  restoreTransformedCurrent: artifact => restoreReleasedV3Artifact(artifact, KNOWN_SESSION_EVENT_TYPES),
  restoreCurrentHeader(header) {
    assertReleasedV3Header(header)
    return header
  },
})
