import { BlockAssembler, expandAssistantStream } from '@deepseek-ai/dsh-llm'
import { deepEqualJson } from '@deepseek-ai/dsh-util-values'
import {
  SessionFormatError,
  SessionFormatUnsupportedMigrationError,
  sessionFormatCount,
  snapshotSessionFormatJson,
} from '@deepseek-ai/dsh-session-format'
import type {
  SessionFormatArtifact,
  SessionFormatEvent,
  SessionFormatJsonValue,
} from '@deepseek-ai/dsh-session-format'
import {
  assertReleasedPayloadSemantics,
  assertReleasedSurfaceMetadata,
} from '@deepseek-ai/dsh-session-format-v0-to-v1'
import { RELEASED_V2_EVENT_DISPOSITIONS, RELEASED_V2_EVENT_TYPES } from '../dispositions.ts'
import {
  assertReleasedV2Keys,
  assertReleasedV2PhysicalArtifact,
  releasedV2Record,
  restoreReleasedV2Artifact,
} from '../validation.ts'

const RELEASED_V2_EVENT_TYPE_SET = new Set(RELEASED_V2_EVENT_TYPES)
const SURFACE_TYPES = new Set(['user/message', 'assistant/message', 'tool/result'])

/**
 * Validate the frozen released-v2 writer image in tests.
 * @param artifact - released-v2 logical artifact.
 */
export function assertReleasedV2Artifact(artifact: SessionFormatArtifact): void {
  assertReleasedV2PhysicalArtifact(artifact)
  for (const [index, event] of artifact.events.entries()) {
    const disposition = RELEASED_V2_EVENT_DISPOSITIONS[event.type]
    if (disposition === undefined) {
      throw new SessionFormatUnsupportedMigrationError(
        `format v2 contains unknown event type ${JSON.stringify(event.type)} at seq ${index}`,
      )
    }
    if (SURFACE_TYPES.has(event.type)) {
      assertReleasedSurfaceMetadata(event, index, event.type, 'forbid-assistant')
    }
    assertPayload(event, disposition)
  }
  restoreReleasedV2Artifact(artifact, RELEASED_V2_EVENT_TYPE_SET)
}

export { assertReleasedV2PhysicalArtifact } from '../validation.ts'

function assertPayload(
  event: SessionFormatEvent,
  disposition: (typeof RELEASED_V2_EVENT_DISPOSITIONS)[string],
): void {
  const data = releasedV2Record(event.data, `${event.type} ${event.seq} data`)
  assertReleasedV2Keys(data, disposition.required, disposition.optional, `${event.type} ${event.seq} data`)
  for (const key of disposition.opaque) {
    if (Object.hasOwn(data, key)) snapshotSessionFormatJson(data[key], `${event.type} ${event.seq} opaque ${key}`)
  }
  if (event.type === 'assistant/attempt' || event.type === 'assistant/message') {
    const turn = sessionFormatCount(data['turn'], `${event.type} ${event.seq} turn`)
    const step = sessionFormatCount(data['step'], `${event.type} ${event.seq} step`)
    const assembler = new BlockAssembler()
    let timed: ReturnType<typeof expandAssistantStream>
    try {
      timed = expandAssistantStream(data['stream'] as never)
      for (const member of timed) {
        assertReleasedPayloadSemantics({
          type: 'assistant/chunk',
          seq: event.seq,
          time: member.time,
          data: { turn, step, chunk: member.chunk } as unknown as SessionFormatJsonValue,
        }, 2)
        assembler.push(member.chunk)
      }
    } catch (error: unknown) {
      throw new SessionFormatError(`${event.type} ${event.seq} has an invalid embedded stream`, { cause: error })
    }
    if (event.type === 'assistant/attempt') return
    assertReleasedPayloadSemantics(event, 2)
    if (timed.length > 0) {
      const message = releasedV2Record(data['message'], `assistant/message ${event.seq} message`)
      const content = data['interrupted'] === true ? assembler.interruptedBlocks() : assembler.blocks()
      if (!deepEqualJson(message['content'], content)) {
        throw new SessionFormatError(`assistant/message ${event.seq} message content disagrees with its embedded stream`)
      }
      if (!deepEqualJson(data['usage'], assembler.usage)) {
        throw new SessionFormatError(`assistant/message ${event.seq} usage disagrees with its embedded stream`)
      }
      const source = releasedV2Record(message['source'], `assistant/message ${event.seq} source`)
      if (!deepEqualJson(source['replayState'], assembler.replayState)) {
        throw new SessionFormatError(`assistant/message ${event.seq} replay state disagrees with its embedded stream`)
      }
    }
    return
  }
  if (event.type === 'session/end-seed') {
    if (data['inherited'] !== undefined && data['inherited'] !== true) {
      throw new SessionFormatError(`session/end-seed ${event.seq} inherited must be true when present`)
    }
    return
  }
  assertReleasedPayloadSemantics(event, 2)
}
