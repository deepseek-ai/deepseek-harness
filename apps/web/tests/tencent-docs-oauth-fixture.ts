/**
 * Loopback stand-in for Tencent Docs' hosted MCP server, laid out like the
 * hosted metadata: the 401 challenge names protected-resource metadata under
 * the MCP path, that metadata lists the `docs:*` scopes, and the
 * authorization endpoint already carries a query string. Dynamic client
 * registration, an authorization endpoint that approves every request by
 * redirecting straight back without an `iss` parameter, a token endpoint, and
 * a Streamable HTTP MCP endpoint that requires the issued bearer token and
 * answers JSON-RPC with plain JSON complete the flow.
 */
import { once } from 'node:events'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

const SCOPES = ['docs:read', 'docs:write', 'docs:manage']

/** The running fixture and what the browser and Host asked of it. */
export interface TencentDocsOAuthFixture {
  /** `http://127.0.0.1:<port>`; the MCP endpoint is `<origin>/mcp`. */
  readonly origin: string
  /** Authorization pages the browser opened. */
  authorizations(): number
  /** Query of the latest authorization page the browser opened. */
  authorizationQuery(): URLSearchParams | undefined
  /** Stop listening and close open connections. */
  close(): Promise<void>
}

/**
 * Listen on an OS-assigned loopback port.
 * @returns the running fixture.
 */
export async function startTencentDocsOAuthFixture(): Promise<TencentDocsOAuthFixture> {
  let origin = '', authorizations = 0, tokens = 0, registrations = 0
  let authorizationQuery: URLSearchParams | undefined
  const json = (response: ServerResponse, value: unknown, status = 200): void => {
    response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value))
  }
  async function text(request: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = []
    for await (const chunk of request) {
      if (!(chunk instanceof Uint8Array)) throw new Error('Expected request bytes')
      chunks.push(Buffer.from(chunk))
    }
    return Buffer.concat(chunks).toString()
  }
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url!, origin)
    if (url.pathname === '/mcp/.well-known/oauth-protected-resource') {
      json(response, { resource: origin + '/mcp', authorization_servers: [origin], scopes_supported: SCOPES, bearer_methods_supported: ['header'] })
    } else if (url.pathname === '/.well-known/oauth-authorization-server') {
      json(response, {
        issuer: origin, authorization_endpoint: origin + '/authorize?authType=2', token_endpoint: origin + '/token',
        registration_endpoint: origin + '/register', scopes_supported: SCOPES, response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      })
    } else if (url.pathname === '/register') {
      registrations++
      const metadata = JSON.parse(await text(request)) as Record<string, unknown>
      json(response, { ...metadata, client_id: 'tencent-docs-client-' + String(registrations), token_endpoint_auth_method: 'none' }, 201)
    } else if (url.pathname === '/authorize') {
      authorizations++
      authorizationQuery = url.searchParams
      const callback = new URL(url.searchParams.get('redirect_uri')!)
      callback.searchParams.set('code', 'tencent-docs-code-' + String(authorizations))
      callback.searchParams.set('state', url.searchParams.get('state')!)
      response.writeHead(302, { location: callback.href }).end()
    } else if (url.pathname === '/token') {
      await text(request)
      tokens++
      json(response, { access_token: 'tencent-docs-access-' + String(tokens), refresh_token: 'tencent-docs-refresh-' + String(tokens), token_type: 'Bearer', expires_in: 31535999, scope: SCOPES.join(' ') })
    } else if (url.pathname === '/mcp') {
      if (request.headers.authorization === undefined) {
        response.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${origin}/mcp/.well-known/oauth-protected-resource"` }).end()
      } else await answerMcp(request, response)
    } else response.writeHead(404).end()
  }
  async function answerMcp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== 'POST') { response.writeHead(405).end(); return }
    const message = JSON.parse(await text(request)) as { id?: number | string; method: string; params?: { protocolVersion?: string } }
    if (message.id === undefined) { response.writeHead(202).end(); return }
    const reply = (result: unknown): void => { json(response, { jsonrpc: '2.0', id: message.id, result }) }
    switch (message.method) {
      case 'initialize':
        reply({ protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'tencent-docs-fixture', version: '1.0.0' } })
        break
      case 'tools/list':
        reply({ tools: [{ name: 'search', description: 'Search the fixture documents.', inputSchema: { type: 'object', properties: {} } }] })
        break
      case 'ping': reply({}); break
      default: json(response, { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } })
    }
  }
  const server = createServer((request, response) => {
    handle(request, response).catch(() => { if (!response.headersSent) response.writeHead(500).end() })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Tencent Docs OAuth fixture did not bind TCP')
  origin = `http://127.0.0.1:${String(address.port)}`
  return {
    origin,
    authorizations: () => authorizations,
    authorizationQuery: () => authorizationQuery,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => { if (error === undefined) resolve(); else reject(error) })
        server.closeAllConnections()
      })
    },
  }
}
