/**
 * Loopback stand-in for Linear's hosted MCP server: OAuth protected-resource
 * and authorization-server metadata, dynamic client registration, an
 * authorization endpoint that approves every request by redirecting straight
 * back to the caller, a token endpoint, and a Streamable HTTP MCP endpoint
 * that requires a bearer token this fixture issued and answers JSON-RPC with
 * plain JSON. The `initialize`, `tools/list`, and `ping` answers are written
 * by hand because `apps/web` carries no MCP SDK dependency; the scenario only
 * needs the handshake and the tool listing to succeed.
 */
import { once } from 'node:events'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

/** The running fixture and what the browser and Host asked of it. */
export interface LinearOAuthFixture {
  /** `http://127.0.0.1:<port>`; the MCP endpoint is `<origin>/mcp`. */
  readonly origin: string
  /** Authorization pages the browser opened. */
  authorizations(): number
  /** Errors thrown while answering requests, each answered with a 500; the scenario expects none. */
  failures(): readonly unknown[]
  /** Stop listening and close open connections. */
  close(): Promise<void>
}

/**
 * Listen on an OS-assigned loopback port.
 * @returns the running fixture.
 */
export async function startLinearOAuthFixture(): Promise<LinearOAuthFixture> {
  let origin = '', authorizations = 0, tokens = 0, registrations = 0
  const issued = new Set<string>()
  const failures: unknown[] = []
  const json =(response: ServerResponse, value: unknown, status = 200): void => {
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
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
      json(response, { resource: origin + '/mcp', authorization_servers: [origin] })
    } else if (url.pathname === '/.well-known/oauth-authorization-server') {
      json(response, {
        issuer: origin, authorization_endpoint: origin + '/authorize', token_endpoint: origin + '/token',
        registration_endpoint: origin + '/register', response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'], authorization_response_iss_parameter_supported: true,
      })
    } else if (url.pathname === '/register') {
      registrations++
      const metadata = JSON.parse(await text(request)) as Record<string, unknown>
      json(response, { ...metadata, client_id: 'linear-client-' + String(registrations), token_endpoint_auth_method: 'none' }, 201)
    } else if (url.pathname === '/authorize') {
      authorizations++
      const callback = new URL(url.searchParams.get('redirect_uri')!)
      callback.searchParams.set('code', 'linear-code-' + String(authorizations))
      callback.searchParams.set('state', url.searchParams.get('state')!)
      callback.searchParams.set('iss', origin)
      response.writeHead(302, { location: callback.href }).end()
    } else if (url.pathname === '/token') {
      await text(request)
      tokens++
      const token = 'linear-access-' + String(tokens)
      issued.add(token)
      json(response, { access_token: token, refresh_token: 'linear-refresh-' + String(tokens), token_type: 'Bearer', expires_in: 3600 })
    } else if (url.pathname === '/mcp') {
      const token = request.headers.authorization?.replace(/^Bearer /u, '')
      if (token === undefined || !issued.has(token)) {
        response.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` }).end()
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
        reply({ protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'linear-fixture', version: '1.0.0' } })
        break
      case 'tools/list':
        reply({ tools: [{ name: 'linear-search', description: 'Search the fixture workspace.', inputSchema: { type: 'object', properties: {} } }] })
        break
      case 'ping': reply({}); break
      default: json(response, { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } })
    }
  }
  const server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      failures.push(error)
      if (!response.headersSent) response.writeHead(500).end()
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Linear OAuth fixture did not bind TCP')
  origin = `http://127.0.0.1:${String(address.port)}`
  return {
    origin,
    authorizations: () => authorizations,
    failures: () => failures,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => { if (error === undefined) resolve(); else reject(error) })
        server.closeAllConnections()
      })
    },
  }
}
