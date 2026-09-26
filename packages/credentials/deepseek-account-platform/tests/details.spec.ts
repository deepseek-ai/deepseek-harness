import { expect, it } from 'vitest'
import { profile } from '../src/details.ts'

it.each([undefined, null, '', 'https://example.test/avatar.png'])('projects Platform picture %s', (picture) => {
  expect(profile({ id: 'user', email: 'masked@example.test', id_profile: { name: 'User', picture } }).avatarUrl)
    .toBe(picture || null)
})

it('projects missing display fields and empty contact values as null', () => {
  expect(profile({ email: '' })).toEqual({ id: null, avatarUrl: null, name: null, contact: null })
  expect(profile({ email: '', id_profile: { name: '' } }).name).toBeNull()
})
