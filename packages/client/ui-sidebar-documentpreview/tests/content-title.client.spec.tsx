// @vitest-environment jsdom
/** The content tab's chip title: the media-type icon and the shared title rule. */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { createElement } from 'react'
import type { ResourceSnapshot } from '@deepseek-ai/dsh-client-resources/client'
import { ContentTitle } from '../src/client/content/ContentTitle.tsx'
import type { ContentTitleProps } from '../src/client/content/ContentTitle.tsx'
import type { PreviewContent } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'

afterEach(cleanup)

const BLOB = 'dsh-resource://blob/window/item'

function renderTitle(address: string, snapshot: ResourceSnapshot<PreviewContent>) {
  const props = {
    useTabInfo: () => ({ tab: { id: 'tab-1', contentId: address, title: 'Recorded title', navigation: { params: snapshot.value === undefined ? undefined : { previewContent: snapshot.value, previewTitle: 'Stored title' } } } }),
    useResource: () => snapshot,
  } as never as ContentTitleProps
  return render(createElement(ContentTitle, props)).container
}

const loading: ResourceSnapshot<PreviewContent> = { status: 'loading', value: undefined, failure: undefined }
const live = (value: PreviewContent): ResourceSnapshot<PreviewContent> => ({ status: 'live', value, failure: undefined })

describe('content title', () => {
  it('shows the recorded title with a generic icon before the content loads', () => {
    const container = renderTitle(BLOB, loading)
    expect(container.textContent).toBe('Recorded title')
    expect(container.querySelector('svg')).not.toBeNull()
  })

  it('shows the stored blob title with an icon chosen by media type', () => {
    const markdown = renderTitle(BLOB, live({ mediaType: 'text/markdown', text: '#' }))
    expect(markdown.textContent).toBe('Stored title')
    const plain = renderTitle(BLOB, live({ mediaType: 'text/plain', text: 'a' }))
    expect(plain.querySelector('svg')?.outerHTML).not.toBe(markdown.querySelector('svg')?.outerHTML)
  })

})
