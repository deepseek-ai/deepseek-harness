import { expect, it } from 'vitest'
import { ContactConfig } from '../src/contact-config.ts'
import { contactUrl } from '../src/client/contact-url.ts'

it('prefills available support context and hides all context fields', () => {
  const config = ContactConfig({ contactSource: 'app_harness' })
  const url = new URL(contactUrl(config, {
    version: '1.2.3', locale: 'zh-CN', width: 1512, height: 982, pixelRatio: 2,
  }))
  expect(url.origin).toBe('https://trtgsjkv6r.feishu.cn')
  expect(url.pathname).toBe('/share/base/form/shrcnlCoGElW7MQznGy9r3YYXcg')
  expect(Object.fromEntries(url.searchParams)).toEqual({
    hide_source: '1', prefill_source: 'app_harness', hide_app_version: '1', prefill_app_version: '1.2.3',
    hide_os_version: '1',
    hide_device_brand: '1', hide_device_model: '1', hide_app_locale: '1', prefill_app_locale: 'zh-CN',
    hide_screen_resolution: '1', prefill_screen_resolution: '3024x1964',
  })
  expect(url.searchParams.has('prefill_uid')).toBe(false)
  expect(url.searchParams.has('hide_uid')).toBe(false)
})

it('opens a configured form without stale context when unavailable', () => {
  const url = new URL(contactUrl(ContactConfig({ contactFormUrl: 'https://example.test/form/?prefill_uid=old&hide_uid=1&prefill_app_version=old&prefill_source=old' }), {
    version: undefined, locale: 'en', width: 0, height: 0, pixelRatio: 1,
  }))
  expect(url.origin).toBe('https://example.test')
  expect(url.searchParams.has('prefill_uid')).toBe(false)
  expect(url.searchParams.has('hide_uid')).toBe(false)
  expect(url.searchParams.has('prefill_app_version')).toBe(false)
  expect(url.searchParams.has('prefill_source')).toBe(false)
  expect(url.searchParams.has('prefill_screen_resolution')).toBe(false)
  expect(url.searchParams.get('hide_source')).toBe('1')
  expect(url.searchParams.get('hide_app_version')).toBe('1')
  expect(() => ContactConfig({ contactFormUrl: 'javascript:alert(1)' })).toThrow()
})

it.each([NaN, Infinity])('uses CSS pixel dimensions when device pixel ratio is %s', (pixelRatio) => {
  const url = new URL(contactUrl(ContactConfig({}), {
    version: undefined, locale: 'en', width: 800, height: 600, pixelRatio,
  }))
  expect(url.searchParams.get('prefill_screen_resolution')).toBe('800x600')
})
