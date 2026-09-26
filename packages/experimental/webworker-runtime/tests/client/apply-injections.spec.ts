// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { applyIndexInjections } from '../../src/client/apply-injections.ts'

afterEach(() => {
  document.head.innerHTML = ''
  document.body.innerHTML = ''
})

it('ignores script preload hints and executes script sources through the worker loader', async () => {
  const loadScript = vi.fn(async () => {})
  const preload = 'plugins/??app-a/client.js,app-b/client.js&rev=app'
  const bootstrap = 'plugins/??modules/client.js&rev=boot'

  await applyIndexInjections([
    { kind: 'script-preload', src: preload },
    { kind: 'script-src', placement: 'head', src: bootstrap },
  ], loadScript)

  expect(loadScript).toHaveBeenCalledOnce()
  expect(loadScript).toHaveBeenCalledWith(bootstrap)
  expect(document.querySelector('link[rel="preload"]')).toBeNull()
})
