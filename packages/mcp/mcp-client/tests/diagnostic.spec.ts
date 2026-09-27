// The connection-diagnostic line: cause chains survive, raw identifiers stay
// verbatim, and hostile shapes (cycles, empty messages, bare values) cannot
// break the status text they feed.
import { describe, expect, it } from 'vitest'
import { SdkError, SdkErrorCode } from '@modelcontextprotocol/client'
import { Context } from '@deepseek-ai/cordis'
import { describeError, describeTemplateError, McpLocalError } from '@deepseek-ai/dsh-mcp-client/src/diagnostic.ts'
import { McpTemplateBinding } from '../src/credentials.ts'
import { Config } from '../src/index.ts'

describe('describeError', () => {
  it('keeps a plain error as its own string', () => {
    expect(describeError(new Error('boom'))).toBe('Error: boom')
    expect(describeError(new TypeError('fetch failed'))).toBe('TypeError: fetch failed')
  })

  it('appends the cause chain the way fetch failures carry it', () => {
    const cause = new Error('connect ECONNREFUSED 127.0.0.1:8932')
    const outer = new TypeError('fetch failed', { cause })
    expect(describeError(outer)).toBe('TypeError: fetch failed, cause: connect ECONNREFUSED 127.0.0.1:8932')
  })

  it('walks nested causes and keeps a non-generic name on an inner segment', () => {
    const inner = new RangeError('depth')
    const middle = new Error('middle', { cause: inner })
    const outer = new Error('outer', { cause: middle })
    expect(describeError(outer)).toBe('Error: outer, cause: middle, cause: RangeError: depth')
  })

  it('falls back to the syscall code when an aggregate cause has no message', () => {
    const aggregate = new Error('')
    ;(aggregate as { code?: string }).code = 'ECONNREFUSED'
    const outer = new TypeError('fetch failed', { cause: aggregate })
    expect(describeError(outer)).toBe('TypeError: fetch failed, cause: ECONNREFUSED')
  })

  it('names an empty codeless cause by its error name', () => {
    const blank = new Error('')
    const outer = new Error('outer', { cause: blank })
    expect(describeError(outer)).toBe('Error: outer, cause: Error')
  })

  it('stringifies non-error values at both positions', () => {
    expect(describeError('wire literal')).toBe('wire literal')
    const outer = new Error('outer', { cause: 'raw detail' })
    expect(describeError(outer)).toBe('Error: outer, cause: raw detail')
  })

  it('stringifies a nullish thrown value', () => {
    expect(describeError(undefined)).toBe('undefined')
    expect(describeError(null)).toBe('null')
  })

  it('stops on a circular cause chain', () => {
    const a = new Error('a')
    const b = new Error('b', { cause: a })
    a.cause = b
    expect(describeError(a)).toBe('Error: a, cause: b')
  })
})

describe('template-safe diagnostics', () => {
  it.each(['ECONNREFUSED', 'ENOTFOUND'])('keeps %s without copying credentials from the cause chain', (code) => {
    const cause = Object.assign(new Error('https://secret-token@example.invalid'), { code })
    expect(describeTemplateError(new Error('command secret-token', { cause }))).toBe(code)
  })

  it('keeps SDK error codes without copying their messages', () => {
    expect(describeTemplateError(new SdkError(SdkErrorCode.RequestTimeout, 'secret-token'))).toBe('REQUEST_TIMEOUT')
  })

  it.each(['MCP operation timed out', 'server instructions exceed maxInstructionBytes', 'MCP transport closure could not be confirmed'])(
    'keeps the local reason: %s', (reason) => {
      expect(describeTemplateError(new McpLocalError(reason, { cause: new Error('secret-token') }))).toBe(reason)
    },
  )

  it('omits unknown codes and cyclic upstream causes', () => {
    const error = Object.assign(new Error('secret-token'), { code: 'SECRET_TOKEN' })
    error.cause = error
    const result = describeTemplateError(error)
    expect(result).toContain('upstream details omitted')
    expect(result).not.toMatch(/secret-token|SECRET_TOKEN/)
  })

  it('attributes the operation and preserves ordinary diagnostics when expansion is disabled', () => {
    const config = Config({ transport: 'streamable-http', serverName: 'fixture', url: 'https://example.invalid', expandTemplates: true })
    const error = Object.assign(new Error('connect secret-token'), { code: 'ECONNREFUSED' })
    const ctx = new Context()
    expect(new McpTemplateBinding(ctx, config).diagnostic(error, 'health check'))
      .toBe('mcp-client(fixture): health check: ECONNREFUSED')
    expect(new McpTemplateBinding(ctx, { ...config, expandTemplates: false }).diagnostic(error, 'health check'))
      .toBe('Error: connect secret-token')
  })
})
