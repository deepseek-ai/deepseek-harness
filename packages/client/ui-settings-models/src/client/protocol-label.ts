/**
 * Product names for the wire protocols a pi-ai route may speak. The pickers
 * show these instead of the schema identifiers (`openai-completions`), which
 * are what `settings.yaml` carries and what the option values stay.
 */

import type { ModelsKey } from './locales.ts'

/** The protocols this page names, keyed by their schema identifier. */
const PROTOCOL_LABEL_KEYS: Readonly<Record<string, ModelsKey>> = {
  'openai-completions': 'protocolOpenAiCompletions',
  'openai-responses': 'protocolOpenAiResponses',
  'anthropic-messages': 'protocolAnthropicMessages',
}

/**
 * The picker text for one protocol identifier.
 * @param t - section copy.
 * @param protocol - the schema identifier of the protocol.
 * @returns the product name this page knows the protocol by; a protocol the
 * adapter adds before this page names it shows its identifier, the spelling
 * `settings.yaml` needs anyway.
 */
export function protocolLabel(t: (key: ModelsKey) => string, protocol: string): string {
  const key = PROTOCOL_LABEL_KEYS[protocol]
  return key === undefined ? protocol : t(key)
}
