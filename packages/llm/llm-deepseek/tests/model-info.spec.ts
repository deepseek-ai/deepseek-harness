/** Catalog metadata supports embedding callers without deployment normalization. */
import { expect, it } from 'vitest'
import { catalogModelInfo } from '../src/model-info.ts'

it('advertises a minimal model declaration as text input with its ID as the label', () => {
  expect(catalogModelInfo('deepseek-official', { id: 'embedded-model' })).toEqual({
    provider: 'deepseek-official', id: 'embedded-model', name: 'embedded-model', inputModalities: ['text'],
  })
})
