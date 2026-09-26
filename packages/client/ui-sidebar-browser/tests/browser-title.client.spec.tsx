// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import { BrowserNavigation } from '../src/client/browser/BrowserNavigation.ts'
import type { BrowserTitleProps } from '../src/client/view/BrowserTitle.tsx'
import { BrowserTitle } from '../src/client/view/BrowserTitle.tsx'

const TAB = 'tab' as TabId

function props(entry = false): BrowserTitleProps {
  const state = entry
    ? {
      ...BrowserNavigation.empty(),
      entries: [{ kind: 'https' as const, url: 'https://example.test/', title: 'Loaded page' }],
      index: 0,
    }
    : BrowserNavigation.empty()
  return {
    useTabInfo: () => ({ tab: { id: TAB, title: 'Browser' } }),
    useStore: selector => selector({ byTab: { [TAB]: state } }),
  } as BrowserTitleProps
}

describe('BrowserTitle', () => {
  it('uses the current page title and falls back to the tab title', () => {
    const view = render(<BrowserTitle {...props(true)} />)
    expect(view.getByText('Loaded page')).toBeDefined()
    view.rerender(<BrowserTitle {...props()} />)
    expect(view.getByText('Browser')).toBeDefined()
  })
})
