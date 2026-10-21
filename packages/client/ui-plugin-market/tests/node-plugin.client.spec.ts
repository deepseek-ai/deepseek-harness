import { expect, it } from 'vitest'
import { apply } from '../src/index.ts'

it('registers nothing on the Host', () => {
  expect(() => { apply() }).not.toThrow()
})
