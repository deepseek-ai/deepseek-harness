// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { MarkdownText } from './markdown-test-components.tsx'
import type { MarkdownPathImages } from '../src/markdown/MarkdownText.tsx'

afterEach(cleanup)

const LOCAL_IMAGE = '![diagram](/tmp/graph.png)'

const mapping = (value: string): string | undefined =>
  value === '/tmp/graph.png' ? 'https://cdn.example.com/graph.png' : undefined

describe('MarkdownText local-path images', () => {
  it('renders authored alt text when no path vocabulary exists', () => {
    const { container } = render(<MarkdownText text={LOCAL_IMAGE} />)
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByText('diagram')).toBeTruthy()
  })

  it('rewrites a local image path through the vocabulary', () => {
    const pathImages: MarkdownPathImages = { resolve: mapping }
    const { container } = render(<MarkdownText text={LOCAL_IMAGE} pathImages={pathImages} />)
    const image = container.querySelector('img')
    expect(image?.getAttribute('src')).toBe('https://cdn.example.com/graph.png')
    expect(image?.getAttribute('alt')).toBe('diagram')
  })

  it.each(['diagram', ''])('shows authored text after an image fails with alt %j', (alt) => {
    const pathImages: MarkdownPathImages = { resolve: mapping }
    const { container } = render(
      <MarkdownText text={`![${alt}](/tmp/graph.png)`} pathImages={pathImages} />,
    )
    fireEvent.error(screen.getByAltText(alt))
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toBe(alt || '/tmp/graph.png')
  })

  it('loads a replacement destination after the preceding image failed', () => {
    const pathImages: MarkdownPathImages = { resolve: value => `https://example.com${value}` }
    const { container, rerender } = render(
      <MarkdownText text={LOCAL_IMAGE} pathImages={pathImages} />,
    )
    fireEvent.error(screen.getByRole('img'))
    rerender(<MarkdownText text="![](/tmp/replacement.png)" pathImages={pathImages} />)
    expect(container.querySelector('img')?.getAttribute('src'))
      .toBe('https://example.com/tmp/replacement.png')
  })

  it('keeps the alt fallback when the vocabulary misses', () => {
    const pathImages: MarkdownPathImages = { resolve: () => undefined }
    const { container } = render(<MarkdownText text={LOCAL_IMAGE} pathImages={pathImages} />)
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByText('diagram')).toBeTruthy()
  })

  it('accepts data and blob vocabulary results', () => {
    const data: MarkdownPathImages = { resolve: () => 'data:image/png;base64,AAAA' }
    const blob: MarkdownPathImages = { resolve: () => 'blob:https://example.com/id' }
    const dataRender = render(<MarkdownText text={LOCAL_IMAGE} pathImages={data} />)
    const blobRender = render(<MarkdownText text={LOCAL_IMAGE} pathImages={blob} />)
    expect(dataRender.container.querySelector('img')?.getAttribute('src'))
      .toBe('data:image/png;base64,AAAA')
    expect(blobRender.container.querySelector('img')?.getAttribute('src'))
      .toBe('blob:https://example.com/id')
  })

  it('rejects non-absolute vocabulary results', () => {
    for (const result of ['relative.png', '/api/image?path=%2Ftmp%2Fx.png', 'ftp://host/x.png']) {
      const pathImages: MarkdownPathImages = { resolve: () => result }
      const { container, unmount } = render(<MarkdownText text={LOCAL_IMAGE} pathImages={pathImages} />)
      expect(container.querySelector('img')).toBeNull()
      unmount()
    }
  })

  it('leaves remote images untouched even when the vocabulary maps them', () => {
    const remote = '![remote](https://example.com/a.png)'
    const pathImages: MarkdownPathImages = { resolve: () => 'https://cdn.example.com/b.png' }
    const { container } = render(<MarkdownText text={remote} pathImages={pathImages} />)
    expect(container.querySelector('img')?.getAttribute('src')).toBe('https://example.com/a.png')
  })

  it('rewrites reference-style local image destinations', () => {
    const reference = ['![diagram][fig]', '', '[fig]: /tmp/graph.png'].join('\n')
    const pathImages: MarkdownPathImages = { resolve: mapping }
    const { container } = render(<MarkdownText text={reference} pathImages={pathImages} />)
    expect(container.querySelector('img')?.getAttribute('src'))
      .toBe('https://cdn.example.com/graph.png')
  })

  it('applies the vocabulary only to settled renders, never while streaming', () => {
    const pathImages: MarkdownPathImages = { resolve: mapping }
    const { container, rerender } = render(
      <MarkdownText text={LOCAL_IMAGE} streaming pathImages={pathImages} />,
    )
    // Streaming messages may still grow, so their prose keeps the inert alt
    // fallback until the settled pass self-heals it.
    expect(container.querySelector('img')).toBeNull()
    rerender(<MarkdownText text={LOCAL_IMAGE} pathImages={pathImages} />)
    expect(container.querySelector('img')?.getAttribute('src'))
      .toBe('https://cdn.example.com/graph.png')
  })
})
