/** Native V4 developer-message and deferred-tool-schema validation. */

import { SessionFormatError, isSessionFormatJsonObject, sessionFormatCount } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatEvent, SessionFormatJsonObject, SessionFormatJsonValue } from '@deepseek-ai/dsh-session-format'

function assertToolChange(block: unknown, developer: boolean): void {
  if (!isSessionFormatJsonObject(block) || (block['type'] !== 'tool-addition' && block['type'] !== 'tool-removal')) return
  if (!developer) throw new SessionFormatError(`format v4 ${block['type']} requires developer role`)
  if (typeof block['toolName'] !== 'string' || block['toolName'].length === 0) {
    throw new SessionFormatError(`format v4 ${block['type']} requires a nonempty toolName`)
  }
  if (block['type'] === 'tool-addition' && Object.hasOwn(block, 'tool')) {
    throw new SessionFormatError('format v4 tool-addition must omit inline tool definitions')
  }
}

function assertContent(value: SessionFormatJsonValue | undefined, developer = false): void {
  if (Array.isArray(value)) value.forEach((block) => { assertToolChange(block, developer) })
}

function assertDeveloperMessage(message: SessionFormatJsonObject): void {
  assertContent(message['content'], true)
  const source = message['source']
  if (typeof message['id'] !== 'string' || message['id'].length === 0
    || !Array.isArray(message['content']) || !isSessionFormatJsonObject(source)
    || typeof source['kind'] !== 'string' || source['kind'].length === 0 || source['kind'] === 'plugin') {
    throw new SessionFormatError('format v4 developer message requires id, role, content, and a producer-owned source')
  }
}

/** Ordinary-message corruption belongs to the decoder; recognized V4-only values are refused here. */
function assertOrdinaryMessage(value: SessionFormatJsonValue | undefined): void {
  if (!isSessionFormatJsonObject(value)) return
  if (value['role'] === 'developer') {
    throw new SessionFormatError('format v4 developer/message and developer role must occur together')
  }
  assertContent(value['content'])
}

/**
 * Validate native V4 developer messages, tool-change blocks, and deferred tool schemas.
 * Additional developer JSON fields are preserved. Malformed legacy message
 * slots remain available to recoverable decoding.
 * @param event - logical event or physical row before source-event range decoding.
 */
export function assertV4DeveloperData(event: SessionFormatEvent): void {
  const data = event.data
  if (!isSessionFormatJsonObject(data)) {
    if (event.type === 'developer/message') throw new SessionFormatError('format v4 developer/message data must be an object')
    return
  }
  if (event.type === 'developer/message') {
    const message = data['message']
    if (!isSessionFormatJsonObject(message) || message['role'] !== 'developer') {
      throw new SessionFormatError('format v4 developer/message requires turn, step, and a developer message')
    }
    for (const field of ['turn', 'step']) {
      if (sessionFormatCount(data[field], `developer/message ${field}`) === 0) {
        throw new SessionFormatError(`developer/message ${field} must be positive`)
      }
    }
    assertDeveloperMessage(message)
    const content = message['content'] as SessionFormatJsonValue[]
    const hasAdditions = content.some(block => isSessionFormatJsonObject(block) && block['type'] === 'tool-addition')
    if (hasAdditions) {
      sessionFormatCount(data['headerSeq'], 'developer/message headerSeq')
    } else if (Object.hasOwn(data, 'headerSeq')) {
      throw new SessionFormatError('format v4 developer/message must omit headerSeq without tool additions')
    }
  } else {
    switch (event.type) {
      case 'user/message':
        assertOrdinaryMessage(data)
        break
      case 'system/message':
      case 'assistant/message':
      case 'tool/result':
        assertOrdinaryMessage(data['message'])
        break
      case 'agent/inbox/spliced':
      case 'session/title-llm-request': {
        const messages = data[event.type === 'agent/inbox/spliced' ? 'inserted' : 'messages']
        if (Array.isArray(messages)) messages.forEach(assertOrdinaryMessage)
        break
      }
    }
  }
  if (event.type === 'compaction/summary') {
    assertContent(data['summary'])
    assertContent(data['rawOutput'])
  }
  if ((event.type === 'assistant/message' || event.type === 'assistant/attempt') && Array.isArray(data['stream'])) {
    for (const entry of data['stream']) {
      if (!isSessionFormatJsonObject(entry) || entry['type'] !== 'chunk') continue
      const chunk = entry['chunk']
      if (!isSessionFormatJsonObject(chunk)) continue
      if (chunk['type'] === 'block-end') assertToolChange(chunk['block'], false)
      if (chunk['type'] === 'block-start' && (chunk['blockType'] === 'tool-addition' || chunk['blockType'] === 'tool-removal')) {
        throw new SessionFormatError('format v4 tool-change blocks require developer role')
      }
    }
  }
  if (event.type === 'request/header' && isSessionFormatJsonObject(data['header'])) {
    const header = data['header']
    const tools = header['tools']
    if (Array.isArray(tools)) {
      for (const tool of tools) {
        if (!isSessionFormatJsonObject(tool) || !Object.hasOwn(tool, 'deferLoading')) continue
        if (tool['deferLoading'] !== true) throw new SessionFormatError('format v4 tool deferLoading must be true when present')
      }
    }
  }
}
