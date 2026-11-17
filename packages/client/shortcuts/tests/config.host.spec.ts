import { Context } from '@deepseek-ai/cordis'
import { expect, it } from 'vitest'
import { Config, apply } from '../src/index.ts'

it('registers no Host behavior', () => {
  expect(() => { apply(new Context(), Config({})) }).not.toThrow()
})

it('validates positive sequence timing within the browser timer limit', () => {
  expect(Config({}).stopSequenceMs.get()).toBe(500)
  expect(Config({ stopSequenceMs: 2_147_483_646 }).stopSequenceMs.get()).toBe(2_147_483_646)
  for (const stopSequenceMs of [0, -1, 1.5, 2_147_483_647, Infinity, NaN]) expect(() => Config({ stopSequenceMs })).toThrow()
})
