/** Frame one text or tool response from the local Messages endpoint. */
export function messagesResponse(content: Record<string, unknown>, stopReason: 'end_turn' | 'max_tokens' | 'tool_use'): string {
  return [
    { type: 'message_start', message: { id: 'sdk-smoke-response', model: 'deepseek-v4-pro', usage: { input_tokens: 3, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: content },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
}
