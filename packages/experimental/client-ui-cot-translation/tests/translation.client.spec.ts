/** Paragraph completion, provider failures, and disclosure-owned cancellation. */
import { describe, expect, it, vi } from 'vitest'
import { ReasoningTranslation, reasoningFragments, type TranslateText, type TranslationState } from '../src/client/translation.ts'

function fixture(maxTextChars = 4000) {
  const states: TranslationState[] = []
  const translate = vi.fn<TranslateText>(async ({ text }) => `译:${text}`)
  const controller = new ReasoningTranslation({ provider: 'google', targetLanguage: 'zh' }, maxTextChars, translate,
    (state) => { states.push(state) })
  return { controller, translate, states }
}

describe('reasoning translation', () => {
  it.each([
    ['', true, []],
    ['unfinished', true, []],
    ['settled', false, ['settled']],
    ['First\n\nTail', true, ['First']],
    ['First\r\n \r\nSecond', false, ['First', 'Second']],
    [' \n\n', false, []],
  ])('translates only completed content in %j', async (text, running, expected) => {
    const b = fixture()
    try {
      b.controller.update(text, running)
      await vi.waitFor(() => { expect(b.states.at(-1)?.pending).toBe(false) })
      expect(b.translate.mock.calls.map(([request]) => request.text)).toEqual(expected)
    } finally { b.controller.dispose() }
  })

  it('retains exact whitespace and keeps every chunk within the configured Unicode-safe cap', () => {
    for (const text of ['abcdefgh', 'hello world again', 'A😀B😀C😀', 'AB😀CD', 'first\r\n \r\nsecond', '  leading   trailing  ']) {
      const parts = reasoningFragments(text, false, 3)
      expect(parts.map(part => part.text + part.suffix).join('')).toBe(text)
      for (const part of parts) {
        expect(part.text.length).toBeLessThanOrEqual(3)
        expect(part.text.endsWith('\ud83d')).toBe(false)
        expect(part.text.startsWith('\ude00')).toBe(false)
      }
    }
  })

  it('finishes long streaming chunks while retaining the incomplete tail', async () => {
    const b = fixture(4)
    try {
      b.controller.update('abcdefghij', true)
      await vi.waitFor(() => { expect(b.states.at(-1)).toEqual({ text: '译:abcd译:efghij', pending: false, failed: false }) })
      expect(b.translate.mock.calls.map(([request]) => request.text)).toEqual(['abcd', 'efgh'])
      b.controller.update('abcdefghij', false)
      await vi.waitFor(() => { expect(b.translate).toHaveBeenCalledTimes(3) })
      expect(b.translate.mock.calls[2]?.[0]).toMatchObject({ provider: 'google', targetLanguage: 'zh', text: 'ij' })
    } finally { b.controller.dispose() }
  })

  it('does not restart an in-flight paragraph on streaming updates and caches repeated completed text', async () => {
    const pending = Promise.withResolvers<string>()
    const b = fixture()
    b.translate.mockImplementationOnce(() => pending.promise)
    try {
      b.controller.update('First\n\nTail', true)
      b.controller.update('First\n\nTail continues', true)
      expect(b.translate).toHaveBeenCalledTimes(1)
      pending.resolve('第一段')
      await vi.waitFor(() => { expect(b.states.at(-1)?.text).toBe('第一段\n\nTail continues') })
      b.controller.update('First\n\nFirst\n\nTail continues', true)
      expect(b.translate).toHaveBeenCalledTimes(1)
      expect(b.states.at(-1)?.text).toBe('第一段\n\n第一段\n\nTail continues')
    } finally { pending.resolve('第一段'); b.controller.dispose() }
  })

  it('keeps a repeated unfinished tail original until the paragraph completes', async () => {
    const b = fixture()
    try {
      b.controller.update('First\n\nFirst', true)
      await vi.waitFor(() => { expect(b.states.at(-1)?.pending).toBe(false) })
      expect(b.states.at(-1)?.text).toBe('译:First\n\nFirst')
      b.controller.update('First\n\nFirst words', true)
      expect(b.states.at(-1)?.text).toBe('译:First\n\nFirst words')
      expect(b.translate.mock.calls.map(([request]) => request.text)).toEqual(['First'])
      b.controller.update('First\n\nFirst words', false)
      await vi.waitFor(() => { expect(b.states.at(-1)?.text).toBe('译:First\n\n译:First words') })
      expect(b.translate.mock.calls.map(([request]) => request.text)).toEqual(['First', 'First words'])
    } finally { b.controller.dispose() }
  })

  it('requires an explicit retry after failure and does not publish provider messages', async () => {
    const b = fixture()
    b.translate.mockRejectedValueOnce(new Error('sensitive provider response'))
    try {
      b.controller.update('First', false)
      await vi.waitFor(() => { expect(b.states.at(-1)?.failed).toBe(true) })
      b.controller.update('First\n\nSecond', false)
      expect(b.translate).toHaveBeenCalledTimes(1)
      expect(JSON.stringify(b.states)).not.toContain('sensitive')
      b.controller.retry()
      await vi.waitFor(() => { expect(b.states.at(-1)).toEqual({ text: '译:First\n\n译:Second', failed: false, pending: false }) })
      expect(b.translate).toHaveBeenCalledTimes(3)
    } finally { b.controller.dispose() }
  })

  it.each(['resolve', 'reject'] as const)('aborts on disposal and ignores a late %s', async (outcome) => {
    const pending = Promise.withResolvers<string>()
    const b = fixture()
    b.translate.mockImplementationOnce(() => pending.promise)
    b.controller.update('First', false)
    const request = b.translate.mock.calls[0]!
    const count = b.states.length
    b.controller.dispose()
    expect(request[1].aborted).toBe(true)
    b.controller.update('Second', false)
    b.controller.retry()
    if (outcome === 'resolve') pending.resolve('late')
    else pending.reject(new Error('late'))
    await pending.promise.catch(() => {})
    await Promise.resolve()
    expect(b.states).toHaveLength(count)
    expect(b.translate).toHaveBeenCalledTimes(1)
  })
})
