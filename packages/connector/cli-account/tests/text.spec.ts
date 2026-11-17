/** A presenter writes each key in every language its dictionaries hold, with the values it passes filled in. */
import { expect, it } from 'vitest'
import { accountText } from '../src/text.ts'

const text = accountText({
  en: { status: 'Connected', signedIn: 'Signed in as {name} in {org}.' },
  zh: { status: '已连接', signedIn: '已登录为 {org} 的 {name}。' },
})

it('renders a key in every language', () => {
  expect(text('status')).toEqual({ en: 'Connected', zh: '已连接' })
})

it('fills each placeholder with its value and leaves one without a value as written', () => {
  expect(text('signedIn', { name: 'Ada', org: 'Acme' })).toEqual({ en: 'Signed in as Ada in Acme.', zh: '已登录为 Acme 的 Ada。' })
  expect(text('signedIn', { name: 'Ada' })).toEqual({ en: 'Signed in as Ada in {org}.', zh: '已登录为 {org} 的 Ada。' })
})
