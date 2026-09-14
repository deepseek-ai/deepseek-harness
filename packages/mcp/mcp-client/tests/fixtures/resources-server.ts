/** Deterministic MCP resources and literal instructions for headless Session snapshots. */

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'

serveStdio(() => {
  const server = new McpServer(
    { name: 'snapshot-resources', version: '1.0.0' },
    { instructions: 'MCP_RESOURCE_INSTRUCTION: keep {{braces}} literal. Read resources from the catalog server.' },
  )
  server.registerResource('memo', 'memo://text', {
    description: 'Deterministic text memo.', mimeType: 'text/plain',
  }, async uri => ({
    contents: [{ uri: uri.href, mimeType: 'text/plain', text: 'MCP resource text with {{braces}} intact.' }],
  }))
  server.registerResource('binary', 'memo://binary', {
    description: 'Binary content for programmatic callers.', mimeType: 'application/octet-stream',
  }, async uri => ({
    contents: [{ uri: uri.href, mimeType: 'application/octet-stream', blob: 'bWNwLXJlc291cmNlLWJpbmFyeQ==' }],
  }))
  server.registerResource('greeting', new ResourceTemplate('memo://greeting/{name}', { list: undefined }), {
    description: 'A greeting for the named reader.', mimeType: 'text/plain',
  }, async (uri, variables) => ({
    contents: [{ uri: uri.href, mimeType: 'text/plain', text: `Hello, ${String(variables.name)}.` }],
  }))
  return server
})
