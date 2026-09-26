/** V3 content tags and request-tool fields admitted before V4 interpretation. */

import { SessionFormatError, SessionFormatUnsupportedMigrationError, isSessionFormatJsonObject } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatEvent, SessionFormatJsonObject, SessionFormatJsonValue } from '@deepseek-ai/dsh-session-format'
import { mapEventMessages } from './sources.ts'

const V3_BLOCK_TYPES = new Set(['text', 'reasoning', 'image', 'file', 'tool-call', 'tool-result'])

function migrateBlock(value: SessionFormatJsonValue, subject: string): SessionFormatJsonValue {
  if (!isSessionFormatJsonObject(value) || typeof value['type'] !== 'string') {
    throw new SessionFormatError(`${subject} requires content blocks with string type tags`)
  }
  const type = value['type']
  if (V3_BLOCK_TYPES.has(type)) return value
  return { ...value, type: `plugin:${type}` }
}

/**
 * Convert declared content tags while keeping arguments and extension data opaque.
 * @param value - released content array.
 * @param subject - owning event and content location for diagnostics.
 * @returns content in the same order, sharing unchanged blocks and image references.
 */
export function migrateV3Content(value: SessionFormatJsonValue | undefined, subject: string): SessionFormatJsonValue[] {
  if (!Array.isArray(value)) throw new SessionFormatError(`${subject} content must be an array`)
  const blocks = value as readonly SessionFormatJsonValue[]
  const mapped = blocks.map((block, index) => migrateBlock(block, `${subject}[${index}]`))
  return mapped.every((block, index) => block === value[index]) ? value as SessionFormatJsonValue[] : mapped
}

function migrateMessage(message: SessionFormatJsonObject, subject: string): SessionFormatJsonObject {
  const content = migrateV3Content(message['content'], subject)
  return content === message['content'] ? message : { ...message, content }
}

function migrateChunk(value: SessionFormatJsonValue | undefined, subject: string): SessionFormatJsonValue | undefined {
  if (!isSessionFormatJsonObject(value)) return value
  if (value['type'] === 'block-end') {
    const block = migrateBlock(value['block'] as SessionFormatJsonValue, `${subject}.block`)
    return block === value['block'] ? value : { ...value, block }
  }
  if (value['type'] !== 'block-start') return value
  const original = value['blockType']
  if (typeof original !== 'string') throw new SessionFormatError(`${subject} blockType must be a string`)
  const blockType = V3_BLOCK_TYPES.has(original) ? original : `plugin:${original}`
  return blockType === original ? value : { ...value, blockType }
}

/**
 * Convert declared V3 extension content and stream tags after canonical result lifting.
 * @param event - source event after producer attribution conversion.
 * @returns the event with namespaced content tags, retaining all coordinates and other fields.
 * @throws {SessionFormatUnsupportedMigrationError} A V3 tool definition contains the V4-only deferLoading field.
 */
export function migrateV3EventContent(event: SessionFormatEvent): SessionFormatEvent {
  const subject = `format v3 ${event.type} at seq ${event.seq}`
  let mapped = mapEventMessages(event, message => migrateMessage(message, subject))
  if (!isSessionFormatJsonObject(mapped.data)) return mapped
  let data = mapped.data
  const contentField = (key: string): void => {
    const content = migrateV3Content(data[key], `${subject}.${key}`)
    if (content !== data[key]) data = { ...data, [key]: content }
  }
  if (event.type === 'compaction/summary') {
    contentField('summary')
    if (data['rawOutput'] !== undefined) contentField('rawOutput')
  } else if (event.type === 'tool/ptc-dispatch') contentField('content')
  else if (event.type === 'team/message/queued' && isSessionFormatJsonObject(data['message'])) {
    const message = migrateMessage(data['message'], subject)
    if (message !== data['message']) data = { ...data, message }
  }
  if (event.type === 'request/header' && isSessionFormatJsonObject(data['header'])) {
    const tools = data['header']['tools']
    if (Array.isArray(tools)) {
      for (const [index, tool] of (tools as readonly SessionFormatJsonValue[]).entries()) {
        if (isSessionFormatJsonObject(tool) && Object.hasOwn(tool, 'deferLoading')) {
          throw new SessionFormatUnsupportedMigrationError(
            `${subject}.header.tools[${index}] contains deferLoading, which is only defined in V4`,
          )
        }
      }
    }
  }
  if ((event.type === 'assistant/message' || event.type === 'assistant/attempt') && Array.isArray(data['stream'])) {
    const stream = data['stream'] as readonly SessionFormatJsonValue[]
    const converted = stream.map((entry, index) => {
      if (!isSessionFormatJsonObject(entry) || entry['type'] !== 'chunk') return entry
      const chunk = migrateChunk(entry['chunk'], `${subject}.stream[${index}]`)
      return chunk === entry['chunk'] ? entry : { ...entry, chunk: chunk as SessionFormatJsonValue }
    })
    if (converted.some((entry, index) => entry !== stream[index])) data = { ...data, stream: converted }
  }
  if (data !== mapped.data) mapped = { ...mapped, data }
  return mapped
}
