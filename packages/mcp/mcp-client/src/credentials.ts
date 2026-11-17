/** Runtime template resolution and secret redaction for one MCP instance. */

import type { Context } from '@deepseek-ai/cordis'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { assertTemplateSyntax, credentialRefsIn, resolveTemplateString } from './templates.ts'
import { describeError, McpLocalError, redactSecrets } from './diagnostic.ts'
import type { Config } from './index.ts'

/** Resolves raw configuration through the current credential provider and redacts every value it resolved. */
export class McpTemplateBinding {
  /** Enabled credential references from raw configuration, including currently unconfigured references. */
  readonly refs: ReadonlySet<string>
  /** Resolved values and their URL-encoded forms, retained for the instance lifetime. */
  private readonly secrets = new Set<string>()

  constructor(private readonly ctx: Context, private readonly config: Config) {
    const strings = config.transport === 'stdio'
      ? [config.command, ...config.args, ...Object.values(config.env), config.cwd]
      : [config.url, ...Object.values(config.headers)]
    this.refs = new Set(config.expandTemplates ? strings.flatMap(credentialRefsIn) : [])
    if (config.expandTemplates) {
      for (const value of strings) assertTemplateSyntax(value, `mcp-client(${config.serverName})`)
      if (this.refs.size > 0 && ctx.get('credentials') === undefined) {
        throw new McpLocalError('MCP credential templates require a credentials provider', 'MCP_CREDENTIALS_UNAVAILABLE')
      }
    }
  }

  /**
   * Replace every value this binding resolved, including earlier rotations.
   * @param text - diagnostic or upstream text.
   * @returns the text with resolved values replaced by `[redacted]`.
   */
  redact(text: string): string {
    return redactSecrets(text, this.secrets)
  }

  /**
   * Format a failure, naming the operation and redacting resolved values when templates are enabled.
   * @param error - caught operation failure.
   * @param operation - local operation name for the diagnostic.
   * @returns diagnostic text safe for the configured template mode.
   */
  diagnostic(error: unknown, operation: string): string {
    if (!this.config.expandTemplates) return describeError(error)
    return `mcp-client(${this.config.serverName}): ${operation}: ${this.redact(describeError(error))}`
  }

  /**
   * Resolve transport strings without changing the plugin's raw configuration.
   * @param signal - cancellation checked before and after template resolution.
   * @returns resolved transport configuration, or the raw configuration when expansion is disabled.
   * @throws when a credential or the credentials provider is unavailable.
   */
  async resolve(signal: AbortSignal): Promise<Config> {
    signal.throwIfAborted()
    if (!this.config.expandTemplates) return this.config
    const values = new Map<string, Promise<string | undefined>>()
    const credential = (ref: string): Promise<string | undefined> => {
      let value = values.get(ref)
      if (value === undefined) {
        const provider = this.ctx.get('credentials')
        if (provider === undefined) throw new McpLocalError('MCP credential templates require a credentials provider', 'MCP_CREDENTIALS_UNAVAILABLE')
        value = provider.resolve(ref as CredentialRef).then((result) => {
          if (result !== undefined && result.value !== '') this.secrets.add(result.value).add(encodeURIComponent(result.value))
          return result?.value
        })
        values.set(ref, value)
      }
      return value
    }
    const resolve = async (value: string, path: string): Promise<string> => {
      const result = await resolveTemplateString(value, path, credential)
      signal.throwIfAborted()
      return result
    }
    const record = async (value: Record<string, string>, path: string): Promise<Record<string, string>> => {
      const resolved: Array<[string, string]> = []
      for (const [key, entry] of Object.entries(value)) resolved.push([key, await resolve(entry, `${path}.${key}`)])
      return Object.fromEntries(resolved)
    }
    const config = this.config
    if (config.transport === 'stdio') {
      const args: string[] = []
      for (const [index, arg] of config.args.entries()) args.push(await resolve(arg, `args[${index}]`))
      return {
        ...config,
        command: await resolve(config.command, 'command'),
        args,
        env: await record(config.env, 'env'),
        cwd: await resolve(config.cwd, 'cwd'),
      }
    }
    return { ...config, url: await resolve(config.url, 'url'), headers: await record(config.headers, 'headers') }
  }
}
