/** The types package registers nothing: both faces' `apply` return without effects. */
import { expect, it } from 'vitest'
import { apply as clientApply } from '../src/client/index.ts'
import { apply as hostApply } from '../src/index.ts'

it('registers nothing on either face', () => {
  expect(hostApply).not.toThrow()
  expect(clientApply).not.toThrow()
})
