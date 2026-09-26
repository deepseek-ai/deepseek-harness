// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AssistantMarkdown, localPathMediaUrl } from '../src/client/chat/AssistantMarkdown.tsx'
import { useDetailedPresentation } from './presentation-fixture.client.ts'
import { useDisclosure } from '../src/client/chat/use-disclosure.ts'
import type { ChatNodeOwnerProps, ChatViewSlotProps } from '../src/client/contract/slots.ts'
import type { AssistantBlock } from '../src/client/contract/snapshot.ts'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const t = ((_key: string) => 'label') as ChatViewSlotProps['t']
const renderMessageImages = (() => null) as ChatNodeOwnerProps['renderMessageImages']

function textBlock(text: string): AssistantBlock {
  return { kind: 'text', text }
}

const BASE = 'http://127.0.0.1:3080/'
const MOUNTED_BASE = 'http://127.0.0.1:3080/tools/dsh/'

describe('localPathMediaUrl', () => {
  it('maps an absolute POSIX path to the file route of the document, root or mount', () => {
    const path = encodeURIComponent('/tmp/graph.png')
    for (const [base, root] of [
      [BASE, BASE],
      ['https://127.0.0.1:3080/', 'https://127.0.0.1:3080/'],
      [MOUNTED_BASE, MOUNTED_BASE],
      ['dsh-app://app/', 'dsh-app://app/'],
      ['dsh-app://app/index.html', 'dsh-app://app/'],
      ['http://127.0.0.1:3080/tools/dsh/index.html', MOUNTED_BASE],
    ]) {
      expect(localPathMediaUrl(base!, '/tmp/graph.png')).toBe(`${root!}api/file?path=${path}`)
    }
  })

  it('keeps unsupported application transports inert', () => {
    expect(localPathMediaUrl('about:blank', '/tmp/graph.png')).toBeUndefined()
    expect(localPathMediaUrl('dsh-app://shell/', '/tmp/graph.png')).toBeUndefined()
    expect(localPathMediaUrl('file:///app', '/tmp/graph.png')).toBeUndefined()
    expect(localPathMediaUrl('ws://127.0.0.1:3080/', '/tmp/graph.png')).toBeUndefined()
  })

  it('keeps destinations that cannot be Host-served local files inert', () => {
    expect(localPathMediaUrl(BASE, '')).toBeUndefined()
    expect(localPathMediaUrl(BASE, '//cdn.example.com/x.png')).toBeUndefined()
    expect(localPathMediaUrl(BASE, 'relative.png')).toBeUndefined()
    expect(new URL(localPathMediaUrl(BASE, 'C:\\tmp\\x.png')!).searchParams.get('path')).toBe('C:\\tmp\\x.png')
  })

  it('encodes the full path including spaces', () => {
    expect(localPathMediaUrl(BASE, '/tmp/my graph.png'))
      .toBe(`${BASE}api/file?path=${encodeURIComponent('/tmp/my graph.png')}`)
  })
})

describe('AssistantMarkdown local-path images', () => {
  it.each([BASE, 'dsh-app://app/'])('renders a local image in closing prose through %s', (base) => {
    vi.spyOn(document, 'baseURI', 'get').mockReturnValue(base)
    const { container } = render(
      <AssistantMarkdown useDisclosure={useDisclosure}
        usePresentation={useDetailedPresentation}
        blocks={[textBlock('See ![diagram](/tmp/graph.png) for the layout.')]}
        streaming={false}
        renderMessageImages={renderMessageImages}
        t={t}
      />,
    )
    const image = container.querySelector('img')
    expect(image?.getAttribute('alt')).toBe('diagram')
    const url = new URL(image?.getAttribute('src') ?? '')
    expect(url.pathname).toBe('/api/file')
    expect(url.protocol).toBe(new URL(base).protocol)
    expect(url.searchParams.get('path')).toBe('/tmp/graph.png')
  })

  it('keeps non-absolute destinations inert', () => {
    const { container } = render(
      <AssistantMarkdown useDisclosure={useDisclosure}
        usePresentation={useDetailedPresentation}
        blocks={[textBlock('See ![diagram](relative.png).')]}
        streaming={false}
        renderMessageImages={renderMessageImages}
        t={t}
      />,
    )
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('diagram')
  })
})

it('decodes Markdown URL escapes once before encoding the file query', () => {
  for (const [authored, path] of [
    ['/work/test%20workspace/图.png', '/work/test workspace/图.png'],
    ['/work/100%25%23.png', '/work/100%#.png'],
    ['/work/literal%2520.png', '/work/literal%20.png'],
  ]) expect(new URL(localPathMediaUrl(BASE, authored!)!).searchParams.get('path')).toBe(path)
  expect(localPathMediaUrl(BASE, '/work/bad%escape.png')).toBeUndefined()
})
