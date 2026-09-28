import { expect, it } from 'vitest'
import type { AccountUserId } from '@deepseek-ai/dsh-deepseek-account/types'
import { ContactConfig } from '../src/contact-config.ts'
import { contactUrl } from '../src/client/contact-url.ts'

it('prefills the available support context and hides every context field', () => {
  const config = ContactConfig({ contactSource: 'app_harness' })
  const url = new URL(contactUrl(config, {
    uid: 'account-user' as AccountUserId, version: '1.2.3', locale: 'zh-CN',
    deviceInfo: 'Mozilla/5.0 (Macintosh) Harness/1.2.3', width: 1512, height: 982, pixelRatio: 2,
  }))
  expect(url.origin).toBe('https://trtgsjkv6r.feishu.cn')
  expect(url.pathname).toBe('/share/base/form/shrcnlCoGElW7MQznGy9r3YYXcg')
  expect(Object.fromEntries(new URL(ContactConfig({}).contactFormUrl).searchParams)).toEqual({
    hide_uid: '1', hide_device_info: '1', hide_harness_version: '1',
  })
  expect(Object.fromEntries(url.searchParams)).toEqual({
    hide_uid: '1', prefill_uid: 'account-user',
    hide_source: '1', prefill_source: 'app_harness',
    hide_harness_version: '1', prefill_harness_version: '1.2.3',
    hide_os_version: '1', hide_device_brand: '1',
    hide_device_info: '1', prefill_device_info: 'Mozilla/5.0 (Macintosh) Harness/1.2.3',
    hide_app_locale: '1', prefill_app_locale: 'zh-CN',
    hide_screen_resolution: '1', prefill_screen_resolution: '3024x1964',
  })
})

it('percent-encodes context values that carry URL delimiters', () => {
  const url = new URL(contactUrl(ContactConfig({ contactSource: 'a&b=c' }), {
    uid: 'user&admin=1' as AccountUserId, version: '1.0.0-rc.1+build', locale: 'en',
    deviceInfo: 'platform=darwin; os=15.0; app_arch=arm64; cpu=Apple M3; memory_gib=16.0',
    width: 800, height: 600, pixelRatio: 1,
  }))
  expect(url.href).toContain('prefill_uid=user%26admin%3D1')
  expect(url.searchParams.get('prefill_uid')).toBe('user&admin=1')
  expect(url.searchParams.get('prefill_source')).toBe('a&b=c')
  expect(url.searchParams.get('prefill_device_info')).toBe('platform=darwin; os=15.0; app_arch=arm64; cpu=Apple M3; memory_gib=16.0')
  expect(url.searchParams.get('prefill_harness_version')).toBe('1.0.0-rc.1+build')
})

it('opens a configured form and omits unavailable context', () => {
  const url = new URL(contactUrl(ContactConfig({ contactFormUrl: 'https://example.test/form/' }), {
    uid: null, version: undefined, locale: 'en', deviceInfo: '', width: 0, height: 0, pixelRatio: 1,
  }))
  expect(url.origin).toBe('https://example.test')
  expect(url.searchParams.has('prefill_uid')).toBe(false)
  expect(url.searchParams.get('hide_uid')).toBe('1')
  expect(url.searchParams.has('prefill_harness_version')).toBe(false)
  expect(url.searchParams.has('prefill_device_info')).toBe(false)
  expect(url.searchParams.has('prefill_source')).toBe(false)
  expect(url.searchParams.has('prefill_screen_resolution')).toBe(false)
  expect(url.searchParams.get('hide_source')).toBe('1')
  expect(url.searchParams.get('hide_harness_version')).toBe('1')
  expect(url.searchParams.get('hide_device_info')).toBe('1')
  expect(() => ContactConfig({ contactFormUrl: 'javascript:alert(1)' })).toThrow()
})

it.each([NaN, Infinity])('uses CSS pixel dimensions when device pixel ratio is %s', (pixelRatio) => {
  const url = new URL(contactUrl(ContactConfig({}), {
    uid: null, version: undefined, locale: 'en', deviceInfo: '', width: 800, height: 600, pixelRatio,
  }))
  expect(url.searchParams.get('prefill_screen_resolution')).toBe('800x600')
})
