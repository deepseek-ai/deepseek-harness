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

  it('renders one explicit model policy for every context', () => {
    expect(renderBrowserTimeZoneContext({ kind: 'resolved', timeZone: 'Asia/Shanghai' }))
      .toContain('Interpret otherwise-unqualified dates and times in this zone.')
    expect(renderBrowserTimeZoneContext({
      kind: 'mixed', timeZones: ['America/New_York', 'Asia/Shanghai'],
    })).toContain('mixed ["America/New_York","Asia/Shanghai"]')
    expect(renderBrowserTimeZoneContext({ kind: 'missing' })).toContain('unavailable')
  })
})
