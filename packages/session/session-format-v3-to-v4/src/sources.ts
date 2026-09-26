/** Released V3 plugin-source conversion and declared message traversal. */

import { SessionFormatError, isSessionFormatJsonObject } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatEvent, SessionFormatJsonObject, SessionFormatJsonValue } from '@deepseek-ai/dsh-session-format'

/**
 * Visit only messages carried by first-party event payloads.
 * @param event - source or target logical event.
 * @param transform - message transform preserving unchanged identity.
 * @returns the event sharing all untouched payloads.
 */
export function mapEventMessages(
  event: SessionFormatEvent,
  transform: (message: SessionFormatJsonObject) => SessionFormatJsonObject,
): SessionFormatEvent {
  const data = event.data
  if (!isSessionFormatJsonObject(data)) return event
  if (event.type === 'user/message') {
    const message = transform(data)
    return message === data ? event : { ...event, data: message }
  }
  if (event.type === 'developer/message' || event.type === 'system/message' || event.type === 'assistant/message' || event.type === 'tool/result') {
    if (!isSessionFormatJsonObject(data['message'])) throw new SessionFormatError(event.type + ' requires a message')
    const message = transform(data['message'])
    return message === data['message'] ? event : { ...event, data: { ...data, message } }
  }
  const key = event.type === 'agent/inbox/spliced' ? 'inserted' : event.type === 'session/title-llm-request' ? 'messages' : undefined
  if (key === undefined) return event
  const messages = data[key]
  if (!Array.isArray(messages)) throw new SessionFormatError(event.type + ' requires message array')
  const mapped = (messages as readonly SessionFormatJsonValue[]).map((message) => {
    if (!isSessionFormatJsonObject(message)) throw new SessionFormatError(event.type + ' requires message objects')
    return transform(message)
  })
  return mapped.every((message, index) => message === messages[index]) ? event : { ...event, data: { ...data, [key]: mapped } }
}

/** Released V3 plugin names whose current producer kind is not the plugin string. */
const RENAMED_PRODUCERS: Readonly<Record<string, string>> = Object.freeze({
  'compact': 'compact-checkpoint',
  'tools-code-mode': 'ptc-mode',
  'tools-ptc': 'ptc-mode',
  'dsh-compaction-basic': 'compact-basic',
  '@deepseek-ai/dsh-system-prompt': 'runtime-context',
})

/** First-party V3 plugin identities that intentionally keep their current kind. */
const RELEASED_SAME_NAME_PRODUCERS: ReadonlySet<string> = new Set([
  'agent-instructions', 'session-reference', 'team-message', 'goal',
  'skill-invocation', 'skill-catalog', 'coordinator', 'subagent-report',
  'subagent-settled', 'webhook', 'agent-message', 'model-selection',
  'plan-mode', 'time-context', 'tmux-context', 'user-approval',
  'repeat-tool-reminder', 'tool-cordis', 'cordis-host-runner', 'tool-goal',
  'tool-jobs', 'hooks-codex', 'hooks-claude-code', 'schedule',
  'dsh-session-title-llm',
])

/** Resolve the current producer kind for one released V3 plugin string. */
function producerKind(plugin: string, role: SessionFormatJsonValue | undefined): string {
  if (plugin === '@deepseek-ai/dsh-system-prompt' && role === 'system') return 'system-prompt'
  const renamed = Object.hasOwn(RENAMED_PRODUCERS, plugin) ? RENAMED_PRODUCERS[plugin] : undefined
  if (renamed !== undefined) return renamed
  if (RELEASED_SAME_NAME_PRODUCERS.has(plugin)) return plugin
  return `plugin:${plugin}`
}

/**
 * Lift one released V3 plugin source into the current producer-owned shape.
 * @param source - source record whose `kind` is `'plugin'`.
 * @param seq - event seq for diagnostics.
 * @param role - carried message role for role-sensitive renames.
 * @returns a copy whose kind is the producer's own kind and whose `plugin` field is dropped.
 */
export function rewritePluginSource(
  source: SessionFormatJsonObject,
  seq: number,
  role: SessionFormatJsonValue | undefined,
): SessionFormatJsonObject {
  const plugin = source['plugin']
  if (typeof plugin !== 'string') {
    throw new SessionFormatError(
      `plugin source at seq ${seq} is not canonical: plugin requires a string`,
    )
  }
  const kind = producerKind(plugin, role)
  if (Object.keys(source).length === 2) return { kind }
  return Object.fromEntries(Object.entries(source)
    .filter(([key]) => key !== 'plugin')
    .map(([key, item]) => [key, key === 'kind' ? kind : item]))
}

/**
 * Convert released plugin wrappers while retaining every direct source kind and its metadata.
 * @param source - decoded V3 message source.
 * @param seq - event sequence for diagnostics.
 * @param role - enclosing message role for role-sensitive producer mappings.
 * @returns the converted source with every non-identity field preserved.
 */
export function rewriteV3MessageSource(
  source: SessionFormatJsonObject, seq: number, role: SessionFormatJsonValue | undefined,
): SessionFormatJsonObject {
  const kind = source['kind']
  if (typeof kind !== 'string' || kind.length === 0) throw new SessionFormatError(`message source at seq ${seq} requires a nonempty kind`)
  if (kind === 'plugin') return rewritePluginSource(source, seq, role)
  return source
}
