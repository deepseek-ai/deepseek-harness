/** Browser client identity is converted from the local environment for each account call. */
import { afterEach, expect, it, vi } from 'vitest'
import { accountClientMetadata } from '../src/client/client-metadata.ts'

afterEach(() => { vi.restoreAllMocks() })

it('reports the local UTC offset as whole seconds east and keeps the raw UI language', () => {
  const offset = vi.spyOn(Date.prototype, 'getTimezoneOffset')
  // Date reports minutes west of UTC; Platform receives seconds east.
  offset.mockReturnValue(480)
  expect(accountClientMetadata('zh-CN', '1.2.3'))
    .toEqual({ version: '1.2.3', locale: 'zh-CN', timezoneOffsetSeconds: -28_800 })
  offset.mockReturnValue(-300)
  expect(accountClientMetadata('en', '1.2.3'))
    .toEqual({ version: '1.2.3', locale: 'en', timezoneOffsetSeconds: 18_000 })
})

it('samples the offset when it is called instead of caching the first reading', () => {
  const offset = vi.spyOn(Date.prototype, 'getTimezoneOffset').mockReturnValue(60)
  const first = accountClientMetadata('en', '1.2.3')
  offset.mockReturnValue(-60)
  expect(first.timezoneOffsetSeconds).toBe(-3_600)
  expect(accountClientMetadata('en', '1.2.3').timezoneOffsetSeconds).toBe(3_600)
})

it.each([undefined, ''])('refuses an empty client build version instead of reporting it', (version) => {
  expect(() => accountClientMetadata('en', version)).toThrow(/DSH_CLIENT_VERSION/)
})
