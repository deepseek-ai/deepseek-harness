/**
 * The MCP client host, `ctx.mcpClientHost`: the operations a plugin that manages MCP servers needs from this package.
 * The managing plugin creates it, so the host and the server instances it mounts run below that plugin's Fiber and end
 * with it.
 *
 * @module
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import * as McpClient from './index.ts'
import type { Config, StreamableHttpConfig } from './index.ts'
import { hasOAuthWithAuthorizationHeader, SERVER_NAME_PATTERN, StdioSchema, StreamableHttpSchema } from './config.ts'
import type { ConfigInput } from './config.ts'
import { resolveReconnectPolicy } from './connection.ts'
import { templatedFields } from './credentials.ts'
import { McpOAuthAuthorization } from './oauth.ts'
import type { McpOAuthConfig } from './oauth-options.ts'
import { probeServer } from './probe.ts'
import type { McpProbeOptions } from './probe.ts'
import { connectionStatusIn } from './status.ts'
import type { McpConnectionStatusHandle } from './status.ts'
import { assertTemplateSyntax } from './templates.ts'
import type { McpCloseResult, McpProbeResult } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Validates, mounts, probes, and authorizes MCP servers for the plugin that manages them. */
    mcpClientHost: McpClientHost
  }
}

/** One server instance the host mounted below its own Fiber. */
export interface McpServerInstance {
  /** Resolves with the instance's status handle once activation finishes; rejects with the activation failure. */
  readonly ready: Promise<McpConnectionStatusHandle>
  /**
   * Stop the instance and await its teardown.
   * @returns the cleanup result of its latest connection generation, or `undefined` when activation never registered one.
   */
  dispose(): Promise<McpCloseResult | undefined>
}

/** Validates, mounts, probes, and authorizes MCP servers for the plugin that manages them. */
export class McpClientHost extends Service {
  /**
   * The host's own context. A service method's `this.ctx` is the caller's context, so instances, probes, and
   * authorization owners use this one: they run below the host and end with it.
   */
  private readonly ownerContext: Context

  /**
   * Provide `ctx.mcpClientHost` for the lifetime of the managing plugin.
   * @param ctx - the managing plugin's context; mounted instances, probes, and authorization owners use its services.
   */
  constructor(ctx: Context) {
    super(ctx, 'mcpClientHost')
    this.ownerContext = ctx
  }

  /**
   * Resolve a server configuration and refuse what an instance would refuse when it starts.
   * @param input - server configuration before defaults.
   * @param path - configuration path naming the server; every failure message starts with it.
   * @returns the resolved configuration.
   * @throws when the server name, a field, a template token, the reconnect policy, or OAuth beside an Authorization
   *   header is invalid.
   */
  validate(input: ConfigInput, path: readonly string[]): Config {
    const where = path.join('.')
    if (!SERVER_NAME_PATTERN.test(input.serverName)) {
      throw new Error(`${where}: server name must match ${String(SERVER_NAME_PATTERN)}`)
    }
    const options = { path: [...path] }
    const config: Config = input.transport === 'stdio' ? StdioSchema(input, options) : StreamableHttpSchema(input, options)
    if (hasOAuthWithAuthorizationHeader(config)) {
      throw new Error(`${where}: OAuth and an Authorization header cannot be configured together`)
    }
    if (config.expandTemplates) {
      for (const [value, field] of templatedFields(config)) assertTemplateSyntax(value, `${where}.${field}`)
    }
    resolveReconnectPolicy(config.reconnect, `${where}.reconnect`)
    return config
  }

  /**
   * Mount one server instance below the host. The instance registers its tools and holds its `serverName` until disposed.
   * @param config - resolved server configuration, usually from {@link McpClientHost.validate}.
   * @returns the instance's activation and disposal.
   */
  mount(config: Config): McpServerInstance {
    // The host mounts this package's own entry, so every server instance is one plugin runtime: a reload of this
    // package replaces the host's instances together with the entries that load the same module.
    const fiber = this.ownerContext.plugin(McpClient, config)
    return {
      ready: fiber.await().then(() => {
        const status = connectionStatusIn(fiber)
        /* v8 ignore next -- an instance registers its status cell before its activation completes */
        if (status === undefined) throw new Error(`mcp-client(${config.serverName}): activated without connection status`)
        return status
      }),
      dispose: async () => {
        await fiber.dispose()
        return connectionStatusIn(fiber)?.closure()
      },
    }
  }

  /**
   * Probe a server without mounting it: resolve its templates, connect, list its tools, and close.
   * @param config - resolved server configuration; its startup budget does not bound the probe.
   * @param options - whole-probe budget, listing caps, and cancellation signal.
   * @returns the connect and list outcome with the cleanup result.
   * @throws for invalid options, malformed templates, or a missing required credentials provider.
   */
  probe(config: Config, options?: McpProbeOptions): Promise<McpProbeResult> {
    return probeServer(this.ownerContext, config, options)
  }

  /**
   * Create the explicit OAuth authorization owner of one server.
   * @param config - resolved Streamable HTTP configuration with OAuth.
   * @param changed - called after each change of the owner's attempt view.
   * @returns the owner; its caller retires and disposes it.
   */
  authorization(config: StreamableHttpConfig & { oauth: McpOAuthConfig }, changed: () => void): McpOAuthAuthorization {
    return new McpOAuthAuthorization(this.ownerContext, config, changed)
  }
}
