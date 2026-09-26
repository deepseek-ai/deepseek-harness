/** Historical restoration for collecting migration prerequisites without recursively opening current Sessions. */

import { RELEASED_V3_EVENT_TYPES } from '@deepseek-ai/dsh-session-format-v3-to-v4'
import { createSessionFormatCatalog } from '@deepseek-ai/dsh-session-format'
import { releasedV0SessionFormatCodec, releasedV1SessionFormatCodec, sessionFormatV0ToV1 } from '@deepseek-ai/dsh-session-format-v0-to-v1'
import { releasedV2SessionFormatCodec, sessionFormatV1ToV2 } from '@deepseek-ai/dsh-session-format-v1-to-v2'
import { assertReleasedV3Header, releasedV3SessionFormatCodec, restoreReleasedV3Artifact, sessionFormatV2ToV3 } from '@deepseek-ai/dsh-session-format-v2-to-v3'

/** V0–V3 decoding for historical child identity; never publishes or completes parent catalogs. */
export const historicalSessionFormatCatalog = createSessionFormatCatalog({
  currentVersion: 3,
  codecs: [releasedV0SessionFormatCodec, releasedV1SessionFormatCodec, releasedV2SessionFormatCodec, releasedV3SessionFormatCodec],
  currentEncoder: releasedV3SessionFormatCodec,
  migrations: [sessionFormatV0ToV1, sessionFormatV1ToV2, sessionFormatV2ToV3],
  restoreCurrent: artifact => restoreReleasedV3Artifact(artifact, RELEASED_V3_EVENT_TYPES),
  restoreTransformedCurrent: artifact => restoreReleasedV3Artifact(artifact, RELEASED_V3_EVENT_TYPES),
  restoreCurrentHeader(header) {
    assertReleasedV3Header(header)
    return header
  },
})
