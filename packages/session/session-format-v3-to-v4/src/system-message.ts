/** Native system-message fields checked before physical recovery can discard a row. */

import { SessionFormatError, isSessionFormatJsonObject, sessionFormatCount } from '@deepseek-ai/dsh-session-format'

function record(value: unknown, subject: string): Readonly<Record<string, unknown>> {
  if (!isSessionFormatJsonObject(value)) throw new SessionFormatError(`format v4 ${subject} requires an object`)
  return value
}

function string(value: unknown, subject: string, nonempty = false): void {
  if (typeof value !== 'string' || nonempty && value.length === 0) throw new SessionFormatError(`format v4 ${subject} requires a string${nonempty ? ' with content' : ''}`)
}

function positive(value: unknown, subject: string): void {
  if (sessionFormatCount(value, subject) === 0) throw new SessionFormatError(`format v4 ${subject} must be positive`)
}

function image(value: unknown): void {
  const attachment = record(value, 'system image attachment')
  string(attachment['attachmentId'], 'system image attachmentId', true)
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(attachment['mediaType'] as string)) throw new SessionFormatError('format v4 system image requires a supported mediaType')
  sessionFormatCount(attachment['bytes'], 'system image bytes')
  positive(attachment['width'], 'system image width')
  positive(attachment['height'], 'system image height')
  if (attachment['name'] !== undefined) string(attachment['name'], 'system image name')
  if (attachment['originalDimensions'] !== undefined) {
    const original = record(attachment['originalDimensions'], 'system image originalDimensions')
    positive(original['width'], 'system image original width')
    positive(original['height'], 'system image original height')
  }
}

/**
 * Validate system fields independently of historical message representations; preserve additional JSON fields.
 * @param row - complete logical event or parsed physical row before corruption recovery.
 */
export function assertV4SystemMessageFields(row: unknown): void {
  if (!isSessionFormatJsonObject(row) || row['type'] !== 'system/message') return
  const data = record(row['data'], 'system/message data')
  positive(data['turn'], 'system/message turn')
  positive(data['step'], 'system/message step')
  const message = record(data['message'], 'system message')
  string(message['id'], 'system message id', true)
  if (message['role'] !== 'system') throw new SessionFormatError('format v4 system message requires system role')
  const content = message['content']
  if (!Array.isArray(content)) throw new SessionFormatError('format v4 system message requires content array')
  for (const value of content) {
    const block = record(value, 'system content block')
    string(block['type'], 'system content type', true)
    switch (block['type']) {
      case 'text': case 'reasoning': string(block['text'], 'system content text'); break
      case 'tool-call':
        string(block['id'], 'system tool-call id', true)
        string(block['name'], 'system tool-call name', true)
        string(block['arguments'], 'system tool-call arguments')
        break
      case 'image': image(block['attachment']); break
      case 'tool-result': throw new SessionFormatError('format v4 system content rejects retired tool-result wrappers')
      default:
        // ContentBlockMap is merge-extensible; only known block fields are interpreted here.
        break
    }
  }
}
