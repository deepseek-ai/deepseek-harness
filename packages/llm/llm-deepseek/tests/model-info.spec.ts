/** Catalog metadata supports embedding callers without deployment normalization. */
import { expect, it } from 'vitest'
import { catalogModelInfo } from '../src/model-info.ts'

it('advertises a minimal model declaration as text input with its ID as the label', () => {
  expect(catalogModelInfo('deepseek-official', { id: 'embedded-model' })).toEqual({
    provider: 'deepseek-official', id: 'embedded-model', name: 'embedded-model', inputModalities: ['text'],
  })
})

it('advertises a listed badge beside the catalog entry', () => {
  const badge = { text: '1017', tone: 'info' } as const
  expect(catalogModelInfo('deepseek-official', { id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash' }, badge)).toEqual({
    provider: 'deepseek-official', id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', inputModalities: ['text'], badge,
  })
})
