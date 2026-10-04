/** Per-connection Client selection in the frontend bootstrap and upgrade URL. */
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { expect, it } from 'vitest'
import { INSPECTOR_CLIENT_QUERY, readInspectorClientSelection } from '../src/shared/web.ts'

const bootstrap = readFileSync(new URL('../assets/devtools/connect.js', import.meta.url), 'utf8')

it('keeps an absent selector global and decodes one selected Client', () => {
  expect(readInspectorClientSelection(new URL('http://inspector/cdp'))).toBeUndefined()
  const url = new URL('http://inspector/cdp')
  url.searchParams.set(INSPECTOR_CLIENT_QUERY, 'client/page?x=1&y=2')
  expect(readInspectorClientSelection(url)).toBe('client/page?x=1&y=2')
})

it.each(['clientSourceId=', 'clientSourceId=a&clientSourceId=b', `clientSourceId=${'x'.repeat(257)}`])(
  'rejects malformed selections instead of opening a global connection: %s', (query) => {
    expect(() => readInspectorClientSelection(new URL(`http://inspector/cdp?${query}`))).toThrow()
  },
)

it.each(['http', 'https'])('preserves the embedding Client selection and deployment prefix over %s', (protocol) => {
  const location = new URL(`${protocol}://inspector/app/inspector/devtools/devtools_app.html?disableLocaleInfoBar=true`)
  location.searchParams.set(INSPECTOR_CLIENT_QUERY, 'client/page?x=1&y=2')
  let result: URL | undefined
  const preferences = new Map<string, string>()
  runInNewContext(bootstrap, { URL, window: {
    location, localStorage: { setItem: (key: string, value: string) => preferences.set(key, value) },
    history: { state: null, replaceState: (_state: null, _title: string, url: URL) => { result = url } },
  } })
  const selected = new URL(`${protocol === 'https' ? 'wss' : 'ws'}://${result!.searchParams.get(protocol === 'https' ? 'wss' : 'ws')}`)
  expect(selected.pathname).toBe('/app/inspector/devtools/cdp')
  expect(readInspectorClientSelection(selected)).toBe('client/page?x=1&y=2')
  expect(preferences.get('disable-locale-info-bar')).toBe('true')
})

it('keeps an explicit debugging endpoint unchanged', () => {
  const location = new URL('http://inspector/devtools_app.html?ws=remote:9230/devtools/page/target&clientSourceId=client-page')
  let result: URL | undefined
  runInNewContext(bootstrap, { URL, window: {
    location, history: { state: null, replaceState: (_state: null, _title: string, url: URL) => { result = url } },
  } })
  expect(result!.searchParams.get('ws')).toBe('remote:9230/devtools/page/target')
})
