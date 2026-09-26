import { describe, expect, it } from 'vitest'
import type { BrowserTarget } from '../src/client/browser/url.ts'
import { BrowserNavigation, MAX_BROWSER_HISTORY } from '../src/client/browser/BrowserNavigation.ts'

const httpsTarget = (index: number): BrowserTarget => ({
  kind: 'https', url: `https://example.test/${index}`, title: `page ${index}`,
})

describe('BrowserNavigation', () => {
  it('owns bounded history, branch replacement, and reload revisions', () => {
    const navigation = new BrowserNavigation()
    expect(BrowserNavigation.current(navigation.snapshot)).toBeUndefined()
    expect(navigation.back()).toBeUndefined()
    expect(navigation.forward()).toBeUndefined()
    expect(navigation.reload()).toBeUndefined()

    for (let index = 0; index <= MAX_BROWSER_HISTORY; index++) navigation.navigate(httpsTarget(index))
    expect(navigation.snapshot.entries).toHaveLength(MAX_BROWSER_HISTORY)
    expect(navigation.snapshot.entries[0]?.url).toBe('https://example.test/1')
    expect(navigation.canGoBack).toBe(true)
    expect(navigation.canGoForward).toBe(false)

    const back = navigation.back()
    expect(back?.target.url).toBe('https://example.test/99')
    expect(navigation.canGoForward).toBe(true)
    navigation.navigate(httpsTarget(200))
    expect(navigation.snapshot.entries.at(-1)?.url).toBe('https://example.test/200')
    expect(navigation.snapshot.entries.some(entry => entry.url === 'https://example.test/100')).toBe(false)

    const beforeReload = navigation.snapshot.request!.revision
    navigation.reload()
    expect(navigation.snapshot.request?.revision).toBe(beforeReload + 1)
  })

  it('classifies only the first current frame load as known', () => {
    const navigation = new BrowserNavigation()
    navigation.navigate(httpsTarget(1))
    const revision = navigation.snapshot.request!.revision
    navigation.frameLoaded(revision - 1)
    expect(navigation.snapshot.navigation).toEqual({ status: 'loading', revision })
    navigation.frameLoaded(revision)
    expect(navigation.snapshot.navigation).toEqual({ status: 'known', revision })
    navigation.frameLoaded(revision)
    expect(navigation.snapshot.navigation).toEqual({ status: 'unknown', revision })
    navigation.frameLoaded(revision)
    expect(navigation.snapshot.navigation).toEqual({ status: 'unknown', revision })
    expect(navigation.back()).toBeUndefined()
    expect(navigation.forward()).toBeUndefined()

    const reload = navigation.reload()!
    expect(navigation.snapshot.navigation).toEqual({ status: 'loading', revision: reload.revision })
  })

  it('ignores frame observations before a controlled request', () => {
    const navigation = new BrowserNavigation()
    navigation.frameLoaded(1)
    expect(navigation.snapshot).toEqual(BrowserNavigation.empty())
    navigation.navigate(httpsTarget(1))
    const revision = navigation.snapshot.request!.revision
    expect(navigation.snapshot.failure).toBeUndefined()
    navigation.frameLoaded(revision)
    expect(navigation.snapshot.navigation).toEqual({ status: 'known', revision })
  })
})
