/** MCP wire fixture returning a non-terminating discovery pagination. */

import { McpServer } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'

const server = new McpServer(
  { name: 'pagination-limit', version: '1.0.0' },
  { capabilities: { tools: {} } },
)
let requests = 0
server.server.setRequestHandler('tools/list', () => {
  return { tools: [], nextCursor: String(++requests) }
})

await server.connect(new StdioServerTransport())
