// @vitest-environment jsdom
/** The viewer's brand row: what the sidebar's brand seats say about a share, and where they lead. */

import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ViewerBrandMark, ViewerBrandName } from '../src/client/viewer-brand.tsx'
import { viewerContextFacts, type ViewerContextFacts } from '../src/client/viewer-context.ts'
import { en, NS, zh } from '../src/client/locales.ts'

interface ViewerTargetWindow {
  __DSH_LIVESHARE_VIEWER__?: { shareId: string; sessionId: string; basePath: string }
}

// The brand row reads its copy through the locale seat the served page's client tree provides.
const locale = new LocaleRuntime(new Context())
locale.register(NS, { zh, en })
locale.setLocale('zh')
const t = locale.bind(NS)

afterEach(() => {
  cleanup()
  viewerContextFacts.set({})
  delete (globalThis as ViewerTargetWindow).__DSH_LIVESHARE_VIEWER__
})

/** Publish the facts the page's own read put in the store. */
function publish(facts: ViewerContextFacts): void {
  act(() => { viewerContextFacts.set(facts) })
}

/** Point the page at one share under a public base path. */
function target(basePath = '/team/liveshare'): void {
  ;(globalThis as ViewerTargetWindow).__DSH_LIVESHARE_VIEWER__ = {
    shareId: 'e8HUU7dYsW7Y',
    sessionId: 'fx-alpha',
    basePath,
  }
}

describe('viewer brand row', () => {
  it('links home and states the owner and the owner DSH version', async () => {
    target()
    publish({ owner: '许翰翔', dshVersion: '0.1.5-rc.2', relay: '20260911-143800-6a72b8' })
    render(<ViewerBrandName t={t} />)
    const link = screen.getByRole('link', { name: '回到 LiveShare 首页' })
    expect(link.getAttribute('href')).toBe('/team/liveshare/')
    expect(link.textContent).toContain('由 许翰翔 分享')
    expect(link.textContent).toContain('LiveShare')
    expect(link.textContent).toContain('DSH 0.1.5-rc.2')
    // The Relay's own release stays a detail of the same link instead of widening the row.
    expect(link.getAttribute('title')).toBe('由 许翰翔 分享 · DSH 0.1.5-rc.2 · relay 20260911-143800-6a72b8')
    expect(link.textContent).not.toContain('20260911-143800-6a72b8')
  })

  it('states no owner version when the share reported none, and never invents an owner', () => {
    target('')
    publish({})
    render(<ViewerBrandName t={t} />)
    const link = screen.getByRole('link', { name: '回到 LiveShare 首页' })
    expect(link.getAttribute('href')).toBe('/')
    expect(link.textContent).toContain('由 未知分享者 分享')
    expect(link.textContent).not.toContain('DSH')
    expect(link.getAttribute('title')).toBe('由 未知分享者 分享')
  })

  it('labels a share whose verified owner has no display name from the identity itself', () => {
    target()
    publish({ ownerSubjectId: 'feishu:tenant:ou_9f2c4d', dshVersion: '0.1.5-rc.2' })
    render(<ViewerBrandName t={t} />)
    const link = screen.getByRole('link', { name: '回到 LiveShare 首页' })
    expect(link.textContent).toContain('由 主体 …ou_9f2c4d 分享')
    // The signed-in viewer's own name is never pasted onto the share's owner.
    expect(link.textContent).not.toContain('未知分享者')
  })

  it('states facts that arrive after the seat rendered', () => {
    target()
    render(<ViewerBrandName t={t} />)
    expect(screen.getByRole('link', { name: '回到 LiveShare 首页' }).textContent)
      .toContain('由 未知分享者 分享')
    publish({ owner: '许翰翔', dshVersion: '0.1.5-rc.2' })
    const link = screen.getByRole('link', { name: '回到 LiveShare 首页' })
    expect(link.textContent).toContain('由 许翰翔 分享')
    expect(link.textContent).toContain('DSH 0.1.5-rc.2')
  })

  it('keeps the owner release inline and its build metadata on the tooltip', () => {
    target()
    publish({ owner: '许翰翔', dshVersion: '0.1.5-rc.2+9f2c4d1' })
    render(<ViewerBrandName t={t} />)
    const link = screen.getByRole('link', { name: '回到 LiveShare 首页' })

    expect(link.textContent).toContain('DSH 0.1.5-rc.2')
    expect(link.textContent).not.toContain('9f2c4d1')
    // The whole identifier one click away, so a build never widens the row.
    expect(link.getAttribute('title')).toContain('DSH 0.1.5-rc.2+9f2c4d1')
  })

  it('renders the shipped Harness mark at the size the shell asks for', () => {
    const { container } = render(<ViewerBrandMark size={24} />)
    const mark = container.querySelector('svg')
    expect(mark).not.toBeNull()
    expect(mark?.getAttribute('width')).toBe('24')
  })
})
