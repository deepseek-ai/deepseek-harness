/** Compile-time calls to the public plugin-record writer; excluded from production declarations. */
import { appendPluginRecord, pluginRecordOf } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { LlmCallConfig, RequestUserInput } from '@deepseek-ai/dsh-llm'

/** An independent request with domain interfaces and immutable message arrays. */
export interface PluginRequestFixture {
  readonly config: LlmCallConfig
  readonly messages: readonly RequestUserInput[]
}

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    'plugin:test/state': { count: number }
    'plugin:test/echo': Record<string, never>
    'plugin:test/number': number
    'plugin:test/request': PluginRequestFixture
    'plugin:test.bridge/entry_1': readonly (string | number)[]
  }
}

/**
 * Typecheck accepted payloads and rejected record names without executing writes.
 * @param session - target Session.
 * @param request - typed independent model request.
 */
export function checkPluginRecordWriteTypes(session: Session, request: PluginRequestFixture): void {
  appendPluginRecord(session, 'plugin:test/request', request)
  appendPluginRecord(session, 'plugin:test.bridge/entry_1', ['a', 2] as const)
  // @ts-expect-error -- an undeclared record name has no writable payload type.
  appendPluginRecord(session, 'plugin:test/undeclared', request)
  // @ts-expect-error -- the payload must match the selected record's declaration.
  appendPluginRecord(session, 'plugin:test/state', request)
  // @ts-expect-error -- another declared payload must not widen the selected key.
  appendPluginRecord(session, 'plugin:test/state', 1)
}

/**
 * Require payload validation even when a stored record has a declared name.
 * @param event - committed or restored event.
 */
export function checkPluginRecordReadTypes(event: SessionEvent): void {
  const record = pluginRecordOf(event)
  if (record?.type !== 'plugin:test/request') return
  // @ts-expect-error -- a known name does not validate a stored payload.
  const request: PluginRequestFixture = record.data
  void request
}
