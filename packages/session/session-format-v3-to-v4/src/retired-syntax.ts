/** Retired native syntax remains a hard refusal even after a recoverable physical-row failure. */

import { SessionFormatError, SessionFormatUnsupportedMigrationError, isSessionFormatJsonObject } from '@deepseek-ai/dsh-session-format'

function assertBlock(block: unknown, subject: string): void {
  if (isSessionFormatJsonObject(block) && block['type'] === 'tool-result') {
    throw new SessionFormatError(`${subject} must not contain a released tool-result wrapper`)
  }
}

function assertContent(content: unknown, subject: string): void {
  if (Array.isArray(content)) content.forEach((block) => { assertBlock(block, subject) })
}

function assertMessageContent(message: unknown, subject: string): void {
  if (isSessionFormatJsonObject(message)) assertContent(message['content'], subject)
}

/**
 * Refuse retired headers, PTC tags, and tool-result blocks in interpreted content slots.
 * Tool arguments, replay state, schema parameters, and nested extension values remain opaque.
 * @param row - parsed physical row or complete native logical event.
 */
export function assertV4RetiredSyntax(row: unknown): void {
  if (!isSessionFormatJsonObject(row)) return
  if ((row['type'] === 'tool/code-dispatch-start' || row['type'] === 'tool/code-dispatch') && row['ignorable'] !== true) {
    throw new SessionFormatUnsupportedMigrationError(`format v4 rejects retired event type ${row['type']}`)
  }
  const data = row['data']
  if (row['type'] === 'request/header') {
    if (!isSessionFormatJsonObject(data) || !isSessionFormatJsonObject(data['header'])) {
      throw new SessionFormatError('format v4 request/header requires data and header objects')
    }
    if (Object.hasOwn(data['header'], 'system')) {
      throw new SessionFormatError('format v4 request/header rejects retired header.system')
    }
    return
  }
  if (!isSessionFormatJsonObject(data)) return
  const subject = `format v4 ${String(row['type'])} at seq ${String(row['seq'])} content`
  switch (row['type']) {
    case 'user/message':
      assertContent(data['content'], subject)
      break
    case 'developer/message':
    case 'assistant/message':
    case 'team/message/queued':
      assertMessageContent(data['message'], subject)
      break
    case 'agent/inbox/spliced':
    case 'session/title-llm-request': {
      const messages = data[row['type'] === 'agent/inbox/spliced' ? 'inserted' : 'messages']
      if (Array.isArray(messages)) messages.forEach((message) => { assertMessageContent(message, subject) })
      break
    }
    case 'compaction/summary':
      assertContent(data['summary'], subject)
      assertContent(data['rawOutput'], subject)
      break
    case 'tool/ptc-dispatch':
      assertContent(data['content'], subject)
      break
  }
  if ((row['type'] === 'assistant/message' || row['type'] === 'assistant/attempt') && Array.isArray(data['stream'])) {
    for (const entry of data['stream']) {
      if (!isSessionFormatJsonObject(entry) || entry['type'] !== 'chunk') continue
      const chunk = entry['chunk']
      if (!isSessionFormatJsonObject(chunk)) continue
      if (chunk['type'] === 'block-end') assertBlock(chunk['block'], subject)
      if (chunk['type'] === 'block-start' && chunk['blockType'] === 'tool-result') {
        throw new SessionFormatError(`${subject} must not contain a released tool-result wrapper`)
      }
    }
  }
}
