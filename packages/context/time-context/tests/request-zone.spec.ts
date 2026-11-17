import { describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import {
  deriveBrowserTimeZoneContext,
  renderBrowserTimeZoneContext,
} from '../src/request-zone.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'test': { kind: 'test' } & ContextFormed
  }
}

function browserMessage(timeZone: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: timeZone }],
    source: { kind: 'user', rpcId: `rpc-${timeZone}`, clientTimeZone: timeZone } as never,
  })
}

describe('browser request-zone context', () => {
  it('derives missing, unique, and sorted mixed zones from user-rpc messages only', () => {
    const plugin = createUserMessage({
      content: [{ type: 'text', text: 'plugin' }],
      source: { kind: 'test' },
    })
    expect(deriveBrowserTimeZoneContext([plugin])).toEqual({ kind: 'missing' })
    expect(deriveBrowserTimeZoneContext([
      browserMessage('Asia/Shanghai'),
      browserMessage('Asia/Shanghai'),
    ])).toEqual({ kind: 'resolved', timeZone: 'Asia/Shanghai' })
    expect(deriveBrowserTimeZoneContext([
      browserMessage('Asia/Shanghai'),
      browserMessage('America/New_York'),
    ])).toEqual({
      kind: 'mixed',
      timeZones: ['America/New_York', 'Asia/Shanghai'],
    })
  })

  it('validates every browser zone before classifying a mixed turn', () => {
    expect(() => deriveBrowserTimeZoneContext([
      browserMessage('+08:00'),
    ])).toThrow(/canonical UTC or IANA Area\/Location/)
    expect(() => deriveBrowserTimeZoneContext([
      browserMessage('Asia/Shanghai'),
      browserMessage('Not/A_Real_Zone'),
    ])).toThrow(/browser time zone is unsupported/)
    expect(() => deriveBrowserTimeZoneContext([
      browserMessage('Etc/UTC'),
    ])).toThrow(/browser time zone must be canonical/)
  })

  it('combines committed reported zones with proposed messages before validation', () => {
    expect(deriveBrowserTimeZoneContext([browserMessage('America/New_York')], ['Asia/Shanghai']))
      .toEqual({ kind: 'mixed', timeZones: ['America/New_York', 'Asia/Shanghai'] })
    expect(() => deriveBrowserTimeZoneContext([browserMessage('Not/A_Real_Zone')], ['+08:00']))
      .toThrow('browser time zone must be canonical UTC or IANA Area/Location: "+08:00"')
  })

  it('keeps the exact refusal and the platform cause for every unusable zone', () => {
    const refusal = (timeZone: string): Error => {
      try {
        deriveBrowserTimeZoneContext([browserMessage(timeZone)])
        throw new Error('expected a browser-zone refusal')
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(TypeError)
        return error as Error
      }
    }
    expect(refusal('').message)
      .toBe('browser time zone must be canonical UTC or IANA Area/Location: ""')
    expect(refusal('+08:00').message)
      .toBe('browser time zone must be canonical UTC or IANA Area/Location: "+08:00"')
    expect(refusal(' UTC').message)
      .toBe('browser time zone must be canonical UTC or IANA Area/Location: " UTC"')
    expect(refusal('Etc/UTC').message).toBe('browser time zone must be canonical: "Etc/UTC"')
    const unsupported = refusal('Not/A_Real_Zone')
    expect(unsupported.message).toBe('browser time zone is unsupported: "Not/A_Real_Zone"')
    // The platform refusal stays the operator's only evidence of why a well-formed name failed.
    expect((unsupported as Error & { cause?: unknown }).cause).toBeInstanceOf(RangeError)
  })

  it('renders one explicit model policy for every context', () => {
    expect(renderBrowserTimeZoneContext({ kind: 'resolved', timeZone: 'Asia/Shanghai' }))
      .toContain('Interpret otherwise-unqualified dates and times in this zone.')
    expect(renderBrowserTimeZoneContext({
      kind: 'mixed', timeZones: ['America/New_York', 'Asia/Shanghai'],
    })).toContain('mixed ["America/New_York","Asia/Shanghai"]')
    expect(renderBrowserTimeZoneContext({ kind: 'missing' })).toContain('unavailable')
  })
})
