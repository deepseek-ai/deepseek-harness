/** Deterministic MCP screenshot result for real-profile retention replay. */
import { createMcpToolDefinition } from '@deepseek-ai/dsh-mcp-client'

export const inject = ['tools', 'attachments']

/** Register the fixed text/image sequence used by the snapshot model. */
export function apply(ctx) {
  const image = { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC' }
  const text = value => ({ type: 'text', text: value })
  ctx.effect(() => ctx.tools.register(createMcpToolDefinition(ctx, {
    name: 'mcp__fixture__inspect', rawName: 'inspect', description: 'Read a fixed window snapshot.',
    inputSchema: { type: 'object', properties: { layout: { type: 'string', enum: ['ends', 'middle'] } }, required: ['layout'] },
    call: async ({ layout }) => ({ content: layout === 'ends'
      ? [text('A'), image, text('B'.repeat(20000)), image, text('C')]
      : [text('A'.repeat(8000)), image, text('C'.repeat(8000))] }),
  })))
}
