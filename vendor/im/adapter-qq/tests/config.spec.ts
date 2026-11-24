/**
 * Adapter configuration defaults and the two explicit decisions: `transport` and `seqBase`.
 */
import { describe, expect, it } from 'vitest'
import {
  Config,
  DEFAULT_BASE_URL,
  DEFAULT_INTENTS,
  DEFAULT_TOKEN_URL,
  Intents,
  resolveBaseUrl,
  type QQConfig,
} from '@deepseek-ai/cordis-plugin-im-adapter-qq'

/** Parse like the loader does: the schema accepts raw user input. */
function parse(input: Record<string, unknown>): QQConfig {
  return Config(input as unknown as QQConfig)
}

describe('QQ config', () => {
  it('requires the application credentials', () => {
    expect(() => parse({})).toThrow()
    expect(() => parse({ appId: 'a' })).toThrow()
    expect(parse({ appId: 'a', secret: 's' }).appId).toBe('a')
  })

  it('defaults to a websocket transport with the passive seqBase of 2', () => {
    const config = parse({ appId: 'a', secret: 's' })
    expect(config.transport).toBe('ws')
    expect(config.passive.seqBase).toBe(2)
    expect(config.passive.groupWindowMs).toBe(5 * 60 * 1000)
    expect(config.passive.c2cWindowMs).toBe(60 * 60 * 1000)
    expect(config.passive.groupReplies).toBe(5)
    expect(config.passive.c2cReplies).toBe(4)
  })

  it('defaults the send flags and endpoints of', () => {
    const config = parse({ appId: 'a', secret: 's' })
    expect(config.sandbox).toBe(false)
    expect(config.markdown).toBe(false)
    expect(config.keyboard).toBe(false)
    expect(config.stream).toBe(false)
    expect(config.linkPolicy).toBe('text')
    expect(config.intents).toBe(DEFAULT_INTENTS)
    expect(DEFAULT_INTENTS).toBe(Intents.USER_MESSAGE | Intents.INTERACTIONS)
    expect(config.baseUrl).toBe(DEFAULT_BASE_URL)
    expect(config.tokenUrl).toBe(DEFAULT_TOKEN_URL)
    expect(config.ws.retryTimes).toBeGreaterThan(0)
  })

  it('accepts the REST-only transport', () => {
    expect(parse({ appId: 'a', secret: 's', transport: 'none' }).transport).toBe('none')
    expect(() => parse({ appId: 'a', secret: 's', transport: 'webhook' })).toThrow()
    expect(() => parse({ appId: 'a', secret: 's', linkPolicy: 'inline' })).toThrow()
  })

  it('merges partial passive settings over the defaults', () => {
    const config = parse({ appId: 'a', secret: 's', passive: { seqBase: 50 } })
    expect(config.passive.seqBase).toBe(50)
    expect(config.passive.groupReplies).toBe(5)
  })

  it('rewrites the base URL host for the sandbox', () => {
    expect(resolveBaseUrl({ baseUrl: 'https://api.sgroup.qq.com/', sandbox: false })).toBe('https://api.sgroup.qq.com/')
    expect(resolveBaseUrl({ baseUrl: 'https://api.sgroup.qq.com', sandbox: true })).toBe('https://sandbox.api.sgroup.qq.com/')
  })
})
