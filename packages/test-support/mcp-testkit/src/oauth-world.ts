/**
 * A loopback OAuth authorization server and MCP endpoint with real credential, authorization, and callback services.
 *
 * @module
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, onTestFinished, vi } from 'vitest'
import { Context, Logger, LoggerLevel, type Exporter } from '@deepseek-ai/cordis'
import Authorization from '@deepseek-ai/dsh-authorization'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import Tools from '@deepseek-ai/dsh-tools'
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server'
import { toNodeHandler, type NodeIncomingMessageLike } from '@modelcontextprotocol/node'
import { z } from 'zod'
import { Config, type McpOAuthConfig, type StreamableHttpConfig } from '@deepseek-ai/dsh-mcp-client'
import { McpOAuthAuthorization } from '@deepseek-ai/dsh-mcp-client/src/oauth.ts'
import type { McpOAuthAttemptView } from '@deepseek-ai/dsh-mcp-client/types'

/** Recorded external request; token endpoints can be held by an explicit barrier. */
export interface OAuthRequest {
  path: string
  headers: IncomingMessage['headers']
  form: URLSearchParams
  response: ServerResponse
}

/** The protocol server's answers that a test may change. */
export interface OAuthBehavior {
  /** Answers token requests instead of issuing sequential tokens. */
  token?: (request: OAuthRequest) => Promise<void>
  /** Answers authenticated MCP requests with this status and optional challenge. */
  rejection?: { status: number; challenge?: string }
  /** `false` answers metadata discovery with 404 and challenges without a metadata URL. */
  metadata?: false
  /** Authorization endpoint the authorization-server metadata advertises. */
  authorizationEndpoint?: string
  /** Resource the protected-resource metadata advertises. */
  resource?: string
}

/** A loopback OAuth world and the services mounted for it, torn down with the calling test. */
export interface OAuthWorld {
  /** Context carrying the credential, authorization, Web server, and tool services. */
  ctx: Context
  /** Streamable HTTP configuration of the world's MCP endpoint with OAuth. */
  config: StreamableHttpConfig & { oauth: McpOAuthConfig }
  /** Create an authorization owner; teardown expects each owner to close cleanly. */
  owner: (options?: StreamableHttpConfig & { oauth: McpOAuthConfig }) => McpOAuthAuthorization
  /** Switches that change the protocol server's answers. */
  behavior: OAuthBehavior
  /** Every request the protocol server received. */
  requests: OAuthRequest[]
  /** The protocol server's origin. */
  origin: string
  /** Create a gate that teardown releases. */
  barrier: () => PromiseWithResolvers<void>
  /** Dynamic client registrations so far. */
  registrations: () => number
  /** Token requests so far. */
  tokens: () => number
}

/**
 * Mount isolated credential, authorization, Web server, and tool services and a protocol server, with all teardown
 * owned by the calling test.
 * @param interactive - mount the authorization and Web server services that explicit authorization requires.
 * @param webHost - host the Web server binds.
 * @returns the world, whose teardown is registered with the calling test.
 */
export async function oauthWorld(interactive = true, webHost = '127.0.0.1'): Promise<OAuthWorld> {
  const ctx = new Context()
  const releases: Array<() => void> = []
  const owners: McpOAuthAuthorization[] = []
  const requests: OAuthRequest[] = []
  let registrationCount = 0
  let tokenCount = 0
  let origin = ''
  const behavior: OAuthBehavior = {}
  const mcp = createMcpHandler(({ requestInfo }) => {
    const server = new McpServer({ name: 'oauth-fixture', version: '1.0.0' }, { capabilities: { tools: {} } })
    server.registerTool('ping', { description: 'Replies pong.', inputSchema: z.object({}) }, () => ({ content: [{ type: 'text', text: 'pong' }] }))
    server.registerTool('reject', { description: 'Echoes the request authorization in an error.', inputSchema: z.object({}) }, () => ({
      isError: true, content: [{ type: 'text', text: `rejected ${String(requestInfo?.headers.get('authorization'))}` }],
    }))
    return server
  })
  const handleMcp = toNodeHandler(mcp)
  const server = createServer((request, response) => {
    // A failing handler answers 500, so a fixture defect fails the request instead of leaving it open.
    void handle(request, response).catch(() => { response.writeHead(500).end() })
  })
  const dir = await mkdtemp(join(tmpdir(), 'dsh-mcp-oauth-'))
  onTestFinished(async () => {
    for (const release of releases) release()
    try {
      for (const owner of owners) expect(await owner.dispose()).toEqual({ closeConfirmed: true })
      await ctx.fiber.dispose()
    } finally {
      await mcp.close()
      await new Promise<void>((resolve, reject) => {
        /* v8 ignore next -- a close failure fails the test's teardown */
        server.close((error) => { if (error === undefined) resolve(); else reject(error) })
        server.closeAllConnections()
      })
      await rm(dir, { recursive: true, force: true })
    }
  })
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    /* v8 ignore next -- a request a server receives always carries its URL */
    const path = new URL(request.url ?? '/', origin).pathname
    const body: Buffer[] = []
    if (path !== '/mcp') for await (const chunk of request) {
      /* v8 ignore next -- Node yields Buffer chunks for a request without an encoding */
      if (!(chunk instanceof Uint8Array)) throw new Error('Expected request bytes')
      body.push(Buffer.from(chunk))
    }
    const observed = { path, headers: { ...request.headers }, form: new URLSearchParams(Buffer.concat(body).toString()), response }
    requests.push(observed)
    const json = (value: unknown, status = 200): void => { response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value)) }
    if (behavior.metadata === false && path.startsWith('/.well-known/')) {
      response.writeHead(404).end()
    } else if (path.startsWith('/.well-known/oauth-protected-resource')) {
      json({ resource: behavior.resource ?? origin + '/mcp', authorization_servers: [origin], scopes_supported: ['tools'] })
    } else if (path === '/.well-known/oauth-authorization-server') {
      json({ issuer: origin, authorization_endpoint: behavior.authorizationEndpoint ?? origin + '/authorize', token_endpoint: origin + '/token', registration_endpoint: origin + '/register',
        response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_post', 'none'], authorization_response_iss_parameter_supported: true })
    } else if (path === '/register') {
      registrationCount++
      const metadata: unknown = JSON.parse(Buffer.concat(body).toString())
      json({ ...z.looseObject({ redirect_uris: z.array(z.string()) }).parse(metadata), client_id: 'client-' + String(registrationCount),
        client_secret: 'fixture-client-secret', token_endpoint_auth_method: 'client_secret_post' }, 201)
    } else if (path === '/token') {
      tokenCount++
      if (behavior.token !== undefined) await behavior.token(observed)
      else json({ access_token: 'access-' + String(tokenCount), refresh_token: 'refresh-' + String(tokenCount), token_type: 'Bearer', expires_in: 3600, scope: 'tools' })
    } else if (path === '/mcp') {
      if (request.headers.authorization === undefined) {
        response.writeHead(401, { 'www-authenticate': behavior.metadata === false ? 'Bearer' : `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource", scope="tools"` }).end()
      } else if (behavior.rejection !== undefined) {
        response.writeHead(behavior.rejection.status, behavior.rejection.challenge === undefined ? {} : { 'www-authenticate': behavior.rejection.challenge }).end()
      } else await handleMcp(request as NodeIncomingMessageLike, response)
    } else response.writeHead(404).end()
  }
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  /* v8 ignore next -- a listening TCP server reports an address object */
  if (address === null || typeof address === 'string') throw new Error('OAuth fixture did not bind TCP')
  origin = `http://127.0.0.1:${String(address.port)}`
  await ctx.plugin(LocalCredentialProvider, { path: join(dir, 'credentials.yaml'), watch: false })
  if (interactive) {
    await ctx.plugin(Authorization)
    await ctx.plugin(WebServer, { host: webHost, port: 0 })
  }
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(NativeToolExecutor)
  const resolved = Config({ transport: 'streamable-http', serverName: 'oauth', url: origin + '/mcp',
    headers: { 'x-resource-only': 'fixture-resource-secret' }, oauth: { credentialKey: 'mcp-client/oauth' }, reconnect: { enabled: false } })
  /* v8 ignore next -- the literal above resolves to a Streamable HTTP OAuth configuration */
  if (resolved.transport !== 'streamable-http' || resolved.oauth === undefined) throw new Error('Missing HTTP OAuth configuration')
  const config: StreamableHttpConfig & { oauth: McpOAuthConfig } = { ...resolved, oauth: resolved.oauth }
  const owner = (options = config): McpOAuthAuthorization => {
    const result = new McpOAuthAuthorization(ctx, options, () => undefined)
    owners.push(result)
    return result
  }
  const barrier = (): PromiseWithResolvers<void> => {
    const gate: PromiseWithResolvers<void> = Promise.withResolvers()
    releases.push(gate.resolve)
    return gate
  }
  return { ctx, config, owner, behavior, requests, origin, barrier,
    registrations: () => registrationCount, tokens: () => tokenCount }
}

/**
 * Wait for an observed authorization phase.
 * @param read - reads the current attempt view.
 * @param expected - phase to wait for.
 * @returns the view in that phase.
 */
export async function phase(read: () => McpOAuthAttemptView | undefined, expected: McpOAuthAttemptView['phase']): Promise<McpOAuthAttemptView> {
  await vi.waitFor(() => { expectPhase(read(), expected) }, { timeout: 5000 })
  const view = read()
  expectPhase(view, expected)
  return view
}

/**
 * Record every message the world logs, formatted as a console exporter prints it.
 * @param ctx - world context whose logger service receives the exporter.
 * @returns the formatted lines, appended as messages arrive.
 */
export function captureLogs(ctx: Context): string[] {
  const lines: string[] = []
  const exporter: Exporter = {
    levels: { default: LoggerLevel.DEBUG },
    export: (message) => { lines.push(Logger.format(exporter, message)) },
  }
  ctx.logger.exporter(exporter)
  return lines
}

function expectPhase(view: McpOAuthAttemptView | undefined, expected: McpOAuthAttemptView['phase']): asserts view is McpOAuthAttemptView {
  if (view?.phase !== expected) throw new Error(`Expected ${expected}, received ${JSON.stringify(view)}`)
}

function present<T>(value: T | null | undefined, what: string): T {
  /* v8 ignore next -- an attempt waiting for the browser carries its authorization URL, redirect URI, and state */
  if (value === null || value === undefined) throw new Error(`OAuth attempt has no ${what}`)
  return value
}

/**
 * Deliver a browser callback with the state and issuer advertised by this attempt.
 * @param view - attempt view carrying the authorization URL.
 * @param result - the authorization code or error the browser returns.
 * @returns the callback's HTTP status.
 */
export async function callback(view: McpOAuthAttemptView, result: { code: string } | { error: string } = { code: 'fixture-code' }): Promise<number> {
  const authorization = new URL(present(view.authorizationUrl, 'authorization URL'))
  const url = new URL(present(authorization.searchParams.get('redirect_uri'), 'redirect URI'))
  url.searchParams.set('state', present(authorization.searchParams.get('state'), 'state'))
  url.searchParams.set('iss', authorization.origin)
  for (const [key, value] of Object.entries(result)) url.searchParams.set(key, value)
  const response = await fetch(url)
  await response.arrayBuffer()
  return response.status
}

/**
 * Finish one real discovery, registration, PKCE exchange, and durable grant commit.
 * @param owner - authorization owner from the world.
 */
export async function authorize(owner: McpOAuthAuthorization): Promise<void> {
  await owner.start()
  const waiting = await phase(() => owner.current(), 'waiting-browser')
  /* v8 ignore next -- a refused callback fails the helper instead of waiting for the attempt to time out */
  if (await callback(waiting) !== 200) throw new Error('OAuth callback was rejected')
  await phase(() => owner.current(), 'authorized')
}
