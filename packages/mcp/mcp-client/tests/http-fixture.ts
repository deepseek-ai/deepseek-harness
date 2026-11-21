import { z } from 'zod'
/** Keyless stateless Streamable HTTP MCP fixture for integration tests. */

import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createMcpHandler, McpServer, type CallToolResult } from '@modelcontextprotocol/server'
import { toNodeHandler, type NodeIncomingMessageLike } from '@modelcontextprotocol/node'

/** Running HTTP fixture and the request headers it observed. */
export interface HttpMcpFixture {
  url: string
  calls: string[]
  authorization: Array<string | undefined>
  /** Forget every session id issued under the `sessions` option. */
  expireSessions: () => void
  close: () => Promise<void>
}

/** The JSON-RPC error body stateful servers send with a rejected session. */
function sessionError(status: number, message: string): Response {
  return Response.json({ jsonrpc: '2.0', error: { code: -32_000, message }, id: null }, { status })
}

/**
 * Start a stateless MCP endpoint whose ping tool can echo request credentials in tool errors or authorization failures.
 * With `sessions`, `initialize` issues an `Mcp-Session-Id`, and any other request is rejected with 400 when it
 * carries no id and with 404 when the fixture no longer knows its id.
 */
export async function startHttpMcpFixture(
  options: { rejectToolCalls?: boolean; authorizationFailure?: boolean; sessions?: boolean } = {},
): Promise<HttpMcpFixture> {
  const calls: string[] = []
  const authorization: Array<string | undefined> = []
  const sessions = new Set<string>()
  const handler = createMcpHandler(({ requestInfo }) => {
    const mcp = new McpServer(
      { name: 'http-fixture', version: '1.0.0' },
      { capabilities: { tools: {} }, ...options.authorizationFailure ? { instructions: 'MCP_AUTHORIZED_INSTRUCTION: use the protected ping tool.' } : {} },
    )
    mcp.registerTool('ping', { description: 'Replies pong.', inputSchema: z.object({}) }, async (): Promise<CallToolResult> => {
      calls.push('ping')
      if (options.rejectToolCalls) {
        return { isError: true, content: [{ type: 'text', text: `MCP fixture rejected ${requestInfo?.headers.get('authorization')}` }] }
      }
      return { content: [{ type: 'text', text: 'pong' }] }
    })
    return mcp
  })
  const handle = toNodeHandler({
    async fetch(request, context) {
      const inspected = options.authorizationFailure === true || options.sessions === true
      const body: unknown = inspected && request.method === 'POST' ? await request.clone().json() : undefined
      const method = body !== null && typeof body === 'object' && 'method' in body ? body.method : undefined
      if (options.authorizationFailure && method === 'tools/call') {
        calls.push('ping')
        return new Response(`MCP fixture rejected ${request.headers.get('authorization')}`, {
          status: 403,
          headers: { 'www-authenticate': 'Bearer error="insufficient_scope", scope="admin"' },
        })
      }
      if (options.sessions && method === 'initialize') {
        const response = await handler.fetch(request, context)
        const headers = new Headers(response.headers)
        const id = randomUUID()
        sessions.add(id)
        headers.set('mcp-session-id', id)
        return new Response(response.body, { status: response.status, headers })
      }
      if (options.sessions) {
        const id = request.headers.get('mcp-session-id')
        if (id === null) return sessionError(400, 'Bad Request: Server not initialized')
        if (!sessions.has(id)) return sessionError(404, 'Session not found')
      }
      return handler.fetch(request, context)
    },
  })
  const handleRequest = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    authorization.push(request.headers.authorization)
    // The adapter excludes explicit undefined on Node's optional HTTP fields.
    await handle(request as NodeIncomingMessageLike, response)
  }
  const server = createServer((request, response) => {
    handleRequest(request, response).catch((error: unknown) => {
      response.writeHead(500).end(String(error))
    })
  })
  const listening: PromiseWithResolvers<void> = Promise.withResolvers()
  server.listen(0, '127.0.0.1', listening.resolve)
  await listening.promise
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('HTTP MCP fixture has no TCP address')
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    authorization,
    calls,
    expireSessions: () => { sessions.clear() },
    close: async () => {
      await handler.close()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => { if (error === undefined) resolve(); else reject(error) })
      })
    },
  }
}
