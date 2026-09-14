/** Messages response shared by SDK transport fixtures. */

/** A completed text turn with provider usage. */
export const MESSAGES_RESPONSE = [
  { type: 'message_start', message: { id: 'sdk-response', model: 'mock-model', usage: { input_tokens: 3, output_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
  { type: 'message_stop' },
].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
