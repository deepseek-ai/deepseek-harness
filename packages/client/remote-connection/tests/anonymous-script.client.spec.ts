// @vitest-environment jsdom
/** The generated HTTP script runs without its Host module's lexical scope. */
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { renderPairingScript } from '../src/anonymous/index.ts'
import { renderAuthenticationPage } from '../src/login-page.ts'

const recovery = { requestTtlMs: 10000, pollIntervalMs: 1000, requestTimeoutMs: 5000, maxRetries: 2, retryMaxDelayMs: 2000 }

afterEach(() => {
  document.body.replaceChildren()
  document.head.replaceChildren()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

it('mounts, requests, and cancels pairing from the source-launched classic script', async ({ task }) => {
  // The dsh source launcher applies tsx name preservation that Vitest's transform does not.
  const entry = pathToFileURL(resolve(import.meta.dirname, '../src/anonymous/index.ts')).href
  const generated = spawnSync(process.execPath, ['--import', 'tsx/esm', '--input-type=module', '--eval',
    `import { renderPairingScript } from ${JSON.stringify(entry)}; process.stdout.write(renderPairingScript(${JSON.stringify(recovery)}))`,
  ], { encoding: 'utf8', timeout: task.timeout })
  expect(generated.error).toBeUndefined()
  expect(generated.signal).toBeNull()
  expect(generated.status, generated.stderr).toBe(0)
  vi.useFakeTimers()
  const ticket = {
    id: 'c647d366-084c-4b7e-9c10-592dd355a4fb', secret: 'a'.repeat(43), code: 'ABCD2345',
    authority: 'https://host.example', sourceIp: null, expiresInMs: 10000, pollIntervalMs: 1000,
  }
  const request = vi.fn<typeof fetch>()
    .mockImplementationOnce(async (_input, init) => {
      if (typeof init?.body !== 'string') throw new Error('Missing creation credentials')
      const held = JSON.parse(init.body) as { id: string; secret: string }
      return new Response(JSON.stringify({ ...ticket, ...held }))
    })
    .mockResolvedValueOnce(new Response('{"status":"cancelled"}'))
  vi.stubGlobal('fetch', request)
  const html = new DOMParser().parseFromString(renderAuthenticationPage({ tokenLoginEnabled: true, pairingEnabled: true }), 'text/html')
  document.documentElement.innerHTML = html.documentElement.innerHTML
  document.head.insertAdjacentHTML('afterbegin', '<base href="https://host.example/tools/dsh/">')
  window.eval(generated.stdout)
  const element = document.querySelector('dsh-device-pairing')!
  expect(element.querySelector('style')?.textContent).toContain('.dsh-device-pairing-code')
  expect(document.querySelector('#token-form')).not.toBeNull()
  expect(document.querySelector('script[src]')?.getAttribute('src')).toBe('./pairing/client.js')
  expect('__ModuleLoader__' in window).toBe(false)
  element.querySelector<HTMLButtonElement>('#auth-pair-request')!.click()
  await vi.advanceTimersByTimeAsync(0)
  expect(element.querySelector('#auth-pair-code')?.textContent).toBe('ABCD 2345')
  element.querySelector<HTMLButtonElement>('#auth-pair-cancel')!.click()
  await vi.advanceTimersByTimeAsync(0)
  expect(request.mock.calls[1]?.[1]?.body).toBe(request.mock.calls[0]?.[1]?.body)
  expect(element.querySelector('#auth-pair-panel')?.getAttribute('data-state')).toBe('cancelled')
  expect(vi.getTimerCount()).toBe(0)
})

it('escapes public data that could otherwise close an embedded script', () => {
  vi.spyOn(JSON, 'stringify').mockReturnValueOnce('{"title":"</script><img src=x>"}')
  const script = renderPairingScript(recovery)
  expect(script).not.toContain('</script')
  expect(script).toContain('\\u003c/script>\\u003cimg src=x>')
})
