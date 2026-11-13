// The connection-diagnostic line: cause chains survive, raw identifiers stay
// verbatim, and hostile shapes (cycles, empty messages, bare values) cannot
// break the status text they feed.
import { describe, expect, it } from 'vitest'
import { describeError, McpLocalError, mcpRequestError, redactSecrets } from '@deepseek-ai/dsh-mcp-client/src/diagnostic.ts'
import { withDeadline } from '@deepseek-ai/dsh-mcp-client/src/deadline.ts'
import { MissingTemplateValue, resolveTemplateString } from '@deepseek-ai/dsh-mcp-client/src/templates.ts'

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

describe('local failure codes', () => {
  it('rejects an elapsed deadline as MCP_TIMEOUT', async () => {
    await expect(withDeadline(new Promise(() => {}), 1, 'MCP operation timed out')).rejects.toMatchObject({
      name: 'McpLocalError', code: 'MCP_TIMEOUT', message: 'MCP operation timed out',
    })
  })

  it('reports an unconfigured credential as MCP_CREDENTIAL_NOT_FOUND', async () => {
    const failure = resolveTemplateString('${credential:MISSING}', 'env.TOKEN', async () => undefined)
    await expect(failure).rejects.toBeInstanceOf(MissingTemplateValue)
    await expect(failure).rejects.toMatchObject({ name: 'McpLocalError', code: 'MCP_CREDENTIAL_NOT_FOUND' })
  })

  it('keeps a local failure unchanged when classifying a request failure', () => {
    const closed = new McpLocalError('MCP connection closed', 'MCP_CONNECTION_CLOSED')
    expect(mcpRequestError(closed, 'resources/read', () => 'replaced')).toBe(closed)
  })

  it('keeps the original failure as cause only when no redaction applies', () => {
    const failure = new Error('rejected secret-value')
    expect(mcpRequestError(failure, 'resources/read')).toMatchObject({
      message: 'MCP resources/read failed: Error: rejected secret-value', cause: failure,
    })
    const redacted = mcpRequestError(failure, 'resources/read', text => text.replace('secret-value', '[redacted]'))
    expect(redacted.message).toBe('MCP resources/read failed: Error: rejected [redacted]')
    expect(redacted.cause).toBeUndefined()
  })
})

describe('redactSecrets', () => {
  it('replaces every occurrence, longest secret first', () => {
    expect(redactSecrets('token token-long token', ['token', 'token-long'])).toBe('[redacted] [redacted] [redacted]')
  })

  it('returns the text unchanged without secrets', () => {
    expect(redactSecrets('plain', [])).toBe('plain')
  })
})
