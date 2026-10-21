// @vitest-environment jsdom
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { AccountAvatarLoader, type AccountAvatarSnapshot } from '../src/client/account-avatar.ts'

afterEach(() => { vi.unstubAllGlobals() })

function imagesOf() {
  const images: HTMLImageElement[] = []
  vi.stubGlobal('Image', function () {
    const image = document.createElement('img')
    images.push(image)
    return image
  })
  const states: Array<AccountAvatarSnapshot | undefined> = []
  const loader = new AccountAvatarLoader((state) => { states.push(state) })
  onTestFinished(() => { loader.dispose() })
  return { images, states, loader }
}

it('shares successful and pending loads, and retries each failed load only on request', async () => {
  const { images, states, loader } = imagesOf()
  loader.retry()
  loader.setUrl('https://example.test/avatar.png')
  expect(images[0]!.referrerPolicy).toBe('no-referrer')
  expect(images[0]!.src).toBe('https://example.test/avatar.png')
  loader.setUrl('https://example.test/avatar.png')
  loader.retry()
  expect(images).toHaveLength(1)
  images[0]!.dispatchEvent(new Event('error'))
  loader.setUrl('https://example.test/avatar.png')
  expect(images).toHaveLength(1)
  loader.retry()
  images[1]!.dispatchEvent(new Event('error'))
  loader.retry()
  images[2]!.dispatchEvent(new Event('load'))
  loader.retry()
  loader.setUrl('https://example.test/avatar.png')
  expect(images).toHaveLength(3)
  await expect(`${JSON.stringify(states, null, 2)}\n`).toMatchFileSnapshot('./expected/avatar-retry.txt')
  loader.setUrl(null)
  expect(states.at(-1)).toBeUndefined()
  expect(images[2]!.getAttribute('src')).toBeNull()
  loader.setUrl('')
  expect(images).toHaveLength(3)
})

it('discards replaced and disposed image callbacks, including the same URL after sign-out', () => {
  const { images, states, loader } = imagesOf()
  loader.setUrl('https://example.test/old.png')
  const oldLoad = images[0]!.onload!
  const oldError = images[0]!.onerror!
  loader.setUrl('https://example.test/new.png')
  expect(images[0]!.onload).toBeNull()
  expect(images[0]!.onerror).toBeNull()
  oldLoad.call(images[0]!, new Event('load'))
  oldError.call(images[0]!, new Event('error'))
  expect(states.at(-1)).toEqual({ url: 'https://example.test/new.png', status: 'loading' })
  loader.setUrl(undefined)
  loader.setUrl('https://example.test/new.png')
  expect(images).toHaveLength(3)
  const lateLoad = images[2]!.onload!
  const lateError = images[2]!.onerror!
  loader.dispose()
  const published = states.length
  lateLoad.call(images[2]!, new Event('load'))
  lateError.call(images[2]!, new Event('error'))
  loader.setUrl('https://example.test/after-disposal.png')
  loader.retry()
  loader.dispose()
  expect(states).toHaveLength(published)
  expect(images).toHaveLength(3)
})

it('does not start a load when publication releases its owner', () => {
  const image = document.createElement('img')
  vi.stubGlobal('Image', function () { return image })
  const loader = new AccountAvatarLoader(() => { loader.dispose() })
  onTestFinished(() => { loader.dispose() })
  loader.setUrl('https://example.test/avatar.png')
  expect(image.getAttribute('src')).toBeNull()
  expect(image.onload).toBeNull()
  expect(image.onerror).toBeNull()
})

it('shares rendered-image failures and ignores reports from a superseded picture attempt', () => {
  const { images, states, loader } = imagesOf()
  loader.setUrl('https://example.test/avatar.png')
  const loading = states.at(-1)!
  loader.failed(loading)
  expect(states.at(-1)).toBe(loading)
  images[0]!.dispatchEvent(new Event('load'))
  const ready = states.at(-1)!
  loader.failed(ready)
  expect(states.at(-1)).toEqual({ url: ready.url, status: 'failed' })
  loader.retry()
  images[1]!.dispatchEvent(new Event('load'))
  const successor = states.at(-1)!
  loader.failed(ready)
  expect(states.at(-1)).toBe(successor)
  loader.dispose()
  loader.failed(successor)
  expect(states.at(-1)).toBe(successor)
})

it('resets an account picture without publishing an intermediate account snapshot', () => {
  const { images, states, loader } = imagesOf()
  loader.setUrl('https://example.test/avatar.png')
  const lateLoad = images[0]!.onload!
  loader.reset()
  lateLoad.call(images[0]!, new Event('load'))
  expect(states).toHaveLength(1)
  loader.setUrl('https://example.test/avatar.png')
  expect(images).toHaveLength(2)
})
