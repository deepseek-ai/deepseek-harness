import {
  RELEASED_V0_EVENT_DISPOSITIONS,
  defineReleasedPayloadDisposition,
  type ReleasedV0PayloadDisposition,
} from '@deepseek-ai/dsh-session-format-v0-to-v1'

const retained = Object.fromEntries(
  Object.entries(RELEASED_V0_EVENT_DISPOSITIONS).filter(([type]) => (
    type !== 'assistant/chunk'
    && type !== 'assistant/message'
    && type !== 'session-log-deepseek/delivery-accepted'
    && type !== 'session/end-seed'
  )),
)

/** Exact top-level event and payload-member inventory frozen for released v2. */
export const RELEASED_V2_EVENT_DISPOSITIONS: Readonly<Record<string, ReleasedV0PayloadDisposition>> = Object.freeze({
  ...retained,
  'assistant/attempt': defineReleasedPayloadDisposition(['turn', 'step', 'stream']),
  'assistant/message': defineReleasedPayloadDisposition(
    ['turn', 'step', 'message', 'stream'],
    ['usage', 'interrupted'],
  ),
  'session-log-deepseek/delivery-accepted': defineReleasedPayloadDisposition(
    ['sessionId', 'throughSeq'],
    ['sessionFormatVersion'],
  ),
  'session/end-seed': defineReleasedPayloadDisposition([], ['inherited']),
})

/** Stable sorted released-v2 event inventory. */
export const RELEASED_V2_EVENT_TYPES: readonly string[] = Object.freeze(
  Object.keys(RELEASED_V2_EVENT_DISPOSITIONS).sort((left, right) => left.localeCompare(right, 'en')),
)
