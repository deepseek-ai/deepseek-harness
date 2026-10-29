/** Quote draft persistence and prompt serialization remain composer-owned. */
import { describe, expect, it, vi } from 'vitest'
import { formatQuoteText } from '@deepseek-ai/dsh-client-ui-primitives'
import { parseStoredDraft } from '../src/client/draft.ts'
import { serializeDraftPrompt } from '../src/client/input/prompt.ts'

describe('quote draft spans', () => {
  it('validates canonical clipboard text and refuses overlapping references or empty quotes', () => {
    const quote = { offset: 0, length: 7, text: 'quote' }
    const draft = { text: '> quote', references: [], quotes: [quote] }
    expect(parseStoredDraft(draft)).toEqual(draft)
    expect(parseStoredDraft({ ...draft, text: 'changed' })).toBeUndefined()
    expect(parseStoredDraft({ ...draft, quotes: [{ ...quote, text: ' ' }] })).toBeUndefined()
    expect(parseStoredDraft({ ...draft, references: [{ source: 'file', ref: 'quote', label: 'quote', clipboardText: 'quote', offset: 2, length: 5 }] })).toBeUndefined()
    expect(parseStoredDraft({ ...draft, quotes: [quote, quote] })).toBeUndefined()
  })

  it('serializes reference owners outside quotes into ordinary Markdown text', async () => {
    const serialize = vi.fn(() => Promise.resolve('@[Session](dsh-session:id)'))
    const quote = '/review @literal'
    const quoted = formatQuoteText(quote)
    const prompt = await serializeDraftPrompt({
      text: '@session ' + quoted,
      references: [{ source: 'session', ref: 'id', label: 'Session', clipboardText: '@session', offset: 0, length: 8 }],
      quotes: [{ offset: 9, length: quoted.length, text: quote }],
    }, serialize)
    expect(serialize).toHaveBeenCalledExactlyOnceWith('session', 'id')
    expect(prompt).toBe('@[Session](dsh-session:id)\n\n' + quoted)
  })
})
